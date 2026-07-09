"""Device manager — discovery, session tracking, DeviceSession class."""

import asyncio
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path

from pymobiledevice3.usbmux import list_devices
from pymobiledevice3.lockdown import create_using_usbmux

from ggeo.config import MAX_DEVICES, PROJECT_ROOT, TESTED_MAX_IOS
from ggeo.device.tunnel import run_device_session

logger = logging.getLogger("ggeo.manager")

BONJOUR_CACHE_TTL = 10.0
BONJOUR_BROWSE_TIMEOUT = 4.0
BONJOUR_BROKEN_TTL = 300.0
DEVICE_IPS_FILE = PROJECT_ROOT / "data" / "device_ips.json"
DEVICE_IPS_TTL = 24 * 3600


def _version_tuple(v: str) -> tuple:
    """Convert '17.4.1' -> (17, 4, 1)."""
    try:
        return tuple(int(x) for x in v.split("."))
    except Exception:
        return (0,)


def _is_ios_untested(version: str) -> bool:
    """Return True if iOS version exceeds TESTED_MAX_IOS."""
    try:
        return _version_tuple(version) > _version_tuple(TESTED_MAX_IOS)
    except Exception:
        return False


class DeviceSession:
    """State for a single active device session."""

    def __init__(self, udid: str, name: str = "Unknown", lat: float = 0, lon: float = 0,
                 connection_type: str = "USB", ip: str = None):
        self.udid = udid
        self.name = name
        self.lat = lat
        self.lon = lon
        self.connection_type = connection_type
        self.ip = ip
        self.is_simulating = False
        self.status = "connecting"
        self.connect_started_at = time.time()
        self.connect_duration = None
        self.spoof_started_at = None
        self._simulation_task = None
        self._should_stop = False
        self._mount_done = False
        self._retry_count = 0
        self._usage_id = None
        self._deactivated_by_user = False
        self._disconnect_started_at = None
        self._gave_up = False
        self._store = None
        self.activated_by_user_id: str | None = None
        self.activated_by_username: str | None = None

    def to_dict(self) -> dict:
        spoof_elapsed = None
        if self.spoof_started_at:
            spoof_elapsed = round(time.time() - self.spoof_started_at, 1)
        connect_elapsed = None
        if self.connect_started_at and not self.connect_duration and (
                self.status.startswith("connecting") or self.status == "reconnecting"):
            connect_elapsed = round(time.time() - self.connect_started_at, 1)
        return {
            "udid": self.udid,
            "name": self.name,
            "is_active": self.is_simulating,
            "connection_status": self.status,
            "lat": self.lat,
            "lon": self.lon,
            "connect_duration": self.connect_duration,
            "spoof_elapsed": spoof_elapsed,
            "spoof_started_at": self.spoof_started_at,
            "connect_elapsed": connect_elapsed,
            "retry_count": self._retry_count,
            "disconnect_started_at": self._disconnect_started_at,
            "wifi_unreachable": getattr(self, "_wifi_unreachable", False),
            "activated_by_user_id": self.activated_by_user_id,
            "activated_by_username": self.activated_by_username,
        }


