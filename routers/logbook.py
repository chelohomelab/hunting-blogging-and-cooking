from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session
from typing import Optional

import database as models
from config import templates
from dependencies import get_db, save_uploaded_file, save_uploaded_video, delete_uploaded_file
from schemas import HuntLogEntryIn, HuntLogDayIn, HuntTripUpdateIn

router = APIRouter()

GAME_TYPES = ["Deer", "Black Bear", "Elk", "Turkey", "Upland Birds", "Small Game", "Migratory Birds", "Trapping"]


def _media_dict(m: models.HuntLogMedia) -> dict:
    return {"id": m.id, "media_type": m.media_type, "file_path": m.file_path, "caption": m.caption}


def _day_dict(d: models.HuntLogDay) -> dict:
    return {
        "id": d.id,
        "hunt_date": d.hunt_date,
        "location_label": d.location_label,
        "latitude": d.latitude,
        "longitude": d.longitude,
        "weather_temp_f": d.weather_temp_f,
        "weather_conditions": d.weather_conditions,
        "wind_direction": d.wind_direction,
        "wind_speed_mph": d.wind_speed_mph,
        "moon_phase": d.moon_phase,
        "harvested": d.harvested,
        "harvest_notes": d.harvest_notes,
        "narrative": d.narrative,
        "created_at": d.created_at,
        "updated_at": d.updated_at,
        "media": [_media_dict(m) for m in d.media],
    }


def _entry_dict(e: models.HuntLogEntry) -> dict:
    # Whether this is a "trip" entry is based on having day rows, not on scheduled_hunt_id —
    # deleting a ScheduledHunt detaches its entry (sets scheduled_hunt_id to null) rather than
    # deleting the log, and that entry needs to keep behaving as a multi-day entry afterward
    # since its days (and their harvest/media) are still real logged data.
    is_trip = len(e.days) > 0
    return {
        "id": e.id,
        "scheduled_hunt_id": e.scheduled_hunt_id,
        "scheduled_hunt": {
            "id": e.scheduled_hunt.id, "label": e.scheduled_hunt.label,
            "start_date": e.scheduled_hunt.start_date, "end_date": e.scheduled_hunt.end_date,
        } if e.scheduled_hunt else None,
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
        # For a trip entry the flat harvested/harvest_notes columns go unused — whether the trip
        # produced a harvest is derived from its days so it can never drift out of sync with them.
        "harvested": (any(d.harvested for d in e.days) if is_trip else e.harvested),
        "harvest_notes": e.harvest_notes,
        "narrative": e.narrative,
        "created_at": e.created_at,
        "updated_at": e.updated_at,
        # Day-scoped photos live under days[].media instead — excluded here so they don't show
        # twice (this also means a plain non-trip entry's media list is completely unaffected,
        # since none of its media ever has a day_id).
        "media": [_media_dict(m) for m in e.media if m.day_id is None],
        "days": [_day_dict(d) for d in e.days] if is_trip else [],
        "day_count": len(e.days) if is_trip else 0,
    }


def _get_owned_entry(entry_id: int, user_id: int, db: Session) -> models.HuntLogEntry:
    e = db.query(models.HuntLogEntry).filter(
        models.HuntLogEntry.id == entry_id, models.HuntLogEntry.user_id == user_id
    ).first()
    if not e:
        raise HTTPException(404, "Not found")
    return e


def _get_owned_day(entry_id: int, day_id: int, user_id: int, db: Session) -> models.HuntLogDay:
    d = db.query(models.HuntLogDay).filter(
        models.HuntLogDay.id == day_id, models.HuntLogDay.entry_id == entry_id,
        models.HuntLogDay.user_id == user_id,
    ).first()
    if not d:
        raise HTTPException(404, "Not found")
    return d


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


@router.get("/logbook/{entry_id}", response_class=HTMLResponse)
async def logbook_view_page(entry_id: int, request: Request):
    return templates.TemplateResponse("logbook_view.html", {
        "request": request, "user": request.state.user, "entry_id": entry_id,
    })


@router.get("/logbook/{entry_id}/edit", response_class=HTMLResponse)
async def logbook_edit_page(entry_id: int, request: Request):
    return templates.TemplateResponse("logbook_form.html", {
        "request": request, "user": request.state.user, "entry_id": entry_id, "game_types": GAME_TYPES,
    })


