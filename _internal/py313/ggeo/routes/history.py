"""User history — forwards to /api/client/history."""
import logging

import httpx
from fastapi import APIRouter, HTTPException, Request

from ggeo.session import require_user

router = APIRouter(tags=["history"])
logger = logging.getLogger("ggeo.routes.history")


@router.get("/api/history")
async def history(request: Request):
    """Forward host history with pagination envelope."""
    session = await require_user(request)
    page = int(request.query_params.get("page", "1") or 1)
    limit = int(request.query_params.get("limit", "5") or 5)
    agent = request.app.state.sync_agent
    try:
        resp = await agent.get(
            f"{agent.host_url}/api/client/history",
            params={"user_id": session["user_id"]},
        )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"host unreachable: {exc}")
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    payload = resp.json()
    items = payload.get("history", []) if isinstance(payload, dict) else []
    total = len(items)
    start = max(0, (page - 1) * limit)
    end = start + limit
    return {
        "status": "ok",
        "data": items[start:end],
        "total": total,
        "page": page,
        "limit": limit,
    }
