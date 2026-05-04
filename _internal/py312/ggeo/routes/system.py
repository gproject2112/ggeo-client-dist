"""System health endpoint."""
import asyncio
import logging
import sys
import time

from fastapi import APIRouter, Request

from ggeo.session import require_client_admin

router = APIRouter(tags=["system"])
logger = logging.getLogger("ggeo.routes.system")

IS_MACOS = sys.platform == "darwin"
IS_WINDOWS = sys.platform == "win32"

HEARTBEAT_OK_MAX = 15.0
HEARTBEAT_SLOW_MAX = 60.0
PROBE_TIMEOUT = 3.0


async def _run_subprocess(cmd: list[str], timeout: float = PROBE_TIMEOUT) -> tuple[int, str]:
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        rc = proc.returncode if proc.returncode is not None else 1
        return rc, stdout.decode("utf-8", errors="replace")
    except asyncio.TimeoutError:
        await _kill_proc(proc)
        return 124, ""
    except FileNotFoundError:
        return 127, ""
    except Exception as exc:  # noqa: BLE001
        logger.warning("subprocess %s failed: %s", cmd, exc)
        await _kill_proc(proc)
        return 1, ""


async def _kill_proc(proc: asyncio.subprocess.Process | None) -> None:
    if proc is None or proc.returncode is not None:
        return
    try:
        proc.kill()
        await proc.wait()
    except ProcessLookupError:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("kill subprocess failed: %s", exc)


async def _check_pgrep(name: str) -> str:
    rc, _ = await _run_subprocess(["pgrep", name])
    return "ok" if rc == 0 else "error"


async def _check_sc_query(service: str) -> str:
    rc, out = await _run_subprocess(["sc", "query", service])
    if rc != 0:
        return "error"
    return "ok" if "RUNNING" in out else "error"


def _heartbeat_status(age_seconds: float | None) -> str:
    if age_seconds is None:
        return "error"
    if age_seconds <= HEARTBEAT_OK_MAX:
        return "ok"
    if age_seconds <= HEARTBEAT_SLOW_MAX:
        return "slow"
    return "error"


def _tunnel_status(active_count: int) -> str:
    return "ok" if active_count > 0 else "idle"


@router.get("/api/system-health")
async def system_health(request: Request):
    await require_client_admin(request)

    host_status = getattr(request.app.state, "host_status", None)
    last_hb = host_status.last_heartbeat if host_status else 0.0
    hb_age_seconds = (time.time() - last_hb) if last_hb else None

    mgr = getattr(request.app.state, "device_manager", None)
    if mgr is not None:
        active_count = sum(
            1 for s in mgr.sessions.values() if getattr(s, "is_simulating", False)
        )
    else:
        active_count = 0

    if IS_MACOS:
        platform_key = "darwin"
        usbmuxd_status, mdns_status = await asyncio.gather(
            _check_pgrep("usbmuxd"),
            _check_pgrep("mDNSResponder"),
        )
        rows = [
            {"key": "usbmuxd", "label": "usbmuxd", "status": usbmuxd_status},
            {"key": "mdns", "label": "mDNSResponder", "status": mdns_status},
            {"key": "host_sync", "label": "Host sync",
             "status": _heartbeat_status(hb_age_seconds)},
            {"key": "tunnel", "label": "Tunnel",
             "status": _tunnel_status(active_count)},
        ]
    elif IS_WINDOWS:
        platform_key = "win32"
        amds_status, bonjour_status = await asyncio.gather(
            _check_sc_query("Apple Mobile Device Service"),
            _check_sc_query("Bonjour Service"),
        )
        rows = [
            {"key": "amds", "label": "Apple Mobile Device",
             "status": amds_status},
            {"key": "bonjour", "label": "Bonjour Service",
             "status": bonjour_status},
            {"key": "host_sync", "label": "Host sync",
             "status": _heartbeat_status(hb_age_seconds)},
            {"key": "tunnel", "label": "Tunnel",
             "status": _tunnel_status(active_count)},
        ]
    else:
        platform_key = sys.platform
        rows = [
            {"key": "host_sync", "label": "Host sync",
             "status": _heartbeat_status(hb_age_seconds)},
            {"key": "tunnel", "label": "Tunnel",
             "status": _tunnel_status(active_count)},
        ]

    return {
        "platform": platform_key,
        "rows": rows,
        "last_heartbeat_ago_seconds": (
            round(hb_age_seconds, 1) if hb_age_seconds is not None else None
        ),
        "active_sessions": active_count,
    }
