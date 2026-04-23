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
// MHBC Service Worker — basic caching for PWA
const CACHE = 'mhbc-v1';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
messaging.onBackgroundMessage(function(payload) {
  const title = payload.notification?.title || "MHBC";
  const options = {
    body: payload.notification?.body || "",
    icon: "/icon.png"
  };

  self.registration.showNotification(title, options);

  if (payload.data && payload.data.badge) {
    if (navigator.setAppBadge) {
      navigator.setAppBadge(parseInt(payload.data.badge));
    }
  }
});
