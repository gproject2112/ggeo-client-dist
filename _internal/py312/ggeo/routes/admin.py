"""Client admin panel routes."""
import asyncio
import logging
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from pymobiledevice3.exceptions import AlreadyMountedError
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.mobile_image_mounter import auto_mount

from ggeo.config import AUTO_MOUNT_TIMEOUT, LOG_FILE
from ggeo.session import require_client_admin, require_user

router = APIRouter(tags=["admin"])
logger = logging.getLogger("ggeo.routes.admin")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
LOG_PATH = PROJECT_ROOT / LOG_FILE

LOG_TAIL_DEFAULT = 200
LOG_TAIL_MAX = 5000


def _agent(request: Request):
    return request.app.state.sync_agent


async def _forward(request: Request, method: str, path: str,
                   json: dict | None = None, params: dict | None = None):
    """Forward a request to ggeo-host /api/client/{path}."""
    agent = _agent(request)
    url = f"{agent.host_url}/api/client/{path.lstrip('/')}"
    try:
        resp = await agent.request(method, url, json=json, params=params)
    except httpx.RequestError as exc:
        logger.warning("forward %s %s failed: %s", method, url, exc)
        raise HTTPException(status_code=502, detail=f"host unreachable: {exc}")
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            detail = resp.text
        logger.warning(
            "forward %s %s -> %d: %s",
            method, url, resp.status_code, str(detail)[:500],
        )
        raise HTTPException(status_code=resp.status_code, detail=detail)
    return resp.json()


def _envelope(data):
    """Wrap data in API response envelope."""
    return {"status": "ok", "data": data}


# --- Page ------------------------------------------------------------------


@router.get("/admin")
async def admin_page(request: Request):
    await require_client_admin(request)
    return FileResponse(STATIC_DIR / "admin.html")


# --- Users -----------------------------------------------------------------


@router.get("/api/admin/users")
async def list_users(request: Request):
    await require_client_admin(request)
    host_response = await _forward(request, "GET", "users")
    return _envelope(host_response.get("users", []))


@router.post("/api/admin/users")
async def create_user(request: Request):
    await require_client_admin(request)
    body = await request.json()
    return _envelope(await _forward(request, "POST", "users", json=body))


@router.put("/api/admin/users/{user_id}")
async def update_user(request: Request, user_id: str):
    await require_client_admin(request)
    body = await request.json()
    return _envelope(await _forward(request, "PUT", f"users/{user_id}", json=body))


@router.delete("/api/admin/users/{user_id}")
async def delete_user(request: Request, user_id: str):
    await require_client_admin(request)
    return _envelope(await _forward(request, "DELETE", f"users/{user_id}"))


# --- Devices ---------------------------------------------------------------


@router.get("/api/admin/devices")
async def list_devices(request: Request):
    await require_client_admin(request)
    # PERF: only 1 forward to host (was gather(devices, users) — 2 forwards).
    # assigned_users mapping moved to frontend (uses Admin.users cache).
    devices_resp = await _forward(request, "GET", "devices")
    devices = devices_resp.get("devices", [])
    return _envelope(devices)


@router.get("/api/admin/devices/scan")
async def scan_unregistered_devices(request: Request):
    """Scan for devices not yet in the host's registered_devices."""
    await require_client_admin(request)
    mgr = request.app.state.device_manager
    discovered, _ = await mgr.discover()

    try:
        host_response = await _forward(request, "GET", "devices")
        registered_udids = {
            d["udid"] for d in host_response.get("devices", [])
            if d.get("udid")
        }
    except HTTPException as exc:
        logger.warning("fetch registered devices failed: %s", exc.detail)
        registered_udids = set()

    unregistered = [d for d in discovered if d["udid"] not in registered_udids]
    return _envelope(unregistered)


