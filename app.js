// ============================================================
// MHBC App — app.js
// Maxwell Hill Baptist Church — Beckley, WV
//
// Static PWA. No backend: C.A.R.E. Group chat now happens in private
// Facebook Groups (see ROOM_FB_LINKS below) instead of database.
// This file just handles page navigation, the Bible reader, the install
// QR code, the live-service badge, and opening the right external links.
// ============================================================

// ---- LIVE SERVICE MANUAL OVERRIDE ----
// Normally the "live now" badge/pulse turns on automatically based on the
// day/time schedule below (see checkLiveBadge). If a service is canceled
// (snow day, etc.), set this to false and the badge/pulse will stay off
// no matter what the schedule says — even during the normal live window.
// Set it back to true once services resume as normal.
var LIVE_SERVICE_ENABLED = true;

// ---- UNSCHEDULED LIVE SERVICE MANUAL OVERRIDE ----
// For a live service that ISN'T on the normal schedule (a special event,
// funeral, etc.). Set this to true and the badge/pulse will turn on
// immediately, regardless of the day/time schedule below and regardless
// of LIVE_SERVICE_ENABLED. Set it back to false as soon as that service
// ends — it does not turn itself off.
var UNSCHEDULED_LIVE_SERVICE = false;

// ---- C.A.R.E. GROUP LINKS ----
// Facebook group link + prayer/praise request sheet for each room.
var ROOM_FB_LINKS = {
  c101: 'https://www.facebook.com/share/g/1ETLR3hZyK/?mibextid=wwXIfr',
  narthex: 'https://www.facebook.com/share/g/19Au7VGq6W/?mibextid=wwXIfr',
  fellowship1: 'https://www.facebook.com/share/g/1DkToTXiyq/?mibextid=wwXIfr',
  fellowship2: 'https://www.facebook.com/share/g/1Hq4o6F4hE/?mibextid=wwXIfr',
  musicroom: 'https://www.facebook.com/share/g/185NBEvPWX/?mibextid=wwXIfr'
};

var PRAYER_LINKS = {
  c101: 'https://docs.google.com/spreadsheets/d/1-7kNm-5l8F1okka9bU4mpvQDXd2OusWYNQeC9PuJnZQ/edit?usp=drivesdk',
  narthex:
    'https://docs.google.com/spreadsheets/d/1GZUm483lFgxLGM5o6NJBH3z5Fri2FCekFzuKNXF1TgM/edit?usp=drivesdk',
  fellowship1:
    'https://docs.google.com/spreadsheets/d/1Dw8g6q_dE-3ObNr5jbddJ5CIqnzo1NtbU3ZGjoTn1Ws/edit?usp=drivesdk',
  fellowship2:
    'https://docs.google.com/spreadsheets/d/1dVE3TlLK3svbtA2Qp-wxnQJE_ztXLwBzvCW32F0pDI8/edit?usp=drivesdk',
  musicroom: 'https://docs.google.com/spreadsheets/d/1UlIxBJS2ZZlX5QnsjGIckcULLsZ6r7U6mNtaDVe3udQ/edit?usp=drivesdk'
};

var currentRoomId = null;

function showToast(msg) {
  var toast = document.getElementById('app-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(function () {
    toast.classList.remove('show');
  }, 2500);
}


