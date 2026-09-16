from pathlib import Path

from sqlalchemy import create_engine, Column, Integer, String, ForeignKey, Boolean
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
