import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from typing import Optional

from config import templates
from paths import BASE_DIR, DATA_DIR
from routers.backup import _load_config, restore_zip_bytes, save_backup_zip

router = APIRouter()


REPO_ROOT = Path(__file__).resolve().parent.parent
# Docker images exclude .git (see .dockerignore) — this self-upgrade mechanism (git fetch/merge +
# systemd restart) only makes sense for a real git checkout. Computed once at import time; drives
# graceful degradation below rather than letting git commands error against a missing .git.
GIT_AVAILABLE = (REPO_ROOT / ".git").is_dir()
UPGRADE_STATE_PATH = Path(DATA_DIR) / "data" / "upgrade_state.json"
BRANCH = "main"


def _require_admin(request: Request):
    if not getattr(request.state, "user", None) or not request.state.user.is_admin:
        raise HTTPException(status_code=403, detail="Admin required")


def _require_git():
    if not GIT_AVAILABLE:
        raise HTTPException(
            status_code=400,
            detail="Self-upgrade isn't available for this install type — no local git checkout "
                   "found. Update via your platform's normal mechanism instead (a new Docker "
                   "image tag).",
        )


def _run(cmd: list, timeout: int = 60) -> dict:
    try:
        result = subprocess.run(
            cmd, cwd=REPO_ROOT, capture_output=True, text=True, timeout=timeout,
        )
        return {
            "cmd": " ".join(cmd),
            "ok": result.returncode == 0,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    except subprocess.TimeoutExpired:
        return {"cmd": " ".join(cmd), "ok": False, "stdout": "", "stderr": "timed out"}
    except FileNotFoundError as e:
        return {"cmd": " ".join(cmd), "ok": False, "stdout": "", "stderr": str(e)}


def _git(*args, timeout: int = 60) -> dict:
    return _run(["git", *args], timeout=timeout)


def _commit_info(rev: str) -> dict | None:
    # %h (abbreviated hash) is only for display — git recalculates its minimum unambiguous
    # length dynamically as the repo grows, so the SAME commit can print at different lengths
    # between two separate `git log` calls (e.g. one before a `git fetch`, one after), which
    # makes it unsafe to use for equality checks. full_hash (%H) is always 40 stable hex chars
    # and is what every identity comparison below should use instead.
    r = _git("log", "-1", "--format=%H|%h|%cI|%s", rev)
    if not r["ok"] or not r["stdout"]:
        return None
    full_hash, short_hash, iso_date, subject = r["stdout"].split("|", 3)
    tag = _git("describe", "--tags", "--exact-match", rev)
    return {
        "hash": short_hash,
        "full_hash": full_hash,
        "date": iso_date,
        "subject": subject,
        "tag": tag["stdout"] if tag["ok"] else None,
    }


def _version_at(rev: str) -> str | None:
    """The VERSION file's contents at a given revision — the human-facing "1.24" style number,
    as opposed to _commit_info's git hash/tag. Used to drive the simplified upgrade UI, which
    talks in version numbers rather than commit hashes."""
    r = _git("show", f"{rev}:VERSION")
    return r["stdout"].strip() if r["ok"] and r["stdout"].strip() else None


def _parse_version(v: str) -> tuple:
    try:
        return tuple(int(p) for p in v.strip().split("."))
    except (ValueError, AttributeError):
        return (0,)


def _changelog_entries_since(current_version: str | None, rev: str) -> list[str] | None:
    """Plain-English bullet points (not raw commit subjects) for every CHANGELOG.md '## x.y.z'
    section newer than current_version, read from `rev` (typically origin/BRANCH so this reflects
    what's actually pending, not what's already installed). None if CHANGELOG.md doesn't exist
    there or has no qualifying section — callers fall back to raw commit subjects in that case,
    which only happens if someone bumps VERSION without adding a changelog entry."""
    r = _git("show", f"{rev}:CHANGELOG.md")
    if not r["ok"] or not r["stdout"]:
        return None
    current = _parse_version(current_version) if current_version else (0,)
    bullets: list[str] = []
    section_version = None
    for line in r["stdout"].splitlines():
        header = re.match(r"^##\s+([0-9]+(?:\.[0-9]+)*)", line)
        if header:
            section_version = _parse_version(header.group(1))
            if section_version <= current:
                break
            continue
        if not section_version or section_version <= current:
            continue
        stripped = line.strip()
        if stripped.startswith("-"):
            bullets.append(stripped[1:].strip())
        elif stripped and bullets:
            # Wrapped continuation line (no leading "-") — append to the previous bullet
            # instead of dropping it or treating it as a new, truncated entry.
            bullets[-1] += " " + stripped
    return bullets or None


def _version_stops_between(base_rev: str, head_rev: str) -> list[dict]:
    """Every commit in (base_rev, head_rev] that changed VERSION, oldest first — lets the
    upgrade page offer each intermediate version as its own stop instead of only the branch
    tip, since a merge to any of these is still a valid --ff-only fast-forward from base_rev.
    Each entry's changelog is read at that exact commit, which naturally scopes it to "up to
    and including this version" — later version sections don't exist yet at that point in
    history."""
    r = _git("log", "--reverse", "--format=%H", f"{base_rev}..{head_rev}", "--", "VERSION")
    if not r["ok"] or not r["stdout"]:
        return []
    stops = []
    current_version = _version_at(base_rev)
    for commit_hash in r["stdout"].splitlines():
        version = _version_at(commit_hash)
        if not version:
            continue
        stops.append({
            "hash": commit_hash,
            "version": version,
            "changelog_entries": _changelog_entries_since(current_version, commit_hash),
        })
    return stops


def _repo_web_url() -> str | None:
    """Browsable https URL for the origin remote, so the UI can link out to GitHub for users
    who want the full commit/release history instead of the simplified in-app view. Derived
    from the actual remote (not hardcoded) so this keeps working for a fork."""
    if not GIT_AVAILABLE:
        return None
    r = _run(["git", "remote", "get-url", "origin"], timeout=10)
    if not r["ok"] or not r["stdout"]:
        return None
    url = r["stdout"].strip()
    if url.startswith("git@github.com:"):
        url = "https://github.com/" + url[len("git@github.com:"):]
    if url.endswith(".git"):
        url = url[:-4]
    return url


REPO_WEB_URL = _repo_web_url()


def _is_dirty() -> bool:
    r = _git("status", "--porcelain")
    return bool(r["stdout"])


def _dirty_files() -> list:
    # Raw subprocess call, not _run()/_git() — those .strip() the combined stdout blob, which
    # eats the leading status-column space off just the first porcelain line and throws off its
    # fixed-width "XY <path>" slicing.
    try:
        r = subprocess.run(["git", "status", "--porcelain"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=10)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return []
    return [line[3:] for line in r.stdout.splitlines() if line]


def _pip_install() -> dict:
    return _run([sys.executable, "-m", "pip", "install", "--no-cache-dir", "-r", "requirements.txt"], timeout=300)


def _load_upgrade_state() -> dict | None:
    if not UPGRADE_STATE_PATH.exists():
        return None
    try:
        return json.loads(UPGRADE_STATE_PATH.read_text())
    except Exception:
        return None


def _save_upgrade_state(state: dict):
    UPGRADE_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    UPGRADE_STATE_PATH.write_text(json.dumps(state, indent=2))


def _running_under_systemd() -> bool:
    # systemd sets INVOCATION_ID for every unit it starts (hbc.service in prod); a plain
    # `uvicorn ... --reload` launched from a dev shell never has it. This is the load-bearing
    # signal for which restart strategy is safe to use — see _schedule_restart below.
    return bool(os.environ.get("INVOCATION_ID"))


def _schedule_restart() -> str:
    """Trigger a restart appropriate to how the app is actually running, and report which
    strategy was used so the caller/UI can say something accurate.

    - Under systemd (prod): a clean self-exit. hbc.service has Restart=on-failure /
      RestartSec=5, so exiting with a non-zero code is all that's needed — no elevated
      permissions (e.g. calling `systemctl` directly) required from the app itself.
    - Under `--reload` (dev): self-exiting is NOT safe here — uvicorn's reloader supervises a
      *subprocess* and isn't guaranteed to respawn it on an arbitrary exit the way systemd's
      Restart=on-failure does, so it could just leave the dev server dead. Instead, nudge the
      file watcher (git pull already changed tracked .py files, which it would pick up on its
      own shortly anyway) so it reloads the worker gracefully on its own, same as any other
      code change during development.

    Both run on a short delay, off-thread, so the HTTP response for this request finishes
    sending before anything happens.
    """
    if _running_under_systemd():
        def _delayed_exit():
            time.sleep(1.5)
            os._exit(1)
        threading.Thread(target=_delayed_exit, daemon=True).start()
        return "systemd"
    else:
        def _delayed_touch():
            time.sleep(1.5)
            (REPO_ROOT / "main.py").touch()
        threading.Thread(target=_delayed_touch, daemon=True).start()
        return "dev-reload"


# ── Page ─────────────────────────────────────────────────────────────────────

@router.get("/admin/upgrade", response_class=HTMLResponse)
async def upgrade_page(request: Request):
    _require_admin(request)
    # This page's own JS/markup must never be served stale from the browser's plain HTTP cache
    # (independent of the service worker, which doesn't intercept this route at all) — a stale
    # copy calling an old API shape against the current backend is exactly what silently broke
    # the upgrade button on a phone that hadn't reloaded since a prior version of this page.
    return templates.TemplateResponse("admin-upgrade.html", {
        "request": request,
        "user": request.state.user,
        "git_available": GIT_AVAILABLE,
        "repo_url": REPO_WEB_URL,
    }, headers={"Cache-Control": "no-store"})


# ── Check for updates ────────────────────────────────────────────────────────

@router.get("/admin/upgrade/check")
def upgrade_check(request: Request):
    _require_admin(request)
    _require_git()

    current = _commit_info("HEAD")
    current_version = _version_at("HEAD")
    fetch = _git("fetch", "origin", BRANCH, timeout=30)
    if not fetch["ok"]:
        return {
            "ok": False,
            "error": f"git fetch failed: {fetch['stderr'] or 'no network / no access to origin'}",
            "current": current,
            "current_version": current_version,
            "dirty": _is_dirty(),
            "dirty_files": _dirty_files(),
            "rollback": _rollback_summary(),
            "repo_url": REPO_WEB_URL,
        }

    latest = _commit_info(f"origin/{BRANCH}")
    latest_version = _version_at(f"origin/{BRANCH}")
    behind = _git("log", f"HEAD..origin/{BRANCH}", "--format=%h %s")
    commits_behind = behind["stdout"].splitlines() if behind["ok"] and behind["stdout"] else []
    changelog_entries = _changelog_entries_since(current_version, f"origin/{BRANCH}")
    version_stops = _version_stops_between("HEAD", f"origin/{BRANCH}")

    return {
        "ok": True,
        "current": current,
        "current_version": current_version,
        "latest": latest,
        "latest_version": latest_version,
        "up_to_date": current is not None and latest is not None and current["full_hash"] == latest["full_hash"],
        "commits_behind": commits_behind,
        "changelog_entries": changelog_entries,
        "version_stops": version_stops,
        "dirty": _is_dirty(),
        "dirty_files": _dirty_files(),
        "rollback": _rollback_summary(),
        "repo_url": REPO_WEB_URL,
    }


def _rollback_summary() -> dict | None:
    state = _load_upgrade_state()
    if not state:
        return None
    resolves = _git("cat-file", "-e", state["previous_commit"])
    backup_exists = Path(state["backup_file"]).exists() if state.get("backup_file") else False
    return {
        **state,
        "previous_version": _version_at(state["previous_commit"]) if resolves["ok"] else None,
        "available": resolves["ok"] and backup_exists,
    }


# ── Run upgrade ──────────────────────────────────────────────────────────────

@router.post("/admin/upgrade/run")
def upgrade_run(request: Request, target: Optional[str] = None):
    # A query param rather than a JSON body: a request with no body at all (e.g. any client
    # still running a cached copy of this page from before per-version targeting existed) must
    # keep working exactly as "upgrade to latest" always did, not 422 on a missing body.
    _require_admin(request)
    _require_git()
    log = []

    if _is_dirty():
        raise HTTPException(400, "Working tree has local changes on this server — resolve or discard them before upgrading (never auto-discarded).")

    before = _commit_info("HEAD")

    fetch = _git("fetch", "origin", BRANCH, timeout=30)
    log.append(fetch)
    if not fetch["ok"]:
        raise HTTPException(502, f"git fetch failed: {fetch['stderr'] or 'no network / no access to origin'}")

    target_ref = f"origin/{BRANCH}"
    if target:
        valid_hashes = {s["hash"] for s in _version_stops_between("HEAD", f"origin/{BRANCH}")}
        if target not in valid_hashes:
            raise HTTPException(400, "Not a valid upgrade target — refresh the page and try again.")
        target_ref = target

    target_commit = _commit_info(target_ref)
    if target_commit and before and target_commit["full_hash"] == before["full_hash"]:
        return {"ok": True, "up_to_date": True, "log": log, "current": before}

    # Backup BEFORE touching any code, so a rollback always has something to restore to.
    cfg = _load_config()
    try:
        backup_path = save_backup_zip(cfg)
    except Exception as e:
        raise HTTPException(500, f"Pre-upgrade backup failed, aborting upgrade: {e}")
    log.append({"cmd": "backup", "ok": True, "stdout": str(backup_path), "stderr": ""})

    merge = _git("merge", "--ff-only", target_ref, timeout=30)
    log.append(merge)
    if not merge["ok"]:
        raise HTTPException(500, f"git merge --ff-only failed (backup was still taken at {backup_path}): {merge['stderr']}")

    pip = _pip_install()
    log.append(pip)
    if not pip["ok"]:
        raise HTTPException(500, f"pip install failed after code update — code is on the new version but dependencies may be stale. Use Rollback. Details: {pip['stderr']}")

    after = _commit_info("HEAD")
    _save_upgrade_state({
        # Full hash, not the abbreviated one — this gets persisted to disk and read back for a
        # rollback that could happen long after more commits have landed, so it needs to stay
        # unambiguously resolvable indefinitely, not just within this one request.
        "previous_commit": before["full_hash"] if before else None,
        "new_commit": after["full_hash"] if after else None,
        "backup_file": str(backup_path),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    })

    restart_mode = _schedule_restart()
    return {"ok": True, "up_to_date": False, "log": log, "from": before, "to": after, "restarting": True, "restart_mode": restart_mode}


# ── Rollback to the state before the last upgrade ───────────────────────────

@router.post("/admin/upgrade/rollback")
def upgrade_rollback(request: Request):
    _require_admin(request)
    _require_git()
    state = _load_upgrade_state()
    if not state:
        raise HTTPException(400, "No upgrade to roll back — nothing recorded.")

    if _is_dirty():
        raise HTTPException(400, "Working tree has local changes on this server — resolve or discard them before rolling back (never auto-discarded).")

    resolves = _git("cat-file", "-e", state["previous_commit"])
    if not resolves["ok"]:
        raise HTTPException(400, "Previous commit no longer exists locally — cannot roll back code automatically.")

    backup_file = Path(state["backup_file"]) if state.get("backup_file") else None
    if not backup_file or not backup_file.exists():
        raise HTTPException(400, "Pre-upgrade backup file is missing — cannot safely roll back the database.")

    log = []
    reset = _git("reset", "--hard", state["previous_commit"], timeout=30)
    log.append(reset)
    if not reset["ok"]:
        raise HTTPException(500, f"git reset --hard failed: {reset['stderr']}")

    pip = _pip_install()
    log.append(pip)
    if not pip["ok"]:
        raise HTTPException(500, f"Code was rolled back but pip install failed: {pip['stderr']}")

    restore_result = restore_zip_bytes(backup_file.read_bytes())
    log.append({"cmd": "restore_zip_bytes", "ok": True, "stdout": json.dumps(restore_result), "stderr": ""})

    UPGRADE_STATE_PATH.unlink(missing_ok=True)

    restart_mode = _schedule_restart()
    return {"ok": True, "log": log, "restored_to": state["previous_commit"], "restarting": True, "restart_mode": restart_mode}
