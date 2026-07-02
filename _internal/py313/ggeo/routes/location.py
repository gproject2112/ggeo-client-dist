"""Location API — set/clear GPS on an active local device session."""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ggeo.session import require_user

router = APIRouter(prefix="/api/location", tags=["location"])
logger = logging.getLogger("ggeo.routes.location")


def _mgr(request: Request):
    return request.app.state.device_manager


def _agent(request: Request):
    return request.app.state.sync_agent


async def _send_event(request: Request, event_type: str, payload: dict):
    try:
        await _agent(request).send_event(event_type, payload)
    except Exception:
        logger.exception("send_event %s failed (non-fatal)", event_type)


@router.post("/set")
async def set_location(request: Request):
    """Update coordinates on an already-active GPS session."""
    session = await require_user(request)
    body = await request.json()
    udid = body.get("udid")
    lat = body.get("lat") or body.get("latitude")
    lon = body.get("lon") or body.get("longitude") or body.get("long")

    if not udid:
        return JSONResponse(
            {"status": "error", "error": "MISSING_UDID", "message": "No UDID provided"},
            status_code=400)
    if lat is None or lon is None:
        return JSONResponse(
            {"status": "error", "error": "INVALID_COORDINATES", "message": "lat and lon required"},
            status_code=400)

    mgr = _mgr(request)
    sess = mgr.sessions.get(udid)
    if sess is None:
        return JSONResponse(
            {"status": "error", "error": "NO_ACTIVE_SESSION",
             "message": "No active GPS session for this device"},
            status_code=404)

    sess.lat = float(lat)
    sess.lon = float(lon)

    await _send_event(request, "location_set", {
        "user_id": session["user_id"],
        "device_udid": udid,
        "latitude": float(lat),
        "longitude": float(lon),
    })
    return {"status": "ok", "udid": udid, "lat": lat, "lon": lon}


@router.post("/clear")
async def clear_location(request: Request):
    """Request the active session stop (GPS will clear on exit)."""
    session = await require_user(request)
    body = await request.json()
    udid = body.get("udid")
    if not udid:
        return JSONResponse(
            {"status": "error", "error": "MISSING_UDID", "message": "No UDID provided"},
            status_code=400)

    mgr = _mgr(request)
    sess = mgr.sessions.get(udid)
    if sess is None:
        return JSONResponse(
            {"status": "error", "error": "NO_ACTIVE_SESSION",
             "message": "No active GPS session for this device"},
            status_code=404)

    sess._should_stop = True
    await _send_event(request, "session_deactivate", {
        "user_id": session["user_id"],
        "device_udid": udid,
        "end_reason": "user_clear",
    })
    return {"status": "ok", "udid": udid}
