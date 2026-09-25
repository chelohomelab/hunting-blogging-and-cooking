// Offline read-caching service worker. Read-only: mutations (non-GET) always go straight to
// network. This covers "I already loaded the page with signal, keep it viewable offline" —
// the separate offline hunt-logging capture flow (writing new entries with zero signal) is a
// future phase (see docs/VISION.md) that needs its own IndexedDB write-queue, not handled here.
//
// Three independent caches, each with its own eviction policy:
//   hbc-static-{VERSION} — CDN libs (Tailwind), site images, JS — cache-first, name changes on
//                every SW_VERSION bump so stale code/assets can never linger past an update;
//                never purged on login/logout since nothing here is user-specific.
//   hbc-shell — the page shells reachable via normal browsing — stale-while-revalidate (see
//               below), purged on every /login render. Deliberately NOT version-suffixed — see
//               the note by SW_VERSION below for why.
//   hbc-data — JSON from the hunting states/seasons/regulations/logbook/recipes endpoints —
//              stale-while-revalidate, purged on every /login render. Also not version-suffixed.
//
// hbc-shell and hbc-data both use stale-while-revalidate: a cached copy, if one exists, is
// returned IMMEDIATELY with no network wait at all, while a background fetch silently refreshes
// the cache for next time. This replaced an earlier network-first-with-timeout design (racing
// every request against a bound, with a navigator.onLine check to skip the race when already
// known offline) — that still made every single navigation pay up to that bound before showing
// anything, and a real session fires many of these per screen (the page shell, then list data,
// then per-item data on the next tap), so the wait kept compounding into feeling just as slow as
// before even once each individual request was fast (2026-09-24/25 discussion, HAR traces).
// Stale-while-revalidate removes the wait entirely for anything already cached. The tradeoff:
// a screen can show data that's a write or two behind what's actually on the server until the
// background refresh lands — logbook.js explicitly deletes the relevant hbc-data entries right
// after your own successful writes (see invalidateCache() there) specifically so your own
// changes never look stale to you; a change made from a different device would still take one
// extra background-refresh cycle to show up here.
//
// SW_VERSION is a manual bump — bump it whenever this file's caching behavior changes, AND
// whenever the content of any STATIC_URLS entry changes (hunting.js, logbook.js, recipes.js,
// manifest.json, images, ...). STATIC_CACHE is cache-first and never revalidates an asset it
// already has, so an already-installed service worker keeps serving the old cached copy of e.g.
// logbook.js forever after a deploy unless the cache name itself changes.
const SW_VERSION = 'v18';
const STATIC_CACHE = `hbc-static-${SW_VERSION}`;
// Shell/data caches are deliberately NOT version-suffixed, unlike hbc-static. Tying their name to
// SW_VERSION meant every version bump wiped them via the activate cleanup below; a device that
// went offline before its next online page visit repopulated them lost offline loading
// completely instead of just serving a page from a version or two back — a real incident (see
// the 2026-09-24 discussion): two SW_VERSION bumps in quick succession, then offline before a
// fresh online reload, and the app failed to load at all.
const SHELL_CACHE = 'hbc-shell';
const DATA_CACHE = 'hbc-data';
const KNOWN_CACHES = [STATIC_CACHE, SHELL_CACHE, DATA_CACHE];

// No longer a foreground wait on every navigation — bounds two background things instead:
// (1) the very first fetch of a URL that isn't cached yet, since there's nothing to fall back to
// and it still shouldn't hang forever, and (2) the background revalidation fetch in
// handleShell/handleData, so a stalled connection doesn't leave zombie fetches piling up.
const NETWORK_TIMEOUT_MS = 2500;

function fetchWithTimeout(req, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(new Request(req, { signal: controller.signal })).finally(() => clearTimeout(timer));
}

const STATIC_URLS = [
  '/static/manifest.json',
  '/static/images/app-icon.png',
  '/static/images/icon-192.png',
  '/static/images/icon-512.png',
  '/static/images/logo.png',
  '/static/images/background.png',
  '/static/images/background-widescreen.png',
  '/static/images/phone-background.png',
  '/static/images/logbook_background.jpeg',
  '/static/images/phone_logbook_background.jpeg',
  '/static/images/recipes-background-widescreen.jpeg',
  '/static/images/phone-recipes-background.png',
  '/static/hunting.js',
  '/static/logbook.js',
  '/static/recipes.js',
];
// Fetched individually (not via cache.addAll, which is all-or-nothing) so a CDN hiccup during
// install doesn't fail the whole install.
const CROSS_ORIGIN_URLS = [
  'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4',
];

// Exact-match shell routes (server ignores no query string for these).
const SHELL_EXACT = ['/', '/index.html', '/hunting', '/logbook', '/logbook/new', '/recipes', '/recipes/new'];

