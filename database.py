from pathlib import Path

from sqlalchemy import create_engine, Column, Integer, String, ForeignKey, Boolean, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship, sessionmaker

from paths import DATA_DIR

_db_dir = Path(DATA_DIR) / "data"
_db_dir.mkdir(parents=True, exist_ok=True)
DATABASE_URL = f"sqlite:///{(_db_dir / 'hbc.db').as_posix()}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, nullable=False)
    email = Column(String, nullable=True)
    hashed_password = Column(String, nullable=False)
    is_admin = Column(Boolean, default=True)
    is_active = Column(Boolean, default=True)

    sessions = relationship("UserSession", back_populates="user", cascade="all, delete-orphan")


class UserSession(Base):
    __tablename__ = "user_sessions"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    token = Column(String, unique=True, nullable=False, index=True)
    expires_at = Column(String, nullable=False)

    user = relationship("User", back_populates="sessions")


class HuntingState(Base):
    # One row per state the user has added. Standalone reference library — not tied to any
    # other table — populated by hand (or by Claude, reading a regs PDF with the user) rather
    # than an automated importer. Table structure/layout in state digest PDFs changes year to
    # year and differs per game type, so a parser tuned to one year's shape breaks the next —
    # deliberately not automated. See docs/VISION.md.
    __tablename__ = "hunting_states"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)          # e.g. "New Jersey"
    abbreviation = Column(String, nullable=True)    # e.g. "NJ"
    display_order = Column(Integer, default=0)

    season_entries = relationship("HuntingSeasonEntry", back_populates="state", cascade="all, delete-orphan")
    regulation_notes = relationship("HuntingRegulationNote", back_populates="state", cascade="all, delete-orphan")


class HuntingSeasonEntry(Base):
    # Powers the Dates tab. Stored as a compact date RANGE per weapon/season, not one row per
    # calendar day — the calendar grid is reconstructed at render time by expanding every entry
    # that overlaps the viewed month back out day-by-day. weekday_filter lets a single entry cover
    # a recurring weekly exception (e.g. NJ's "Sundays: Crossbow only, private land only" rule)
    # instead of needing ~20 duplicated rows for one month.
    __tablename__ = "hunting_season_entries"
    id = Column(Integer, primary_key=True, index=True)
    state_id = Column(Integer, ForeignKey("hunting_states.id"), nullable=False)
    season_year_label = Column(String, nullable=False)   # e.g. "2026-27"
    game_type = Column(String, nullable=False)           # Deer, Black Bear, Turkey, Upland Birds, Small Game, Migratory Birds, Trapping
    species = Column(String, nullable=True)               # e.g. "Bobwhite Quail" within Upland Birds; null when game_type is specific enough on its own
    season_label = Column(String, nullable=False)         # e.g. "Permit Muzzleloader", "Segment A", "Fall Bow"
    weapon = Column(String, nullable=True)                 # e.g. "Muzzleloader", "Shotgun", "Crossbow"
    zone_or_area = Column(String, nullable=True)           # e.g. "Regulation Set High", "North Zone"
    start_date = Column(String, nullable=False)            # ISO YYYY-MM-DD
    end_date = Column(String, nullable=False)              # ISO YYYY-MM-DD
    weekday_filter = Column(String, nullable=True)          # e.g. "Sunday" — entry applies only on this weekday within the range
    bag_limit = Column(String, nullable=True)
    notes = Column(String, nullable=True)
    display_order = Column(Integer, default=0)

    state = relationship("HuntingState", back_populates="season_entries")


class HuntingRegulationNote(Base):
    # Powers the Regulations tab — free-text reference content (license/permit requirements,
    # legal weapons, general rules) since that's how regs PDFs actually present this material,
    # unlike season dates which are naturally tabular (see HuntingSeasonEntry above).
    __tablename__ = "hunting_regulation_notes"
    id = Column(Integer, primary_key=True, index=True)
    state_id = Column(Integer, ForeignKey("hunting_states.id"), nullable=False)
    game_type = Column(String, nullable=True)   # null = general/statewide, not tied to one game type
    title = Column(String, nullable=False)
    body = Column(String, nullable=False)
    display_order = Column(Integer, default=0)

    state = relationship("HuntingState", back_populates="regulation_notes")


