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


class ScheduledHuntIn(BaseModel):
    label: str
    state: Optional[str] = None
    game_type: Optional[str] = None
    start_date: str
    end_date: str
    location_label: Optional[str] = None
    notes: Optional[str] = None


class HuntTripUpdateIn(BaseModel):
    # Trip-level fields on a HuntLogEntry that has scheduled_hunt_id set — see that model's
    # docstring. Deliberately separate from HuntLogEntryIn: a trip entry doesn't have most of
    # that schema's fields (weather, harvest, per-entry narrative), those live on HuntLogDay.
    location_label: Optional[str] = None
    narrative: Optional[str] = None   # the trip summary


class HuntLogDayIn(BaseModel):
    hunt_date: str
    location_label: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    weather_temp_f: Optional[float] = None
    weather_conditions: Optional[str] = None
    wind_direction: Optional[str] = None
    wind_speed_mph: Optional[float] = None
    moon_phase: Optional[str] = None
    harvested: bool = False
    harvest_notes: Optional[str] = None
    narrative: Optional[str] = None
