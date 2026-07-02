"""Preset routes — forward to /api/client/presets."""
import logging

import httpx
from fastapi import APIRouter, HTTPException, Request

from ggeo.session import require_user

router = APIRouter(tags=["presets"])
logger = logging.getLogger("ggeo.routes.presets")


async def _forward(request, method, path, json=None, params=None):
    agent = request.app.state.sync_agent
    url = f"{agent.host_url}/api/client/{path}"
    try:
        resp = await agent.request(method, url, json=json, params=params)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"host unreachable: {exc}")
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    return resp.json()


def _envelope(data):
    """Wrap host response in API envelope."""
    return {"status": "ok", "data": data}


@router.get("/api/presets")
async def list_presets(request: Request):
    session = await require_user(request)
    host_resp = await _forward(request, "GET", "presets",
                               params={"user_id": session["user_id"]})
    return _envelope(host_resp.get("presets", []))


@router.post("/api/presets")
async def create_preset(request: Request):
    session = await require_user(request)
    body = await request.json()
    body["user_id"] = session["user_id"]
    if "lat" in body and "latitude" not in body:
        body["latitude"] = body.pop("lat")
    if "lon" in body and "longitude" not in body:
        body["longitude"] = body.pop("lon")
    return _envelope(await _forward(request, "POST", "presets", json=body))


@router.delete("/api/presets/{preset_id}")
async def delete_preset(request: Request, preset_id: str):
    await require_user(request)
    return _envelope(
        await _forward(request, "DELETE", f"presets/{preset_id}")
    )
