from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

import database as models
from config import templates
from dependencies import get_db
from schemas import RecipeIn

router = APIRouter()

GAME_TYPES = ["Deer", "Black Bear", "Elk", "Turkey", "Upland Birds", "Small Game", "Migratory Birds", "Trapping"]


def _hunt_summary(e: models.HuntLogEntry) -> dict:
    return {
        "id": e.id, "hunt_date": e.hunt_date,
        "label": " — ".join(filter(None, [e.hunt_date, e.location_label, e.species or e.game_type])),
    }


def _recipe_dict(r: models.Recipe) -> dict:
    return {
        "id": r.id,
        "title": r.title,
        "hunt_log_entry_id": r.hunt_log_entry_id,
        "hunt_log_entry": _hunt_summary(r.hunt_log_entry) if r.hunt_log_entry else None,
        "game_type": r.game_type,
        "ingredients": r.ingredients,
        "instructions": r.instructions,
        "notes": r.notes,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    }


# ── Pages ────────────────────────────────────────────────────────────────────

@router.get("/recipes", response_class=HTMLResponse)
async def recipes_page(request: Request):
    return templates.TemplateResponse("recipes.html", {
        "request": request, "user": request.state.user, "game_types": GAME_TYPES,
    })


@router.get("/recipes/new", response_class=HTMLResponse)
async def recipes_new_page(request: Request):
    return templates.TemplateResponse("recipe_form.html", {
        "request": request, "user": request.state.user, "recipe_id": None, "game_types": GAME_TYPES,
    })


@router.get("/recipes/{recipe_id}/edit", response_class=HTMLResponse)
async def recipes_edit_page(recipe_id: int, request: Request):
    return templates.TemplateResponse("recipe_form.html", {
        "request": request, "user": request.state.user, "recipe_id": recipe_id, "game_types": GAME_TYPES,
    })


# ── API — scoped to the signed-in user throughout (tenant-ready: see docs/VISION.md) ──────────

@router.get("/api/recipes")
def list_recipes(request: Request, db: Session = Depends(get_db)):
    recipes = db.query(models.Recipe).filter(
        models.Recipe.user_id == request.state.user.id
    ).order_by(models.Recipe.title).all()
    return [_recipe_dict(r) for r in recipes]


@router.get("/api/recipes/harvest-options")
def harvest_options(request: Request, db: Session = Depends(get_db)):
    """Harvested hunts this user can link a recipe to — powers the form's dropdown."""
    entries = db.query(models.HuntLogEntry).filter(
        models.HuntLogEntry.user_id == request.state.user.id,
        models.HuntLogEntry.harvested == True,
    ).order_by(models.HuntLogEntry.hunt_date.desc()).all()
    return [_hunt_summary(e) for e in entries]


@router.get("/api/recipes/{recipe_id}")
def get_recipe(recipe_id: int, request: Request, db: Session = Depends(get_db)):
    r = db.query(models.Recipe).filter(
        models.Recipe.id == recipe_id, models.Recipe.user_id == request.state.user.id
    ).first()
    if not r:
        raise HTTPException(404, "Not found")
    return _recipe_dict(r)


def _validate_hunt_link(hunt_log_entry_id, user_id, db):
    if hunt_log_entry_id is None:
        return
    owned = db.query(models.HuntLogEntry).filter(
        models.HuntLogEntry.id == hunt_log_entry_id, models.HuntLogEntry.user_id == user_id
    ).first()
    if not owned:
        raise HTTPException(400, "That logbook entry doesn't exist or isn't yours")


@router.post("/api/recipes")
def create_recipe(payload: RecipeIn, request: Request, db: Session = Depends(get_db)):
    _validate_hunt_link(payload.hunt_log_entry_id, request.state.user.id, db)
    now = datetime.utcnow().isoformat() + "Z"
    r = models.Recipe(user_id=request.state.user.id, created_at=now, **payload.model_dump())
    db.add(r)
    db.commit()
    db.refresh(r)
    return _recipe_dict(r)


@router.put("/api/recipes/{recipe_id}")
def update_recipe(recipe_id: int, payload: RecipeIn, request: Request, db: Session = Depends(get_db)):
    r = db.query(models.Recipe).filter(
        models.Recipe.id == recipe_id, models.Recipe.user_id == request.state.user.id
    ).first()
    if not r:
        raise HTTPException(404, "Not found")
    _validate_hunt_link(payload.hunt_log_entry_id, request.state.user.id, db)
    for field, value in payload.model_dump().items():
        setattr(r, field, value)
    r.updated_at = datetime.utcnow().isoformat() + "Z"
    db.commit()
    db.refresh(r)
    return _recipe_dict(r)


@router.delete("/api/recipes/{recipe_id}")
def delete_recipe(recipe_id: int, request: Request, db: Session = Depends(get_db)):
    r = db.query(models.Recipe).filter(
        models.Recipe.id == recipe_id, models.Recipe.user_id == request.state.user.id
    ).first()
    if not r:
        raise HTTPException(404, "Not found")
    db.delete(r)
    db.commit()
    return {"deleted": recipe_id}