// ---- CHURCH DIRECTORY (my UCD app) ----
function openChurchDirectory() {
  var ua = navigator.userAgent || navigator.vendor || window.opera;
  var isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isMac = /Macintosh|Mac OS X/.test(ua) && !isIOS;
  var isAndroid = /Android/i.test(ua);
  var isWindows = /Windows/i.test(ua);

  var appScheme = 'com.ucdir.mobileapp://';
  var appStore = 'https://apps.apple.com/app/universal-church-directory/id1005590097';
  var playStore =
    'https://play.google.com/store/apps/details?id=com.pivotcreates.universalchurchdirectory';
  var webDirectory = 'https://directory.ucdir.com/';

  // How long to wait for the app to open before giving up and sending the
  // user to the store. 1000ms works well on iOS/Android, where the OS
  // resolves the scheme (success or failure) almost instantly. Mac gets its
  // own, longer delay below — a native app's cold-launch there can take a
  // bit longer than mobile's OS-level handoff, and 1000ms was occasionally
  // outrunning a slow myUCD launch and sending people to the App Store even
  // though the app was about to open fine.
  var STORE_FALLBACK_DELAY_MS = 1000;
  var MAC_STORE_FALLBACK_DELAY_MS = 1500;

  // Shared helper: try the custom scheme, then fall back to a store URL if
  // we're still on this page after delayMs. 'visibilitychange' and
  // 'pagehide' are always the cancel signals. 'blur' is a THIRD, optional
  // signal — pass useBlurSignal=true on platforms where losing window focus
  // reliably means "the app opened" (e.g. Mac, where switching to the
  // native app blurs Safari with no false positives). Leave it false on
  // platforms like iOS, where the native "Safari cannot open the page
  // because the address is invalid" alert (shown when myUCD isn't
  // installed) ALSO fires blur — which would wrongly cancel the fallback
  // for the exact case it's supposed to catch.
  function tryAppThenStore(storeUrl, useBlurSignal, delayMs) {
    var timer = setTimeout(function () {
      if (!document.hidden) {
        window.location.href = storeUrl;
      }
    }, delayMs);

    function cancel() {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', cancel);
      if (useBlurSignal) window.removeEventListener('blur', cancel);
    }

    function onVis() {
      if (document.hidden) cancel();
    }

    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', cancel, { once: true });
    if (useBlurSignal) window.addEventListener('blur', cancel, { once: true });

    window.location.href = appScheme;
  }

  // iPhone / iPad → try app, then fall back to App Store.
  // No blur signal — see note above.
  if (isIOS) {
    tryAppThenStore(appStore, false, STORE_FALLBACK_DELAY_MS);
    return;
  }

  // Mac → try app, fall back to App Store.
  // Blur signal on — this is what correctly detected "already installed"
  // here before. Longer delay — see note above.
  if (isMac) {
    tryAppThenStore(appStore, true, MAC_STORE_FALLBACK_DELAY_MS);
    return;
  }

  // Android → try app, fall back to Play Store.
  // Untested — defaulting to the same blur signal as Mac. If Android shows
  // its own "can't open app" prompt the way iOS does, this branch would
  // need the blur signal turned off too, same fix as iOS.
  if (isAndroid) {
    tryAppThenStore(playStore, true, STORE_FALLBACK_DELAY_MS);
    return;
  }

  // Windows (and everything else) → web directory
  window.open(webDirectory, '_blank');
}

// ---- PAGE NAVIGATION ----
function showPage(id) {
  document.querySelectorAll('.page').forEach(function (p) {
    p.classList.remove('active');
  });
  document.querySelectorAll('.nav-btn').forEach(function (b) {
    b.classList.remove('active');
  });
  var target = document.getElementById('page-' + id);
  if (target) {
    target.classList.add('active');
    window.scrollTo(0, 0);
  }
  var activeBtn = document.querySelector('.nav-btn[data-page="' + id + '"]');
  if (activeBtn) activeBtn.classList.add('active');
  if (id === 'care') {
    showCGScreen('select');
  }
}

function showCGScreen(screen) {
  ['select', 'room'].forEach(function (s) {
    var el = document.getElementById('cg-' + s + '-screen');
    if (el) el.style.display = 'none';
  });
  var show = document.getElementById('cg-' + screen + '-screen');
  if (show) show.style.display = 'block';
}

function openRoom(groupId, groupName) {
  currentRoomId = groupId;

  var roomTitle = document.getElementById('cg-room-title');
  if (roomTitle) roomTitle.textContent = groupName;

  var fbTitle = document.getElementById('cg-room-fb-title');
  if (fbTitle) fbTitle.textContent = groupName;

  var fbSub = document.getElementById('cg-room-fb-sub');
    if (fbSub) fbSub.textContent = 'Tap to open the Private Facebook Group for ' + groupName;

  showCGScreen('room');
}

// ---- BIBLE PICKER ----
var chaptersMap = {
  GEN: 50,
  EXO: 40,
  LEV: 27,
  NUM: 36,
  DEU: 34,
  JOS: 24,
  JDG: 21,
  RUT: 4,
  '1SA': 31,
  '2SA': 24,
  '1KI': 22,
  '2KI': 25,
  '1CH': 29,
  '2CH': 36,
  EZR: 10,
  NEH: 13,
  EST: 10,
  JOB: 42,
  PSA: 150,
  PRO: 31,
  ECC: 12,
  SNG: 8,
  ISA: 66,
  JER: 52,
  LAM: 5,
  EZK: 48,
  DAN: 12,
  HOS: 14,
  JOL: 3,
  AMO: 9,
  OBA: 1,
  JON: 4,
  MIC: 7,
  NAM: 3,
  HAB: 3,
  ZEP: 3,
  HAG: 2,
  ZEC: 14,
  MAL: 4,
  MAT: 28,
  MRK: 16,
  LUK: 24,
  JHN: 21,
  ACT: 28,
  ROM: 16,
  '1CO': 16,
  '2CO': 13,
  GAL: 6,
  EPH: 6,
  PHP: 4,
  COL: 4,
  '1TH': 5,
  '2TH': 3,
  '1TI': 6,
  '2TI': 4,
  TIT: 3,
  PHM: 1,
  HEB: 13,
  JAS: 5,
  '1PE': 5,
  '2PE': 3,
  '1JN': 5,
  '2JN': 1,
  '3JN': 1,
  JUD: 1,
  REV: 22
};
var currentTrans = '59';
var currentCode = 'ESV';

