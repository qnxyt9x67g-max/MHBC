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
const CACHE = 'mhbc-v2';

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
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

messaging.onBackgroundMessage(function(payload) {
  const title = (payload.notification && payload.notification.title) || "MHBC";
  const badgeCount = parseInt((payload.data && payload.data.badge) || "0", 10) || 0;

  const options = {
    body: (payload.notification && payload.notification.body) || "",
    icon: "https://maxwellhillbaptistchurch.com/wp-content/uploads/2024/10/MaxwellHill-Baptist-Favicon.png",
    badge: "https://maxwellhillbaptistchurch.com/wp-content/uploads/2024/10/MaxwellHill-Baptist-Favicon.png",
    data: payload.data || {}
  };

  self.registration.showNotification(title, options);

  if ('setAppBadge' in self.registration) {
    self.registration.setAppBadge(badgeCount).catch(function() {});
  } else if (badgeCount === 0 && 'clearAppBadge' in self.registration) {
    self.registration.clearAppBadge().catch(function() {});
  }
});
