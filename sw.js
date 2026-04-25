importScripts('https://www.gstatic.com/firebasejs/9.6.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.6.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBYt5RR0YGB9u9n7QgvAGXnvmrb7-xTg-Y",
  authDomain: "mhbc-app.firebaseapp.com",
  projectId: "mhbc-app",
  storageBucket: "mhbc-app.firebasestorage.app",
  messagingSenderId: "482094427911",
  appId: "1:482094427911:web:7ed5ec06b716ae66a4dfa2"
});

const messaging = firebase.messaging();

// MHBC Service Worker — caching + background notifications
const CACHE = 'mhbc-v3';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(response => {
        var copy = response.clone();

        caches.open(CACHE).then(cache => {
          if (
            e.request.method === 'GET' &&
            e.request.url.startsWith(self.location.origin)
          ) {
            cache.put(e.request, copy);
          }
        });

        return response;
      })
      .catch(() => caches.match(e.request))
  );
});

function updateClosedAppBadge(badgeCount) {
  badgeCount = parseInt(badgeCount || "0", 10) || 0;

  if (badgeCount > 0 && 'setAppBadge' in self.registration) {
    return self.registration.setAppBadge(badgeCount).catch(function() {});
  }

  if (badgeCount <= 0 && 'clearAppBadge' in self.registration) {
    return self.registration.clearAppBadge().catch(function() {});
  }

  return Promise.resolve();
}

messaging.onBackgroundMessage(function(payload) {
  const badgeCount = (payload.data && payload.data.badge) || "0";

  // Update iPhone/Mac installed-app badge while app is closed/backgrounded.
  return updateClosedAppBadge(badgeCount);
});
