"""Device manager — discovery, session tracking, DeviceSession class."""

import asyncio
import logging
import sys
import time

from pymobiledevice3.usbmux import list_devices
from pymobiledevice3.lockdown import create_using_usbmux

from ggeo.config import MAX_DEVICES, TESTED_MAX_IOS
from ggeo.device.tunnel import run_device_session

logger = logging.getLogger("ggeo.manager")

BONJOUR_CACHE_TTL = 10.0


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

    async def discover(self, _usbmuxd_retry_done: bool = False,
                       scope_udids: set = None) -> list[dict]:
        """Scan for iPhones/iPads via usbmux (USB + WiFi/Network)."""
        try:
            try:
                devices = await list_devices()
            except Exception as e:
                logger.warning("list_devices() failed: %s", e)
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
                    continue

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
                    result.append({
                        "udid": udid,
                        "name": name,
                        "model": model,
                        "ios_version": ios_ver,
                        "connection": info["connection"],
                        "ip": self._device_ips.get(udid),
                        "active": False,
                        "ios_untested": untested,
                        "wifi_connections_enabled": await self._wifi_enabled(udid),
                    })
                    logger.info("Found: %s (%s) via %s", name, udid[:12], info["connection"])
                except Exception as e:
                    logger.warning("Could not get info for %s: %s", udid[:12], e)
                    result.append({
                        "udid": udid,
                        "name": self._device_names.get(udid, "Unknown"),
                        "model": self._device_models.get(udid, "Unknown"),
                        "ios_version": self._device_ios.get(udid, "Unknown"),
                        "connection": info["connection"],
                        "ip": self._device_ips.get(udid),
                        "active": False,
                        "ios_untested": False,
                        "wifi_connections_enabled": await self._wifi_enabled(udid),
                    })
                finally:
                    if lockdown is not None:
                        try:
                            await lockdown.close()
                        except Exception:
                            pass

            found_udids = {r["udid"] for r in result}
            await self._bonjour_discover(result, found_udids)
            if scope_udids is not None:
                result = [r for r in result if r["udid"] in scope_udids]

            for r in result:
                self._device_names.setdefault(r["udid"], r["name"])

            if sys.platform == "darwin" and not _usbmuxd_retry_done:
                registered = await self._list_registered()
                if registered:
                    try:
                        registered_udids = {
                            d["udid"] for d in registered if d.get("udid")
                        }
                        if scope_udids is not None:
                            registered_udids &= scope_udids
                        found_udids_now = {r["udid"] for r in result}
                        missing = registered_udids - found_udids_now
                        if missing:
                            logger.info(
                                "Discover: %d missing device(s) in scope (%s). "
                                "Kick usbmuxd to refresh.",
                                len(missing),
                                [u[:12] for u in list(missing)[:3]])
                            from ggeo.device.tunnel import maybe_restart_usbmuxd
                            if await maybe_restart_usbmuxd(source="discover"):
                                for _ in range(8):
                                    await asyncio.sleep(2)
                                    try:
                                        current = await list_devices()
                                        if any(d.serial in missing for d in current):
                                            break
                                    except Exception:
                                        continue
                                recursive_result = await self.discover(
                                    _usbmuxd_retry_done=True,
                                    scope_udids=scope_udids)
                                recursive_udids = {r["udid"] for r in recursive_result}
                                still_missing = missing - recursive_udids
                                logger.info(
                                    "Discover: post-kick recursive returned %d device(s); "
                                    "still missing: %s",
                                    len(recursive_udids),
                                    [u[:12] for u in still_missing])
                                registered_by_udid = {
                                    d["udid"]: d for d in registered if d.get("udid")
                                }
                                for udid in still_missing:
                                    ip = self._device_ips.get(udid)
                                    if not ip:
                                        logger.info(
                                            "Discover: %s no IP cached, skip ping fallback",
                                            udid[:12])
                                        continue
                                    logger.info(
                                        "Discover: ping-fallback %s @ %s",
                                        udid[:12], ip)
                                    try:
                                        proc = await asyncio.create_subprocess_exec(
                                            "ping", "-c", "1", "-t", "2", ip,
                                            stdout=asyncio.subprocess.DEVNULL,
                                            stderr=asyncio.subprocess.DEVNULL,
                                        )
                                        try:
                                            await asyncio.wait_for(proc.wait(), timeout=3)
                                            if proc.returncode == 0:
                                                reg = registered_by_udid.get(udid)
                                                if reg:
                                                    logger.info(
                                                        "Discover: %s ping OK, add Silent entry",
                                                        udid[:12])
                                                    recursive_result.append({
                                                        "udid": udid,
                                                        "name": reg.get("name", "Unknown"),
                                                        "model": reg.get("model", "Unknown"),
                                                        "ios_version": reg.get("ios_version", "Unknown"),
                                                        "connection": "Silent",
                                                        "ip": ip,
                                                        "active": False,
                                                        "ios_untested": False,
                                                        "bonjour_silent": True,
                                                        "wifi_connections_enabled": bool(
                                                            reg.get("wifi_connections_enabled", 0)),
                                                    })
                                            else:
                                                logger.info(
                                                    "Discover: %s ping failed (rc=%s)",
                                                    udid[:12], proc.returncode)
                                        except asyncio.TimeoutError:
                                            proc.kill()
                                            logger.info("Discover: %s ping timeout", udid[:12])
                                    except Exception as ping_err:
                                        logger.info(
                                            "Discover: %s ping error: %s",
                                            udid[:12], ping_err)
                                return recursive_result
                    except Exception as e:
                        logger.warning("Discover auto-kick usbmuxd failed: %s", e)

            if not result:
                logger.warning("No devices found.")
            return result
        except Exception as e:
            logger.error("Device discovery failed: %s", e)
            return []

    async def _bonjour_discover(self, result: list, found_udids: set):
        """Bonjour WiFi discovery (cross-platform) with caching."""
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
        try:
            async for ip, ld in get_mobdev2_lockdowns():
                try:
                    if ip and ":" in str(ip):
                        continue
                    try:
                        info = ld.short_info
                    except Exception as info_err:
                        logger.debug("Bonjour short_info failed for %s: %s",
                                     ip, info_err)
                        continue
                    udid = info.get("UniqueDeviceID") or getattr(ld, "identifier", None)
                    if not udid:
                        continue
                    self._device_ips[udid] = ip
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
                finally:
                    try:
                        await ld.close()
                    except Exception:
                        pass
        except Exception as e:
            logger.debug("Bonjour discovery failed: %s", e)
            return

        if not new_cache and self._registered_fetcher is not None:
            try:
                registered = await self._list_registered()
                if registered:
                    logger.warning(
                        "Bonjour browse returned empty but %d device(s) registered. "
                        "Check macOS Local Network permission for the Python venv.",
                        len(registered))
            except Exception:
                pass

        self._bonjour_cache = new_cache
        self._bonjour_cache_at = now

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
