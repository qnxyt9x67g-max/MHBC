// MHBC Service Worker — app-shell caching only.
// Database messaging removed along with the rest of the
// backend; C.A.R.E. Group chat now happens in Facebook Groups.
const CACHE = 'mhbc1';

const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json'];

// Third-party hosts we're also allowed to cache at runtime (fonts + QR lib).
// Font Awesome was removed from index.html — it wasn't used anywhere and
// was just adding a dead render-blocking request on every load.
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => {
        // Belt-and-suspenders: clear any stale home screen badge left over
        // from the old database push system, in case this SW update runs
        // before app.js gets a chance to. Support for the Badging API
        // inside a service worker varies by browser, so this is a backup
        // to the clearStaleAppBadge() call in app.js, not the primary fix.
        if ('clearAppBadge' in navigator) {
          return navigator.clearAppBadge().catch(() => {});
        } else if ('setAppBadge' in navigator) {
          return navigator.setAppBadge(0).catch(() => {});
        }
      })
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  var url = new URL(e.request.url);
  var isSameOrigin = url.origin === self.location.origin;
  var isRuntimeCDN = RUNTIME_HOSTS.indexOf(url.hostname) !== -1;

  if (!isSameOrigin && !isRuntimeCDN) return;

  // Stale-while-revalidate: answer from cache immediately when we have it
  // (near-instant open, no network round trip in the way), and refresh the
  // cache from the network in the background for next time. Falls back to
  // the network when nothing is cached yet (first-ever load).
  e.respondWith(
    caches.match(e.request).then((cached) => {
      var network = fetch(e.request)
        .then((response) => {
          // Cross-origin, no-cors requests (fonts/CDN) come back "opaque"
          // (status 0) and can't be inspected — cache those too, just skip
          // real same-origin error responses.
          if (response && (response.ok || response.type === 'opaque')) {
            var copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(e.request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
