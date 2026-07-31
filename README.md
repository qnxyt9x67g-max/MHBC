# MHBC App

Private community app for members of **Maxwell Hill Baptist Church**, Beckley, WV.  
Installed as a Progressive Web App (PWA) on iOS and Android.

## What It Does

Members join one or more **C.A.R.E. Groups** (small groups), each with its own private chat room. The app includes threaded replies, message editing/deletion, a live members directory, church-wide alerts, push notifications, and Home Screen icon badges for unread counts.

**Rooms:** C101 · Narthex · Fellowship Hall 1st Floor · Fellowship Hall 2nd Floor · T.R.A.C.

## Architecture

### Auth & Identity

Firebase Anonymous Auth provides a trusted device/session UID. A separate name + password system (stored in Firestore) handles human identity, account recovery, and portability across devices. Passwords are salted (SHA-256) and verified entirely server-side by the `verifyLoginV2` Cloud Function — the client sends the plaintext password over HTTPS and never reads a stored hash or salt directly. Repeated failed attempts trigger a server-enforced lockout (10 attempts / 15 minutes, tracked on the identity doc) in addition to a client-side guard. Admin status is assigned manually in the Firebase console.

Switching to a new device migrates a member's existing room membership(s) rather than creating a duplicate — an explicit login on one room verifies the password once and restores every other approved room automatically in the same step.

### Badges & Notifications

All badge counts (unread messages + pending approvals) are managed server-side by Cloud Functions. Clients only read the final computed values — keeping badge-related Firestore costs near zero.

Client writes to a user's own `users/{uid}` doc (badge-clearing, token registration) are restricted by Firestore rules to an explicit field whitelist. Since Firestore evaluates that whitelist against the *entire resulting document*, not just the fields being written, any new field added to `users/{uid}` anywhere in the codebase — client or Cloud Function — must also be added to that whitelist, or every future client write to that document will start silently failing.

### Messages & Offline Support

Each room uses a hybrid cache: up to 500 recent messages stored in `localStorage` + live `onSnapshot` listeners. Switching rooms is instant if cached data is available.

### Push Notifications

Powered by FCM through a service worker (`sw.js`). Background badge updates and notifications are handled by Cloud Functions sending data payloads.

### Abuse & Cost Protection

The app includes layered safeguards — spanning Firestore security rules, Cloud Functions, and a billing-level kill switch — against spam, account abuse, and runaway Firebase costs. Specifics are intentionally not documented here; see `DEPLOY_GUIDE.md` (not committed to this public repo) if you need the details.

## Emergency and Alternate Builds

To quickly respond to maintenance, outages, or special events, several pre-built emergency variants are maintained. These are **not** deployed by default; swap them in place of the normal files only when needed.

**Frontend Shell (`index.html` variants)**
- `Index_html_emergency_shutdown.html` — Dims the Church Alerts quick-access button and the C.A.R.E. Groups bottom-nav button (`data-maintenance` + reduced opacity). Pair with the matching `app.js` variant so taps show a short “Temporarily unavailable” toast and do not open those screens.

**Frontend Logic (`app.js` variants)**
- `app_js_emergency_shutdown.js` — On Church Alerts, C.A.R.E. nav, and room-select taps: shows a “Temporarily unavailable” toast and does not open those features. LIVE service badge still follows the normal schedule.
- `app_js_no_live_service.js` — Forces the LIVE badge off (and clears live styling on Watch / YouTube / Facebook). Chat, alerts, and the rest of the app work normally.
- `app_js_emergency_shutdown_and_no_live_service.js` — Both of the above together.

Deploy **both** the emergency `index.html` and emergency `app.js` together for the client-side Care Groups / Church Alerts lockout. The HTML dims the buttons; the JS blocks navigation and shows the toast.

**Firestore rules variant**
- `Emergency_shut_down_Firestore_rules.txt` — Optional tighter rules for a deeper lockout at the database layer. Use only if you also need server-side denial of the corresponding writes/reads; otherwise the HTML + `app.js` pair is enough for the UI lockout described above.

**Backend Functions (`index.js` variants)**
- `index_js_emergency_shutdown.js` — Global kill switch (disables all triggers)
- `index_js_no_service_reminders.js` — Keeps chat & alerts active but disables automated reminders

## Cloud Functions

| Function                        | Trigger                  | Purpose |
|--------------------------------|---------------------------|-------|
| `onNewMessageV2`               | New message document      | Update unread counts and send push notifications |
| `onMemberRequestChangedV2`     | Member document change    | Manage pending approvals and send admin notifications |
| `onChurchAlertCreatedV2`       | New church alert          | Broadcast alert and update badges |
| `sundayServiceReminderV2`      | Cron (Sun 9:00 AM ET)     | Pre-service reminder |
| `wednesdayServiceReminderV2`   | Cron (Wed 6:30 PM ET)     | Pre-service reminder |
| `verifyLoginV2`                | Callable                  | Server-side room + personal password verification and lockout |
| `migrateUidV2`                 | Callable                  | Migrate single group membership (kept deployed for compatibility; not currently called by the login flow, which now uses `migrateAllGroupsV2` alone) |
| `migrateAllGroupsV2`           | Callable                  | Migrate all groups + tokens |
| `migrateTokenV2`               | Callable                  | Migrate FCM token to new UID |
| `getChurchAlertV2`             | HTTP request               | Public read-only endpoint for the latest church alert (used by the GitHub Pages front end) |
| `spamTrapV2`                   | New identity document      | Abuse protection for account/identity creation |
| `messageSpamTrapV2`            | Message create/edit        | Abuse protection for chat volume |
| `alertSpamTrapV2`              | New church alert           | Abuse protection for church-alert volume |
| `globalSpamTrapV2`             | New `users/{uid}` document | Abuse protection for app |
| `stopBillingV2`                | Pub/Sub (billing alert)    | Emergency billing kill switch |

## Files

| File                | Purpose |
|---------------------|---------|
| `index.html`        | Main app shell |
| `app.js`            | Core client logic |
| `styles.css`        | All styling |
| `sw.js`             | Service worker (caching + background FCM) |
| `manifest.json`     | PWA configuration |
| `index.js`          | Cloud Functions (backend logic) |
| `firestore.rules`   | Security rules |
