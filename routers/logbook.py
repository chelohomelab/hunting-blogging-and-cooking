from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session
from typing import Optional

import database as models
from config import templates
from dependencies import get_db, save_uploaded_file, save_uploaded_video, delete_uploaded_file
from schemas import HuntLogEntryIn

router = APIRouter()

GAME_TYPES = ["Deer", "Black Bear", "Elk", "Turkey", "Upland Birds", "Small Game", "Migratory Birds", "Trapping"]


def _media_dict(m: models.HuntLogMedia) -> dict:
    return {"id": m.id, "media_type": m.media_type, "file_path": m.file_path, "caption": m.caption}


def _entry_dict(e: models.HuntLogEntry) -> dict:
    return {
        "id": e.id,
        "hunt_date": e.hunt_date,
        "location_label": e.location_label,
        "latitude": e.latitude,
        "longitude": e.longitude,
        "game_type": e.game_type,
        "species": e.species,
        "weapon": e.weapon,
        "weather_temp_f": e.weather_temp_f,
        "weather_conditions": e.weather_conditions,
        "wind_direction": e.wind_direction,
        "wind_speed_mph": e.wind_speed_mph,
        "moon_phase": e.moon_phase,
        "harvested": e.harvested,
        "harvest_notes": e.harvest_notes,
        "narrative": e.narrative,
        "created_at": e.created_at,
        "updated_at": e.updated_at,
        "media": [_media_dict(m) for m in e.media],
    }


# ── Pages ────────────────────────────────────────────────────────────────────

@router.get("/logbook", response_class=HTMLResponse)
async def logbook_page(request: Request):
    return templates.TemplateResponse("logbook.html", {
        "request": request, "user": request.state.user,
    })


@router.get("/logbook/new", response_class=HTMLResponse)
async def logbook_new_page(request: Request):
    return templates.TemplateResponse("logbook_form.html", {
        "request": request, "user": request.state.user, "entry_id": None, "game_types": GAME_TYPES,
    })


@router.get("/logbook/{entry_id}/edit", response_class=HTMLResponse)
async def logbook_edit_page(entry_id: int, request: Request):
    return templates.TemplateResponse("logbook_form.html", {
        "request": request, "user": request.state.user, "entry_id": entry_id, "game_types": GAME_TYPES,
    })


# ── API — scoped to the signed-in user throughout (tenant-ready: see docs/VISION.md) ──────────

@router.get("/api/logbook")
def list_entries(request: Request, db: Session = Depends(get_db)):
    entries = db.query(models.HuntLogEntry).filter(
        models.HuntLogEntry.user_id == request.state.user.id
    ).order_by(models.HuntLogEntry.hunt_date.desc(), models.HuntLogEntry.id.desc()).all()
    return [_entry_dict(e) for e in entries]


@router.get("/api/logbook/{entry_id}")
def get_entry(entry_id: int, request: Request, db: Session = Depends(get_db)):
    e = db.query(models.HuntLogEntry).filter(
        models.HuntLogEntry.id == entry_id, models.HuntLogEntry.user_id == request.state.user.id
    ).first()
    if not e:
        raise HTTPException(404, "Not found")
    return _entry_dict(e)


@router.post("/api/logbook")
def create_entry(payload: HuntLogEntryIn, request: Request, db: Session = Depends(get_db)):
    now = datetime.utcnow().isoformat() + "Z"
    e = models.HuntLogEntry(user_id=request.state.user.id, created_at=now, **payload.model_dump())
    db.add(e)
    db.commit()
    db.refresh(e)
    return _entry_dict(e)


@router.put("/api/logbook/{entry_id}")
def update_entry(entry_id: int, payload: HuntLogEntryIn, request: Request, db: Session = Depends(get_db)):
    e = db.query(models.HuntLogEntry).filter(
        models.HuntLogEntry.id == entry_id, models.HuntLogEntry.user_id == request.state.user.id
    ).first()
    if not e:
        raise HTTPException(404, "Not found")
    for field, value in payload.model_dump().items():
        setattr(e, field, value)
    e.updated_at = datetime.utcnow().isoformat() + "Z"
    db.commit()
    db.refresh(e)
    return _entry_dict(e)


@router.delete("/api/logbook/{entry_id}")
def delete_entry(entry_id: int, request: Request, db: Session = Depends(get_db)):
    e = db.query(models.HuntLogEntry).filter(
        models.HuntLogEntry.id == entry_id, models.HuntLogEntry.user_id == request.state.user.id
    ).first()
    if not e:
        raise HTTPException(404, "Not found")
    for m in e.media:
        delete_uploaded_file(m.file_path)
    db.delete(e)  # cascades to hunt_log_media rows
    db.commit()
    return {"deleted": entry_id}


# ── Media — online-only (see HuntLogMedia's comment in database.py) ───────────────────────────

@router.post("/api/logbook/{entry_id}/media")
async def upload_media(
    entry_id: int, request: Request, db: Session = Depends(get_db),
    file: UploadFile = File(...), caption: Optional[str] = Form(default=None),
):
    e = db.query(models.HuntLogEntry).filter(
        models.HuntLogEntry.id == entry_id, models.HuntLogEntry.user_id == request.state.user.id
    ).first()
    if not e:
        raise HTTPException(404, "Not found")

    is_video = (file.content_type or "").startswith("video/")
    try:
        if is_video:
            path = await save_uploaded_video(file, f"hunt{entry_id}")
        else:
            path = await save_uploaded_file(file, f"hunt{entry_id}")
    except ValueError as exc:
        raise HTTPException(413, str(exc))
    if not path:
        raise HTTPException(400, "No file provided")

    m = models.HuntLogMedia(
        entry_id=entry_id, user_id=request.state.user.id,
        media_type="video" if is_video else "photo",
        file_path=path, caption=caption,
        created_at=datetime.utcnow().isoformat() + "Z",
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return _media_dict(m)


@router.delete("/api/logbook/{entry_id}/media/{media_id}")
def delete_media(entry_id: int, media_id: int, request: Request, db: Session = Depends(get_db)):
    m = db.query(models.HuntLogMedia).filter(
        models.HuntLogMedia.id == media_id,
        models.HuntLogMedia.entry_id == entry_id,
        models.HuntLogMedia.user_id == request.state.user.id,
    ).first()
    if not m:
        raise HTTPException(404, "Not found")
    delete_uploaded_file(m.file_path)
    db.delete(m)
    db.commit()
    return {"deleted": media_id}