@router.post("/api/admin/devices")
async def register_device(request: Request):
    """Register a device on the host AND prep it for WiFi usage locally."""
    await require_client_admin(request)
    body = await request.json()
    udid = (body.get("udid") or "").strip()
    name = (body.get("name") or "").strip()
    if not udid or not name:
        raise HTTPException(
            status_code=400, detail="udid and name required",
        )

    mgr = request.app.state.device_manager
    discovered, _ = await mgr.discover()
    entry = next((d for d in discovered if d["udid"] == udid), None)
    is_usb = bool(entry and entry.get("connection") == "USB")

    model = (entry or {}).get("model")
    ios_version = (entry or {}).get("ios_version")
    wifi_enabled = False

    lockdown = None
    if is_usb:
        try:
            lockdown = await asyncio.wait_for(
                create_using_usbmux(serial=udid, autopair=True), timeout=10,
            )
            info = lockdown.short_info
            model = info.get("ProductType", model)
            ios_version = info.get("ProductVersion", ios_version)
            try:
                await asyncio.wait_for(auto_mount(lockdown), timeout=AUTO_MOUNT_TIMEOUT)
                logger.info("auto_mount OK for %s", udid[:12])
            except AlreadyMountedError:
                logger.info("auto_mount already mounted for %s", udid[:12])
            except asyncio.TimeoutError:
                logger.warning(
                    "auto_mount timeout for %s during register; "
                    "continuing without DDI (will retry on GPS activate)",
                    udid[:12],
                )
            except Exception as exc:
                logger.warning(
                    "auto_mount failed for %s during register: %s; "
                    "continuing without DDI",
                    udid[:12], exc,
                )
            try:
                await lockdown.set_value(
                    True,
                    domain="com.apple.mobile.wireless_lockdown",
                    key="EnableWifiConnections",
                )
                await lockdown.unpair()
                await lockdown.pair()
                wifi_enabled = True
                logger.info("WiFi enabled and re-paired for %s", udid[:12])
            except Exception as exc:
                logger.warning(
                    "WiFi setup failed for %s: %s -- USB only",
                    udid[:12], exc,
                )
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("lockdown setup failed for %s", udid[:12])
            raise HTTPException(
                status_code=500,
                detail=f"Device not accessible: {exc}",
            )
        finally:
            if lockdown is not None:
                try:
                    await lockdown.close()
                except Exception:
                    pass

    host_body = {
        "udid": udid,
        "name": name,
        "model": model,
        "ios_version": ios_version,
        "wifi_connections_enabled": wifi_enabled,
    }
    return _envelope(await _forward(request, "POST", "devices", json=host_body))


@router.put("/api/admin/devices/{device_id}")
async def update_device(request: Request, device_id: str):
    await require_client_admin(request)
    body = await request.json()
    return _envelope(await _forward(request, "PUT", f"devices/{device_id}", json=body))


@router.delete("/api/admin/devices/{device_id}")
async def delete_device(request: Request, device_id: str):
    await require_client_admin(request)
    return _envelope(await _forward(request, "DELETE", f"devices/{device_id}"))


# --- User-Locations -----------------------------------------


@router.get("/api/admin/users/{user_id}/locations")
async def list_user_locations(request: Request, user_id: str):
    await require_client_admin(request)
    host_response = await _forward(request, "GET", f"users/{user_id}/locations")
    return _envelope(host_response.get("locations", []))


@router.post("/api/admin/user-locations")
async def assign_user_location(request: Request):
    await require_client_admin(request)
    body = await request.json()
    return _envelope(await _forward(request, "POST", "user-locations", json=body))


@router.delete("/api/admin/user-locations/{user_id}/{location_id}")
async def unassign_user_location(request: Request, user_id: str, location_id: str):
    await require_client_admin(request)
    return _envelope(
        await _forward(request, "DELETE", f"user-locations/{user_id}/{location_id}")
    )


# --- History forwards --------------------------


@router.get("/api/admin/sessions/history")
async def admin_session_history(request: Request):
    await require_client_admin(request)
    params = {k: v for k, v in request.query_params.items()}
    host_resp = await _forward(
        request, "GET", "sessions/history", params=params,
    )
    return {"status": "ok", "data": host_resp.get("items", []),
            "total": host_resp.get("total", 0),
            "page": host_resp.get("page", 1),
            "per_page": host_resp.get("per_page", 20)}


@router.get("/api/admin/login-history")
async def admin_login_history(request: Request):
    await require_client_admin(request)
    params = {k: v for k, v in request.query_params.items()}
    host_resp = await _forward(
        request, "GET", "login-history", params=params,
    )
    return {"status": "ok", "data": host_resp.get("items", []),
            "total": host_resp.get("total", 0),
            "page": host_resp.get("page", 1),
            "per_page": host_resp.get("per_page", 20)}


@router.delete("/api/admin/sessions/history/{session_id}")
async def admin_session_history_delete_one(request: Request, session_id: str):
    await require_client_admin(request)
    return _envelope(await _forward(
        request, "DELETE", f"sessions/history/{session_id}",
    ))


@router.delete("/api/admin/sessions/history")
async def admin_session_history_delete_all(request: Request):
    await require_client_admin(request)
    return _envelope(await _forward(
        request, "DELETE", "sessions/history",
    ))


@router.delete("/api/admin/login-history/{login_id}")
async def admin_login_history_delete_one(request: Request, login_id: str):
    await require_client_admin(request)
    return _envelope(await _forward(
        request, "DELETE", f"login-history/{login_id}",
    ))


@router.delete("/api/admin/login-history")
async def admin_login_history_delete_all(request: Request):
    await require_client_admin(request)
    return _envelope(await _forward(
        request, "DELETE", "login-history",
    ))


# --- Locations -------------------------------------------------------------