@router.get("/logbook/trip/{entry_id}", response_class=HTMLResponse)
async def logbook_trip_view_page(entry_id: int, request: Request):
    return templates.TemplateResponse("logbook_trip_view.html", {
        "request": request, "user": request.state.user, "entry_id": entry_id,
    })


@router.get("/logbook/trip/{entry_id}/edit", response_class=HTMLResponse)
async def logbook_trip_edit_page(entry_id: int, request: Request):
    return templates.TemplateResponse("logbook_trip_form.html", {
        "request": request, "user": request.state.user, "entry_id": entry_id,
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


# ── Trip entries — days within a scheduled-hunt-linked entry (see database.py's docstrings) ────

@router.put("/api/logbook/{entry_id}/trip")
def update_trip(entry_id: int, payload: HuntTripUpdateIn, request: Request, db: Session = Depends(get_db)):
    # No scheduled_hunt_id requirement here — an entry whose ScheduledHunt was later deleted
    # (detached, not deleted itself, see delete_scheduled_hunt) still has real days and keeps
    # being managed as a trip.
    e = _get_owned_entry(entry_id, request.state.user.id, db)
    for field, value in payload.model_dump().items():
        setattr(e, field, value)
    e.updated_at = datetime.utcnow().isoformat() + "Z"
    db.commit()
    db.refresh(e)
    return _entry_dict(e)


@router.post("/api/logbook/{entry_id}/days")
def add_day(entry_id: int, payload: HuntLogDayIn, request: Request, db: Session = Depends(get_db)):
    e = _get_owned_entry(entry_id, request.state.user.id, db)
    now = datetime.utcnow().isoformat() + "Z"
    d = models.HuntLogDay(entry_id=entry_id, user_id=request.state.user.id, created_at=now, **payload.model_dump())
    db.add(d)
    db.commit()
    db.refresh(d)
    return _day_dict(d)


@router.put("/api/logbook/{entry_id}/days/{day_id}")
def update_day(entry_id: int, day_id: int, payload: HuntLogDayIn, request: Request, db: Session = Depends(get_db)):
    d = _get_owned_day(entry_id, day_id, request.state.user.id, db)
    for field, value in payload.model_dump().items():
        setattr(d, field, value)
    d.updated_at = datetime.utcnow().isoformat() + "Z"
    db.commit()
    db.refresh(d)
    return _day_dict(d)


@router.delete("/api/logbook/{entry_id}/days/{day_id}")
def delete_day(entry_id: int, day_id: int, request: Request, db: Session = Depends(get_db)):
    d = _get_owned_day(entry_id, day_id, request.state.user.id, db)
    for m in d.media:
        delete_uploaded_file(m.file_path)
    db.delete(d)  # cascades to this day's hunt_log_media rows
    db.commit()
    return {"deleted": day_id}


@router.post("/api/logbook/{entry_id}/days/{day_id}/media")
async def upload_day_media(
    entry_id: int, day_id: int, request: Request, db: Session = Depends(get_db),
    file: UploadFile = File(...), caption: Optional[str] = Form(default=None),
):
    d = _get_owned_day(entry_id, day_id, request.state.user.id, db)

    is_video = (file.content_type or "").startswith("video/")
    try:
        if is_video:
            path = await save_uploaded_video(file, f"hunt{entry_id}day{day_id}")
        else:
            path = await save_uploaded_file(file, f"hunt{entry_id}day{day_id}")
    except ValueError as exc:
        raise HTTPException(413, str(exc))
    if not path:
        raise HTTPException(400, "No file provided")

    m = models.HuntLogMedia(
        entry_id=entry_id, day_id=day_id, user_id=request.state.user.id,
        media_type="video" if is_video else "photo",
        file_path=path, caption=caption,
        created_at=datetime.utcnow().isoformat() + "Z",
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return _media_dict(m)


@router.delete("/api/logbook/{entry_id}/days/{day_id}/media/{media_id}")
def delete_day_media(entry_id: int, day_id: int, media_id: int, request: Request, db: Session = Depends(get_db)):
    m = db.query(models.HuntLogMedia).filter(
        models.HuntLogMedia.id == media_id,
        models.HuntLogMedia.entry_id == entry_id,
        models.HuntLogMedia.day_id == day_id,
        models.HuntLogMedia.user_id == request.state.user.id,
    ).first()
    if not m:
        raise HTTPException(404, "Not found")
    delete_uploaded_file(m.file_path)
    db.delete(m)
    db.commit()
    return {"deleted": media_id}