function populateChapters(book, selected) {
  var sel = document.getElementById('bibleChapter');
  if (!sel) return;
  var count = chaptersMap[book] || 1;
  sel.innerHTML = '';
  for (var i = 1; i <= count; i++) {
    var opt = document.createElement('option');
    opt.value = i;
    opt.textContent = 'Chapter ' + i;
    if (i === (selected || 1)) opt.selected = true;
    sel.appendChild(opt);
  }
}

function openBible() {
  var book = document.getElementById('bibleBook').value;
  var chapter = document.getElementById('bibleChapter').value;
  window.open(
    'https://www.bible.com/bible/' + currentTrans + '/' + book + '.' + chapter + '.' + currentCode,
    '_blank'
  );
}

// ---- INSTALL QR CODE ----
function tryGenerateQR() {
  var qrEl = document.getElementById('appQR');
  if (!qrEl) return;
  if (typeof QRCode !== 'undefined') {
    new QRCode(qrEl, {
      text: 'https://app.maxwellhillbaptistchurch.com/',
      width: 90,
      height: 90,
      colorDark: '#0a1628',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H
    });
  } else {
    setTimeout(tryGenerateQR, 500);
  }
}

// ---- CLEAR STALE HOME SCREEN BADGE ----
// The old database system set (and cleared) the home screen icon
// badge server-side. That backend is gone, so any
// unread count a member had showing on their icon before the cutover
// will never get zeroed out on its own. Proactively clear it every time
// the app opens. Safe to call even where the Badging API isn't supported
// (iOS 16.4+ and Chromium browsers support it for installed PWAs).
function clearStaleAppBadge() {
  if ('clearAppBadge' in navigator) {
    navigator.clearAppBadge().catch(function () {});
  } else if ('setAppBadge' in navigator) {
    navigator.setAppBadge(0).catch(function () {});
  }
}

// ---- LIVE SERVICE BADGE ----
function checkLiveBadge() {
  var now = new Date();

  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(now);

  var dayName = '';
  var hour = 0;
  var minute = 0;

  parts.forEach(function (part) {
    if (part.type === 'weekday') dayName = part.value;
    if (part.type === 'hour') hour = parseInt(part.value, 10);
    if (part.type === 'minute') minute = parseInt(part.value, 10);
  });

  var dayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  var day = dayMap[dayName];
  var totalMins = hour * 60 + minute;

  var isServiceLive =
    UNSCHEDULED_LIVE_SERVICE ||
    (LIVE_SERVICE_ENABLED &&
      ((day === 0 && totalMins >= 565 && totalMins <= 660) || // Sun 9:25–11:00
        (day === 3 && totalMins >= 1135 && totalMins <= 1200))); // Wed 6:55–8:00

  var badge = document.getElementById('liveBadge');
  if (badge) badge.style.display = isServiceLive ? 'flex' : 'none';

  var watchBtn = document.querySelector('.quick-btn[data-action="watch"]');
  var ytLaunchBtn = document.getElementById('yt-launch');
  var fbLaunchBtn = document.getElementById('fb-launch');

  [watchBtn, ytLaunchBtn, fbLaunchBtn].forEach(function (el) {
    if (el) el.classList.toggle('is-live', isServiceLive);
  });
}

