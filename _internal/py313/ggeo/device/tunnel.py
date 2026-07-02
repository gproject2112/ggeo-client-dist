"""Device tunnel management — USB/WiFi tunnel with auto-reconnect."""

import asyncio
import logging
import sys
import time

from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.mobile_image_mounter import auto_mount
from pymobiledevice3.exceptions import (
    AlreadyMountedError,
    ConnectionFailedToUsbmuxdError,
    ConnectionTerminatedError,
    DeviceNotFoundError,
    MuxException,
    PyMobileDevice3Exception,
)
from pymobiledevice3.remote.tunnel_service import CoreDeviceTunnelProxy
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService

from ggeo.config import (
    FAST_RETRY_COUNT, FAST_RETRY_DELAY, MAX_BACKOFF, AUTO_MOUNT_TIMEOUT,
    MAX_DISCONNECT_TIME,
)
from ggeo.device.location import run_location_simulation

logger = logging.getLogger("ggeo.tunnel")

# All exceptions that should trigger reconnect instead of fatal stop
RECOVERABLE_ERRORS = (
    ConnectionError,
    OSError,
    ConnectionTerminatedError,
    DeviceNotFoundError,
    MuxException,
)

USBMUXD_RESTART_COOLDOWN = 60.0

# First-time pairing needs the user to unlock the phone and tap "Trust" —
# that regularly takes >10s. Absent devices still fail fast (usbmuxd raises
# DeviceNotFoundError immediately), so 30s only bites during real pairing.
LOCKDOWN_CONNECT_TIMEOUT = 30

_usbmuxd_last_restart: float = 0.0


