// OpenHub PWA service worker.
//
// Cache policy:
//   - navigations (HTML): network-first, cached shell only as an offline fallback.
//     Cache-first HTML used to pin the app to whatever deploy was first cached,
//     so a phone kept running an old bundle forever after a rebuild.
//   - /assets/*: cache-first (Vite fingerprints these, so a new build gets new names)
//   - other same-origin static files: stale-while-revalidate
//   - /api, /ws, /ntfy, /v1: never cached (auth, streams, bot endpoints)
const CACHE = 'openhub-shell-v3';
const SHELL = ['/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
// A navigation fallback should not wait forever on a dead tunnel.
const NAV_TIMEOUT_MS = 3500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

/** Only same-origin http(s) GETs are cacheable; never intercept API/stream traffic. */
function isCacheable(request, url) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/ws/') || p.startsWith('/ntfy') || p.startsWith('/v1/')) return false;
  return true;
}

/** Network-first for HTML, falling back to the cached shell after a short timeout. */
async function handleNavigation(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('navigation timeout')), NAV_TIMEOUT_MS)),
    ]);
    // Never persist a private/authed page body over the shell.
    if (response && response.ok && response.type === 'basic') {
      cache.put('/index.html', response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    return (await cache.match('/index.html')) || Response.error();
  }
}

/** Cache-first for fingerprinted assets. */
async function handleAsset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok && response.type === 'basic') {
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

/** Stale-while-revalidate for icons/manifest/other static files. */
async function handleStatic(request, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    // Keep the revalidation alive after the cached response has been returned.
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

// Tapping an approval/finish notification focuses the app (or opens the editor).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow('/editor');
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!isCacheable(event.request, url)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(handleNavigation(event.request));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(handleAsset(event.request));
    return;
  }
  event.respondWith(handleStatic(event.request, event));
});