class DeviceManager:
    """Manages device discovery and active sessions."""

    def __init__(self):
        self.sessions: dict[str, DeviceSession] = {}
        self._device_names: dict[str, str] = {}
        self._device_models: dict[str, str] = {}
        self._device_ios: dict[str, str] = {}
        self._device_ips: dict[str, str] = {}
        self._device_connection: dict[str, str] = {}
        self._bonjour_cache: list[dict] = []
        self._bonjour_cache_at: float = 0.0
        self._store = None
        self._registered_fetcher = None
        self._registered_cache: list | None = None
        self._registered_cache_at: float = 0.0
        self._device_ips_meta: dict[str, dict] = {}
        self._last_missing: list[dict] = []
        self._bonjour_broken_until: float = 0.0
        self.last_transport_error: str | None = None
        self._load_device_ips()

    def _load_device_ips(self) -> None:
        try:
            if not DEVICE_IPS_FILE.exists():
                return
            data = json.loads(DEVICE_IPS_FILE.read_text())
            now = time.time()
            for udid, entry in (data or {}).items():
                if not isinstance(entry, dict):
                    continue
                ip = entry.get("ip")
                last_seen = entry.get("last_seen", 0)
                if not ip or (now - last_seen) > DEVICE_IPS_TTL:
                    continue
                self._device_ips[udid] = ip
                self._device_ips_meta[udid] = entry
            if self._device_ips:
                logger.info(
                    "Loaded %d cached device IP(s) from %s",
                    len(self._device_ips), DEVICE_IPS_FILE.name,
                )
        except Exception as exc:
            logger.warning("Failed to load device_ips cache: %s", exc)

    def _record_device_ip(self, udid: str, ip: str, source: str = "bonjour",
                          persist: bool = True) -> None:
        if not udid or not ip:
            return
        self._device_ips[udid] = ip
        self._device_ips_meta[udid] = {
            "ip": ip,
            "last_seen": time.time(),
            "source": source,
        }
        if persist:
            self._save_device_ips()

    def _save_device_ips(self) -> None:
        try:
            DEVICE_IPS_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = tempfile.NamedTemporaryFile(
                mode="w", dir=str(DEVICE_IPS_FILE.parent),
                prefix=".device_ips.", suffix=".tmp", delete=False,
            )
            try:
                json.dump(self._device_ips_meta, tmp, indent=2)
                tmp.flush()
                os.fsync(tmp.fileno())
            finally:
                tmp.close()
            os.replace(tmp.name, DEVICE_IPS_FILE)
        except Exception as exc:
            logger.warning("Failed to persist device_ips cache: %s", exc)
            try:
                if "tmp" in locals() and os.path.exists(tmp.name):
                    os.unlink(tmp.name)
            except Exception:
                pass

    def set_store(self, store):
        """Attach store reference."""
        self._store = store

    def set_registered_fetcher(self, fetcher):
        """Attach an async callable returning the list of registered devices."""
        self._registered_fetcher = fetcher

    async def _list_registered(self) -> list | None:
        if self._store is not None:
            try:
                return await self._store.list_registered_devices()
            except Exception:
                logger.warning("store.list_registered_devices failed", exc_info=True)
                return None
        if self._registered_fetcher is None:
            return None
        now = time.time()
        if (self._registered_cache is not None
                and (now - self._registered_cache_at) < 15.0):
            return self._registered_cache
        try:
            data = await self._registered_fetcher()
            self._registered_cache = data or []
            self._registered_cache_at = now
            return self._registered_cache
        except Exception:
            logger.warning("registered_fetcher failed", exc_info=True)
            return self._registered_cache

    async def _wifi_enabled(self, udid: str) -> bool:
        if self._store is not None:
            try:
                return await self._store.get_device_wifi_enabled(udid)
            except Exception:
                return False
        registered = await self._list_registered()
        if registered is None:
            return False
        for r in registered:
            if r.get("udid") == udid:
                return bool(r.get("wifi_connections_enabled"))
        return False

    async def discover(self, scope_udids: set = None) -> tuple[list[dict], list[dict]]:
        try:
            try:
                devices = await list_devices()
                self.last_transport_error = None
            except Exception as e:
                logger.warning("list_devices() failed: %s", e)
                self.last_transport_error = (
                    "amds_unreachable" if sys.platform == "win32"
                    else "usbmuxd_unreachable"
                )
                devices = []
            by_udid = {}
            for dev in devices:
                if scope_udids is not None and dev.serial not in scope_udids:
                    continue
                ct = getattr(dev, "connection_type", "USB")
                existing = by_udid.get(dev.serial)
                if not existing or (ct == "USB" and existing["connection"] != "USB"):
                    by_udid[dev.serial] = {"dev": dev, "connection": ct}

            result = []
            need_lockdown = []

            for udid, info in by_udid.items():
                self._device_connection[udid] = info["connection"]
                if udid in self.sessions:
                    session = self.sessions[udid]
                    result.append({
                        "udid": udid,
                        "name": session.name,
                        "model": self._device_models.get(udid, "Unknown"),
                        "ios_version": self._device_ios.get(udid, "Unknown"),
                        "connection": info["connection"],
                        "ip": self._device_ips.get(udid),
                        "active": True,
                        "ios_untested": False,
                        "wifi_connections_enabled": await self._wifi_enabled(udid),
                    })
                elif udid in self._device_names and udid in self._device_models:
                    ios_ver = self._device_ios.get(udid, "Unknown")
                    result.append({
                        "udid": udid,
                        "name": self._device_names[udid],
                        "model": self._device_models[udid],
                        "ios_version": ios_ver,
                        "connection": info["connection"],
                        "ip": self._device_ips.get(udid),
                        "active": False,
                        "ios_untested": _is_ios_untested(ios_ver),
                        "wifi_connections_enabled": await self._wifi_enabled(udid),
                    })
                    logger.info("Found (cached): %s (%s) via %s",
                                self._device_names[udid], udid[:12], info["connection"])
                else:
                    need_lockdown.append((udid, info))

            async def _fetch_device_info(udid: str, info: dict) -> dict:
                lockdown = None
                try:
                    lockdown = await asyncio.wait_for(
                        create_using_usbmux(serial=udid, autopair=True), timeout=10)
                    dev_info = lockdown.short_info
                    name = dev_info.get("DeviceName", "Unknown")
                    ios_ver = dev_info.get("ProductVersion", "Unknown")
                    model = dev_info.get("ProductType", "Unknown")
                    self._device_names[udid] = name
                    self._device_models[udid] = model
                    self._device_ios[udid] = ios_ver
                    untested = _is_ios_untested(ios_ver)
                    if untested:
                        logger.warning(
                            "iOS %s has not been verified with GGEO "
                            "(tested max: %s). GPS simulation may not work.",
                            ios_ver, TESTED_MAX_IOS)
                    logger.info("Found: %s (%s) via %s", name, udid[:12], info["connection"])
                    return {
                        "udid": udid,
                        "name": name,
                        "model": model,
                        "ios_version": ios_ver,
                        "connection": info["connection"],
                        "ip": self._device_ips.get(udid),
                        "active": False,
                        "ios_untested": untested,
                        "wifi_connections_enabled": await self._wifi_enabled(udid),
                    }
                except Exception as e:
                    logger.warning("Could not get info for %s: %s", udid[:12], e)
                    return {
                        "udid": udid,
                        "name": self._device_names.get(udid, "Unknown"),
                        "model": self._device_models.get(udid, "Unknown"),
                        "ios_version": self._device_ios.get(udid, "Unknown"),
                        "connection": info["connection"],
                        "ip": self._device_ips.get(udid),
                        "active": False,
                        "ios_untested": False,
                        "wifi_connections_enabled": await self._wifi_enabled(udid),
                    }
                finally:
                    if lockdown is not None:
                        try:
                            await lockdown.close()
                        except Exception:
                            pass

            if need_lockdown:
                tasks = [_fetch_device_info(udid, info) for udid, info in need_lockdown]
                fetched = await asyncio.gather(*tasks, return_exceptions=True)
                for item in fetched:
                    if isinstance(item, Exception):
                        logger.warning("Parallel fetch task error: %s", item)
                        continue
                    result.append(item)

            found_udids = {r["udid"] for r in result}

            if scope_udids is None or not (found_udids >= scope_udids):
                await self._bonjour_discover(result, found_udids, scope_udids)

            result_udids = {r["udid"] for r in result}
            for udid, sess in list(self.sessions.items()):
                if udid in result_udids:
                    continue
                if scope_udids is not None and udid not in scope_udids:
                    continue
                result.append({
                    "udid": udid,
                    "name": sess.name,
                    "model": self._device_models.get(udid, "Unknown"),
                    "ios_version": self._device_ios.get(udid, "Unknown"),
                    "connection": sess.connection_type or "Network",
                    "ip": sess.ip,
                    "active": True,
                    "ios_untested": False,
                    "wifi_connections_enabled": await self._wifi_enabled(udid),
                })
                logger.info("Discover: included active session %s from sessions cache",
                            udid[:12])

            if scope_udids is not None:
                result = [r for r in result if r["udid"] in scope_udids]

            for r in result:
                self._device_names.setdefault(r["udid"], r["name"])

            missing_devices = []
            registered = await self._list_registered()
            if registered:
                registered_udids = {
                    d["udid"] for d in registered if d.get("udid")
                }
                if scope_udids is not None:
                    registered_udids &= scope_udids
                found_final = {r["udid"] for r in result}
                missing_udids = registered_udids - found_final
                if missing_udids:
                    registered_by_udid = {
                        d["udid"]: d for d in registered if d.get("udid")
                    }
                    for udid in missing_udids:
                        reg = registered_by_udid.get(udid, {})
                        meta = self._device_ips_meta.get(udid, {})
                        missing_devices.append({
                            "udid": udid,
                            "name": reg.get("name", self._device_names.get(udid, "Unknown")),
                            "model": reg.get("model", self._device_models.get(udid, "Unknown")),
                            "last_seen": meta.get("last_seen"),
                        })
                    logger.info(
                        "Discover: %d missing device(s): %s",
                        len(missing_udids),
                        [u[:12] for u in missing_udids])

            self._last_missing = missing_devices

            if not result:
                logger.warning("No devices found.")
            return result, missing_devices
        except Exception as e:
            logger.error("Device discovery failed: %s", e)
            return [], []

    async def presence_snapshot(self) -> list[dict]:
        """Cheap per-device presence for the host heartbeat (called every ~10s).

        Uses only the lightweight usbmux enumeration (no lockdown, no Bonjour)
        plus cached metadata, so it is safe on the heartbeat loop. Reports the
        devices the transport currently sees, letting the host show real
        per-device status instead of inferring it from client-online alone.
        Failures return [] — the host then simply doesn't refresh presence.
        """
        try:
            devices = await list_devices()
        except Exception as e:
            logger.debug("presence_snapshot list_devices failed: %s", e)
            return []
        seen: dict[str, dict] = {}
        for dev in devices:
            udid = getattr(dev, "serial", None)
            if not udid:
                continue
            ct = getattr(dev, "connection_type", "USB")
            # Prefer USB when a device appears on both transports.
            if udid in seen and seen[udid]["connection_type"] == "USB":
                continue
            seen[udid] = {
                "udid": udid,
                "connection_type": ct,
                "name": self._device_names.get(udid),
                "model": self._device_models.get(udid),
                "ios_version": self._device_ios.get(udid),
            }
        # Live sessions on WiFi may not enumerate via usbmux — include them.
        for udid, sess in list(self.sessions.items()):
            if udid not in seen:
                seen[udid] = {
                    "udid": udid,
                    "connection_type": sess.connection_type or "Network",
                    "name": sess.name,
                    "model": self._device_models.get(udid),
                    "ios_version": self._device_ios.get(udid),
                }
        return list(seen.values())

    async def _bonjour_discover(self, result: list, found_udids: set,
                               scope_udids: set = None):
        if time.time() < self._bonjour_broken_until:
            return

        now = time.time()

        if self._bonjour_cache and (now - self._bonjour_cache_at) < BONJOUR_CACHE_TTL:
            for entry in self._bonjour_cache:
                if entry["udid"] in found_udids:
                    continue
                fresh = dict(entry)
                fresh["wifi_connections_enabled"] = await self._wifi_enabled(entry["udid"])
                result.append(fresh)
                found_udids.add(entry["udid"])
                self._device_connection[entry["udid"]] = "Network"
            return

        try:
            from pymobiledevice3.lockdown import get_mobdev2_lockdowns
        except ImportError as e:
            logger.debug("Bonjour discovery unavailable: %s", e)
            return

        new_cache: list[dict] = []
        browse_yielded = False

        async def _browse():
            nonlocal browse_yielded
            async for ip, ld in get_mobdev2_lockdowns():
                browse_yielded = True
                try:
                    if ip and ":" in str(ip):
                        continue
                    try:
                        info = ld.short_info
                    except Exception:
                        continue
                    udid = info.get("UniqueDeviceID") or getattr(ld, "identifier", None)
                    if not udid:
                        continue
                    self._record_device_ip(udid, ip, source="bonjour", persist=False)
                    if udid in found_udids:
                        continue
                    name = info.get("DeviceName", self._device_names.get(udid, "Unknown"))
                    model = info.get("ProductType", "Unknown")
                    ios_ver = info.get("ProductVersion", "Unknown")
                    self._device_names[udid] = name
                    self._device_models[udid] = model
                    self._device_ios[udid] = ios_ver
                    untested = _is_ios_untested(ios_ver)
                    entry = {
                        "udid": udid,
                        "name": name,
                        "model": model,
                        "ios_version": ios_ver,
                        "connection": "Network",
                        "ip": ip,
                        "active": False,
                        "ios_untested": untested,
                        "wifi_connections_enabled": await self._wifi_enabled(udid),
                    }
                    result.append(entry)
                    new_cache.append(entry)
                    found_udids.add(udid)
                    self._device_connection[udid] = "Network"
                    logger.info("Found (Bonjour): %s (%s) @ %s", name, udid[:12], ip)
                    if scope_udids and found_udids >= scope_udids:
                        return
                finally:
                    try:
                        await ld.close()
                    except Exception:
                        pass

        try:
            await asyncio.wait_for(_browse(), timeout=BONJOUR_BROWSE_TIMEOUT)
        except asyncio.TimeoutError:
            logger.info("Bonjour browse timeout (%.0fs), found %d device(s)",
                        BONJOUR_BROWSE_TIMEOUT, len(new_cache))
        except Exception as e:
            logger.debug("Bonjour discovery failed: %s", e)
            return

        if not browse_yielded and self._registered_fetcher is not None:
            try:
                registered = await self._list_registered()
                if registered:
                    logger.warning(
                        "Bonjour browse returned empty but %d device(s) registered. "
                        "Check macOS Local Network permission for the Python venv. "
                        "Retrying Bonjour in %ds.",
                        len(registered), int(BONJOUR_BROKEN_TTL))
                    self._bonjour_broken_until = time.time() + BONJOUR_BROKEN_TTL
            except Exception:
                pass

        self._bonjour_cache = new_cache
        self._bonjour_cache_at = now
        self._save_device_ips()

    def get_device_name(self, udid: str) -> str:
        return self._device_names.get(udid, udid[:12])

    async def activate(self, udid: str, lat: float, lon: float,
                       activated_by_user_id: str | None = None,
                       activated_by_username: str | None = None) -> DeviceSession:
        """Start GPS simulation on a device. Returns the session."""
        if udid in self.sessions:
            existing = self.sessions[udid]
            task_done = (existing._simulation_task is None
                         or existing._simulation_task.done())
            if existing._should_stop or task_done:
                if (existing._simulation_task
                        and not existing._simulation_task.done()):
                    try:
                        await asyncio.wait_for(existing._simulation_task, timeout=2)
                    except (asyncio.TimeoutError, Exception):
                        try:
                            existing._simulation_task.cancel()
                        except Exception:
                            pass
                self.sessions.pop(udid, None)
                logger.info("[%s] Cleared stale session entry before reactivate",
                            self.get_device_name(udid))
            else:
                raise ValueError("Device %s already active"
                                 % self.get_device_name(udid))
        if len(self.sessions) >= MAX_DEVICES:
            raise RuntimeError("Max %d devices reached. Deactivate one first." % MAX_DEVICES)

        ip = self._device_ips.get(udid)
        connection_type = self._device_connection.get(
            udid, "Network" if ip else "USB"
        )

        name = self.get_device_name(udid)
        session = DeviceSession(udid, name=name, lat=lat, lon=lon,
                                connection_type=connection_type, ip=ip)
        session._store = self._store
        session.activated_by_user_id = activated_by_user_id
        session.activated_by_username = activated_by_username
        self.sessions[udid] = session
        session._simulation_task = asyncio.create_task(run_device_session(session))
        logger.info("[%s] Session started at %.6f, %.6f via %s",
                    name, lat, lon, connection_type)
        return session

    async def deactivate(self, udid: str):
        """Stop GPS simulation on a device."""
        session = self.sessions.get(udid)
        if not session:
            raise ValueError("Device not active")

        session._should_stop = True
        if session._simulation_task and not session._simulation_task.done():
            try:
                await asyncio.wait_for(session._simulation_task, timeout=15)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                session._simulation_task.cancel()

        self.sessions.pop(udid, None)
        logger.info("[%s] Session stopped.", session.name)

    async def deactivate_all(self) -> list[str]:
        """Stop all active sessions. Returns list of stopped UDIDs."""
        stopped = []
        for udid in list(self.sessions.keys()):
            try:
                await self.deactivate(udid)
                stopped.append(udid)
            except Exception as e:
                logger.error("Failed to deactivate %s: %s", udid[:12], e)
        return stopped

    async def shutdown(self):
        """Clear GPS on all devices before exit."""
        logger.info("Shutting down %d active session(s)...", len(self.sessions))
        await self.deactivate_all()
        logger.info("All sessions stopped.")

    def get_status(self) -> dict:
        """Get status of all sessions."""
        return {
            "active_count": len(self.sessions),
            "max_devices": MAX_DEVICES,
            "sessions": {udid: s.to_dict() for udid, s in self.sessions.items()},
        }
