// Offline read-caching service worker. Read-only: mutations (non-GET) always go straight to
// network. This covers "I already loaded the page with signal, keep it viewable offline" —
// the separate offline hunt-logging capture flow (writing new entries with zero signal) is a
// future phase (see docs/VISION.md) that needs its own IndexedDB write-queue, not handled here.
//
// Three independent caches, each with its own eviction policy:
//   hbc-static — CDN libs (Tailwind), site images, manifest.json — cache-first, never purged on
//                login/logout since nothing here is user-specific.
//   hbc-shell  — the page shells reachable via normal browsing — network-first w/ cache
//                fallback, purged on every /login render.
//   hbc-data   — JSON from the hunting states/seasons/regulations endpoints — network-first w/
//                cache fallback, purged on every /login render.
//
// SW_VERSION is a manual bump — bump it whenever this file's caching behavior changes.
const SW_VERSION = 'v1';
const STATIC_CACHE = `hbc-static-${SW_VERSION}`;
const SHELL_CACHE = `hbc-shell-${SW_VERSION}`;
const DATA_CACHE = `hbc-data-${SW_VERSION}`;
const KNOWN_CACHES = [STATIC_CACHE, SHELL_CACHE, DATA_CACHE];

const STATIC_URLS = [
  '/static/manifest.json',
  '/static/images/app-icon.png',
  '/static/images/icon-192.png',
  '/static/images/icon-512.png',
  '/static/images/logo.png',
  '/static/images/background.png',
  '/static/images/background-widescreen.png',
  '/static/images/phone-background.png',
  '/static/hunting.js',
];
// Fetched individually (not via cache.addAll, which is all-or-nothing) so a CDN hiccup during
// install doesn't fail the whole install.
const CROSS_ORIGIN_URLS = [
  'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4',
];

// Exact-match shell routes (server ignores no query string for these).
const SHELL_EXACT = ['/', '/index.html'];

// The hunting reference data this app currently exposes — small, always network-first with
// cache fallback so a stale copy is only ever served when the network genuinely isn't there.
const DATA_PATTERNS = [
  /^\/hunting\/states$/,
  /^\/hunting\/states\/\d+\/seasons$/,
  /^\/hunting\/states\/\d+\/regulations$/,
  /^\/hunting\/states\/\d+\/game-types$/,
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
    const resp = await fetch(req);
    if (resp.ok) (await caches.open(STATIC_CACHE)).put(req, resp.clone());
    return resp;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

async function handleShell(req, url) {
  try {
    const resp = await fetch(req);
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
  try {
    const resp = await fetch(req);
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

  if (req.mode === 'navigate' && SHELL_EXACT.includes(url.pathname)) {
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
