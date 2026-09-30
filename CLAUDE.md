# CLAUDE.md

Working notes for Claude Code sessions on this repo — conventions, workflow, decisions and their
reasons, and gotchas that aren't obvious from reading the code cold. `docs/VISION.md` has the
original planning/history narrative; this file is the practical, current operating manual. Keep
both in sync when either goes stale.

## What this is

FastAPI + Jinja2 + SQLAlchemy (SQLite) monolith, forked from a sibling project ("Guns & Reloading",
at `/home/chelo/inventory-and-reloading` on the dev machine — its `.venv` is reused to run this
app's dev server too, since it has the same dependencies installed). Session-based auth, admin
pages under `/admin/...`. Self-hosted for a single user (tenant-ready schema, not yet multi-user
in practice — see "Tenant-ready" in VISION.md).

Deployed at `/opt/hunting-blogging-and-cooking` on the production host, run via systemd unit
`hbc.service` (repo's `hbc.service` file is the source of truth for that unit). Self-upgrades via
`routers/upgrade.py` (git fetch + `merge --ff-only` + restart), exposed as the Upgrade page in the
app itself. Manual deploy when the self-upgrade mechanism itself is what's being fixed:
```bash
cd /opt/hunting-blogging-and-cooking
git pull
sudo systemctl restart hbc
```

## Workflow: branching, shipping, and when to batch vs. ship immediately

**Every PR that changes `main` must bump the root `VERSION` file and add a matching `## x.y.z`
section to `CHANGELOG.md`** (plain-English bullets, no raw commit messages) — in the *same* PR as
the change, not after. This isn't optional even for small/internal fixes. Reason: the Upgrade
page's "new version available" detection keys off `VERSION` changing (see
`_version_stops_between()`/`_changelog_entries_since()` in `routers/upgrade.py`) — skip the bump
and the page either looks broken (shows the version you're already on as "new") or silently hides
a real pending change. Got this wrong twice early on; the version-picker feature later surfaced a
much sneakier variant of the same class of bug (see Gotchas below).

**Two different shipping cadences, depending on the situation:**
- **A round of small, planned fixes** (the user is reporting several minor things in a batch, not
  urgent production breakage): create one branch, commit each fix to it as it's identified, and
  hold off on push/PR/merge until the user says to ship or clearly moves on. Bump VERSION/
  CHANGELOG once, in the final commit before shipping — not per individual fix.
- **An urgent, discrete production bug report on code that's already shipped** (a hotfix): ship it
  immediately as its own branch → PR → merge, one bug at a time, VERSION bump included. Don't
  batch these — the user is actively blocked on the live app.
Judge which mode applies from context, not just message count: several bug reports arriving in
quick succession while the user is actively using the deployed app, each describing something
broken *right now*, is the hotfix case even if there are many of them.

**PR/branch hygiene**: branches are created per fix/feature (`fix-...`, `add-...`, feature-name),
pushed, PR'd, and merged via `gh pr merge N --merge`. Merged branches are **not currently being
deleted** after merge — there's a long tail of stale local+remote branches from past work. Worth
cleaning up at some point (`git branch -d`/`git push origin --delete`), but hasn't been a priority.

## Testing discipline (and its limits)

**No JS runtime is available in the dev sandbox** — no `node`, `deno`, `bun`, or headless browser
(playwright etc.). This means:
- Client-side JS logic that matters (e.g. text-parsing logic, regex-heavy code) should be
  **prototyped and run in Python first** to validate the actual algorithm against real input, then
  carefully hand-ported to JS with a line-by-line comparison against the working Python version.
  This is not a formality — it's the closest thing to real verification available here, and it's
  caught real logic errors before shipping (see the ChatGPT-recipe-parser work).
- Anything that only a real browser can exercise (service worker fetch interception, actual
  Cache API behavior, click events, CSS layout/rendering) **cannot be verified in this
  environment** — say so explicitly rather than claiming it's tested, and flag it in the PR
  description as needing the user's on-device confirmation.

**Backend/API testing pattern**: create a temporary user directly via sqlite3 + bcrypt (matching
`dependencies.py`'s `_hash_pw` scheme), log in via curl against the running dev server
(`/home/chelo/inventory-and-reloading/.venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port
8129 --app-dir /home/chelo/hunting-blogging-and-cooking`), exercise the real endpoints, then
**always delete the temp user (and its session) afterward** and verify via a `SELECT username FROM
users` that only the real `chelo` account remains. Never leave test data behind, and never touch
the real user's actual rows.

**Schema changes**: `init_db()` in `database.py` runs `Base.metadata.create_all()` (creates
brand-new tables automatically — no extra step needed) followed by a manual `_add_col()` migration
list (needed for adding a column to a table that already exists on a deployed DB — SQLite `ALTER
TABLE ADD COLUMN`). Adding a new table needs nothing extra; adding a column to an existing table
needs a new `_add_col(...)` line or every query against it breaks with "no such column" the moment
the new code ships. After any schema change, restart the dev server (uvicorn was started without
`--reload` in most sessions so far) and confirm via `PRAGMA table_info(...)` that the migration
actually applied and existing rows weren't disturbed.

## Offline caching architecture (static/sw.js)

Three caches, each with a different policy — read the top-of-file comment in `static/sw.js` for
the full current reasoning, but in short:
- `hbc-static-{SW_VERSION}` — CDN libs, images, the per-page JS files (`hunting.js`, `logbook.js`,
  `recipes.js`). **Cache-first, never revalidates.** Bump `SW_VERSION` whenever the *content* of
  any file in `STATIC_URLS` changes, not just when `sw.js`'s own logic changes — this bit us once:
  a JS-only change (adding functions to `logbook.js`) shipped without a version bump, so an
  already-installed service worker kept serving the old file forever.
- `hbc-shell` / `hbc-data` — page shells and JSON data endpoints. **Stale-while-revalidate**: a
  cached copy is served instantly (zero network wait) if one exists, with a background fetch
  refreshing the cache for next time. This replaced an earlier network-first-with-timeout design
  that still made every navigation pay a fixed delay before showing anything — see git history
  around "stale-while-revalidate" for the full incident writeup. Deliberately **not**
  version-suffixed (tying them to `SW_VERSION` wiped them on every deploy, which once caused a
  real offline-loading outage after two rapid version bumps).
- Because stale-while-revalidate serves cache first unconditionally, **a user's own write could
  look stale to them** until the next background refresh. Fixed by `invalidateCache()` (duplicated
  in `logbook.js`, `hunting.js`, `recipes.js` — these pages deliberately don't share a bundled
  app.js) — call it after every successful create/edit/delete with the list of affected `hbc-data`
  URLs, so the very next load has nothing cached and falls through to a real fetch.

## Data model conventions

- **Free text over rigid taxonomy** for anything genuinely variable: recipe `servings` ("4-6"),
  `cooking_method` ("Slow cooker — LOW"), `cuisine`, weather fields, etc. are all plain nullable
  `String` columns, not enums or FKs to a lookup table. `game_type` is the one real fixed taxonomy
  (same 8 values used everywhere: Deer, Black Bear, Elk, Turkey, Upland Birds, Small Game,
  Migratory Birds, Trapping) since it's genuinely used for cross-cutting filtering.
- **Media attachments** (`HuntLogMedia`, `RecipeMedia`) follow one consistent pattern: `user_id`
  duplicated onto the child row (avoids a join for ownership checks), `media_type` ("photo" or
  "video"), `file_path` under `/static/uploads/...`, cascade-deleted with the parent row. Deleting
  a parent (recipe, logbook entry) must explicitly call `delete_uploaded_file()` for each attached
  media item **before** the DB cascade — the cascade only removes DB rows, not files on disk. This
  was missed once when recipe media was first added (caught in testing, not from copying the
  logbook pattern carefully enough) — always double check both sides when adding a new media type.
- **Tenant-ready from day one**: every table with personal data gets `user_id`, every query scopes
  by it, even though there's currently only one real user. See VISION.md's "Architecture
  principles" for the full reasoning.
- Pages that deliberately don't load a shared `app.js` (`hunting.js`, `logbook.js`, `recipes.js`,
  every `admin-*.html`) each carry their own small duplicated copies of `toggleUserMenu`/
  `openMobileNav`/`closeMobileNav`/`invalidateCache`. This is intentional, not an oversight — keep
  the duplication if adding a new standalone page, rather than introducing a shared bundle.

## Gotchas (things that cost real debugging time — don't repeat them)

1. **Never build an inline `onclick="fn(${JSON.stringify(x)})"` attribute.** `JSON.stringify`
   wraps its output in double quotes, which collide with the `onclick="..."` attribute's own
   double quotes — the browser truncates the attribute at the first quote it hits, silently
   breaking the handler with zero visible error. This exact bug took down the Upgrade page's
   button for an entire release. Use `data-*` attributes + `addEventListener` instead whenever a
   dynamic value needs to reach a click handler.
2. **Git's abbreviated hash (`%h`) is not a stable identity token.** Its minimum-unambiguous
   length is recalculated per invocation based on repo size, so the *same* commit can print at
   different lengths between two `git log` calls in the same request (e.g. one before a `git
   fetch`, one after) — breaking any `==` comparison between them. Always use the full hash (`%H`)
   for equality/identity checks; keep `%h` only for what's shown to the user.
3. **A `gh pr merge --merge` always creates a merge commit that doesn't touch whatever file you're
   using to detect "is there a pending update"** (e.g. `VERSION`). If your upgrade-target logic
   walks `git log -- VERSION` to find valid fast-forward stops, that trailing merge commit is
   invisible to it and unreachable — anchor the *last* stop to the actual branch tip, not just the
   last commit that touched the file you're watching.
4. **`navigator.onLine` is not equivalent to "genuinely offline."** It reliably reflects true
   OS-level disconnection (airplane mode, no radio) but does **not** flip to `false` under Chrome
   DevTools' "Offline" network throttling — that only blocks requests at the network layer. Don't
   trust a DevTools-based repro of an offline code path that branches on `navigator.onLine`;
   confirm against a real HAR trace from an actually-disconnected device if the symptom matters.
5. **Native `window.confirm()`/`alert()` can be silently suppressed inside an installed PWA's
   standalone display mode** on some mobile browsers — no dialog, no error, the code after it just
   never runs (since a suppressed `confirm()` returns falsy). Only fixed so far on the Upgrade
   page (replaced with a custom in-page modal); other `confirm()`-gated buttons elsewhere
   (delete actions in `logbook.js`/`recipes.js`/admin pages) likely have the same latent bug —
   apply the same fix if/when reported there.
6. **An installed Android PWA (WebAPK) does not reliably re-check its service worker on a normal
   force-stop + reopen.** `skipWaiting()` + `clients.claim()` in `sw.js` help but aren't sufficient
   by themselves for the *installed home-screen icon* specifically. If a shipped fix "doesn't work"
   on the user's phone but works fine in a private/incognito tab, that's confirmation it's stale
   PWA/service-worker state, not a code bug — the fix is **Android Settings → Apps → \[app] →
   Storage → Clear Cache** (or full "Clear storage"), then relaunch from the home screen. A regular
   browser tab (not the installed icon) is a faster way to test a fresh deploy without hitting
   this lag.
7. **Deleting a parent row with attached media must clean up files on disk, not just rely on the
   ORM cascade.** See "Media attachments" above.

## Current state (as of 0.9.3, 2026-09-30)

Shipped and working: hunt logbook (offline-capable creation/editing — including editing a
not-yet-synced pending entry, added after the original online-only assumption turned out wrong in
practice), scheduled hunts / multi-day trip logging, photo/video media on both logbook entries and
recipes, wild-game recipes (with Prep/Cook Time, Cooking Method, Servings, Cuisine, and a
"paste from ChatGPT" tab that auto-splits a recipe generated from the user's own ChatGPT template
into all the form fields — see `parseChatGptRecipe()` in `static/recipes.js`), weather auto-fill
on logbook entries (Open-Meteo, no API key), self-upgrade with per-version picking (not just
"jump to latest"), and the stale-while-revalidate offline caching rewrite.

**Known gaps, not yet addressed (mentioned to the user, not forgotten, just not asked for yet):**
- The multi-day trip form (`logbook_trip_form.html`) doesn't capture weather at all — the
  auto-fill feature only exists on the plain single-entry logbook form.
- Pending (not-yet-synced) **trip days** have the same "can't view/edit until synced" limitation
  that was fixed for plain logbook entries — same shape of fix would apply if it comes up.
- `confirm()`-gated delete buttons outside the Upgrade page haven't been swept for the standalone-
  PWA-suppression bug (see Gotcha #5) — only fix reactively if reported, per the user's own
  scoping preference expressed when the Upgrade page fix shipped.
- OnX GPX waypoint import: **explicitly on hold**, user has not decided the data model yet (a
  standalone "Spots" feature vs. importing each waypoint as a draft logbook entry — see git
  history / old memory for the two options discussed). Do not start building this without the
  user re-raising it.
- Long tail of merged-but-undeleted git branches (see "PR/branch hygiene" above) — cosmetic, not
  urgent.

## Naming

Full name **Hunting, Blogging and Cooking**, abbreviation **HB&C** (keep the ampersand — plain
"HBC" collides with Hudson's Bay Company). See `docs/VISION.md` for the full history/rationale
behind the project and its architecture decisions.
