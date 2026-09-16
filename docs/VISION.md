# Hunting, Blogging and Cooking (HB&C)

Planning notes carried over from the `guns-and-reloading` (G&R) project, where this idea was
first discussed (2026-09-15/16), before this repo existed. Meant as a starting point, not a
finished spec — edit freely.

## Why this is its own app

The original `hunting-per-state` feature (season dates + regulations lookup, per state/game type)
was built inside G&R first, then the user decided it didn't belong there long-term: G&R is
"inventory and reloading," and this is a different domain — a personal hunting reference/journal,
not inventory tracking. The planned feature set (see below) is also much bigger than a lookup
table, closer to its own product than a bolt-on page.

## What ships in v1.0

Fork G&R's framework as a skeleton (not reinvented) — same stack and conventions:
- FastAPI + Jinja2 + SQLAlchemy, session-based auth
- Same admin patterns: `_require_admin(request)` guard, admin pages under `/admin/...`
- Same self-upgrade mechanism (`routers/upgrade.py`'s git fetch/merge + systemd restart) and
  backup/restore approach, ported over rather than redesigned

Then port over the season/regulations/calendar feature as-is:
- Per-state tabs, each with **Regulations** and **Dates** sub-tabs, broken down by game type
  (Deer, Black Bear, Elk, Turkey, Upland Birds, Small Game, Migratory Birds, Trapping)
- Data model: a `HuntingState`, date-range `HuntingSeasonEntry` rows (with an optional
  `weekday_filter` like `"!Sunday"` — NOT one row per day), and free-text `HuntingRegulationNote`
  rows (`game_type=None` = statewide general note)
- Manual data entry per state/year via hand-transcription from the state's digest PDF, seeded
  through an admin "run this state's seed script" button (subprocess-driven, one script per
  state under something like `scripts/hunting_data_seeds/`) — **deliberately not an automated
  PDF parser**: table structure/layout changes year to year and differs per game type, so a
  parser tuned to one year's shape breaks the next. NJ 2026-27 was the first state seeded this
  way (Deer scoped to "Regulation Set High").

## What comes after v1.0 — build incrementally, same as G&R did

One feature at a time, each shipped and used before starting the next:

1. **Hunt logging** — a blog-style journal entry per hunt (date, location, weather, what
   happened, harvest or not). This is the heart of the app; everything else attaches to it.
2. **Media** — photos and video attached to a hunt log entry. Needs real storage/thumbnailing
   design, not an afterthought bolted onto the logging feature.
3. **Maps** — onX integration for hunt locations/routes. No known public onX API as of this
   writing — likely a manual link/screenshot/embed approach rather than a real API integration
   unless that changes.
4. **Recipes** — meals cooked from the wild game harvested, linked back to the hunt(s) that
   produced the ingredients.

## Architecture principles (added 2026-09-16, after reviewing an external AI-generated design)

An outside AI proposed a full microservices/mobile/multi-tenant-social architecture (Go +
Node.js + Python services, PostGIS, MongoDB, Elasticsearch, Redis, native Flutter/React Native
apps, AWS S3+CloudFront). Rejected as solving problems this project doesn't have: no team to run
microservices, no social/multi-tenant goal today, no budget for cloud infra costs. Some of its
*feature* ideas were good and are folded into the roadmap below (auto-populated weather/moon
phase on harvest, yield-by-cut calculator, auto-draft blog text from log data, freezer inventory
→ recipe matching) — but as features built on the simple stack, not as a reason to adopt its
architecture.

Two real constraints did come out of that discussion and change the plan:

**1. Tenant-ready from day one, even as a single-user app.** Started as a private app for just
the user, but if hunting buddies want in later, the goal is "add a row to the Users table," not
a migration project. Concretely, as the schema and code get written:
- Every table holding personal data (hunt logs, harvest records, recipes, media) gets a
  `user_id` FK from the start, even though there's only one user row initially.
- All queries scope by `user_id`, even when there's only one user — a coding habit, not
  infrastructure to build.
- File/media storage goes behind a small abstraction (`save_media()` / `get_media_url()`)
  rather than scattered direct filesystem calls, so local disk can later be swapped for
  S3-compatible object storage without touching callers.
- Stick to portable SQLAlchemy (avoid SQLite-specific raw SQL) so SQLite → Postgres later is a
  connection-string change, not a rewrite.
- Config via env vars, not hardcoded values.
- Explicitly NOT doing yet (revisit only if a public/multi-tenant future actually happens):
  microservices, multiple databases, message queues, Elasticsearch/Mongo (Postgres/SQLite
  full-text search is plenty at this scale), signup/billing/email-verification flows.

**2. Offline-first hunt logging is a hard requirement, not a nice-to-have.** The user backpack
hunts with no cell signal and needs full hunt-logging functionality in the field. This rules out
a pure server-rendered-page approach for that flow specifically. Plan:
- The hunt-logging capture flow (only that flow, not the whole app) is a PWA: a service worker
  caches the app shell so it loads with no signal, and form data/photos are staged in IndexedDB
  until connectivity returns, then synced to the server explicitly. Single-user, single-device
  writes, so there's no real conflict-resolution problem to solve (unlike a multi-device
  multi-user offline-sync system).
- GPS coordinates are captured client-side via the device's GPS chip (works with zero cell
  signal) — no offline map tiles needed for v1. The user already uses OnX for actual offline
  field mapping; this app just needs to record lat/long, viewable later on a simple online map.
  Full offline map rendering (topo/property boundaries in-app) is a possible future upgrade, not
  a v1 requirement.
- Moon phase is computed client-side from date/time — no API or connectivity needed, ever.
- Live weather at time of harvest can't be fetched with no signal, so it isn't: the logged
  GPS coordinate + timestamp is used to backfill actual historical weather conditions from a
  weather API once the device is back online, which is more accurate than a live guess anyway.
- The rest of the app (regs/season lookup, recipes, browsing past logs) stays plain
  server-rendered pages — those don't need to work with no signal, so they don't carry the
  added complexity of the offline-first approach.

## Infrastructure notes

- Separate deployment from G&R: own LXC/systemd service, own SQLite DB, own backup/upgrade
  cycle — accepted tradeoff for keeping scope clean between the two apps.
- Login: likely a separate login from G&R rather than shared SSO, unless that becomes annoying
  enough in practice to revisit.
- Repo is **private** (unlike G&R, which is public) — this app will hold personal hunt
  photos/videos and location data, a different privacy profile than G&R's inventory data.

## Naming

Full name: **Hunting, Blogging and Cooking**. Abbreviation: **HB&C**. Considered and rejected
alternatives: "Just Another Hunting App" (JAHA — original working name), "Hunting, Blogging to
Table" (HBT). If this ever gets trademarked, it'll be filed as HB&C specifically (the ampersand
matters — plain "HBC" is Hudson's Bay Company's abbreviation, unrelated field, low real
collision risk but worth keeping the ampersand to stay distinct).