// ---- INIT ----
window.onload = function () {
  if ('serviceWorker' in navigator) {
    // Auto-apply SW updates: when a new service worker skips waiting and
    // takes control (sw.js already does self.skipWaiting() + clients.claim()
    // on every update), the page it's controlling is still running the OLD
    // rendered DOM/JS. `controllerchange` fires the moment that handoff
    // happens, so we use it to silently reload — the user gets the new
    // version on their very next interaction instead of having to close
    // and reopen the app a second time.
    //
    // Two guards keep this safe:
    // 1. `hadController` — on a brand-new install there's no previous
    //    controller, so the *first* controllerchange just means "the SW is
    //    now in charge for the first time," not "an update happened." We
    //    skip reloading in that case and only start reacting to
    //    controllerchange events after that baseline is set.
    // 2. A sessionStorage timestamp cooldown — protects against a genuine
    //    infinite loop (e.g. a bug that makes the browser think sw.js
    //    changed on every load) by refusing to auto-reload more than once
    //    every 10 seconds, no matter how many controllerchange events fire.
    var hadController = !!navigator.serviceWorker.controller;
    var reloading = false;

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) {
        hadController = true;
        return;
      }
      if (reloading) return;

      var last = Number(sessionStorage.getItem('mhbcSwReloadAt') || 0);
      if (Date.now() - last < 10000) {
        console.warn('MHBC: skipping SW auto-reload — one already happened in the last 10s.');
        return;
      }
      sessionStorage.setItem('mhbcSwReloadAt', String(Date.now()));

      reloading = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('./sw.js')
      .then(function (reg) {
        // Look for updates every time the user brings the app back to the
        // foreground (home screen reopen, app switcher, tab focus). Without
        // this, the browser may sit on its own cached copy of sw.js for up
        // to 24h before checking again — this makes "next open" reliable.
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') {
            reg.update().catch(function () {});
          }
        });
      })
      .catch(function (err) {
        console.error('Service worker registration failed:', err);
      });
  }

  populateChapters('JHN', 1);
  var bookSel = document.getElementById('bibleBook');
  if (bookSel) {
    bookSel.addEventListener('change', function () {
      populateChapters(this.value, 1);
    });
  }

  document.querySelectorAll('.pill').forEach(function (pill) {
    pill.addEventListener('click', function () {
      document.querySelectorAll('.pill').forEach(function (p) {
        p.classList.remove('active');
      });
      this.classList.add('active');
      currentTrans = this.getAttribute('data-trans');
      currentCode = this.getAttribute('data-code');
    });
  });

  var bibleBtn = document.getElementById('openBibleBtn');
  if (bibleBtn) bibleBtn.addEventListener('click', openBible);

  document.querySelectorAll('.nav-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var page = this.getAttribute('data-page');
      if (page) showPage(page);
    });
  });

  document.querySelectorAll('.quick-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var action = this.getAttribute('data-action');
      var url = this.getAttribute('data-url');

      if (action === 'directory') {
        openChurchDirectory();
      } else if (action) {
        showPage(action);
      } else if (url) {
        window.open(url, '_blank');
      }
    });
  });

  document.querySelectorAll('.cg-group-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var groupId = this.getAttribute('data-group');
      var groupName = this.getAttribute('data-name');
      if (groupId && groupName) openRoom(groupId, groupName);
    });
  });

  var backToSelect = document.getElementById('cg-back-to-select');
  if (backToSelect) {
    backToSelect.addEventListener('click', function () {
      currentRoomId = null;
      showCGScreen('select');
    });
  }

  var roomFbLaunch = document.getElementById('cg-room-fb-launch');
  if (roomFbLaunch) {
    roomFbLaunch.addEventListener('click', function () {
      var link = ROOM_FB_LINKS[currentRoomId];
      if (link) window.open(link, '_blank');
    });
  }

  var roomPrayerLaunch = document.getElementById('cg-room-prayer-launch');
  if (roomPrayerLaunch) {
    roomPrayerLaunch.addEventListener('click', function () {
      var link = PRAYER_LINKS[currentRoomId];
      if (link) window.open(link, '_blank');
    });
  }

  var locationCard = document.getElementById('location-card');
  if (locationCard) {
    locationCard.addEventListener('click', function () {
      window.open(
        'https://www.google.com/maps/search/?api=1&query=301+Teel+Road+Beckley+WV+25801',
        '_blank'
      );
    });
  }

  var ytLaunch = document.getElementById('yt-launch');
  if (ytLaunch) {
    ytLaunch.addEventListener('click', function () {
      window.open('https://www.youtube.com/@maxwellhillbaptistchurch9695/streams', '_blank');
    });
  }

  var liveBadge = document.getElementById('liveBadge');
  if (liveBadge) {
    liveBadge.addEventListener('click', function () {
      showPage('watch');
    });
  }

  clearStaleAppBadge();
  checkLiveBadge();
  setInterval(checkLiveBadge, 60000);
  tryGenerateQR();
};

// ============================================================
// iOS Safari / WebKit UI Fix: phantom thickness/floating of the bottom
// nav bar during pinch-zoom.
// ============================================================
(function applyWebKitFixes() {
  if (!window.visualViewport) return;

  function syncViewport() {
    var bottomNav = document.querySelector('.bottom-nav');
    if (!bottomNav) return;

    if (window.visualViewport.scale > 1) {
      var offset = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
      bottomNav.style.transform = 'translateY(' + Math.max(0, offset) + 'px)';
    } else {
      bottomNav.style.transform = '';
    }
  }

  window.visualViewport.addEventListener('resize', syncViewport);
  window.visualViewport.addEventListener('scroll', syncViewport);
})();