async def run_device_session(session):
    """Main loop for a device session with auto-reconnect."""
    udid = session.udid
    backoff = 5
    fast_retry_count = 0

    while not session._should_stop:
        try:
            t0 = time.monotonic()
            session.connect_started_at = time.time()
            session.connect_duration = None
            session.is_simulating = False

            link_label = "[USB]" if session.connection_type == "USB" else "[WiFi]"

            # Try USB path
            usb_ok = False
            lockdown = None
            try:
                session.status = "connecting: usb"
                logger.info("[%s] %s Connecting...", session.name, link_label)
                lockdown = await asyncio.wait_for(
                    create_using_usbmux(serial=udid, autopair=True),
                    timeout=LOCKDOWN_CONNECT_TIMEOUT)
                usb_ok = True
                logger.info("[%s] %s Lockdown OK (%.1fs)",
                            session.name, link_label, time.monotonic() - t0)
                session._wifi_unreachable = False
                session._wifi_unreachable_count = 0
            except (DeviceNotFoundError, asyncio.TimeoutError, ConnectionError, OSError) as e:
                logger.info("[%s] %s Not available: %s",
                            session.name, link_label, type(e).__name__)

            # Auto-mount (only via USB, only once per device)
            if usb_ok and lockdown and not session._mount_done:
                await _ensure_ddi_mounted(session, lockdown, t0)

            # Try USB tunnel -> simulation
            if usb_ok and lockdown:
                try:
                    session.status = "connecting: tunnel"
                    logger.info("[%s] %s Starting tunnel...",
                                session.name, link_label)
                    await _run_usb_tunnel(lockdown, session)
                    if not session._should_stop:
                        session.status = "reconnecting"
                        backoff = 5
                        fast_retry_count = 0
                    continue
                except RECOVERABLE_ERRORS as e:
                    logger.info("[%s] %s Tunnel failed: %s",
                                session.name, link_label, type(e).__name__)

            # WiFi fallback (Network entry via usbmux)
            session.status = "connecting: wifi"
            session.connect_started_at = time.time()
            logger.info("[%s] [WiFi] Trying via usbmux Network...", session.name)
            lockdown_wifi = await asyncio.wait_for(
                create_using_usbmux(serial=udid, autopair=True),
                timeout=LOCKDOWN_CONNECT_TIMEOUT)
            await _run_usb_tunnel(lockdown_wifi, session)

            if not session._should_stop:
                session.status = "reconnecting"
                backoff = 5
                fast_retry_count = 0

        except RECOVERABLE_ERRORS as e:
            if session._should_stop:
                break
            session.is_simulating = False
            session.status = "reconnecting"
            session._retry_count = fast_retry_count + 1

            # Track when disconnection started
            if session._disconnect_started_at is None:
                session._disconnect_started_at = time.time()

            # Give up if reconnecting too long
            elapsed = time.time() - session._disconnect_started_at
            if elapsed > MAX_DISCONNECT_TIME:
                logger.warning("[%s] Gave up after %ds of reconnecting. Marking as disconnect.",
                               session.name, int(elapsed))
                session._gave_up = True
                session._should_stop = True
                break

            logger.warning("[%s] Connection lost (%s). Reconnecting... (%ds elapsed)",
                           session.name, type(e).__name__, int(elapsed))

            if (sys.platform == "win32"
                and session.connection_type == "Network"
                and isinstance(e, (DeviceNotFoundError, ConnectionFailedToUsbmuxdError))):
                session._wifi_unreachable_count = getattr(session, "_wifi_unreachable_count", 0) + 1
                if session._wifi_unreachable_count >= 3:
                    if not getattr(session, "_amds_restart_done", False):
                        session._amds_restart_done = True
                        ok = await _try_restart_amds()
                        if ok:
                            session._wifi_unreachable_count = 0
                        else:
                            session._wifi_unreachable = True
                    else:
                        session._wifi_unreachable = True

            if sys.platform == "darwin" and elapsed > 25:
                await maybe_restart_usbmuxd(source="reconnect-%s" % session.name)

            if fast_retry_count < FAST_RETRY_COUNT:
                fast_retry_count += 1
                logger.info("[%s] Fast retry %d/%d in %ds...",
                            session.name, fast_retry_count, FAST_RETRY_COUNT, FAST_RETRY_DELAY)
                await asyncio.sleep(FAST_RETRY_DELAY)
            else:
                delay = min(backoff, MAX_BACKOFF)
                logger.info("[%s] Backoff retry in %ds...", session.name, delay)
                await asyncio.sleep(delay)
                backoff = min(backoff * 2, MAX_BACKOFF)

        except PyMobileDevice3Exception as e:
            if session._should_stop:
                break
            session.is_simulating = False
            session.status = "reconnecting"
            session._retry_count += 1

            if session._disconnect_started_at is None:
                session._disconnect_started_at = time.time()
            elapsed = time.time() - session._disconnect_started_at
            if elapsed > MAX_DISCONNECT_TIME:
                logger.warning("[%s] Gave up after %ds. Marking as disconnect.",
                               session.name, int(elapsed))
                session._gave_up = True
                session._should_stop = True
                break

            logger.warning("[%s] Device error (%s). Reconnecting...", session.name, type(e).__name__)
            await asyncio.sleep(min(backoff, MAX_BACKOFF))
            backoff = min(backoff * 2, MAX_BACKOFF)

        except Exception as e:
            if session._should_stop:
                break
            session.is_simulating = False
            session.status = "error: %s" % str(e)
            logger.error("[%s] Fatal error: %s", session.name, e, exc_info=True)
            return

    session.status = "inactive"
    session.is_simulating = False
    session.spoof_started_at = None

    if session._gave_up and not session._deactivated_by_user:
        logger.info("[%s] Session gave up on reconnect.", session.name)
        _store = getattr(session, "_store", None)
        if _store and session._usage_id:
            try:
                await _store.record_deactivate(session._usage_id, end_reason="disconnect")
                logger.info("[%s] usage_session marked as disconnect.", session.name)
            except Exception as e:
                logger.warning("[%s] Failed to record disconnect: %s", session.name, e)

    logger.info("[%s] Session stopped.", session.name)


async def _ensure_ddi_mounted(session, lockdown, t0):
    """Attempt to auto-mount the developer disk image, once per device.

    Only marks the mount done on success or AlreadyMountedError. A timeout
    leaves `_mount_done` False so the caller retries on the next reconnect
    instead of treating a failed mount as permanent.
    """
    session.status = "connecting: mount"
    logger.info("[%s] Auto-mounting developer image...", session.name)
    try:
        await asyncio.wait_for(auto_mount(lockdown), timeout=AUTO_MOUNT_TIMEOUT)
        logger.info("[%s] Developer image mounted (%.1fs)", session.name, time.monotonic() - t0)
        session._mount_done = True
    except AlreadyMountedError:
        logger.info("[%s] Already mounted (%.1fs)", session.name, time.monotonic() - t0)
        session._mount_done = True
    except asyncio.TimeoutError:
        logger.warning("[%s] auto_mount timeout — will retry on next reconnect.",
                       session.name)


async def _run_usb_tunnel(lockdown, session):
    """Create tunnel via CoreDeviceTunnelProxy and run simulation."""
    try:
        proxy = await asyncio.wait_for(CoreDeviceTunnelProxy.create(lockdown), timeout=30)
        async with proxy.start_tcp_tunnel() as tunnel_result:
            async with RemoteServiceDiscoveryService(
                (tunnel_result.address, tunnel_result.port)
            ) as rsd:
                await run_location_simulation(rsd, session)
    except Exception as e:
        _log_wintun_hint_if_windows(e)
        raise


