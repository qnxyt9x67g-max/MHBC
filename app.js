// ============================================================
// MHBC App — app.js
// Maxwell Hill Baptist Church — Beckley, WV
//
// Static PWA. No backend: C.A.R.E. Group chat now happens in private
// Facebook Groups (see ROOM_FB_LINKS below) instead of Firebase/Firestore.
// This file just handles page navigation, the Bible reader, the install
// QR code, the live-service badge, and opening the right external links.
// ============================================================

// ---- C.A.R.E. GROUP LINKS ----
// Facebook group link + prayer/praise request sheet for each room.
var ROOM_FB_LINKS = {
  c101: 'https://www.facebook.com/share/g/1ETLR3hZyK/?mibextid=wwXIfr',
  narthex: 'https://www.facebook.com/share/g/19Au7VGq6W/?mibextid=wwXIfr',
  fellowship1: 'https://www.facebook.com/share/g/1DkToTXiyq/?mibextid=wwXIfr',
  fellowship2: 'https://www.facebook.com/share/g/1Hq4o6F4hE/?mibextid=wwXIfr',
  trac: 'https://www.facebook.com/share/g/196S56mPhH/?mibextid=wwXIfr'
};

var PRAYER_LINKS = {
  c101: 'https://docs.google.com/spreadsheets/d/1-7kNm-5l8F1okka9bU4mpvQDXd2OusWYNQeC9PuJnZQ/edit?usp=drivesdk',
  narthex:
    'https://docs.google.com/spreadsheets/d/1GZUm483lFgxLGM5o6NJBH3z5Fri2FCekFzuKNXF1TgM/edit?usp=drivesdk',
  fellowship1:
    'https://docs.google.com/spreadsheets/d/1Dw8g6q_dE-3ObNr5jbddJ5CIqnzo1NtbU3ZGjoTn1Ws/edit?usp=drivesdk',
  fellowship2:
    'https://docs.google.com/spreadsheets/d/1dVE3TlLK3svbtA2Qp-wxnQJE_ztXLwBzvCW32F0pDI8/edit?usp=drivesdk',
  trac: 'https://docs.google.com/spreadsheets/d/1UlIxBJS2ZZlX5QnsjGIckcULLsZ6r7U6mNtaDVe3udQ/edit?usp=drivesdk'
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

function showComingSoon() {
  showToast('Coming soon! 🎵');
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
// The old Firebase-based system set (and cleared) the home screen icon
// badge server-side via Cloud Functions. That backend is gone, so any
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
    (day === 0 && totalMins >= 565 && totalMins <= 660) || // Sun 9:25–11:00
    (day === 3 && totalMins >= 1135 && totalMins <= 1200); // Wed 6:55–8:00

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
    navigator.serviceWorker.register('./sw.js').catch(function (err) {
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

      if (action) showPage(action);
      else if (url) window.open(url, '_blank');
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