// Per-id shell routes: /logbook/{id}, /logbook/{id}/edit, /logbook/trip/{id},
// /logbook/trip/{id}/edit, /recipes/{id}, /recipes/{id}/edit. These used to be left uncached
// entirely on the theory that viewing one always needs a live fetch anyway — but that meant
// falling all the way through route() to a bare, un-timed, un-cached fetch() with zero offline
// fallback (confirmed via a real HAR trace: these came back completely blank, not just slow).
// That's exactly wrong for the trip-logging flow in particular, which is explicitly supposed to
// keep working offline once a trip's been started (see CHANGELOG 0.6.0) — you start a trip with
// signal, then need to reopen it with none to add a day. Cache-keying is per full URL (each id
// gets its own entry), same as any other request, so this doesn't require anything special.
const SHELL_PATTERNS = [
  /^\/logbook\/\d+$/,
  /^\/logbook\/\d+\/edit$/,
  /^\/logbook\/trip\/\d+$/,
  /^\/logbook\/trip\/\d+\/edit$/,
  /^\/recipes\/\d+$/,
  /^\/recipes\/\d+\/edit$/,
];

// The hunting reference data and the user's own logbook entries — small, always network-first
// with cache fallback so a stale copy is only ever served when the network genuinely isn't
// there. (Creating a NEW logbook entry offline doesn't go through this at all — that's a POST,
// which this service worker never intercepts; see the write-queue in logbook.js instead.)
const DATA_PATTERNS = [
  /^\/hunting\/states$/,
  /^\/hunting\/states\/\d+\/seasons$/,
  /^\/hunting\/states\/\d+\/regulations$/,
  /^\/hunting\/states\/\d+\/game-types$/,
  /^\/api\/logbook$/,
  /^\/api\/logbook\/\d+$/,
  /^\/api\/scheduled-hunts$/,
  /^\/api\/scheduled-hunts\/\d+$/,
  /^\/api\/recipes$/,
  /^\/api\/recipes\/\d+$/,
  /^\/api\/recipes\/harvest-options$/,
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(STATIC_URLS);
    await Promise.allSettled(
      CROSS_ORIGIN_URLS.map(async (url) => {
        try {
          const resp = await fetch(url, { mode: 'cors' });
          if (resp.ok) await cache.put(url, resp);
        } catch (_) {
          // Offline install or CDN hiccup — non-fatal, retried opportunistically on next
          // successful fetch of the same URL (won't happen automatically, but doesn't block
          // install of everything else).
        }
      })
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !KNOWN_CACHES.includes(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function purgeUserScopedCaches() {
  await Promise.all([caches.delete(SHELL_CACHE), caches.delete(DATA_CACHE)]);
}

// Marks a response as served from the cache (not necessarily because offline — under
// stale-while-revalidate this fires on every cache hit, online or not) so page JS can optionally
// distinguish cached data from a live fetch — cloning is required since Response.headers is
// otherwise immutable once constructed from a cache read.
function withOfflineHeader(resp) {
  const headers = new Headers(resp.headers);
  headers.set('X-Served-From', 'sw-cache');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

// AuthMiddleware 302-redirects any unauthenticated request to /login. If a session expires
// while this SW does a network-first fetch, fetch() follows that redirect transparently and
// returns a 200 HTML login page — caching that under the original request's cache key would
// silently poison the shell/data cache with login-page content. Guard against it here.
function isSafeToCache(resp) {
  return resp.ok && !resp.redirected;
}

function isStaticAsset(url) {
  return STATIC_URLS.includes(url.pathname) || CROSS_ORIGIN_URLS.includes(url.href);
}

async function handleStatic(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const resp = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
    if (resp.ok) (await caches.open(STATIC_CACHE)).put(req, resp.clone());
    return resp;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

// Stale-while-revalidate: return a cached copy instantly if one exists (no network wait at all),
// and kick off a background fetch to refresh the cache for next time via event.waitUntil (so the
// refresh can finish even after the response above has already been sent). If nothing is cached
// yet — the very first visit to this URL — there's nothing to serve instantly, so this falls
// back to just awaiting the network fetch directly, bounded by NETWORK_TIMEOUT_MS as before.
async function staleWhileRevalidate(req, cacheName, event, extraSafetyCheck) {
  const cached = await caches.match(req, { cacheName });

  const refresh = (async () => {
    try {
      const resp = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
      if (isSafeToCache(resp) && (!extraSafetyCheck || extraSafetyCheck(resp))) {
        (await caches.open(cacheName)).put(req, resp.clone());
      }
      return resp;
    } catch (e) {
      return null; // Background refresh failed silently — the cache (if any) just stays as-is.
    }
  })();

  if (cached) {
    if (event) event.waitUntil(refresh);
    return withOfflineHeader(cached);
  }

  const resp = await refresh;
  if (resp) return resp;
  throw new Error(`${cacheName}: nothing cached and network failed`);
}

function handleShell(req, url, event) {
  return staleWhileRevalidate(req, SHELL_CACHE, event, (resp) => new URL(resp.url).pathname !== '/login');
}

function handleData(req, event) {
  return staleWhileRevalidate(req, DATA_CACHE, event);
}

async function route(req, url, event) {
  if (url.pathname === '/login' && req.mode === 'navigate') {
    let resp;
    try {
      resp = await fetch(req);
    } finally {
      await purgeUserScopedCaches();
    }
    return resp;
  }

  if (isStaticAsset(url)) return handleStatic(req);

  if (req.mode === 'navigate' && (SHELL_EXACT.includes(url.pathname) || SHELL_PATTERNS.some((re) => re.test(url.pathname)))) {
    return handleShell(req, url, event);
  }

  if (DATA_PATTERNS.some((re) => re.test(url.pathname))) return handleData(req, event);

  return fetch(req);
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  event.respondWith(route(event.request, url, event));
});
