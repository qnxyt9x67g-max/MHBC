// MHBC Service Worker — app-shell caching only.
// Firebase Cloud Messaging removed along with the rest of the Firebase
// backend; C.A.R.E. Group chat now happens in Facebook Groups.
const CACHE = 'mhbc125';

const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json'];

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
        // from the old Firebase push system, in case this SW update runs
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
  // Only intercept same-origin requests (the app shell: HTML/CSS/JS/manifest).
  if (!e.request.url.startsWith(self.location.origin)) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((response) => {
        var copy = response.clone();

        caches.open(CACHE).then((cache) => {
          if (e.request.method === 'GET') {
            cache.put(e.request, copy);
          }
        });

        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
