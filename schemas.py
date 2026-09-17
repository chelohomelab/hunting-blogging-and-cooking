from typing import Optional

from pydantic import BaseModel


class AdminUserPatch(BaseModel):
    is_admin: Optional[bool] = None
    is_active: Optional[bool] = None


class HuntLogEntryIn(BaseModel):
    hunt_date: str
    location_label: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    game_type: Optional[str] = None
    species: Optional[str] = None
    weapon: Optional[str] = None
    weather_temp_f: Optional[float] = None
    weather_conditions: Optional[str] = None
    wind_direction: Optional[str] = None
    wind_speed_mph: Optional[float] = None
    moon_phase: Optional[str] = None
    harvested: bool = False
    harvest_notes: Optional[str] = None
    narrative: Optional[str] = None


class RecipeIn(BaseModel):
    title: str
    hunt_log_entry_id: Optional[int] = None
    game_type: Optional[str] = None
    ingredients: Optional[str] = None
    instructions: Optional[str] = None
    notes: Optional[str] = None
