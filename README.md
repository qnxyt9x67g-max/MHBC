# MHBC App

Private community app for members of **Maxwell Hill Baptist Church**, Beckley, WV.
Installed as a Progressive Web App (PWA) on iOS and Android.

## What It Does

Members join one or more **C.A.R.E. Groups** (small groups). Tapping a group opens a
simple screen with a link to that group's private Facebook Group (where the actual
chat happens) and a link to that group's Praises & Prayer Requests sheet. The app also
has a live-service badge, Bible reader, giving links, and general church info.

**Rooms:** C101 · Narthex · Fellowship Hall 1st Floor · Fellowship Hall 2nd Floor · T.R.A.C.

## Architecture

This is now a fully static site — no backend, no database, no accounts. C.A.R.E. Group
chat, membership, and moderation are handled entirely by Facebook Groups instead of a
custom Firebase backend.

`app.js` just handles page navigation, the Bible reader, the install QR code, the
live-service badge (a plain day/time check, no server involved), and opening the right
external link (Facebook group, prayer sheet, YouTube, giving portal, etc.) for whatever
was tapped.

`sw.js` is a minimal service worker that caches the app shell (HTML/CSS/JS/manifest)
for offline/fast reloads. It no longer does anything Firebase- or push-notification-related.

Church Alerts is currently a "Coming soon" placeholder — not wired to anything yet.

## Files

| File            | Purpose                                    |
| ---------------- | ------------------------------------------ |
| `index.html`     | Main app shell                             |
| `app.js`         | All client logic                           |
| `styles.css`     | All styling                                |
| `sw.js`          | Service worker (app-shell caching only)    |
| `manifest.json`  | PWA configuration                          |

## No Longer Used

These files belonged to the old Firebase-backed chat/login/notifications system and can
be deleted from the repo — there's nothing in the new app that reads them:

- `index.js` (Cloud Functions)
- `firestore.rules`
- `Spam_resistance_deploy_guide.md` (a.k.a. `DEPLOY_GUIDE.md`)
- `backfill_approved_claims.js` (one-off migration script, if still present)
- Emergency/alternate build variants, since they were all built on top of the old
  Firebase-dependent `index.html` / `app.js` / `index.js`:
  - `Index_html_emergency_shutdown.html`
  - `app_js_emergency_shutdown.js`
  - `app_js_no_live_service.js`
  - `app_js_emergency_shutdown_and_no_live_service.js`
  - `Emergency_shut_down_Firestore_rules.txt`
  - `index_js_emergency_shutdown.js`
  - `index_js_no_service_reminders.js`

Any Firebase project resources (Firestore database, Cloud Functions, Authentication,
Cloud Messaging, App Check, the billing kill switch) can also be torn down in the
Firebase console once this is deployed, since nothing in the app talks to Firebase anymore.
