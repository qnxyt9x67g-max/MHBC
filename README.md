# MHBC App

Private community app for members of **Maxwell Hill Baptist Church**, Beckley, WV.  
Installed as a Progressive Web App (PWA) on iOS and Android.

## What It Does

Members join one or more **C.A.R.E. Groups** (small groups), each with its own private chat room. The app includes threaded replies, message editing/deletion, a live members directory, church-wide alerts, push notifications, and Home Screen icon badges for unread counts.

**Rooms:** C101 · Narthex · Fellowship Hall 1st Floor · Fellowship Hall 2nd Floor · T.R.A.C.

## Architecture

### Auth & Identity

Firebase Anonymous Auth provides a trusted device/session UID. A separate name + password system (stored in Firestore) handles human identity, account recovery, and portability across devices. Admin status is assigned manually in the Firebase console.

### Badges & Notifications

All badge counts (unread messages + pending approvals) are managed server-side by Cloud Functions. Clients only read the final computed values — keeping badge-related Firestore costs near zero.

### Messages & Offline Support

Each room uses a hybrid cache: up to 500 recent messages stored in `localStorage` + live `onSnapshot` listeners. Switching rooms is instant if cached data is available.

### Push Notifications

Powered by FCM through a service worker (`sw.js`). Background badge updates and notifications are handled by Cloud Functions sending data payloads.

## Emergency and Alternate Builds

To quickly respond to maintenance, outages, or special events, several pre-built emergency variants are maintained:

**Frontend Shell (`index.html` variants)**
- `Index_html_emergency_shutdown.html` — Full maintenance lockout with overlay

**Frontend Logic (`app.js` variants)**
- `app_js_emergency_shutdown.js` — Complete client-side lockout
- `app_js_no_live_service.js` — Disables only live service / watch features
- `app_js_emergency_shutdownand_no_live_service.js` — Combined shutdown

**Backend Functions (`index.js` variants)**
- `index_js_emergency_shutdown.js` — Global kill switch (disables all triggers)
- `index_js_no_service_reminders.js` — Keeps chat & alerts active but disables automated reminders

## Cloud Functions

| Function                        | Trigger                  | Purpose |
|--------------------------------|--------------------------|-------|
| `onNewMessageV2`               | New message document     | Update unread counts and send push notifications |
| `onMemberRequestChangedV2`     | Member document change   | Manage pending approvals and send admin notifications |
| `onChurchAlertCreatedV2`       | New church alert         | Broadcast alert and update badges |
| `sundayServiceReminderV2`      | Cron (Sun 9:00 AM ET)    | Pre-service reminder |
| `wednesdayServiceReminderV2`   | Cron (Wed 6:30 PM ET)    | Pre-service reminder |
| `migrateUidV2`                 | Callable                 | Migrate single group membership |
| `migrateAllGroupsV2`           | Callable                 | Migrate all groups + tokens |
| `migrateTokenV2`               | Callable                 | Migrate FCM token to new UID |

## Files

| File                | Purpose |
|---------------------|---------|
| `index.html`        | Main app shell |
| `app.js`            | Core client logic |
| `styles.css`        | All styling |
| `sw.js`             | Service worker (caching + background FCM) |
| `manifest.json`     | PWA configuration |
| `index.js`          | Cloud Functions (backend logic) |
| `Firestore_Rules`   | Security rules |