class HuntLogEntry(Base):
    # A blog-style journal entry per hunt — the heart of the app (see docs/VISION.md phase 1).
    # user_id is here even though there's only one user today: tenant-ready from day one, so
    # adding a second user later is "add a row to Users," not a migration project.
    #
    # latitude/longitude are captured client-side from the device's GPS chip (works with zero
    # cell signal) — deliberately no map tiles/geocoding here, the user relies on OnX for actual
    # field mapping and this just records the coordinate for later reference. moon_phase is
    # computed client-side from hunt_date (pure calculation, no API/connectivity needed).
    # Weather fields are manual entry for now — auto-fetching historical weather from the
    # captured coordinate+timestamp once back online is a possible future enhancement, deferred
    # pending a provider/API-key decision rather than assumed here.
    #
    # scheduled_hunt_id makes this a "trip entry" when set (see ScheduledHunt below): one entry
    # per trip, holding trip-level fields only (location_label = general area, narrative = trip
    # summary), with the actual per-day data — including this same set of weather/harvest/
    # narrative fields — living instead in this entry's `days` (HuntLogDay), one row per day
    # logged. A plain single-day entry (scheduled_hunt_id is null) is unaffected and keeps using
    # its own flat fields exactly as before; the two shapes share a table rather than forking
    # into a separate model so the Logbook list can query/sort both in one pass.
    __tablename__ = "hunt_log_entries"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    scheduled_hunt_id = Column(Integer, ForeignKey("scheduled_hunts.id"), nullable=True, index=True)
    hunt_date = Column(String, nullable=False)          # ISO YYYY-MM-DD; for a trip entry, set once at creation to the trip's start_date so list sorting works unchanged
    location_label = Column(String, nullable=True)       # e.g. "Back 40", a free-text nickname
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    game_type = Column(String, nullable=True)            # Deer, Black Bear, Elk, Turkey, Upland Birds, Small Game, Migratory Birds, Trapping
    species = Column(String, nullable=True)
    weapon = Column(String, nullable=True)
    weather_temp_f = Column(Float, nullable=True)
    weather_conditions = Column(String, nullable=True)
    wind_direction = Column(String, nullable=True)
    wind_speed_mph = Column(Float, nullable=True)
    moon_phase = Column(String, nullable=True)
    harvested = Column(Boolean, default=False)
    harvest_notes = Column(String, nullable=True)
    narrative = Column(String, nullable=True)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=True)

    user = relationship("User")
    scheduled_hunt = relationship("ScheduledHunt", back_populates="log_entries")
    media = relationship("HuntLogMedia", back_populates="entry", cascade="all, delete-orphan")
    days = relationship("HuntLogDay", back_populates="entry", cascade="all, delete-orphan", order_by="HuntLogDay.hunt_date")


