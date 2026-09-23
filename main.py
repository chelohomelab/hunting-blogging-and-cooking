import os
from datetime import datetime

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

import database as models
from config import UPLOAD_DIR, templates
from paths import BASE_DIR
from routers import auth, pages, admin, backup, upgrade, hunting, logbook, recipes, scheduled_hunts

app = FastAPI(title="Hunting, Blogging and Cooking")


class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if "text/html" in response.headers.get("content-type", ""):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response


class AuthMiddleware(BaseHTTPMiddleware):
    # /sw.js is exempt so the browser's periodic background service-worker update check never
    # gets redirected to /login HTML if the session happens to be expired at that moment — a
    # redirected response isn't valid JS and would break the service worker's own update.
    _PUBLIC = {"/login", "/setup", "/sw.js"}

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path in self._PUBLIC or path.startswith("/static/"):
            return await call_next(request)

        token = request.cookies.get("session")
        if not token:
            return RedirectResponse("/login", status_code=302)

        db = models.SessionLocal()
        try:
            sess = db.query(models.UserSession).filter(models.UserSession.token == token).first()
            now = datetime.utcnow()
            if not sess or datetime.fromisoformat(sess.expires_at) < now:
                if sess:
                    db.delete(sess)
                    db.commit()
                resp = RedirectResponse("/login", status_code=302)
                resp.delete_cookie("session")
                return resp
            user = db.query(models.User).filter(models.User.id == sess.user_id).first()
            if not user or not user.is_active:
                db.delete(sess)
                db.commit()
                resp = RedirectResponse("/login", status_code=302)
                resp.delete_cookie("session")
                return resp
            db.expunge(user)
            request.state.user = user
        finally:
            db.close()

        return await call_next(request)


app.add_middleware(NoCacheMiddleware)
app.add_middleware(AuthMiddleware)
models.init_db()
os.makedirs(UPLOAD_DIR, exist_ok=True)
# Registered before the broader "/static" mount below — Starlette matches mounts in
# registration order, and uploads (user data, under DATA_DIR) need to win over the bundled
# app assets mount even though they're nested under the same "/static" URL prefix. For every
# deployment where BASE_DIR == DATA_DIR (source/dev, current systemd/LXC, current Docker) this
# split is physically inert — both mounts point at the same nested folders a single mount would.
app.mount("/static/uploads", StaticFiles(directory=UPLOAD_DIR), name="static-uploads")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

app.include_router(auth.router)
app.include_router(pages.router)
app.include_router(admin.router)
app.include_router(backup.router)
app.include_router(upgrade.router)
app.include_router(hunting.router)
app.include_router(logbook.router)
app.include_router(recipes.router)
app.include_router(scheduled_hunts.router)

# Global (not per-request context) — every template rendered through this Jinja2Templates
# instance sees it automatically, so the nav templates can gate the "Upgrade" link without
# threading a new kwarg through every TemplateResponse(...) call site that renders them.
templates.env.globals["upgrade_available"] = upgrade.GIT_AVAILABLE