@router.get("/api/admin/locations")
async def list_locations(request: Request):
    await require_client_admin(request)
    host_response = await _forward(request, "GET", "locations")
    return _envelope(
        list(host_response.get("universal", []))
        + list(host_response.get("per_client", []))
    )


@router.post("/api/admin/locations")
async def create_location(request: Request):
    await require_client_admin(request)
    body = await request.json()
    return _envelope(await _forward(request, "POST", "locations", json=body))


@router.put("/api/admin/locations/{location_id}")
async def update_location(request: Request, location_id: str):
    await require_client_admin(request)
    body = await request.json()
    return _envelope(await _forward(request, "PUT", f"locations/{location_id}", json=body))


@router.delete("/api/admin/locations/{location_id}")
async def delete_location(request: Request, location_id: str):
    await require_client_admin(request)
    return _envelope(await _forward(request, "DELETE", f"locations/{location_id}"))


# --- Local GPS session monitor ---------------------------------------------


@router.get("/api/admin/sessions")
async def list_active_sessions(request: Request):
    await require_client_admin(request)
    mgr = request.app.state.device_manager

    try:
        locs_resp = await _forward(request, "GET", "locations")
        locations = locs_resp.get("locations", [])
    except HTTPException as exc:
        logger.warning("fetch locations failed: %s", exc.detail)
        locations = []

    sessions = []
    for udid, sess in list(mgr.sessions.items()):
        lat = getattr(sess, "lat", None)
        lon = getattr(sess, "lon", None)
        location_name = None
        if lat is not None and lon is not None:
            for loc in locations:
                loc_lat = loc.get("latitude")
                loc_lon = loc.get("longitude")
                if loc_lat is None or loc_lon is None:
                    continue
                if (abs(float(loc_lat) - float(lat)) < 1e-5
                        and abs(float(loc_lon) - float(lon)) < 1e-5):
                    location_name = loc.get("name")
                    break
        sessions.append({
            "udid": udid,
            "name": getattr(sess, "name", udid[:12]),
            "status": getattr(sess, "status", "unknown"),
            "lat": lat,
            "lon": lon,
            "is_simulating": getattr(sess, "is_simulating", False),
            "spoof_started_at": getattr(sess, "spoof_started_at", None),
            "location_name": location_name,
        })
    return _envelope(sessions)


@router.post("/api/admin/sessions/{udid}/kill")
async def kill_session(request: Request, udid: str):
    """Kill a specific session locally; emit deactivate event to host."""
    session = await require_client_admin(request)
    mgr = request.app.state.device_manager
    if udid not in mgr.sessions:
        raise HTTPException(status_code=404, detail="session not found")
    sess = mgr.sessions[udid]
    sess._should_stop = True
    try:
        await _agent(request).send_event("session_deactivate", {
            "device_udid": udid,
            "end_reason": "client_admin",
            "killed_by_user_id": session.get("user_id"),
        })
    except Exception:
        pass
    return _envelope({"killed": True})


@router.post("/api/admin/sessions/kill-all")
async def kill_all_sessions(request: Request):
    session = await require_client_admin(request)
    mgr = request.app.state.device_manager
    udids = list(mgr.sessions.keys())
    for udid in udids:
        sess = mgr.sessions.get(udid)
        if sess:
            sess._should_stop = True
    try:
        await _agent(request).send_event("session_deactivate_all", {
            "device_udids": udids,
            "killed_by_user_id": session.get("user_id"),
        })
    except Exception:
        pass
    return _envelope({"count": len(udids)})


# --- Host status snapshot (for UI limit bars + offline banner) -------------


@router.get("/api/admin/host-status")
async def host_status(request: Request):
    await require_user(request)
    status = request.app.state.host_status
    return _envelope(status.to_dict())


# --- Log viewer -----------------------------------------------------------


@router.get("/api/admin/logs")
async def get_logs(request: Request, tail: int = LOG_TAIL_DEFAULT):
    await require_client_admin(request)
    n = max(1, min(int(tail), LOG_TAIL_MAX))

    if not LOG_PATH.is_file():
        return _envelope({"lines": [], "total": 0, "path": str(LOG_PATH)})

    try:
        with LOG_PATH.open("r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
        lines = all_lines[-n:] if n < len(all_lines) else all_lines
        return _envelope({
            "lines": [line.rstrip("\n") for line in lines],
            "total": len(all_lines),
            "path": str(LOG_PATH),
        })
    except OSError as exc:
        logger.warning("log read failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"log read failed: {exc}")


@router.delete("/api/admin/logs")
async def truncate_logs(request: Request):
    await require_client_admin(request)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        LOG_PATH.write_text("", encoding="utf-8")
        logger.info("log file truncated")
        return _envelope({"ok": True})
    except OSError as exc:
        logger.warning("log truncate failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"log truncate failed: {exc}")