class HuntLogMedia(Base):
    # Photos/video attached to a logbook entry (phase 2b — see docs/VISION.md). user_id is
    # duplicated from the parent entry rather than requiring a join for ownership checks, same
    # tenant-ready reasoning as everywhere else. Deliberately online-only: attaching media from
    # the backcountry doesn't really apply (no camera-to-server path without signal either way),
    # so this is attached once you're back in range, same as the "edit a past entry" flow.
    # day_id is set instead of being trip-day-specific media's only link — entry_id stays filled
    # in too (the day's parent entry) so existing entry-scoped queries need no special-casing.
    # Null day_id (the original/common case) means this photo belongs to the entry as a whole,
    # exactly as before trip entries existed.
    __tablename__ = "hunt_log_media"
    id = Column(Integer, primary_key=True, index=True)
    entry_id = Column(Integer, ForeignKey("hunt_log_entries.id"), nullable=False, index=True)
    day_id = Column(Integer, ForeignKey("hunt_log_days.id"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    media_type = Column(String, nullable=False)   # "photo" or "video"
    file_path = Column(String, nullable=False)     # /static/uploads/... URL
    caption = Column(String, nullable=True)
    display_order = Column(Integer, default=0)
    created_at = Column(String, nullable=False)

    entry = relationship("HuntLogEntry", back_populates="media")
    day = relationship("HuntLogDay", back_populates="media")


class ScheduledHunt(Base):
    # A planned future hunt/trip, created ahead of time while there's still signal, so its
    # details are already on the device before heading out of range (see docs/VISION.md's
    # offline-first principles) — the whole point is being selectable from the Logbook once
    # offline. Deliberately stays around indefinitely after the trip happens (no auto-archive/
    # complete flag): a multi-day trip is logged as ONE HuntLogEntry that keeps growing more
    # HuntLogDay rows as each day is logged, potentially over several separate offline sessions,
    # so there's no single moment a trip becomes "done."
    #
    # state/game_type are free text, matching how HuntLogEntry.game_type already works (a
    # shared constant list drives the picker client-side, not a DB-level FK/enum) — a trip can
    # be planned for a state before that state has any regulations data loaded here at all.
    __tablename__ = "scheduled_hunts"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    label = Column(String, nullable=False)               # e.g. "Upstate NY — Late October"
    state = Column(String, nullable=True)
    game_type = Column(String, nullable=True)
    start_date = Column(String, nullable=False)          # ISO YYYY-MM-DD
    end_date = Column(String, nullable=False)
    location_label = Column(String, nullable=True)        # general trip-level location
    notes = Column(String, nullable=True)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=True)

    user = relationship("User")
    log_entries = relationship("HuntLogEntry", back_populates="scheduled_hunt")


class HuntLogDay(Base):
    # One logged day within a multi-day trip (a HuntLogEntry with scheduled_hunt_id set — see
    # both docstrings above). Mirrors the fields a plain single-day HuntLogEntry uses, since
    # conceptually each day IS a single-day hunt, just nested under a trip container instead of
    # standing alone. location_label here is the day's specific stand/spot, distinct from the
    # trip-level general location on the parent entry.
    __tablename__ = "hunt_log_days"
    id = Column(Integer, primary_key=True, index=True)
    entry_id = Column(Integer, ForeignKey("hunt_log_entries.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    hunt_date = Column(String, nullable=False)           # ISO YYYY-MM-DD
    location_label = Column(String, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    weather_temp_f = Column(Float, nullable=True)
    weather_conditions = Column(String, nullable=True)
    wind_direction = Column(String, nullable=True)
    wind_speed_mph = Column(Float, nullable=True)
    moon_phase = Column(String, nullable=True)
    harvested = Column(Boolean, default=False)
    harvest_notes = Column(String, nullable=True)
    narrative = Column(String, nullable=True)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=True)

    entry = relationship("HuntLogEntry", back_populates="days")
    media = relationship("HuntLogMedia", back_populates="day", cascade="all, delete-orphan")


class Recipe(Base):
    # Wild-game recipes, the bridge from harvest to kitchen (phase 4 — see docs/VISION.md).
    # hunt_log_entry_id is optional and nullable — a recipe doesn't have to trace back to one
    # specific hunt (e.g. "a general venison chili recipe"), but when it does, this is what
    # "linked back to the hunt(s) that produced the ingredients" means. Deliberately a single
    # link, not many-to-many, for v1 — a recipe naming multiple contributing hunts is a real but
    # rarer case, not worth the extra join-table complexity until it's actually needed.
    __tablename__ = "recipes"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    hunt_log_entry_id = Column(Integer, ForeignKey("hunt_log_entries.id"), nullable=True, index=True)
    title = Column(String, nullable=False)
    game_type = Column(String, nullable=True)   # Deer, Black Bear, Elk, Turkey, Upland Birds, Small Game, Migratory Birds, Trapping — same categories as everywhere else, for filtering
    ingredients = Column(String, nullable=True)  # free text, one per line
    instructions = Column(String, nullable=True)
    notes = Column(String, nullable=True)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=True)

    user = relationship("User")
    hunt_log_entry = relationship("HuntLogEntry")


def init_db():
    Base.metadata.create_all(bind=engine)
    from sqlalchemy import text, inspect as sa_inspect
    inspector = sa_inspect(engine)

    def _add_col(table, col, ddl):
        """Additive auto-migration for existing SQLite databases: create_all() only creates
        brand-new tables, so any column added to a model after its table already exists on a
        deployed DB needs an explicit ALTER TABLE here too, or every query against it starts
        failing with "no such column" the moment the new code ships."""
        existing = [c['name'] for c in inspector.get_columns(table)]
        if col not in existing:
            with engine.connect() as conn:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {ddl}"))
                conn.commit()

    _add_col("hunt_log_entries", "scheduled_hunt_id", "scheduled_hunt_id INTEGER")
    _add_col("hunt_log_media", "day_id", "day_id INTEGER")