def _log_wintun_hint_if_windows(e: Exception):
    """Log hint if WinTUN driver is missing on Windows."""
    if sys.platform == "win32" and any(
        kw in str(e).lower()
        for kw in ("wintun", "tun", "tap", "driver", "interface", "pywintunx")
    ):
        logger.error(
            "Tunnel creation failed on Windows. "
            "WinTUN driver may not be installed. "
            "Re-run setup.py or: pip install pywintunx-pmd3 --upgrade"
        )


async def _try_restart_amds() -> bool:
    """Restart Apple Mobile Device Service (Windows only)."""
    if sys.platform != "win32":
        return False
    try:
        logger.info("AMDS restart: stop Apple Mobile Device Service")
        stop = await asyncio.create_subprocess_exec(
            "sc", "stop", "Apple Mobile Device Service",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(stop.wait(), timeout=10)
        except asyncio.TimeoutError:
            stop.kill()
            logger.warning("AMDS sc stop timeout, abort restart")
            return False
        if stop.returncode not in (0, 1062):
            logger.warning("AMDS sc stop returncode=%s, continue anyway",
                           stop.returncode)

        await asyncio.sleep(3)

        logger.info("AMDS restart: start Apple Mobile Device Service")
        start = await asyncio.create_subprocess_exec(
            "sc", "start", "Apple Mobile Device Service",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(start.wait(), timeout=10)
        except asyncio.TimeoutError:
            start.kill()
            logger.warning("AMDS sc start timeout")
            return False
        if start.returncode != 0:
            logger.warning("AMDS sc start returncode=%s", start.returncode)
            return False

        await asyncio.sleep(8)
        logger.info("AMDS restart complete")
        return True
    except Exception as e:
        logger.warning("AMDS restart failed: %s", e)
        return False


async def maybe_restart_usbmuxd(source: str = "unknown") -> bool:
    """Kill usbmuxd on macOS to refresh Bonjour cache (requires root)."""
    global _usbmuxd_last_restart
    now = time.time()
    if now - _usbmuxd_last_restart < USBMUXD_RESTART_COOLDOWN:
        logger.debug(
            "[%s] usbmuxd restart skipped (cooldown active, %.1fs left)",
            source,
            USBMUXD_RESTART_COOLDOWN - (now - _usbmuxd_last_restart),
        )
        return False
    try:
        pgrep_proc = await asyncio.create_subprocess_exec(
            "/usr/bin/pgrep", "usbmuxd",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(
                pgrep_proc.communicate(), timeout=3)
        except asyncio.TimeoutError:
            pgrep_proc.kill()
            logger.warning("[%s] pgrep usbmuxd timeout, skip restart", source)
            return False
        pid = stdout.decode().strip().split("\n")[0].strip()
        if not pid or not pid.isdigit():
            logger.warning("[%s] usbmuxd PID not found (pgrep output: %r), "
                           "skip restart", source, stdout[:50])
            return False
        logger.info("[%s] Restarting usbmuxd (PID %s) to refresh Network "
                    "entries (launchd will re-spawn)", source, pid)
        kill_proc = await asyncio.create_subprocess_exec(
            "/bin/kill", pid,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            rc = await asyncio.wait_for(kill_proc.wait(), timeout=3)
        except asyncio.TimeoutError:
            kill_proc.kill()
            logger.warning("[%s] kill usbmuxd timeout", source)
            return False
        if rc != 0:
            _usbmuxd_last_restart = now   # don't hammer a kill that can't work
            logger.warning(
                "[%s] kill usbmuxd failed (exit %s) — not running as root? "
                "Skipping restart.", source, rc)
            return False
        _usbmuxd_last_restart = now
        try:
            hup_proc = await asyncio.create_subprocess_exec(
                "/usr/bin/killall", "-HUP", "mDNSResponder",
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(hup_proc.wait(), timeout=3)
            logger.info("[%s] mDNSResponder HUP sent (refresh Bonjour cache)",
                        source)
        except asyncio.TimeoutError:
            logger.debug("[%s] mDNSResponder HUP timeout", source)
        except Exception as e:
            logger.debug("[%s] mDNSResponder HUP failed: %s", source, e)
        await asyncio.sleep(2)
        return True
    except Exception as e:
        logger.warning("[%s] usbmuxd restart failed: %s: %s",
                       source, type(e).__name__, e)
        return False
