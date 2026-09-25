# Changelog

Plain-English release notes, shown on the Upgrade page under "Show details" for whatever
versions you're behind on. Newest first. Add a new `## x.y.z` section here whenever `VERSION`
is bumped — see `_changelog_entries_since()` in `routers/upgrade.py` for how this file is read.

## 0.7.10 - 2026-09-25
- Fixed logbook entries saved while offline (no signal) being impossible to open, view, or edit
  until they synced — they now open the same way a synced entry does, showing exactly what you
  saved, and any changes you make are kept on the device and synced automatically once you're
  back in range.

## 0.7.9 - 2026-09-25
- Fixed the Upgrade page still offering to "upgrade" to the version you're already on, in a
  different way than before — merging a pull request always leaves one extra, harmless commit
  on top of the real change, and that trailing commit wasn't being offered as an actual upgrade
  target, only showing up as a confusing "new version" that looked identical to your current one.
  Every upgrade now always lands you fully caught up, with no leftover commit behind the scenes.

## 0.7.8 - 2026-09-24
- Fixed the Upgrade page sometimes claiming a new version was available when you were already
  on it (offering to "upgrade" to the exact version/commit already running) — it was comparing
  shortened commit hashes, which git can print at different lengths for the same commit depending
  on when they're asked for, instead of the full, always-stable hash.

## 0.7.7 - 2026-09-24
- Fixed several pages failing to load at all offline after visiting them earlier while
  connected — logging/viewing a trip, viewing or editing a logbook entry, and viewing or editing
  a recipe. These pages were never being kept for offline use in the first place, unlike the
  rest of the app; this was especially noticeable for reopening a trip to log a day, since that's
  explicitly supposed to keep working once a trip's been started.

## 0.7.6 - 2026-09-24
- Found and fixed the actual reason the Upgrade button did nothing, on phone AND on a regular
  computer browser — the button's own markup was malformed since the version-picker feature
  first shipped (0.7.0), which silently broke the button before any of the previous fixes could
  even come into play. Rebuilt how the button is wired up so this can't happen again.

## 0.7.5 - 2026-09-24
- Fixed offline browsing still feeling painfully slow after the last timeout fix — every single
  page/data request was still waiting out the full ~2.5s network timeout before showing cached
  content, and a normal session fires off many of these as you tap around, so it added right back
  up. When the phone already knows it has no connection at all, cached content now shows
  immediately instead of waiting out that timeout first.

## 0.7.4 - 2026-09-24
- Fixed the Upgrade/Rollback buttons still doing nothing on some phones after the last two
  fixes — the browser's native confirmation popup wasn't appearing at all inside the installed
  app, so the confirmation step silently failed before anything could run. Replaced it with the
  app's own confirmation popup, which doesn't depend on that browser feature.

## 0.7.3 - 2026-09-24
- Fixed the app failing to load at all while offline right after an update — the page-shell and
  data caches were being wiped on every version bump instead of only when they actually needed
  to be, so a device that went offline before its next online visit had nothing left to fall
  back to. They now survive updates; only the static asset cache (which does need a clean slate
  each release) is still reset.

## 0.7.2 - 2026-09-24
- Fixed the Upgrade button silently doing nothing on some devices — the endpoint had started
  requiring a JSON body that an already-loaded copy of the page didn't send, so the request
  quietly failed. It's back to accepting the same plain request either way, and the page itself
  is now marked never-cache so this class of mismatch can't recur.

## 0.7.1 - 2026-09-24
- Fixed painfully slow page loads while offline — the service worker's cached pages/data now
  fall back after a short timeout instead of waiting out a full network failure first, which
  could take 5-20+ seconds depending on the connection.

## 0.7.0 - 2026-09-24
- The Upgrade page now shows every version between what you're running and the latest as its
  own pickable stop, each with its own changelog and its own "Upgrade to X" button — no longer
  forced to jump straight to the newest version if you'd rather go one at a time.

## 0.6.0 - 2026-09-24
- Scheduled Hunts: plan a trip ahead of time (state, game type, dates, general location) from
  the Hunting Regulations page, while you've still got signal.
- Logging a scheduled trip now supports multiple days under one trip log — add a day at a time
  (each with its own stand location, weather, harvest, and photos), works fully offline once
  the trip's been started. The Logbook list and the trip's own page show a day count and a
  generated trip summary alongside each day's own story.

## 0.5.0 - 2026-09-24
- Fixed low-contrast text on the Hunting, Logbook, and Recipes pages — the new background art
  had its own title text baked in right where the page's own text renders, so nothing behind it
  gave it contrast.
- Renamed the Hunting page to "Hunting Regulations" for clarity.
- Replaced the recipe page's phone background with a cleaner parchment crop, and restyled
  recipes to read like a printed recipe card (title, divider, underlined section headings)
  instead of plain text.
- Fixed the installed app icon showing a white halo around it compared to how it should look —
  the icon artwork had a transparent margin instead of filling the icon edge-to-edge.

## 0.4.0 - 2026-09-22
- Added a hamburger menu on phones/tablets — the section links (Hunting, Logbook, Recipes) were
  only reachable by scrolling the header sideways before; now they open in a proper slide-out
  menu, matching how Guns & Reloading does it.

## 0.3.0 - 2026-09-21
- "Show details" on this page now describes changes in plain English instead of raw commit
  messages.
- Removed the map page — it was a generic map, not the planned onX integration. A proper
  onX-based approach is being worked out instead.

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
