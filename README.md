# MHBC App

Private community app for members of **Maxwell Hill Baptist Church**, Beckley, WV.
Installed as a Progressive Web App (PWA) on iOS and Android.

## What It Does

Members join one or more **C.A.R.E. Groups** (small groups). Tapping a group opens a
simple screen with a link to that group's private Facebook Group (where the actual
chat happens) and a link to that group's Praises & Prayer Requests sheet. The app also
has a live-service badge, Bible reader, giving links, and general church info.

**Rooms:** C101 · Narthex · Fellowship Hall 1st Floor · Fellowship Hall 2nd Floor · Music Room

## Architecture

This is now a fully static site — no backend, no database, no accounts. C.A.R.E. Group
chat, membership, and moderation are handled entirely by Facebook Groups.

`app.js` just handles page navigation, the Bible reader, the install QR code, the
live-service badge (a plain day/time check, no server involved), and opening the right
external link (Facebook group, prayer sheet, YouTube, giving portal, etc.) for whatever
was tapped.

### Canceling a service (snow day, etc.)

Near the top of `app.js` there's a manual override flag:

```js
var LIVE_SERVICE_ENABLED = true;
```

If a service is canceled, edit this file in GitHub and change it to `false`. That
stops the "live now" badge/pulse from showing during the normal service window, no
matter what the day/time schedule says. Change it back to `true` once services
resume as normal.

### Going live for an unscheduled service (special event, funeral, etc.)

Right below that is a second manual override flag:

```js
var UNSCHEDULED_LIVE_SERVICE = false;
```

For a live service that isn't on the normal Sun/Wed schedule, edit this file in
GitHub and change it to `true`. That turns on the "live now" badge/pulse
immediately, no matter what the day/time schedule says (and regardless of
`LIVE_SERVICE_ENABLED`). It does not turn itself off — change it back to `false`
as soon as that service ends.

`sw.js` is a minimal service worker that caches the app shell (HTML/CSS/JS/manifest)
for offline/fast reloads. It no longer does anything database- or push-notification-related.


## Files

| File            | Purpose                                    |
| ---------------- | ------------------------------------------ |
| `index.html`     | Main app shell                             |
| `app.js`         | All client logic                           |
| `styles.css`     | All styling                                |
| `sw.js`          | Service worker (app-shell caching only)    |
| `manifest.json`  | PWA configuration                          |

