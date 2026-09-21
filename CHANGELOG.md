# Changelog

Plain-English release notes, shown on the Upgrade page under "Show details" for whatever
versions you're behind on. Newest first. Add a new `## x.y.z` section here whenever `VERSION`
is bumped — see `_changelog_entries_since()` in `routers/upgrade.py` for how this file is read.

## 0.2.0 - 2026-09-21
- Hunt logbook: log a hunt with GPS location, weather, and moon phase — works even with no cell
  signal, syncing automatically once you're back in range.
- Photo and video attachments on logbook entries.
- Map page showing all your logged hunt locations.
- Recipes: a wild-game cookbook that can link a recipe back to the hunt that produced it.
- Tapping a logbook entry or recipe now opens a dedicated page styled like a page from a hunting
  journal, instead of jumping straight into editing.
- "Generate Draft" button writes a starting narrative paragraph from a hunt's details.
- Home page separated from the Hunting seasons/regulations page.
- One-line install script for setting up a new server.
- Added a license.
- Fixed the upgrade page getting stuck on a false "local changes present" warning.
- Fixed the upgrade page sometimes showing a "new version" that matched the current version.

## 0.1.0 - 2026-09-16
- Initial release: hunting seasons and regulations lookup, ported from the Guns & Reloading app.
