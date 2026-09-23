from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import database as models
from dependencies import get_db
from schemas import ScheduledHuntIn

router = APIRouter()


def _scheduled_hunt_dict(s: models.ScheduledHunt) -> dict:
    log_entry = s.log_entries[0] if s.log_entries else None
    return {
        "id": s.id,
        "label": s.label,
        "state": s.state,
        "game_type": s.game_type,
        "start_date": s.start_date,
        "end_date": s.end_date,
        "location_label": s.location_label,
        "notes": s.notes,
        "created_at": s.created_at,
        "updated_at": s.updated_at,
        "log_entry_id": log_entry.id if log_entry else None,
        "days_logged": len(log_entry.days) if log_entry else 0,
    }


@router.get("/api/scheduled-hunts")
def list_scheduled_hunts(request: Request, db: Session = Depends(get_db)):
    hunts = db.query(models.ScheduledHunt).filter(
        models.ScheduledHunt.user_id == request.state.user.id
    ).order_by(models.ScheduledHunt.start_date).all()
    return [_scheduled_hunt_dict(h) for h in hunts]


@router.get("/api/scheduled-hunts/{hunt_id}")
def get_scheduled_hunt(hunt_id: int, request: Request, db: Session = Depends(get_db)):
    h = db.query(models.ScheduledHunt).filter(
        models.ScheduledHunt.id == hunt_id, models.ScheduledHunt.user_id == request.state.user.id
    ).first()
    if not h:
        raise HTTPException(404, "Not found")
    return _scheduled_hunt_dict(h)


@router.post("/api/scheduled-hunts")
def create_scheduled_hunt(payload: ScheduledHuntIn, request: Request, db: Session = Depends(get_db)):
    now = datetime.utcnow().isoformat() + "Z"
    h = models.ScheduledHunt(user_id=request.state.user.id, created_at=now, **payload.model_dump())
    db.add(h)
    db.commit()
    db.refresh(h)
    return _scheduled_hunt_dict(h)


@router.put("/api/scheduled-hunts/{hunt_id}")
def update_scheduled_hunt(hunt_id: int, payload: ScheduledHuntIn, request: Request, db: Session = Depends(get_db)):
    h = db.query(models.ScheduledHunt).filter(
        models.ScheduledHunt.id == hunt_id, models.ScheduledHunt.user_id == request.state.user.id
    ).first()
    if not h:
        raise HTTPException(404, "Not found")
    for field, value in payload.model_dump().items():
        setattr(h, field, value)
    h.updated_at = datetime.utcnow().isoformat() + "Z"
    db.commit()
    db.refresh(h)
    return _scheduled_hunt_dict(h)


@router.delete("/api/scheduled-hunts/{hunt_id}")
def delete_scheduled_hunt(hunt_id: int, request: Request, db: Session = Depends(get_db)):
    h = db.query(models.ScheduledHunt).filter(
        models.ScheduledHunt.id == hunt_id, models.ScheduledHunt.user_id == request.state.user.id
    ).first()
    if not h:
        raise HTTPException(404, "Not found")
    # The linked trip entry (if any) is real logged data — deleting the plan it was scheduled
    # from shouldn't take the log with it. Just detach it back to a plain entry.
    for e in h.log_entries:
        e.scheduled_hunt_id = None
    db.delete(h)
    db.commit()
    return {"deleted": hunt_id}


@router.post("/api/scheduled-hunts/{hunt_id}/log-entry")
def start_or_get_log_entry(hunt_id: int, request: Request, db: Session = Depends(get_db)):
    """Find-or-create the one HuntLogEntry a scheduled hunt's days get logged against. Requires
    connectivity (it's normally tapped once, from signal, to kick off a trip) — everything after
    this point (adding each day) goes through the same offline write-queue the rest of the
    Logbook already uses."""
    h = db.query(models.ScheduledHunt).filter(
        models.ScheduledHunt.id == hunt_id, models.ScheduledHunt.user_id == request.state.user.id
    ).first()
    if not h:
        raise HTTPException(404, "Not found")

    existing = db.query(models.HuntLogEntry).filter(
        models.HuntLogEntry.scheduled_hunt_id == hunt_id
    ).first()
    if existing:
        return {"entry_id": existing.id, "created": False}

    now = datetime.utcnow().isoformat() + "Z"
    entry = models.HuntLogEntry(
        user_id=request.state.user.id,
        scheduled_hunt_id=hunt_id,
        hunt_date=h.start_date,
        location_label=h.location_label,
        game_type=h.game_type,
        created_at=now,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return {"entry_id": entry.id, "created": True}
