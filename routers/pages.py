from fastapi import APIRouter
from fastapi.responses import FileResponse, HTMLResponse
from fastapi import Request
from config import templates
from paths import BASE_DIR

router = APIRouter()


@router.get("/sw.js")
async def service_worker():
    # Must be served from the origin root, not /static/sw.js — a service worker's default scope
    # is limited to its own directory, and /static/sw.js would never see /, /admin/*, etc.
    return FileResponse(
        str(BASE_DIR / "static" / "sw.js"),
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


@router.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "user": request.state.user})


@router.get("/index.html", response_class=HTMLResponse)
async def index_explicit(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "user": request.state.user})


@router.get("/map", response_class=HTMLResponse)
async def map_page(request: Request):
    return templates.TemplateResponse("map.html", {"request": request, "user": request.state.user})
