// Offline read-caching service worker. Read-only: mutations (non-GET) always go straight to
// network. This covers "I already loaded the page with signal, keep it viewable offline" —
// the separate offline hunt-logging capture flow (writing new entries with zero signal) is a
// future phase (see docs/VISION.md) that needs its own IndexedDB write-queue, not handled here.
//
// Three independent caches, each with its own eviction policy:
//   hbc-static-{VERSION} — CDN libs (Tailwind), site images, JS — cache-first, name changes on
//                every SW_VERSION bump so stale code/assets can never linger past an update;
//                never purged on login/logout since nothing here is user-specific.
//   hbc-shell — the page shells reachable via normal browsing — network-first w/ cache fallback,
//               purged on every /login render. Deliberately NOT version-suffixed — see the note
//               by SW_VERSION below for why.
//   hbc-data — JSON from the hunting states/seasons/regulations endpoints — network-first w/
//              cache fallback, purged on every /login render. Also not version-suffixed.
//
// SW_VERSION is a manual bump — bump it whenever this file's caching behavior changes, AND
// whenever the content of any STATIC_URLS entry changes (hunting.js, logbook.js, recipes.js,
// manifest.json, images, ...). STATIC_CACHE is cache-first and never revalidates an asset it
// already has, so an already-installed service worker keeps serving the old cached copy of e.g.
// logbook.js forever after a deploy unless the cache name itself changes.
const SW_VERSION = 'v17';
const STATIC_CACHE = `hbc-static-${SW_VERSION}`;
// Shell/data caches are deliberately NOT version-suffixed, unlike hbc-static. Static JS/CSS
// needs hard cache-busting on every release (cache-first would otherwise serve stale code
// forever), but shell/data are network-first-with-cache-fallback — fresh content is always
// preferred when online, and the cached copy is only ever seen at all once genuinely offline.
// Tying their name to SW_VERSION meant every version bump wiped them via the activate cleanup
// below; a device that went offline before its next online page visit repopulated them lost
// offline loading completely instead of just serving a page from a version or two back — a real
// incident (see the 2026-09-24 discussion): two SW_VERSION bumps in quick succession, then
// offline before a fresh online reload, and the app failed to load at all.
const SHELL_CACHE = 'hbc-shell';
const DATA_CACHE = 'hbc-data';
const KNOWN_CACHES = [STATIC_CACHE, SHELL_CACHE, DATA_CACHE];

// A plain `fetch()` doesn't fail fast when there's no connectivity — depending on the network
// stack it can take anywhere from a few seconds to 20+ before actually giving up, and every
// network-first handler below was waiting on that full hang before ever falling back to cache
// (confirmed via a real offline DevTools trace: identical elapsed time between the failed
// network attempt and the eventual cached response, up to 23s on one request). Racing every
// fetch against this timeout means a dead connection falls back to cache in ~2.5s instead.
// This is still only a bound for the "connected but stalled" case (weak signal, captive portal) —
// when the OS already knows there's no connection at all (navigator.onLine === false), handleShell
// and handleData skip the race entirely and read cache straight away, since a real browsing
// session fires many of these per screen and paying 2.5s on each one added right back up to
// feeling just as slow as before (see the 2026-09-24 HAR trace, v13: every single request during
// a no-signal session stalling ~2.5s in a row).
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

// Marks a response as served from the offline cache so page JS can optionally distinguish
// stale/cached data from a live fetch — cloning is required since Response.headers is
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

async function handleShell(req, url) {
  // The 2.5s network race below only protects against a connection that's live but stalled
  // (weak signal, captive portal). When the OS already knows there's no connection at all,
  // navigator.onLine is false and there's no point paying that 2.5s on every single navigation —
  // a real offline session fires this dozens of times as you tap around, and it was adding up to
  // feeling just as slow as the original unbounded hang (see the 2026-09-24 HAR trace: every
  // request stalling ~2.5s back to back). Go straight to cache in that case instead.
  if (!self.navigator.onLine) {
    const cached = await caches.match(req, { cacheName: SHELL_CACHE });
    if (cached) return withOfflineHeader(cached);
  }
  try {
    const resp = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
    if (isSafeToCache(resp) && new URL(resp.url).pathname !== '/login') {
      (await caches.open(SHELL_CACHE)).put(req, resp.clone());
    }
    return resp;
  } catch (e) {
    const cached = await caches.match(req, { cacheName: SHELL_CACHE });
    if (cached) return withOfflineHeader(cached);
    throw e;
  }
}

async function handleData(req) {
  // See the matching comment in handleShell — same reasoning applies to data endpoints, which
  // are fetched even more often per page (states, seasons, regulations, scheduled hunts, ...).
  if (!self.navigator.onLine) {
    const cached = await caches.match(req, { cacheName: DATA_CACHE });
    if (cached) return withOfflineHeader(cached);
  }
  try {
    const resp = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
    if (isSafeToCache(resp)) (await caches.open(DATA_CACHE)).put(req, resp.clone());
    return resp;
  } catch (e) {
    const cached = await caches.match(req, { cacheName: DATA_CACHE });
    if (cached) return withOfflineHeader(cached);
    throw e;
  }
}

async function route(req, url) {
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
    return handleShell(req, url);
  }

  if (DATA_PATTERNS.some((re) => re.test(url.pathname))) return handleData(req);

  return fetch(req);
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  event.respondWith(route(event.request, url));
});
