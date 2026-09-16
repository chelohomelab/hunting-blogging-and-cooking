"""BASE_DIR: the app's own bundled code/templates/static assets (read-only, ships with the app).
DATA_DIR: where user data lives — db, uploads, backups (read-write, must survive updates).

DATA_DIR defaults to "." (current working directory) — unset, this is byte-identical to every
path this app has ever computed relative to CWD. Only Docker (optionally) sets HBC_DATA_DIR to
something else.
"""
import os
from pathlib import Path

BASE_DIR: Path = Path(__file__).resolve().parent
DATA_DIR: Path = Path(os.environ.get("HBC_DATA_DIR", "."))
