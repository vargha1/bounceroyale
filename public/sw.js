/**
 * Bounce Royale Service Worker
 * ============================================================================
 *
 * Makes the game work fully offline. After the first visit, all assets are
 * cached locally — single-player AND LAN play work without an internet
 * connection.
 *
 * Strategy:
 *   - On install: pre-cache the static shell (index.html, logo, manifest).
 *   - On fetch (navigation): network-first, fall back to cached index.html.
 *     This ensures the user always gets the latest version when online but
 *     can still load the app offline.
 *   - On fetch (other GET requests): cache-first, fall back to network, then
 *     cache the response. This covers JS bundles, WASM, CSS, fonts, sounds,
 *     and images.
 *
 * Notes:
 *   - The WASM file (rapier_wasm3d_bg-*.wasm) is ~1.6 MB. After the first
 *     load it's cached and subsequent loads are instant + work offline.
 *   - We DO NOT cache socket.io requests (they go to a user-supplied server
 *     URL anyway, not our origin). Same for STUN/WebRTC traffic — that's not
 *     HTTP and doesn't go through the SW.
 *   - We use a versioned cache name so a deploy clears the old cache.
 *
 * The service worker is registered from src/main.tsx.
 */

const CACHE_NAME = 'bounceroyale-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './images/logo.png',
  './IRSANS.ttf',
  './sounds/jump.mp3',
  './sounds/collision.mp3',
  './sounds/break.mp3',
];

// Install: pre-cache the app shell. We use `addAll` so if ANY request fails,
// the whole install fails and we retry next time. The dynamically-built
// assets (chunked JS/WASM with hashed names) are NOT pre-cached here — they
// get cached on first fetch via the cache-first handler below.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use individual fetches with catch so a single 404 doesn't abort
      // the whole pre-cache (e.g., if a sound file is missing).
      return Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((e) => {
            console.warn('[SW] Pre-cache failed for', url, e);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches from previous versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch handler. We split strategies:
//   - Navigation requests (HTML pages): network-first, fall back to cache so
//     the app loads even when fully offline. This is the standard PWA pattern.
//   - Same-origin GET requests: cache-first. If it's not in the cache, fetch
//     from network and cache the response. This handles JS/CSS/WASM/fonts/
//     sounds/images with their hashed filenames (which we can't pre-cache).
//   - Cross-origin requests: don't cache (let them go to the network).
//   - Non-GET requests: don't intercept.
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET — POST/PUT/etc. go straight to network.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Skip cross-origin requests entirely (e.g., STUN doesn't go through here
  // anyway, but defensive — we don't want to cache third-party resources).
  if (url.origin !== self.location.origin) return;

  // Skip Vite HMR websocket in dev (not relevant in production but harmless).
  if (url.pathname.startsWith('/@vite') || url.pathname.startsWith('/__vite')) return;

  // Navigation requests → network-first.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Cache a copy of the latest index.html for offline use.
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => {
          // Offline — serve the cached index.html (or any cached navigation
          // response we have).
          return caches.match('./index.html').then(
            (cached) => cached || caches.match(req).then((c) => c || new Response(
              '<h1>Offline</h1><p>The game is not yet cached. Please go online once to enable offline play.</p>',
              { headers: { 'Content-Type': 'text/html' } }
            ))
          );
        })
    );
    return;
  }

  // All other same-origin GET requests → cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Refresh in background (stale-while-revalidate) so the next load
        // gets the latest version. We don't await this — return cached
        // immediately for fast load.
        fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
            }
          })
          .catch(() => { /* offline — ignore */ });
        return cached;
      }
      // Not in cache — fetch from network and cache the response.
      return fetch(req)
        .then((res) => {
          if (!res || res.status !== 200 || res.type === 'opaque') return res;
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => {
          // Offline and not cached — for WASM/CSS/JS this is fatal, but
          // returning a 508 makes the error visible in DevTools instead of
          // a generic TypeError.
          return new Response('Offline and resource not cached.', {
            status: 508,
            headers: { 'Content-Type': 'text/plain' },
          });
        });
    })
  );
});

// Allow the page to trigger an immediate update (we don't currently use this,
// but it's good hygiene for future PWA updates).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
