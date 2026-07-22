// ============================================================
// MHBC App — app.js
// Maxwell Hill Baptist Church — Beckley, WV
//
// Auth:     Firebase Anonymous Auth (UID = trusted session identity)
// Identity: Custom name + password stored in Firestore (recovery & portability)
// Badges:   Owned entirely by Cloud Functions. Counts flow from Firestore writes
//           → Cloud Function → users/{uid} → listenForBadgeUpdates() → UI.
//           No client-side message watchers. Badge reads are free.
// Messages: Hybrid offline cache (localStorage) + Firestore onSnapshot listener.
//           Cache ceiling: 500 messages per room (ROOM_MESSAGE_CACHE_MAX).
// Push:     FCM via sw.js service worker. Background badges handled by Cloud
//           Functions. Foreground messages handled by messaging.onMessage().
// Admin:    isAdmin flag set in Firebase console on member docs.
//           Admin capabilities: approve/deny members, send church alerts,
//           delete any message.
// ============================================================

var db = null;
var auth = null;
var currentUID = null;
var currentGroup = null;
var currentGroupName = null;
var currentUser = null;
var currentMemberKey = null;
var messageListener = null;
var navToken = 0;
var unreadCountsByGroup = {};
var unreadCount = 0;
var membersPanelIsOpen = false;
var lastSeenTimestamps = {};
var replyingTo = null;
var deleteInProgressIds = {};
var editInProgress = false;
var audioUnlocked = false;
var audioCtx = null;
var authReady = false;
var suppressAutoScrollUntil = 0;
var pendingCountsByGroup = {};
var MESSAGE_PAGE_SIZE = 50;
var ROOM_MESSAGE_CACHE_PREFIX = 'mhbc_msg_cache_';
var ROOM_MESSAGE_CACHE_MAX = 500;
var roomMessageStateByGroup = {};
var ROOM_MEMBERS_CACHE_PREFIX = 'mhbc_members_cache_';
var ROOM_MEMBERS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
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
var BUBBLE_COLORS = [
  // --- RICH REDS (Deep Crimson & Brick) ---
  '#A93226',
  '#922B21',
  '#7B241C',

  // --- BURNT ORANGES (Rust & Clay) ---
  '#D35400',
  '#BA4A00',
  '#A04000',

  // --- DEEP GOLDS (Antique Gold & Dark Mustard) ---
  '#B7950B',
  '#9A7D0A',
  '#8D6E1F',

  // --- FOREST GREENS (Pine & Emerald) ---
  '#1E8449',
  '#196F3D',
  '#145A32',
  '#0E6655',

  // --- SAPPHIRE BLUES (Ocean & Deep Navy) ---
  '#21618C',
  '#1A5276',
  '#1B4F72',
  '#154360',

  // --- DEEP CHARCOALS (Gunmetal & Slate) ---
  '#455A64',
  '#37474F',
  '#2C3E50',
  '#263238'
];

function getBubbleColor(name) {
  var hash = 0;
  for (var i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return BUBBLE_COLORS[Math.abs(hash) % BUBBLE_COLORS.length];
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function linkifyEscaped(escapedStr) {
  return escapedStr.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
    return '<a href="' + url + '" target="_blank" rel="noopener" class="alert-link">' + url + '</a>';
  });
}

function normalizeName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

async function hashInput(input, salt) {
  var encoder = new TextEncoder();
  var data = encoder.encode(input + salt);
  var hashBuffer = await crypto.subtle.digest('SHA-256', data);
  var hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map(function (b) {
      return b.toString(16).padStart(2, '0');
    })
    .join('');
}

function generateSalt() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var salt = '';
  for (var i = 0; i < 8; i++) salt += chars[Math.floor(Math.random() * chars.length)];
  return salt;
}

// ---- LOGIN BRUTE-FORCE GUARD ----
var LOGIN_GUARD_PREFIX = 'mhbc_login_guard_';
var LOGIN_MAX_ATTEMPTS = 10;
var LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function getLoginGuardKey(groupId, normalizedName) {
  return LOGIN_GUARD_PREFIX + groupId + '_' + normalizedName;
}

function getLoginGuard(groupId, normalizedName) {
  var key = getLoginGuardKey(groupId, normalizedName);
  var raw = localStorage.getItem(key);
  if (!raw) return { failedCount: 0, lockoutUntil: 0 };
  try {
    var parsed = JSON.parse(raw);
    return { failedCount: parsed.failedCount || 0, lockoutUntil: parsed.lockoutUntil || 0 };
  } catch (e) {
    return { failedCount: 0, lockoutUntil: 0 };
  }
}

function setLoginGuard(groupId, normalizedName, failedCount, lockoutUntil) {
  var key = getLoginGuardKey(groupId, normalizedName);
  localStorage.setItem(
    key,
    JSON.stringify({ failedCount: failedCount, lockoutUntil: lockoutUntil })
  );
}

function clearLoginGuard(groupId, normalizedName) {
  localStorage.removeItem(getLoginGuardKey(groupId, normalizedName));
}

function recordFailedLogin(groupId, normalizedName) {
  var now = Date.now();
  var guard = getLoginGuard(groupId, normalizedName);
  // If old lockout has expired, reset before counting new failures
  if (guard.lockoutUntil && now >= guard.lockoutUntil) {
    guard.failedCount = 0;
    guard.lockoutUntil = 0;
  }
  guard.failedCount += 1;
  if (guard.failedCount >= LOGIN_MAX_ATTEMPTS) {
    guard.lockoutUntil = now + LOGIN_LOCKOUT_MS;
  }
  setLoginGuard(groupId, normalizedName, guard.failedCount, guard.lockoutUntil);
}

function getRemainingLockoutMs(groupId, normalizedName) {
  var guard = getLoginGuard(groupId, normalizedName);
  var now = Date.now();
  if (guard.lockoutUntil && now < guard.lockoutUntil) return guard.lockoutUntil - now;
  return 0;
}

function formatRemainingLockout(ms) {
  var totalSeconds = Math.ceil(ms / 1000);
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  return minutes > 0 ? minutes + 'm ' + seconds + 's' : seconds + 's';
}

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

function initFirebase() {
  firebase.initializeApp({
    apiKey: 'AIzaSyBYt5RR0YGB9u9n7QgvAGXnvmrb7-xTg-Y',
    authDomain: 'mhbc-app.firebaseapp.com',
    projectId: 'mhbc-app',
    storageBucket: 'mhbc-app.firebasestorage.app',
    messagingSenderId: '482094427911',
    appId: '1:482094427911:web:7ed5ec06b716ae66a4dfa2'
  });
  db = firebase.firestore();

  // Auto-detect: Try WebSockets first, fall back to Long Polling if needed
  db.settings({ experimentalAutoDetectLongPolling: true });

  auth = firebase.auth();
}

function listenForBadgeUpdates() {
  if (!currentUID) return;

  db.collection('users')
    .doc(currentUID)
    .onSnapshot(function (doc) {
      if (!doc.exists) return;

      var data = doc.data() || {};
      var unreadMap = data.unread || {};
      var pendingMap = data.pending || {};
      var totalUnread = data.totalUnread || 0;
      var totalPending = data.totalPending || 0;
      var total = data.badgeTotal != null ? data.badgeTotal : totalUnread + totalPending;

      // clear all known room badges first
      ['c101', 'narthex', 'fellowship1', 'fellowship2', 'trac'].forEach(function (groupId) {
        unreadCountsByGroup[groupId] = 0;
        pendingCountsByGroup[groupId] = 0;
      });

      // rebuild room unread badges from unread map
      Object.keys(unreadMap).forEach(function (groupId) {
        if (groupId && groupId !== 'null') {
          unreadCountsByGroup[groupId] = Math.max(0, unreadMap[groupId] || 0);
        }
      });

      // rebuild pending/admin badges from pending map
      Object.keys(pendingMap).forEach(function (groupId) {
        if (groupId && groupId !== 'null') {
          pendingCountsByGroup[groupId] = Math.max(0, pendingMap[groupId] || 0);
        }
      });

      // update each room badge
      var pendingSeenAt2 = (currentUser && currentUser.pendingAcknowledgedAt) || 0;
      var pendingLastUpdatedAt2 = data.pendingLastUpdatedAt || 0;

      ['c101', 'narthex', 'fellowship1', 'fellowship2', 'trac'].forEach(function (groupId) {
        var roomBadge = document.getElementById('badge-' + groupId);
        var unread = unreadCountsByGroup[groupId] || 0;
        var isCurrentGroupAcked =
          groupId === currentGroup && membersPanelIsOpen && pendingLastUpdatedAt2 <= pendingSeenAt2;
        var pending = isCurrentGroupAcked ? 0 : pendingCountsByGroup[groupId] || 0;
        var roomTotal = unread + pending;

        if (roomBadge) {
          if (roomTotal > 0) {
            roomBadge.textContent = roomTotal > 99 ? '99+' : String(roomTotal);
            roomBadge.style.display = 'flex';
          } else {
            roomBadge.style.display = 'none';
            roomBadge.textContent = '';
          }
        }
      });

      // update Members button badge for current room
      var membersBadge = document.getElementById('members-badge');
      if (membersBadge && currentGroup) {
        var currentPending = pendingCountsByGroup[currentGroup] || 0;
        if (currentPending > 0) {
          membersBadge.textContent = currentPending > 99 ? '99+' : String(currentPending);
          membersBadge.style.display = 'flex';
        } else {
          membersBadge.style.display = 'none';
          membersBadge.textContent = '';
        }
      }

      // update Care Groups nav badge
      var truePendingTotal = 0;
      ['c101', 'narthex', 'fellowship1', 'fellowship2', 'trac'].forEach(function (groupId) {
        var isCurrentGroupAcked =
          groupId === currentGroup && membersPanelIsOpen && pendingLastUpdatedAt2 <= pendingSeenAt2;
        truePendingTotal += isCurrentGroupAcked ? 0 : pendingCountsByGroup[groupId] || 0;
      });
      var effectiveTotal = totalUnread + truePendingTotal;
      unreadCount = effectiveTotal;
      var navBadge = document.getElementById('nav-badge-care');
      if (navBadge) {
        if (effectiveTotal > 0) {
          navBadge.textContent = effectiveTotal > 99 ? '99+' : String(effectiveTotal);
          navBadge.style.display = 'flex';
        } else {
          navBadge.style.display = 'none';
          navBadge.textContent = '';
        }
      }

      // update Church Alerts badge
      var hasUnreadAlert = data.hasUnreadAlert === true;
      var alertsBadge = document.getElementById('badge-church-alerts');
      if (alertsBadge) {
        alertsBadge.style.display = hasUnreadAlert ? 'flex' : 'none';
      }

      // update app icon badge
      var appBadgeTotal = effectiveTotal + (hasUnreadAlert ? 1 : 0);
      updateAppBadge(appBadgeTotal);
    });
}
// ==========================
// 🔔 FCM NOTIFICATIONS SETUP
// ==========================
var messaging = null;

function initMessaging() {
  if (!('Notification' in window)) return;
  if (!('serviceWorker' in navigator)) return;
  if (Notification.permission !== 'granted') return;
  if (!currentUID) return;

  messaging = firebase.messaging();

  navigator.serviceWorker
    .register('./sw.js')
    .then(function (reg) {
      return navigator.serviceWorker.ready.then(function () {
        return messaging.getToken({
          vapidKey:
            'BBPJw98hi9HkHDJHAJMXvUu6l9lmBMjJdTrKxLVLqx-KT5tcHDua9tq2FRxKanZxuSXJ6D0XRvITjWmVXGTMhKE',
          serviceWorkerRegistration: reg
        });
      });
    })
    .then(function (token) {
      if (token) {
        // Attempt token migration first in case UID reset
        var migrateToken = firebase.functions().httpsCallable('migrateTokenV2');
        migrateToken({ fcmToken: token })
          .then(function (result) {
            if (result.data.status === 'migrated') {
              console.log('FCM token migrated to new UID');
            }
          })
          .catch(function () {
            // Silent fail — migration not critical
          })
          .finally(function () {
            saveToken(token);
            console.log('FCM token saved');
          });
      } else {
        console.log('No FCM token returned');
      }
    })
    .catch(function (err) {
      console.error('initMessaging failed:', err);
    });

  messaging.onMessage(function (payload) {
    console.log('Foreground message received:', payload);

    var title = (payload.notification && payload.notification.title) || 'MHBC';
    var body = (payload.notification && payload.notification.body) || '';

    if (body && document.visibilityState !== 'visible') {
      try {
        new Notification(title, {
          body: body,
          icon: 'https://maxwellhillbaptistchurch.com/wp-content/uploads/2024/10/MaxwellHill-Baptist-Favicon.png'
        });
      } catch (e) {}
    }

    if (payload.data && payload.data.badge) {
      var badgeNum = parseInt(payload.data.badge, 10) || 0;
      updateAppBadge(badgeNum);
    }
  });
}

function saveToken(token) {
  if (!currentUID) return;

  db.collection('users')
    .doc(currentUID)
    .set(
      {
        tokens: firebase.firestore.FieldValue.arrayUnion(token)
      },
      { merge: true }
    );
}

function requestPermission(type) {
  localStorage.setItem(type + '_notifs_prompted', 'yes');

  if (!('Notification' in window)) {
    alert('Push notifications work after adding this app to your Home Screen.');
    return;
  }

  if (Notification.permission === 'granted') {
    localStorage.setItem(type + '_notifs_permission', 'granted');
    localStorage.setItem(type + '_notifs', 'yes');
    alert('Notifications Enabled'); // moved BEFORE initMessaging
    initMessaging();
    return;
  }

  Notification.requestPermission().then(function (permission) {
    localStorage.setItem(type + '_notifs_permission', permission);

    if (permission !== 'granted') {
      if (permission === 'denied') {
        alert('Notifications are turned off in your device/browser settings.');
      }
      return;
    }

    localStorage.setItem(type + '_notifs', 'yes');
    alert('Notifications Enabled'); // moved BEFORE initMessaging
    initMessaging();
  });
}

// ==========================
// 🔔 FIRST-TIME PROMPTS
// ==========================
function checkChurchPrompt() {
  if (localStorage.getItem('church_notifs_prompted')) return;
  if (/android/i.test(navigator.userAgent)) return;

  setTimeout(function () {
    var overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';

    var box = document.createElement('div');
    box.style.cssText =
      'background:#0f1e3a;border:1px solid #c9a84c;border-radius:14px;padding:20px;max-width:360px;width:100%;color:white;font-family:Lato,sans-serif;text-align:center;';

    box.innerHTML =
      '<div style="font-size:28px;margin-bottom:10px;">🔔</div>' +
      '<div style="font-size:18px;font-weight:700;margin-bottom:8px;">Enable Notifications?</div>' +
      '<div style="font-size:14px;color:#dce6f5;line-height:1.4;margin-bottom:16px;">Get church updates, service reminders, and messages in your C.A.R.E. Group.</div>';

    var yesBtn = document.createElement('button');
    yesBtn.textContent = 'Enable Notifications';
    yesBtn.style.cssText =
      'width:100%;padding:12px;border:none;border-radius:10px;background:#c9a84c;color:#0a1628;font-weight:700;font-size:15px;margin-bottom:10px;';

    var noBtn = document.createElement('button');
    noBtn.textContent = 'Not Now';
    noBtn.style.cssText =
      'width:100%;padding:12px;border:1px solid #c9a84c;border-radius:10px;background:transparent;color:#c9a84c;font-weight:700;font-size:15px;';

    yesBtn.addEventListener('click', function () {
      localStorage.setItem('church_notifs_prompted', 'yes');
      overlay.remove();
      requestPermission('church');
    });

    noBtn.addEventListener('click', function () {
      localStorage.setItem('church_notifs_prompted', 'yes');
      overlay.remove();
    });

    box.appendChild(yesBtn);
    box.appendChild(noBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }, 1000);
}
// ---- AUDIO ----
function unlockAudio() {
  if (audioUnlocked) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var buf = audioCtx.createBuffer(1, 1, 22050);
    var src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
    audioUnlocked = true;
  } catch (e) {}
}

function playNotificationSound() {
  unlockAudio();
  if (!audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();

    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(680, audioCtx.currentTime); // soft rising tone
    osc.frequency.linearRampToValueAtTime(920, audioCtx.currentTime + 0.25);

    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.45);

    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.45);
  } catch (e) {}
}

function playSendSound() {
  unlockAudio();
  if (!audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();

    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type = 'sine';
    osc.frequency.value = 880; // gentle "pop" / sent tone

    gain.gain.setValueAtTime(0.22, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);

    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.18);
  } catch (e) {}
}
// ---- BADGES ----

// ---- APP ICON BADGE (iOS) ----
function updateAppBadge(count) {
  if (!('setAppBadge' in navigator)) return;

  if (count > 0) {
    navigator.setAppBadge(count).catch(function () {});
  } else {
    navigator.clearAppBadge().catch(function () {});
  }
}

function refreshCareNavBadge() {
  var navBadge = document.getElementById('nav-badge-care');
  var total = 0;

  Object.keys(unreadCountsByGroup).forEach(function (groupId) {
    var unread = unreadCountsByGroup[groupId] || 0;
    var isCurrentGroupAcked = groupId === currentGroup && membersPanelIsOpen;
    var pending = isCurrentGroupAcked ? 0 : pendingCountsByGroup[groupId] || 0;
    total += unread + pending;
  });
  unreadCount = total;
  if (!navBadge) return;
  if (total > 0) {
    navBadge.textContent = total > 99 ? '99+' : String(total);
    navBadge.style.display = 'flex';
  } else {
    navBadge.style.display = 'none';
  }
  updateAppBadge(total);
}

function setUnreadCount(groupId, count) {
  unreadCountsByGroup[groupId] = Math.max(0, count || 0);
  var roomBadge = document.getElementById('badge-' + groupId);
  if (roomBadge) {
    var unread = unreadCountsByGroup[groupId] || 0;
    var pending = pendingCountsByGroup[groupId] || 0;
    var total = unread + pending;
    if (total > 0) {
      roomBadge.textContent = total > 99 ? '99+' : String(total);
      roomBadge.style.display = 'flex';
    } else {
      roomBadge.style.display = 'none';
    }
  }
  refreshCareNavBadge();
}

function setPendingCount(groupId, count) {
  pendingCountsByGroup[groupId] = Math.max(0, count || 0);
  var isCurrentGroupAcked = groupId === currentGroup && membersPanelIsOpen;
  var effectivePending = isCurrentGroupAcked ? 0 : pendingCountsByGroup[groupId];
  var unread = unreadCountsByGroup[groupId] || 0;
  var total = unread + effectivePending;
  var roomBadge = document.getElementById('badge-' + groupId);
  if (roomBadge) {
    if (total > 0) {
      roomBadge.textContent = total > 99 ? '99+' : String(total);
      roomBadge.style.display = 'flex';
    } else {
      roomBadge.style.display = 'none';
    }
  }
  var membersBadge = document.getElementById('members-badge');
  if (membersBadge && groupId === currentGroup) {
    var rawPending = pendingCountsByGroup[groupId] || 0;
    if (rawPending > 0) {
      membersBadge.textContent = rawPending > 99 ? '99+' : String(rawPending);
      membersBadge.style.display = 'flex';
    } else {
      membersBadge.style.display = 'none';
    }
  }
  refreshCareNavBadge();
}

function clearUnreadCount(groupId) {
  delete unreadCountsByGroup[groupId];

  var roomBadge = document.getElementById('badge-' + groupId);
  if (roomBadge) roomBadge.style.display = 'none';

  refreshCareNavBadge();
}

function isInChat() {
  var chatScreen = document.getElementById('cg-chat-screen');
  var carePage = document.getElementById('page-care');
  if (!chatScreen || !carePage) return false;
  return carePage.classList.contains('active') && chatScreen.style.display !== 'none';
}

function hideInputBar() {
  var b = document.getElementById('cg-input-bar');
  if (b) b.style.display = 'none';
}
function showInputBar() {
  var b = document.getElementById('cg-input-bar');
  if (b) b.style.display = 'flex';
}

function updateSelectConnectionStatus() {
  var el = document.getElementById('cg-connection-status');
  if (!el) {
    var selectScreen = document.getElementById('cg-select-screen');
    if (!selectScreen) return;
    el = document.createElement('div');
    el.id = 'cg-connection-status';
    el.style.cssText =
      'text-align:center;font-size:13px;padding:4px 16px 8px;font-family:Lato,sans-serif;';
    selectScreen.insertBefore(el, selectScreen.firstChild);
  }
  if (!navigator.onLine) {
    el.textContent = 'Offline: Check your internet connection.';
    el.style.color = '#e05c5c';
    el.style.display = 'block';
  } else if (!authReady) {
    el.textContent = 'Establishing connection...';
    el.style.color = '#7a8fa8';
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
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
  hideInputBar();
  if (id === 'care') {
    setPendingCount(null, 0);
    refreshCareNavBadge();

    var lastGroup = getLastGroup();
    var saved = lastGroup ? getSavedUser(lastGroup) : null;

    if (saved) {
      currentGroup = saved.group;
      currentGroupName = saved.groupName;
      currentUser = saved;
      currentMemberKey = saved.normalizedName;

      ['select', 'login', 'pending', 'chat', 'members', 'changepassword'].forEach(function (s) {
        var el = document.getElementById('cg-' + s + '-screen');
        if (el) el.style.display = 'none';
      });

      var chatScreen = document.getElementById('cg-chat-screen');
      var mask = document.getElementById('cg-loading-mask');
      if (!mask && chatScreen) {
        mask = document.createElement('div');
        mask.id = 'cg-loading-mask';
        mask.style.cssText =
          'position:fixed;top:60px;left:0;right:0;bottom:60px;background:#0a1628;z-index:99;display:flex;align-items:center;justify-content:center;color:#7a8fa8;font-size:15px;';
        mask.innerHTML = 'Loading messages...';
        chatScreen.appendChild(mask);
      }
      if (mask) mask.style.display = 'flex';
      if (chatScreen) chatScreen.style.display = 'block';

      var kickToken = navToken;
      db.disableNetwork()
        .then(function () {
          return db.enableNetwork();
        })
        .then(function () {
          if (navToken !== kickToken) return;
          checkApprovalAndEnter();
        })
        .catch(function () {
          if (navToken !== kickToken) return;
          checkApprovalAndEnter();
        });
    } else {
      db.disableNetwork()
        .then(function () {
          db.enableNetwork();
        })
        .catch(function () {});
      showCGScreen('select');
    }
  }
}

function showCGScreen(screen) {
  if (screen === 'select') {
    var mainTitle = document.getElementById('cg-main-title');
    if (mainTitle) {
      mainTitle.textContent = 'C.A.R.E. Groups';
    }
    updateSelectConnectionStatus();
  }
  ['select', 'login', 'pending', 'chat', 'members', 'changepassword'].forEach(function (s) {
    var el = document.getElementById('cg-' + s + '-screen');
    if (el) el.style.display = 'none';
  });
  var show = document.getElementById('cg-' + screen + '-screen');
  if (show) show.style.display = 'block';
  if (screen === 'chat') {
    showInputBar();
    if (currentGroup) {
      setPendingCount(currentGroup, pendingCountsByGroup[currentGroup] || 0);
    }
  } else {
    hideInputBar();
  }
}

function toggleVisible(inputId, btn) {
  var input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
  } else {
    input.type = 'password';
    btn.textContent = '👀';
  }
}

function startOver() {
  clearUnreadCount(currentGroup);
  setPendingCount(currentGroup, 0);
  clearSavedUser(currentGroup);
  currentUser = null;
  currentGroup = null;
  currentGroupName = null;
  currentMemberKey = null;
  showCGScreen('select');
}

// ---- ROOM SWITCH CLEANUP ----
// Called before currentGroup changes so the old listener can never write
// into the new room's state. localStorage cache is preserved intentionally
// so returning to a room costs zero extra Firestore reads.
function leaveCurrentRoom() {
  if (messageListener) {
    messageListener();
    messageListener = null;
  }
  if (currentGroup) {
    delete roomMessageStateByGroup[currentGroup];
  }
  var messagesEl = document.getElementById('cg-messages');
  if (messagesEl) messagesEl.innerHTML = '';
  replyingTo = null;
  var replyBar = document.getElementById('cg-reply-bar');
  if (replyBar) replyBar.style.display = 'none';
  var mask = document.getElementById('cg-loading-mask');
  if (mask) mask.style.display = 'none';
}

function selectGroup(groupId, groupName) {
  navToken++;

  // Kill the old listener BEFORE currentGroup changes — prevents stale
  // snapshots from writing into the new room's message state.
  leaveCurrentRoom();

  currentGroup = groupId;
  currentGroupName = groupName;

  clearInterval(migrationPollInterval);
  migrationPollInterval = null;

  var saved = getSavedUser(groupId);
  if (saved) {
    currentUser = saved;
    currentMemberKey = saved.normalizedName;
    setLastGroup(groupId);
    var kickToken = navToken;
    db.disableNetwork()
      .then(function () {
        return db.enableNetwork();
      })
      .then(function () {
        if (navToken !== kickToken) return;
        checkApprovalAndEnter();
      })
      .catch(function () {
        if (navToken !== kickToken) return;
        checkApprovalAndEnter();
      });
    return;
  }

  if (currentUID) {
    var token = navToken;
    db.collection('groups')
      .doc(groupId)
      .collection('members')
      .doc(currentUID)
      .get()
      .then(function (snap) {
        if (token !== navToken) return;
        if (snap.exists && snap.data().approved) {
          var data = snap.data();
          currentUser = {
            group: groupId,
            groupName: groupName,
            name: data.displayName,
            normalizedName: data.normalizedName,
            isAdmin: data.isAdmin === true
          };
          currentMemberKey = data.normalizedName;
          saveUser(currentUser);
          setLastGroup(groupId);
          checkApprovalAndEnter();
        } else if (migrationInProgress) {
          var attempts = 0;
          migrationPollInterval = setInterval(function () {
            attempts++;
            var recheck = getSavedUser(groupId);
            if (recheck) {
              clearInterval(migrationPollInterval);
              migrationPollInterval = null;
              currentUser = recheck;
              currentMemberKey = recheck.normalizedName;
              setLastGroup(groupId);
              checkApprovalAndEnter();
            } else if (!migrationInProgress || attempts >= 10) {
              clearInterval(migrationPollInterval);
              migrationPollInterval = null;
              showLoginScreen(groupId, groupName);
            }
          }, 500);
        } else {
          showLoginScreen(groupId, groupName);
        }
      })
      .catch(function () {
        showLoginScreen(groupId, groupName);
      });
    return;
  }

  showLoginScreen(groupId, groupName);
}

function showLoginScreen(groupId, groupName) {
  document.getElementById('cg-login-title').textContent = groupName;
  ['cg-room-password', 'cg-user-name', 'cg-user-pin'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('cg-login-error').textContent = '';
  showCGScreen('login');
}

// ---- PENDING SCREEN MESSAGES ----
function showFirstTimeMessage() {
  var el = document.getElementById('cg-pending-msg');
  if (el)
    el.textContent =
      'Your request to join has been sent! Your group leader will approve you shortly.';
}

function showReturningUserMessage() {
  var el = document.getElementById('cg-pending-msg');
  if (el)
    el.textContent =
      'We recognize your account. This device or browser needs to be approved by your group leader before you can continue.';
}

// ---- SUBMIT LOGIN ----
var loginInProgress = false;
var migrationInProgress = false;
var migrationPollInterval = null;

function submitLogin() {
  if (loginInProgress) return;
  loginInProgress = true;

  var loginBtn = document.getElementById('cg-login-submit');
  if (loginBtn) {
    loginBtn.disabled = true;
    loginBtn.textContent = 'Logging in...';
    loginBtn.style.opacity = '0.7';
  }

  var roomPass = document.getElementById('cg-room-password').value.trim();
  var userName = document.getElementById('cg-user-name').value.trim();
  var userPassword = document.getElementById('cg-user-pin').value.trim();
  var errEl = document.getElementById('cg-login-error');
  errEl.textContent = '';

  if (!roomPass || !userName || !userPassword) {
    errEl.textContent = 'Please fill in all fields.';
    if (loginBtn) {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Log In';
      loginBtn.style.opacity = '1';
    }
    loginInProgress = false;
    return;
  }
  if (userPassword.length < 4) {
    errEl.textContent = 'Password must be at least 4 characters.';
    if (loginBtn) {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Log In';
      loginBtn.style.opacity = '1';
    }
    loginInProgress = false;
    return;
  }

  if (!authReady || !auth.currentUser) {
    errEl.textContent = 'Connecting... please try again in a moment.';
    if (loginBtn) {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Log In';
      loginBtn.style.opacity = '1';
    }
    loginInProgress = false;
    return;
  }

  currentUID = auth.currentUser.uid;
  var normalized = normalizeName(userName);
  if (!normalized) {
    errEl.textContent = 'Please enter a valid name.';
    if (loginBtn) {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Log In';
      loginBtn.style.opacity = '1';
    }
    loginInProgress = false;
    return;
  }

  var remainingLockout = getRemainingLockoutMs(currentGroup, normalized);
  if (remainingLockout > 0) {
    errEl.textContent =
      'Too many failed attempts. Please wait ' +
      formatRemainingLockout(remainingLockout) +
      ' before trying again.';
    if (loginBtn) {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Log In';
      loginBtn.style.opacity = '1';
    }
    loginInProgress = false;
    return;
  }

  // Device guard: block a different user from logging in on a device already tied to someone else
  // Sweeps all rooms in case the member doc in the current room was deleted by admin
  var allGroups = ['c101', 'narthex', 'fellowship1', 'fellowship2', 'trac'];
  var roomChecks = allGroups.map(function (groupId) {
    return db.collection('groups').doc(groupId).collection('members').doc(currentUID).get();
  });
  Promise.all(roomChecks)
    .then(function (snaps) {
      var conflict = snaps.some(function (snap) {
        return snap.exists && snap.data().normalizedName !== normalized;
      });
      if (conflict) {
        errEl.textContent =
          "This device is tied to another user's profile. Please try again on a different device.";
        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.textContent = 'Log In';
          loginBtn.style.opacity = '1';
        }
        loginInProgress = false;
        return;
      }
      runLoginPipeline();
    })
    .catch(function () {
      errEl.textContent = 'Network too weak to verify session security. Please try again.';
      if (loginBtn) {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Log In';
        loginBtn.style.opacity = '1';
      }
      loginInProgress = false;
    });

  function runLoginPipeline() {
    var identityRef = db.collection('groups').doc(currentGroup).collection('identities').doc(normalized);

    // Room password + personal password are now verified entirely server-side
    // (verifyLoginV2), so passwordHash/passwordSalt never reach the client.
    var verifyLogin = firebase.functions().httpsCallable('verifyLoginV2');
    verifyLogin({
      groupId: currentGroup,
      normalizedName: normalized,
      roomPassword: roomPass,
      userPassword: userPassword
    })
      .then(function (verifyResult) {
        if (verifyResult.data.identityExists) {
          var identity = { displayName: verifyResult.data.displayName };

          clearLoginGuard(currentGroup, normalized);

          var memberRef = db
                    .collection('groups')
                    .doc(currentGroup)
                    .collection('members')
                    .doc(currentUID);
                  memberRef
                    .get()
                    .then(function (memberSnap) {
                      if (memberSnap.exists) {
                        memberRef.update({
                          lastLoginAt: Date.now(),
                          removalRequested: false,
                          removalRequestedAt: firebase.firestore.FieldValue.delete()
                        });

                        var memberData = memberSnap.data();
                        currentMemberKey = normalized;
                        currentUser = {
                          group: currentGroup,
                          groupName: currentGroupName,
                          name: identity.displayName,
                          normalizedName: normalized,
                          isAdmin: memberData.isAdmin === true
                        };
                        saveUser(currentUser);
                        setLastGroup(currentGroup);
                        listenForBadgeUpdates();
                        if (loginBtn) {
                          loginBtn.disabled = false;
                          loginBtn.textContent = 'Log In';
                          loginBtn.style.opacity = '1';
                        }
                        loginInProgress = false;
                        if (memberData.approved) {
                          silentlyRestoreRoomsFromUID();
                          enterChat();
                        } else {
                          document.getElementById('cg-pending-title').textContent =
                            currentGroupName;
                          showReturningUserMessage();
                          showCGScreen('pending');
                        }
                      } else {
                        var migrateUid = firebase.functions().httpsCallable('migrateUidV2');
                        migrateUid({
                          groupId: currentGroup,
                          normalizedName: normalized,
                          userPassword: userPassword
                        })
                          .then(function (result) {
                            if (result.data.status === 'migrated') {
                              currentMemberKey = normalized;
                              currentUser = {
                                group: currentGroup,
                                groupName: currentGroupName,
                                name: result.data.displayName,
                                normalizedName: normalized,
                                isAdmin: result.data.isAdmin === true
                              };
                              saveUser(currentUser);
                              setLastGroup(currentGroup);
                              var discoveredOldUID = result.data.oldUID || null;
                              var allSaved = getSavedUsers();
                              var groupsToMigrate = [];
                              if (allSaved && Object.keys(allSaved).length > 0) {
                                Object.keys(allSaved).forEach(function (groupId) {
                                  var s = allSaved[groupId];
                                  if (s && s.normalizedName) {
                                    groupsToMigrate.push({
                                      groupId: groupId,
                                      normalizedName: s.normalizedName
                                    });
                                  }
                                });
                              }
                              if (groupsToMigrate.length > 0 || discoveredOldUID) {
                                var migrateAll = firebase
                                  .functions()
                                  .httpsCallable('migrateAllGroupsV2');
                                migrationInProgress = true;
                                migrateAll({ groups: groupsToMigrate, oldUID: discoveredOldUID })
                                  .then(function (res) {
                                    console.log(
                                      'In-session multi-group migration successful:',
                                      res.data
                                    );
                                    var groupNames = {
                                      c101: 'C101',
                                      narthex: 'Narthex',
                                      fellowship1: 'Fellowship Hall 1st Floor',
                                      fellowship2: 'Fellowship Hall 2nd Floor',
                                      trac: 'T.R.A.C.'
                                    };
                                    if (res.data && Array.isArray(res.data.results)) {
                                      res.data.results.forEach(function (r) {
                                        if (
                                          (r.status === 'migrated' ||
                                            r.status === 'migrated-by-uid') &&
                                          r.displayName &&
                                          r.normalizedName
                                        ) {
                                          saveUser({
                                            group: r.groupId,
                                            groupName: groupNames[r.groupId] || r.groupId,
                                            name: r.displayName,
                                            normalizedName: r.normalizedName,
                                            isAdmin: r.isAdmin === true
                                          });
                                        }
                                      });
                                    }
                                    migrationInProgress = false;
                                  })
                                  .catch(function (err) {
                                    console.log(
                                      'In-session multi-group migration skipped:',
                                      err.message
                                    );
                                  })
                                  .finally(function () {
                                    migrationInProgress = false;
                                  });
                              }
                              listenForBadgeUpdates();
                              if (loginBtn) {
                                loginBtn.disabled = false;
                                loginBtn.textContent = 'Log In';
                                loginBtn.style.opacity = '1';
                              }
                              loginInProgress = false;
                              silentlyRestoreRoomsFromUID();
                              enterChat();
                            } else {
                              memberRef
                                .set({
                                  uid: currentUID,
                                  normalizedName: normalized,
                                  displayName: identity.displayName,
                                  approved: false,
                                  isAdmin: false,
                                  createdAt: Date.now(),
                                  lastLoginAt: Date.now()
                                })
                                .then(function () {
                                  currentMemberKey = normalized;
                                  currentUser = {
                                    group: currentGroup,
                                    groupName: currentGroupName,
                                    name: identity.displayName,
                                    normalizedName: normalized,
                                    isAdmin: false
                                  };
                                  saveUser(currentUser);
                                  setLastGroup(currentGroup);
                                  listenForBadgeUpdates();
                                  document.getElementById('cg-pending-title').textContent =
                                    currentGroupName;
                                  showReturningUserMessage();
                                  showCGScreen('pending');
                                  if (loginBtn) {
                                    loginBtn.disabled = false;
                                    loginBtn.textContent = 'Log In';
                                    loginBtn.style.opacity = '1';
                                  }
                                  loginInProgress = false;
                                })
                                .catch(function (err) {
                                  if (loginBtn) {
                                    loginBtn.disabled = false;
                                    loginBtn.textContent = 'Log In';
                                    loginBtn.style.opacity = '1';
                                  }
                                  loginInProgress = false;
                                  errEl.textContent = 'Session error: ' + err.message;
                                });
                            }
                          })
                          .catch(function (err) {
                            if (err.code === 'not-found') {
                              memberRef
                                .set({
                                  uid: currentUID,
                                  normalizedName: normalized,
                                  displayName: identity.displayName,
                                  approved: false,
                                  isAdmin: false,
                                  createdAt: Date.now(),
                                  lastLoginAt: Date.now()
                                })
                                .then(function () {
                                  currentMemberKey = normalized;
                                  currentUser = {
                                    group: currentGroup,
                                    groupName: currentGroupName,
                                    name: identity.displayName,
                                    normalizedName: normalized,
                                    isAdmin: false
                                  };
                                  saveUser(currentUser);
                                  setLastGroup(currentGroup);
                                  listenForBadgeUpdates();
                                  document.getElementById('cg-pending-title').textContent =
                                    currentGroupName;
                                  showReturningUserMessage();
                                  showCGScreen('pending');
                                  if (loginBtn) {
                                    loginBtn.disabled = false;
                                    loginBtn.textContent = 'Log In';
                                    loginBtn.style.opacity = '1';
                                  }
                                  loginInProgress = false;
                                })
                                .catch(function (err2) {
                                  if (loginBtn) {
                                    loginBtn.disabled = false;
                                    loginBtn.textContent = 'Log In';
                                    loginBtn.style.opacity = '1';
                                  }
                                  loginInProgress = false;
                                  errEl.textContent = 'Session error: ' + err2.message;
                                });
                            } else {
                              if (loginBtn) {
                                loginBtn.disabled = false;
                                loginBtn.textContent = 'Log In';
                                loginBtn.style.opacity = '1';
                              }
                              loginInProgress = false;
                              errEl.textContent = 'Migration error: ' + err.message;
                            }
                          });
                      }
                    })
                    .catch(function (err) {
                      if (loginBtn) {
                        loginBtn.disabled = false;
                        loginBtn.textContent = 'Log In';
                        loginBtn.style.opacity = '1';
                      }
                      loginInProgress = false;
                      errEl.textContent = 'Member lookup error: ' + err.message;
                    });
              } else {
                // Brand new profile registration path
                var passwordSalt = generateSalt();
                hashInput(userPassword, passwordSalt).then(function (passwordHash) {
                  identityRef
                    .set({
                      displayName: userName,
                      normalizedName: normalized,
                      passwordHash: passwordHash,
                      passwordSalt: passwordSalt,
                      approved: false,
                      isAdmin: false,
                      createdAt: Date.now()
                    })
                    .then(function () {
                      return db
                        .collection('groups')
                        .doc(currentGroup)
                        .collection('members')
                        .doc(currentUID)
                        .set({
                          uid: currentUID,
                          normalizedName: normalized,
                          displayName: userName,
                          approved: false,
                          isAdmin: false,
                          createdAt: Date.now(),
                          lastLoginAt: Date.now()
                        });
                    })
                    .then(function () {
                      clearLoginGuard(currentGroup, normalized);
                      currentMemberKey = normalized;
                      currentUser = {
                        group: currentGroup,
                        groupName: currentGroupName,
                        name: userName,
                        normalizedName: normalized,
                        isAdmin: false
                      };
                      saveUser(currentUser);
                      setLastGroup(currentGroup);
                      listenForBadgeUpdates();
                      document.getElementById('cg-pending-title').textContent = currentGroupName;
                      showFirstTimeMessage();
                      showCGScreen('pending');
                      if (loginBtn) {
                        loginBtn.disabled = false;
                        loginBtn.textContent = 'Log In';
                        loginBtn.style.opacity = '1';
                      }
                      loginInProgress = false;
                    })
                    .catch(function (err) {
                      if (loginBtn) {
                        loginBtn.disabled = false;
                        loginBtn.textContent = 'Log In';
                        loginBtn.style.opacity = '1';
                      }
                      loginInProgress = false;
                      errEl.textContent = 'Registration error: ' + err.message;
                    });
                });
              }
      })
      .catch(function (err) {
        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.textContent = 'Log In';
          loginBtn.style.opacity = '1';
        }
        loginInProgress = false;

        if (err && err.code === 'permission-denied') {
          // Wrong room password or wrong personal password (server-verified).
          recordFailedLogin(currentGroup, normalized);
          var remainingAfterFailure = getRemainingLockoutMs(currentGroup, normalized);
          if (remainingAfterFailure > 0) {
            errEl.textContent =
              'Too many failed attempts. Please wait ' +
              formatRemainingLockout(remainingAfterFailure) +
              ' before trying again.';
          } else {
            errEl.textContent = err.message;
          }
        } else if (err && err.code === 'resource-exhausted') {
          // Server-enforced lockout — authoritative even if the local guard
          // was cleared (new device, cleared storage, etc).
          errEl.textContent = err.message;
        } else {
          errEl.textContent = 'Login error: ' + (err && err.message ? err.message : 'Please try again.');
        }
      });
  }
}

// ---- CHECK APPROVAL ----
function checkApproval() {
  if (!currentUID || !currentGroup) return;
  var btn = document.getElementById('cg-check-btn');
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.6';
  }
  db.collection('groups')
    .doc(currentGroup)
    .collection('members')
    .doc(currentUID)
    .get()
    .then(function (snap) {
      if (snap.exists && snap.data().approved) {
        currentUser.isAdmin = snap.data().isAdmin === true;
        saveUser(currentUser);
        setLastGroup(currentGroup);
        listenForBadgeUpdates();
        silentlyRestoreRoomsFromUID();
        enterChat();
      } else {
        alert('Not approved yet. Please wait for your group leader to approve you.');
      }
    })
    .catch(function (err) {
      console.error('checkApproval error:', err);
    })
    .finally(function () {
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = '';
      }
    });
}

function checkApprovalAndEnter() {
  if (!currentUID || !currentGroup) {
    showCGScreen('select');
    return;
  }
  var token = navToken;
  db.collection('groups')
    .doc(currentGroup)
    .collection('members')
    .doc(currentUID)
    .get()
    .then(function (snap) {
      if (token !== navToken) return;
      if (snap.exists && snap.data().approved) {
        currentUser.isAdmin = snap.data().isAdmin === true;
        if (snap.data().removalRequested) {
          db.collection('groups')
            .doc(currentGroup)
            .collection('members')
            .doc(currentUID)
            .update({
              removalRequested: false,
              removalRequestedAt: firebase.firestore.FieldValue.delete()
            })
            .catch(function () {});
        }
        saveUser(currentUser);
        setLastGroup(currentGroup);
        listenForBadgeUpdates();
        silentlyRestoreRoomsFromUID();
        enterChat();
      } else if (snap.exists) {
        document.getElementById('cg-pending-title').textContent = currentGroupName;
        showCGScreen('pending');
      } else {
        clearUnreadCount(currentGroup);
        clearSavedUser(currentGroup);
        showCGScreen('select');
      }
    })
    .catch(function (err) {
      var isNetworkError =
        err &&
        (err.code === 'unavailable' ||
          err.code === 'deadline-exceeded' ||
          (err.message && err.message.toLowerCase().indexOf('network') !== -1));
      if (!isNetworkError) {
        clearUnreadCount(currentGroup);
        clearSavedUser(currentGroup);
      }
      showCGScreen('select');
    });
}
function silentlyRestoreRoomsFromUID() {
  if (!currentUID) return;
  var alreadyRestored = localStorage.getItem('mhbc_uid_restored_' + currentUID);
  if (alreadyRestored) return;
  var allGroups = ['c101', 'narthex', 'fellowship1', 'fellowship2', 'trac'];
  var groupNames = {
    c101: 'C101',
    narthex: 'Narthex',
    fellowship1: 'Fellowship Hall 1st Floor',
    fellowship2: 'Fellowship Hall 2nd Floor',
    trac: 'T.R.A.C.'
  };
  var checks = allGroups.filter(function (groupId) {
    return groupId !== currentGroup && !getSavedUser(groupId);
  });
  if (checks.length === 0) {
    localStorage.setItem('mhbc_uid_restored_' + currentUID, '1');
    return;
  }
  var completed = 0;
  checks.forEach(function (groupId) {
    db.collection('groups')
      .doc(groupId)
      .collection('members')
      .doc(currentUID)
      .get()
      .then(function (snap) {
        if (snap.exists && snap.data().approved) {
          var data = snap.data();
          saveUser({
            group: groupId,
            groupName: groupNames[groupId] || groupId,
            name: data.displayName,
            normalizedName: data.normalizedName,
            isAdmin: data.isAdmin === true
          });
          console.log('Silently restored room from UID:', groupId);
        }
      })
      .catch(function () {})
      .finally(function () {
        completed++;
        if (completed === checks.length) {
          localStorage.setItem('mhbc_uid_restored_' + currentUID, '1');
        }
      });
  });
}
function getLastOpenedKey(groupId) {
  return 'mhbc_last_opened_' + groupId;
}

function getLastOpenedTimestamp(groupId) {
  var raw = localStorage.getItem(getLastOpenedKey(groupId));
  var value = parseInt(raw, 10);
  return isNaN(value) ? 0 : value;
}

function setLastOpenedTimestamp(groupId) {
  if (!groupId) return;
  localStorage.setItem(getLastOpenedKey(groupId), String(Date.now()));
}
function refreshCurrentMembersBadge() {
  var membersBadge = document.getElementById('members-badge');
  if (!membersBadge || !currentGroup) return;

  var currentPending = pendingCountsByGroup[currentGroup] || 0;

  if (currentPending > 0) {
    membersBadge.textContent = currentPending > 99 ? '99+' : String(currentPending);
    membersBadge.style.display = 'flex';
  } else {
    membersBadge.style.display = 'none';
    membersBadge.textContent = '';
  }
}
function enterChat() {
  // Second safety net: clears any listener that may have fired between
  // selectGroup's leaveCurrentRoom() call and now (e.g. during approval flow).
  leaveCurrentRoom();

  roomMessageStateByGroup[currentGroup] = getRoomMessageCache(currentGroup);

  var previousOpenedTs = getLastOpenedTimestamp(currentGroup);
  var hadUnreadAtEntry = (unreadCountsByGroup[currentGroup] || 0) > 0;

  roomMessageStateByGroup[currentGroup].newMessageBoundaryTs = hadUnreadAtEntry
    ? previousOpenedTs || 0
    : 0;

  roomMessageStateByGroup[currentGroup].showNewMessageDivider =
    hadUnreadAtEntry && previousOpenedTs > 0;
  var mainTitle = document.getElementById('cg-main-title');
  if (mainTitle) {
    mainTitle.innerHTML =
      'C.A.R.E. Groups<br><span class="cg-room-title-line">' + currentGroupName + '</span>';
  }

  var prayerBtn = document.getElementById('cg-prayer-btn');
  if (prayerBtn) {
    var prayerLink = PRAYER_LINKS[currentGroup];
    prayerBtn.onclick = function () {
      if (prayerLink) {
        window.open(prayerLink, '_blank');
      } else {
        alert('Coming soon!');
      }
    };
  }

  var mb = document.getElementById('cg-members-btn');
  if (mb) {
    mb.style.display = 'block';
    setPendingCount(currentGroup, pendingCountsByGroup[currentGroup] || 0);
  }
  refreshCurrentMembersBadge();

  showCGScreen('chat');

  var chatScreen = document.getElementById('cg-chat-screen');
  var mask = document.getElementById('cg-loading-mask');
  if (!mask && chatScreen) {
    mask = document.createElement('div');
    mask.id = 'cg-loading-mask';
    mask.style.cssText =
      'position:fixed;top:60px;left:0;right:0;bottom:60px;background:#0a1628;z-index:99;display:flex;align-items:center;justify-content:center;color:#7a8fa8;font-size:15px;';
    mask.innerHTML = 'Loading messages...';
    chatScreen.appendChild(mask);
  }
  if (mask) mask.style.display = 'flex';

  loadMessages(true);
  markAsRead();

  setTimeout(function () {
    setLastOpenedTimestamp(currentGroup);
  }, 1500);
}

function setReply(messageId, authorName) {
  if (!navigator.onLine) {
    showToast('No connection.');
    return;
  }
  replyingTo = { id: messageId, author: authorName };

  var bar = document.getElementById('cg-reply-bar');
  if (bar) bar.style.display = 'none';

  hideInputBar();
  loadMessages();

  setTimeout(function () {
    var inlineInput = document.getElementById('inline-reply-input-' + messageId);
    if (inlineInput) {
      inlineInput.focus();
      inlineInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 100);
}

function clearReply() {
  replyingTo = null;
  var bar = document.getElementById('cg-reply-bar');
  if (bar) bar.style.display = 'none';
  showInputBar();
  renderCurrentRoomMessages(false);
}

function sendInlineReply(parentId) {
  var input = document.getElementById('inline-reply-input-' + parentId);
  if (!input || !db || !currentUID) return;

  var text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  playSendSound();

  var nowMs = Date.now();
  var localTs = {
    toMillis: function () {
      return nowMs;
    }
  };
  var nowTs = firebase.firestore.FieldValue.serverTimestamp();
  var replyAuthor = replyingTo ? replyingTo.author : '';

  var msgData = {
    text: text,
    author: currentUser.name,
    authorKey: currentMemberKey,
    authorUid: currentUID,
    timestamp: nowTs,
    updatedAt: nowTs,
    edited: false,
    deleted: false,
    replyTo: parentId,
    replyToAuthor: replyAuthor
  };

  var docRef = db.collection('groups').doc(currentGroup).collection('messages').doc();

  // Show the reply immediately — a pending serverTimestamp() reads back as
  // null on this device until the write is acknowledged, so the live
  // "new messages" listener can't show it until the round trip completes.
  var state = getCurrentRoomState();
  mergeMessagesIntoRoomState(state, [
    {
      _id: docRef.id,
      text: text,
      author: currentUser.name,
      authorKey: currentMemberKey,
      authorUid: currentUID,
      timestamp: localTs,
      updatedAt: localTs,
      edited: false,
      deleted: false,
      replyTo: parentId,
      replyToAuthor: replyAuthor
    }
  ]);
  saveRoomMessageCache(currentGroup, state);

  suppressAutoScrollUntil = Date.now() + 2000;
  clearReply();

  setTimeout(function () {
    var thread = document.getElementById('thread-' + parentId);
    if (thread) {
      thread.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 150);

  docRef.set(msgData).catch(function (err) {
    console.error('SEND REPLY FAILED:', err);
    removeMessageFromRoomState(state, docRef.id);
    saveRoomMessageCache(currentGroup, state);
    renderCurrentRoomMessages(false);
    showToast('Reply failed to send. Check your connection and try again.');
  });
}

// ---- MESSAGE OWNERSHIP — three-tier fallback ----
function isMyMessage(msg) {
  if (msg.authorUid && currentUID && msg.authorUid === currentUID) return true;
  if (msg.authorKey && currentMemberKey && msg.authorKey === currentMemberKey) return true;
  if (
    !msg.authorUid &&
    !msg.authorKey &&
    msg.author &&
    currentUser &&
    msg.author === currentUser.name
  )
    return true;
  return false;
}

// ---- LONG PRESS MENU ----
function showMessageMenu(msgId, isMe) {
  var existing = document.getElementById('msg-menu');
  if (existing) existing.remove();
  var menu = document.createElement('div');
  menu.id = 'msg-menu';
  menu.className = 'msg-menu';

  if (isMe) {
    var editBtn = document.createElement('button');
    editBtn.className = 'msg-menu-btn';
    editBtn.textContent = '✏️ Edit';
    editBtn.addEventListener('click', function () {
      menu.remove();
      editMessage(msgId);
    });
    menu.appendChild(editBtn);
  }
  if (isMe || currentUser.isAdmin) {
    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'msg-menu-btn msg-menu-delete';
    deleteBtn.textContent = '🗑️ Delete';
    deleteBtn.addEventListener('click', function () {
      menu.remove();
      if (!navigator.onLine) {
        showToast('No connection.');
        return;
      }
      if (deleteInProgressIds[msgId]) return;

      if (confirm('Delete this message?')) {
        deleteInProgressIds[msgId] = true;
        suppressAutoScrollUntil = Date.now() + 2000;

        db.collection('groups')
          .doc(currentGroup)
          .collection('messages')
          .doc(msgId)
          .update({
            text: '',
            deleted: true,
            edited: false,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          })
          .then(function () {
            delete deleteInProgressIds[msgId];
            var state = getCurrentRoomState();
            if (state.messagesById[msgId]) {
              state.messagesById[msgId].text = '';
              state.messagesById[msgId].deleted = true;
              state.messagesById[msgId].edited = false;
              saveRoomMessageCache(currentGroup, state);
              renderCurrentRoomMessages(false);
            }
          })
          .catch(function (err) {
            delete deleteInProgressIds[msgId];
            console.error('Soft delete failed:', err);
          });
      }
    });
    menu.appendChild(deleteBtn);
  }
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'msg-menu-btn msg-menu-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function () {
    menu.remove();
  });
  menu.appendChild(cancelBtn);
  document.body.appendChild(menu);
  setTimeout(function () {
    document.addEventListener('click', function dismiss() {
      menu.remove();
      document.removeEventListener('click', dismiss);
    });
  }, 100);
}

function editMessage(msgId) {
  if (!navigator.onLine) {
    showToast('No connection.');
    return;
  }
  if (editInProgress) {
    showToast('Opening editor…');
    return;
  }
  editInProgress = true;
  setTimeout(function () {
    editInProgress = false;
  }, 8000); // safety reset if something hangs
  var msgRef = db.collection('groups').doc(currentGroup).collection('messages').doc(msgId);

  msgRef
    .get()
    .then(function (snap) {
      editInProgress = false;
      if (!snap.exists) {
        var state = getCurrentRoomState();
        removeMessageFromRoomState(state, msgId);
        saveRoomMessageCache(currentGroup, state);
        renderCurrentRoomMessages(false);
        return;
      }

      var currentText = snap.data().text || '';

      var overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';

      var box = document.createElement('div');
      box.style.cssText =
        'background:#1a2a44;border:1px solid #c9a84c;border-radius:12px;padding:20px;width:100%;max-width:400px;';

      var label = document.createElement('div');
      label.textContent = 'Edit your message:';
      label.style.cssText =
        'color:#c9a84c;font-family:Lato,sans-serif;font-size:13px;font-weight:700;margin-bottom:10px;';

      var textarea = document.createElement('textarea');
      textarea.className = 'cg-edit-input';
      textarea.value = currentText;
      textarea.style.cssText =
        'width:100%;box-sizing:border-box;background:#0a1628;color:#fff;border:1px solid #c9a84c;border-radius:8px;padding:10px;font-family:Lato,sans-serif;font-size:16px;min-height:80px;resize:none;';

      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:14px;';

      var cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText =
        'background:transparent;border:1px solid #c9a84c;color:#c9a84c;padding:8px 18px;border-radius:6px;font-family:Lato,sans-serif;font-size:13px;font-weight:700;cursor:pointer;';

      var saveBtn = document.createElement('button');
      saveBtn.className = 'cg-edit-save-btn';
      saveBtn.textContent = 'Save';
      saveBtn.style.cssText =
        'background:#c9a84c;border:none;color:#0a1628;padding:8px 18px;border-radius:6px;font-family:Lato,sans-serif;font-size:13px;font-weight:700;cursor:pointer;';

      function closeOverlay() {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }

      var editSaveInProgress = false;

      cancelBtn.addEventListener('click', function () {
        if (editSaveInProgress) return; // save already in flight — Cancel can't stop it
        closeOverlay();
      });

      saveBtn.addEventListener('click', function () {
        if (editSaveInProgress) return;

        var newText = textarea.value.trim();

        if (!newText || newText === currentText) {
          closeOverlay();
          return;
        }

        suppressAutoScrollUntil = Date.now() + 2000;

        editSaveInProgress = true;
        saveBtn.disabled = true;
        cancelBtn.disabled = true;
        saveBtn.style.opacity = '0.6';
        cancelBtn.style.opacity = '0.4';
        saveBtn.textContent = 'Saving…';

        msgRef
          .update({
            text: newText,
            edited: true,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          })
          .then(function () {
            playSendSound();

            var state = getCurrentRoomState();

            if (state.messagesById[msgId]) {
              state.messagesById[msgId].text = newText;
              state.messagesById[msgId].edited = true;
              state.messagesById[msgId].deleted = false;
              saveRoomMessageCache(currentGroup, state);
              renderCurrentRoomMessages(false);
            }

            closeOverlay();
          })
          .catch(function (err) {
            console.error('Edit failed:', err);
            editSaveInProgress = false;
            saveBtn.disabled = false;
            cancelBtn.disabled = false;
            saveBtn.style.opacity = '1';
            cancelBtn.style.opacity = '1';
            saveBtn.textContent = 'Save';
            alert('Edit failed: ' + err.message);
          });
      });

      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeOverlay();
      });

      textarea.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          saveBtn.click();
        }
      });

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(saveBtn);
      box.appendChild(label);
      box.appendChild(textarea);
      box.appendChild(btnRow);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      setTimeout(function () {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }, 100);
    })
    .catch(function (err) {
      editInProgress = false;
      console.error('Edit lookup failed:', err);
      alert('Edit failed: ' + err.message);
    });
}

// ---- YOUTUBE ID EXTRACTOR ----
function extractYouTubeId(url) {
  var patterns = [
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/
  ];
  for (var i = 0; i < patterns.length; i++) {
    var match = url.match(patterns[i]);
    if (match) return match[1];
  }
  return null;
}

// ---- RICH MEDIA RENDERER ----
function renderMessageContent(text, container) {
  if (!text) return;

  // Split on URLs but preserve newlines and whitespace
  var parts = text.split(/(https?:\/\/[^\s]+)/g);

  parts.forEach(function (part) {
    if (!part) return;

    if (part.match(/^https?:\/\//)) {
      // URL / Media handling
      var url = part;
      var ytId = extractYouTubeId(url);
      if (ytId) {
        var wrap = document.createElement('div');
        wrap.className = 'msg-yt-wrap';
        var thumb = document.createElement('img');
        thumb.src = 'https://img.youtube.com/vi/' + ytId + '/hqdefault.jpg';
        thumb.className = 'msg-image msg-yt-thumb';
        thumb.setAttribute('loading', 'lazy');
        thumb.addEventListener('click', function () {
          window.open(url, '_blank');
        });
        var play = document.createElement('div');
        play.className = 'msg-yt-play';
        play.textContent = '▶';
        play.addEventListener('click', function () {
          window.open(url, '_blank');
        });
        wrap.appendChild(thumb);
        wrap.appendChild(play);
        container.appendChild(wrap);
        return;
      }
      if (url.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i)) {
        var img = document.createElement('img');
        img.src = url;
        img.className = 'msg-image';
        img.setAttribute('loading', 'lazy');
        img.addEventListener('click', function () {
          window.open(url, '_blank');
        });
        container.appendChild(img);
        return;
      }
      if (url.match(/\.(mp4|webm|ogg)(\?.*)?$/i)) {
        var video = document.createElement('video');
        video.src = url;
        video.className = 'msg-video';
        video.controls = true;
        video.setAttribute('playsinline', '');
        container.appendChild(video);
        return;
      }
      var link = document.createElement('a');
      link.href = url;
      link.textContent = url;
      link.target = '_blank';
      link.className = 'msg-link';
      container.appendChild(link);
    } else {
      // Plain text: preserve newlines and blank lines
var lines = part.split('\n');
lines.forEach(function (line, index) {
  if (index > 0) {
    var br = document.createElement('br');
    container.appendChild(br);
  }
  if (line) {
    var span = document.createElement('span');
    span.textContent = line;
    container.appendChild(span);
  }
});
    }
  });
}
function getMessageTime(msg) {
  if (!msg || !msg.timestamp) return 0;
  if (typeof msg.timestamp.toMillis === 'function') return msg.timestamp.toMillis();
  if (typeof msg.timestamp.seconds === 'number') return msg.timestamp.seconds * 1000;
  if (typeof msg.timestamp === 'number') return msg.timestamp;
  return 0;
}
function getUpdatedTime(msg) {
  if (!msg) return 0;
  if (msg.updatedAt && typeof msg.updatedAt.toMillis === 'function')
    return msg.updatedAt.toMillis();
  if (msg.updatedAt && typeof msg.updatedAt.seconds === 'number')
    return msg.updatedAt.seconds * 1000;
  if (typeof msg.updatedAt === 'number') return msg.updatedAt;
  return getMessageTime(msg);
}
function refreshHasOlderMessages() {
  var state = getCurrentRoomState();
  var previousValue = state.hasOlderMessages;

  if (!state.oldestTimestamp) {
    state.hasOlderMessages = false;
    if (previousValue !== state.hasOlderMessages) {
      renderCurrentRoomMessages(false);
    }
    return;
  }

  db.collection('groups')
    .doc(currentGroup)
    .collection('messages')
    .where('timestamp', '<', firebase.firestore.Timestamp.fromMillis(state.oldestTimestamp))
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get()
    .then(function (snap) {
      state.hasOlderMessages = !snap.empty;
      if (previousValue !== state.hasOlderMessages) {
        renderCurrentRoomMessages(false);
      }
    })
    .catch(function () {
      state.hasOlderMessages = false;
      if (previousValue !== state.hasOlderMessages) {
        renderCurrentRoomMessages(false);
      }
    });
}

function loadOlderMessages() {
  var state = getCurrentRoomState();
  if (!state.oldestTimestamp) return;

  suppressAutoScrollUntil = Date.now() + 2000;

  function fetchOlder(boundaryTs, allowFallback) {
    db.collection('groups')
      .doc(currentGroup)
      .collection('messages')
      .where('timestamp', '<=', firebase.firestore.Timestamp.fromMillis(boundaryTs))
      .orderBy('timestamp', 'desc')
      .limit(MESSAGE_PAGE_SIZE + 1)
      .get()
      .then(function (snap) {
        var older = [];

        snap.forEach(function (doc) {
          var msg = normalizeFirestoreMessage(doc);
          if (!state.messagesById[msg._id]) {
            older.push(msg);
          }
        });

        if (!older.length && allowFallback && boundaryTs > 0) {
          fetchOlder(boundaryTs - 1, false);
          return;
        }

        older.reverse();
        mergeMessagesIntoRoomState(state, older);
        saveRoomMessageCache(currentGroup, state);
        refreshHasOlderMessages();
        renderCurrentRoomMessages(false);
      });
  }

  fetchOlder(state.oldestTimestamp, true);
}

function viewOriginalMessage(parentId) {
  if (!currentGroup || !parentId) return;

  var state = getCurrentRoomState();

  if (state.messagesById[parentId]) {
    suppressAutoScrollUntil = Date.now() + 2000;
    renderCurrentRoomMessages(false);

    setTimeout(function () {
      var thread = document.getElementById('thread-' + parentId);
      if (thread) thread.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);

    return;
  }

  db.collection('groups')
    .doc(currentGroup)
    .collection('messages')
    .doc(parentId)
    .get()
    .then(function (snap) {
      if (!snap.exists) return;

      var msg = normalizeFirestoreMessage(snap);
      mergeMessagesIntoRoomState(state, [msg]);
      saveRoomMessageCache(currentGroup, state);

      suppressAutoScrollUntil = Date.now() + 2000;
      renderCurrentRoomMessages(false);

      setTimeout(function () {
        var thread = document.getElementById('thread-' + parentId);
        if (thread) thread.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 200);
    });
}

function renderMissingParentReply(msg, container, showDivider) {
  var wrap = document.createElement('div');
  wrap.className = 'cg-thread cg-missing-thread';

  var info = document.createElement('div');
  info.className = 'cg-missing-parent-bar';

  var infoText = document.createElement('span');
  infoText.className = 'cg-missing-parent-text';
  infoText.textContent = 'Reply to an older message';

  var viewBtn = document.createElement('button');
  viewBtn.className = 'cg-missing-parent-btn';
  viewBtn.type = 'button';
  viewBtn.textContent = 'View original message';
  viewBtn.addEventListener('click', function () {
    viewOriginalMessage(msg.replyTo);
  });

  info.appendChild(infoText);
  info.appendChild(viewBtn);
  wrap.appendChild(info);

  var repliesContainer = document.createElement('div');
  repliesContainer.className = 'cg-replies-container';
  renderReplyMessage(msg, repliesContainer);
  wrap.appendChild(repliesContainer);

  if (showDivider) {
    var divider = document.createElement('div');
    divider.className = 'cg-thread-divider';
    wrap.appendChild(divider);
  }

  container.appendChild(wrap);
}
function createNewMessageDivider() {
  var divider = document.createElement('div');
  divider.className = 'cg-new-message-divider';
  divider.textContent =
    'Here’s where you last left off. New replies to older messages may still appear above.';
  return divider;
}
function renderCurrentRoomMessages(allowAutoScroll) {
  var messagesEl = document.getElementById('cg-messages');
  var state = getCurrentRoomState();

  messagesEl.innerHTML = '';

  if (!state.orderedIds.length) {
    messagesEl.innerHTML = '<div class="cg-no-msgs">No messages yet. Say hello! 👋</div>';
    messagesEl.style.visibility = 'visible';
    var mask = document.getElementById('cg-loading-mask');
    if (mask) mask.style.display = 'none';
    return;
  }

  var allMessages = state.orderedIds.map(function (id) {
    return state.messagesById[id];
  });

  var loadedIds = {};
  allMessages.forEach(function (msg) {
    loadedIds[msg._id] = true;
  });

  var replyMap = {};
  allMessages.forEach(function (msg) {
    if (!msg.replyTo) {
      replyMap[msg._id] = [];
    }
  });

  allMessages.forEach(function (msg) {
    if (msg.replyTo && replyMap[msg.replyTo]) {
      replyMap[msg.replyTo].push(msg);
    }
  });

  var renderItems = [];
  allMessages.forEach(function (msg) {
    if (!msg.replyTo) {
      renderItems.push({
        type: 'thread',
        msg: msg,
        replies: replyMap[msg._id] || []
      });
    } else if (!loadedIds[msg.replyTo]) {
      renderItems.push({
        type: 'missingParentReply',
        msg: msg
      });
    }
  });

  if (!allowAutoScroll) {
    messagesEl.style.visibility = 'hidden';
  }

  if (state.hasOlderMessages) {
    var olderWrap = document.createElement('div');
    olderWrap.className = 'cg-older-wrap';

    var olderBtn = document.createElement('button');
    olderBtn.className = 'cg-older-btn';
    olderBtn.type = 'button';
    olderBtn.textContent = 'Load Older Messages';
    olderBtn.addEventListener('click', function () {
      loadOlderMessages();
    });

    olderWrap.appendChild(olderBtn);
    messagesEl.appendChild(olderWrap);
  }

  // === NEW MESSAGES DIVIDER LOGIC ===
  var newMessageBoundaryTs = state.newMessageBoundaryTs || 0;

  if (state.showNewMessageDivider && newMessageBoundaryTs > 0) {
    var dividerInserted = false;

    renderItems.forEach(function (item, index) {
      var itemTime = getMessageTime(item.msg);

      // Insert divider RIGHT BEFORE the first message that is newer than last visit
      if (!dividerInserted && itemTime > newMessageBoundaryTs) {
        messagesEl.appendChild(createNewMessageDivider());
        dividerInserted = true;
      }

      if (item.type === 'thread') {
        renderThread(item.msg, item.replies, messagesEl, index < renderItems.length - 1);
      } else if (item.type === 'missingParentReply') {
        renderMissingParentReply(item.msg, messagesEl, index < renderItems.length - 1);
      }
    });
  }
  // No new messages divider needed - render normally
  else {
    renderItems.forEach(function (item, index) {
      if (item.type === 'thread') {
        renderThread(item.msg, item.replies, messagesEl, index < renderItems.length - 1);
      } else if (item.type === 'missingParentReply') {
        renderMissingParentReply(item.msg, messagesEl, index < renderItems.length - 1);
      }
    });
  }

  requestAnimationFrame(function () {
    if (!allowAutoScroll) {
      messagesEl.style.visibility = 'visible';
      var mask = document.getElementById('cg-loading-mask');
      if (mask) mask.style.display = 'none';
      return;
    }

    requestAnimationFrame(function () {
      if (!replyingTo && Date.now() > suppressAutoScrollUntil) {
        window.scrollTo(0, document.body.scrollHeight);
      }
      messagesEl.style.visibility = 'visible';
      // Safety net: iOS sometimes hasn't finished layout by the second rAF,
      // so fire a correction scroll once the dust has settled.
      setTimeout(function () {
        if (!replyingTo && Date.now() > suppressAutoScrollUntil) {
          window.scrollTo(0, document.body.scrollHeight);
        }
        // --- HIDE LOADING MASK AFTER SCROLL IS FINISHED ---
        var mask = document.getElementById('cg-loading-mask');
        if (mask) mask.style.display = 'none';
      }, 150);

      // Self-healing scroll: catches late font/flexbox layout settling
      // that fires after our fixed timeouts. Disconnects after 1000ms
      // so it never fights user-initiated scrolling.
      if (typeof ResizeObserver !== 'undefined') {
        var scrollObserver = new ResizeObserver(function () {
          if (!replyingTo && Date.now() > suppressAutoScrollUntil) {
            window.scrollTo(0, document.body.scrollHeight);
          }
        });
        scrollObserver.observe(messagesEl);
        setTimeout(function () {
          scrollObserver.disconnect();
        }, 1000);
      }
    });
  });

  if (isInChat()) {
    markAsRead();
  }
}

function attachRecentMessagesListener() {
  var state = getCurrentRoomState();
  var newestUpdatedAt = state.newestUpdatedAt || 0;

  if (messageListener) {
    messageListener();
    messageListener = null;
  }

  if (!newestUpdatedAt) return;

  messageListener = db
    .collection('groups')
    .doc(currentGroup)
    .collection('messages')
    .where('updatedAt', '>', firebase.firestore.Timestamp.fromMillis(newestUpdatedAt))
    .orderBy('updatedAt', 'asc')
    .onSnapshot(function (snapshot) {
      var changed = false;
      var incomingFromOtherPerson = false;

      snapshot.docChanges().forEach(function (change) {
        var msg = normalizeFirestoreMessage(change.doc);

        if (
          change.type === 'added' &&
          isInChat() &&
          currentGroup &&
          msg.authorUid &&
          msg.authorUid !== currentUID
        ) {
          incomingFromOtherPerson = true;
        }

        mergeMessagesIntoRoomState(state, [msg]);
        changed = true;
      });

      if (changed) {
        saveRoomMessageCache(currentGroup, state);
        renderCurrentRoomMessages(isInChat());

        if (incomingFromOtherPerson) {
          playNotificationSound();
        }
      }
    });
}
// ---- LOAD MESSAGES ----
function loadMessages(scrollOnOpen) {
  if (messageListener) {
    messageListener();
    messageListener = null;
  }

  var messagesEl = document.getElementById('cg-messages');
  var state = getCurrentRoomState();

  if (state.orderedIds.length) {
    renderCurrentRoomMessages(!!scrollOnOpen);
    refreshHasOlderMessages();
    attachRecentMessagesListener();
    return;
  }

  messagesEl.innerHTML = '<div class="cg-loading">Loading messages...</div>';

  db.collection('groups')
    .doc(currentGroup)
    .collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(MESSAGE_PAGE_SIZE)
    .get()
    .then(function (snapshot) {
      var newest = snapshot.docs
        .map(function (doc) {
          return normalizeFirestoreMessage(doc);
        })
        .reverse();

      mergeMessagesIntoRoomState(state, newest);
      saveRoomMessageCache(currentGroup, state);
      renderCurrentRoomMessages(!!scrollOnOpen);
      refreshHasOlderMessages();
      attachRecentMessagesListener();
    })
    .catch(function (err) {
      console.error('LOAD MESSAGES FAILED:', err);
      messagesEl.innerHTML =
        '<div class="cg-no-msgs">Unable to load messages right now.<br>' + err.message + '</div>';
      messagesEl.style.visibility = 'visible';
      var mask = document.getElementById('cg-loading-mask');
      if (mask) mask.style.display = 'none';
    });
}

function buildMessageRow(msg, isPrimary) {
  var isMe = isMyMessage(msg);
  var color = getBubbleColor(msg.author);
  var time = '';
  if (msg.timestamp) {
    var dt = new Date(msg.timestamp.toMillis());
    time =
      dt.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }) +
      ' · ' +
      dt.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
  }

  var row = document.createElement('div');
  row.className = isPrimary ? 'cg-primary-row' : 'cg-reply-row';

  var avatar = document.createElement('div');
  avatar.className = isPrimary ? 'cg-avatar' : 'cg-avatar cg-avatar-sm';
  avatar.textContent = msg.author.charAt(0).toUpperCase();
  avatar.style.background = color;
  row.appendChild(avatar);

  var content = document.createElement('div');
  content.className = isPrimary ? 'cg-primary-content' : 'cg-reply-content';

  var header = document.createElement('div');
  header.className = 'cg-primary-header';

  var headerLeft = document.createElement('div');
  headerLeft.className = 'cg-primary-header-left';

  var nameSpan = document.createElement('span');
  nameSpan.className = 'cg-primary-name';
  nameSpan.textContent = msg.author;
  nameSpan.style.color = color;

  var timeSpan = document.createElement('span');
  timeSpan.className = 'cg-primary-time';
  timeSpan.textContent = time;

  headerLeft.appendChild(nameSpan);
  headerLeft.appendChild(timeSpan);

  header.appendChild(headerLeft);

  if (isMe || currentUser.isAdmin) {
    var menuBtn = document.createElement('button');
    menuBtn.className = 'msg-menu-trigger';
    menuBtn.type = 'button';
    menuBtn.textContent = '⋯';
    menuBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      showMessageMenu(msg._id, isMe);
    });
    header.appendChild(menuBtn);
  }

  content.appendChild(header);

  var wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper';

  if (msg.deleted) {
    var deletedSpan = document.createElement('span');
    deletedSpan.className = 'msg-deleted';
    deletedSpan.textContent = '(message deleted)';
    wrapper.appendChild(deletedSpan);
  } else {
    var textBlock = document.createElement('div');
    textBlock.className = 'msg-text';
    renderMessageContent(msg.text, textBlock);
    wrapper.appendChild(textBlock);

    if (msg.edited) {
      var editedTag = document.createElement('span');
      editedTag.className = 'msg-edited';
      editedTag.textContent = ' (edited)';
      wrapper.appendChild(editedTag);
    }
  }

  content.appendChild(wrapper);
  row.appendChild(content);
  return row;
}

function renderPrimaryMessage(msg, container) {
  container.appendChild(buildMessageRow(msg, true));
}
function renderReplyMessage(msg, container) {
  container.appendChild(buildMessageRow(msg, false));
}

function renderThread(msg, replies, container, showDivider) {
  var thread = document.createElement('div');
  thread.className = 'cg-thread';
  thread.id = 'thread-' + msg._id;
  renderPrimaryMessage(msg, thread);

  var commentBar = document.createElement('div');
  commentBar.className = 'cg-comment-bar';

  if (!msg.deleted) {
    var replyBtn = document.createElement('button');
    replyBtn.className = 'cg-comment-btn';
    replyBtn.textContent =
      replies.length > 0
        ? '💬 Reply · ' + replies.length + (replies.length === 1 ? ' Comment' : ' Comments')
        : '💬 Reply';
    replyBtn.addEventListener(
      'click',
      (function (id, author) {
        return function () {
          setReply(id, author);
        };
      })(msg._id, msg.author)
    );
    commentBar.appendChild(replyBtn);
  }

  thread.appendChild(commentBar);
  if (replyingTo && replyingTo.id === msg._id) {
    var inlineReplyBox = document.createElement('div');
    inlineReplyBox.className = 'cg-inline-reply-box';

    var inlineReplyHeader = document.createElement('div');
    inlineReplyHeader.className = 'cg-inline-reply-header';
    inlineReplyHeader.textContent = 'Replying to ' + replyingTo.author;

    var inlineReplyRow = document.createElement('div');
    inlineReplyRow.className = 'cg-inline-reply-row';

    var inlineInput = document.createElement('textarea');
    inlineInput.className = 'cg-inline-reply-input';
    inlineInput.id = 'inline-reply-input-' + msg._id;
    inlineInput.placeholder = 'Write a reply...';
    inlineInput.rows = 1;

    inlineInput.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    });
    inlineInput.addEventListener('focus', function () {
      var nav = document.querySelector('.bottom-nav');
      if (nav) nav.style.display = 'none';
    });
    inlineInput.addEventListener('blur', function () {
      var nav = document.querySelector('.bottom-nav');
      if (nav) nav.style.display = '';
    });

    var inlineSend = document.createElement('button');
    inlineSend.className = 'cg-inline-reply-send';
    inlineSend.type = 'button';
    inlineSend.textContent = 'Send';
    inlineSend.addEventListener('click', function () {
      sendInlineReply(msg._id);
    });

    var inlineCancel = document.createElement('button');
    inlineCancel.className = 'cg-inline-reply-cancel';
    inlineCancel.type = 'button';
    inlineCancel.textContent = 'Cancel';
    inlineCancel.addEventListener('click', function () {
      clearReply();
    });

    var inlineBtnGroup = document.createElement('div');
    inlineBtnGroup.className = 'cg-inline-reply-btn-group';
    inlineBtnGroup.appendChild(inlineSend);
    inlineBtnGroup.appendChild(inlineCancel);
    inlineReplyRow.appendChild(inlineInput);
    inlineReplyRow.appendChild(inlineBtnGroup);

    inlineReplyBox.appendChild(inlineReplyHeader);
    inlineReplyBox.appendChild(inlineReplyRow);

    thread.appendChild(inlineReplyBox);
  }

  if (replies.length > 0) {
    var repliesContainer = document.createElement('div');
    repliesContainer.className = 'cg-replies-container';
    replies.forEach(function (reply) {
      renderReplyMessage(reply, repliesContainer);
    });
    thread.appendChild(repliesContainer);
  }
  if (showDivider) {
    var divider = document.createElement('div');
    divider.className = 'cg-thread-divider';
    thread.appendChild(divider);
  }
  container.appendChild(thread);
}

function sendMessage() {
  var input = document.getElementById('cg-msg-input');
  var text = input.value.trim();
  if (!text || !db || !currentUID) return;
  input.value = '';
  input.style.height = 'auto';
  playSendSound();

  var nowMs = Date.now();
  var localTs = {
    toMillis: function () {
      return nowMs;
    }
  };
  var nowTs = firebase.firestore.FieldValue.serverTimestamp();

  var msgData = {
    text: text,
    author: currentUser.name,
    authorKey: currentMemberKey,
    authorUid: currentUID,
    timestamp: nowTs,
    updatedAt: nowTs,
    edited: false,
    deleted: false
  };

  var docRef = db.collection('groups').doc(currentGroup).collection('messages').doc();

  // Show the message immediately — a pending serverTimestamp() reads back as
  // null on this device until the write is acknowledged, so the live
  // "new messages" listener can't show it until the round trip completes.
  var state = getCurrentRoomState();
  mergeMessagesIntoRoomState(state, [
    {
      _id: docRef.id,
      text: text,
      author: currentUser.name,
      authorKey: currentMemberKey,
      authorUid: currentUID,
      timestamp: localTs,
      updatedAt: localTs,
      edited: false,
      deleted: false
    }
  ]);
  saveRoomMessageCache(currentGroup, state);
  renderCurrentRoomMessages(true);

  docRef.set(msgData).catch(function (err) {
    console.error('SEND MESSAGE FAILED:', err);
    removeMessageFromRoomState(state, docRef.id);
    saveRoomMessageCache(currentGroup, state);
    renderCurrentRoomMessages(false);
    input.value = text;
    showToast('Message failed to send. Check your connection and try again.');
  });
}

function leaveChat() {
  leaveCurrentRoom();
  clearReply();
  currentUser = null;
  currentGroup = null;
  currentGroupName = null;
  currentMemberKey = null;
  hideInputBar();
  showCGScreen('select');
}

function markAsRead() {
  if (!currentUID || !currentGroup) return;

  // 👇 LOCAL guard (prevents unnecessary writes while actively in chat)
  var localUnread = unreadCountsByGroup[currentGroup] || 0;

  if (localUnread <= 0) {
    setUnreadCount(currentGroup, 0);
    return;
  }

  setUnreadCount(currentGroup, 0);

  const userRef = db.collection('users').doc(currentUID);

  userRef.get().then((doc) => {
    if (!doc.exists) return;

    let data = doc.data() || {};
    let unread = data.unread || {};
    let pending = data.pending || {};

    // 👇 FIRESTORE guard (prevents duplicate writes)
    if ((Number(unread[currentGroup]) || 0) <= 0) {
      return;
    }

    unread[currentGroup] = 0;

    let totalUnread = 0;
    Object.values(unread).forEach((v) => (totalUnread += Number(v) || 0));

    let totalPending = 0;
    Object.values(pending).forEach((v) => (totalPending += Number(v) || 0));

    let badgeTotal = totalUnread + totalPending;

    userRef.set(
      {
        unread: unread,
        totalUnread: totalUnread,
        totalPending: totalPending,
        badgeTotal: badgeTotal
      },
      { merge: true }
    );

    updateAppBadge(badgeTotal);
  });
}
function showChurchAlertButtonIfAdmin() {
  var btn = document.getElementById('church-alert-btn');
  if (!btn) return;

  btn.style.display = currentUser && currentUser.isAdmin ? 'block' : 'none';
}
// ---- MEMBERS PANEL ----
function showMembersPanel() {
  membersPanelIsOpen = true; // ← add this line
  showCGScreen('members');
  showChurchAlertButtonIfAdmin();
  window.scrollTo(0, 0);

  var membersBadge = document.getElementById('members-badge');
  if (membersBadge) {
    membersBadge.style.display = 'none';
    membersBadge.textContent = '';
  }

  if (currentUID && currentUser && currentUser.isAdmin && currentGroup) {
    var ackedNow = Date.now();

    var updateObj = {
      pendingAcknowledgedAt: ackedNow,
      ['pending.' + currentGroup]: 0
    };

    db.collection('users').doc(currentUID).update(updateObj);

    pendingCountsByGroup[currentGroup] = 0;
  }

  var forceRefresh = currentUser && currentUser.isAdmin;
  loadMembersList(forceRefresh);
}
function renderMembersListFromData(members) {
  var listEl = document.getElementById('members-list');
  if (!listEl) return;

  listEl.innerHTML = '';

  var dedupMap = {};
  members.forEach(function (m) {
    var key = m.normalizedName || m._id;
    if (!dedupMap[key] || (m.lastLoginAt || 0) > (dedupMap[key].lastLoginAt || 0)) {
      dedupMap[key] = m;
    }
  });

  var deduped = Object.keys(dedupMap).map(function (k) {
    return dedupMap[k];
  });

  var pending = deduped.filter(function (m) {
    return !m.approved;
  });
  var approved = deduped.filter(function (m) {
    return m.approved;
  });

  pending.sort(function (a, b) {
    return (a.displayName || '').localeCompare(b.displayName || '');
  });

  approved.sort(function (a, b) {
    return (a.displayName || '').localeCompare(b.displayName || '');
  });

  if (currentUser.isAdmin && pending.length > 0) {
    var pendingLabel = document.createElement('div');
    pendingLabel.className = 'section-label';
    pendingLabel.textContent = 'PENDING APPROVAL';
    listEl.appendChild(pendingLabel);

    var pendingList = document.createElement('div');
    pendingList.className = 'cg-member-list';

    pending.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'cg-member-row';

      var nameSpan = document.createElement('span');
      nameSpan.className = 'cg-member-name';
      nameSpan.textContent = m.displayName || m._id;
      div.appendChild(nameSpan);

      var approveBtn = document.createElement('button');
      approveBtn.className = 'cg-approve-btn';
      approveBtn.textContent = 'Approve';
      approveBtn.addEventListener(
        'click',
        (function (id) {
          return function () {
            approveMember(id);
          };
        })(m._id)
      );
      div.appendChild(approveBtn);

      var denyBtn = document.createElement('button');
      denyBtn.className = 'cg-deny-btn';
      denyBtn.textContent = 'Deny';
      denyBtn.addEventListener(
        'click',
        (function (id) {
          return function () {
            denyMember(id);
          };
        })(m._id)
      );
      div.appendChild(denyBtn);

      pendingList.appendChild(div);
    });

    listEl.appendChild(pendingList);
  }

  // "MEMBERS" label is now in the sticky header — no need to re-render it here

  var approvedList = document.createElement('div');
  approvedList.className = 'cg-member-list';

  if (approved.length === 0) {
    approvedList.innerHTML = '<div class="cg-empty-note">No approved members yet</div>';
  } else {
    approved.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'cg-member-row';

      var nameSpan = document.createElement('span');
      nameSpan.className = 'cg-member-name';
      nameSpan.textContent = m.displayName || m._id;

      if (m.isAdmin) {
        nameSpan.textContent += ' ⭐';
      }

      if (m.removalRequested && currentUser && currentUser.isAdmin === true) {
        var tag = document.createElement('span');
        tag.className = 'cg-removal-tag';
        tag.textContent = 'Requested Removal';
        div.appendChild(tag);
      }
      div.appendChild(nameSpan);

      var isSelf = currentUser.normalizedName && m.normalizedName === currentUser.normalizedName;

      var canRemoveThisMember = currentUser.isAdmin || isSelf;

      if (canRemoveThisMember) {
        if (m.removalRequested && currentUser && currentUser.isAdmin === true && !isSelf) {
          var stayBtn = document.createElement('button');
          stayBtn.className = 'cg-stay-btn';
          stayBtn.textContent = 'Staying';
          stayBtn.style.cssText =
            'background:#2e7d32;color:#fff;border:none;padding:6px 12px;border-radius:6px;font-size:13px;font-family:Lato,sans-serif;cursor:pointer;margin-right:8px;';
          stayBtn.addEventListener(
            'click',
            (function (id) {
              return function () {
                clearRemovalFlag(id);
              };
            })(m._id)
          );
          div.appendChild(stayBtn);
        }
        var removeBtn = document.createElement('button');
        removeBtn.className = 'cg-deny-btn';
        removeBtn.textContent = isSelf ? 'Leave Group?' : 'Remove';
        removeBtn.addEventListener(
          'click',
          (function (id, isSelfFlag) {
            return function () {
              removeMember(id, isSelfFlag);
            };
          })(m._id, isSelf)
        );
        div.appendChild(removeBtn);
      }

      approvedList.appendChild(div);
    });
  }

  listEl.appendChild(approvedList);
}
function loadMembersList(forceRefresh) {
  var listEl = document.getElementById('members-list');
  if (!listEl) return;

  var cache = getMembersCache(currentGroup);

  if (!forceRefresh && cache && isMembersCacheFresh(cache)) {
    renderMembersListFromData(cache.members);
    return;
  }

  if (!cache) {
    listEl.innerHTML = '<div class="cg-loading">Loading...</div>';
  } else {
    renderMembersListFromData(cache.members);
  }

  var targetGroup = currentGroup;
  var done = false;

  // The old code used watchdogTimedOut=true before calling the retry, which caused
  // the retry's .then() to bail immediately — screen stayed on "Loading..." forever.
  // done is only set true when we have an actual result (success or terminal failure).

  function showFallback() {
    if (done) return;
    done = true;
    if (currentGroup !== targetGroup || !listEl) return;
    if (!cache) {
      listEl.innerHTML =
        '<div class="cg-empty-note">Couldn\'t load members right now. Tap back and try again shortly.</div>';
    }
    // Stale cache already on screen — leave it; something is better than nothing.
  }

  // Overall give-up: 12s covers first attempt + reboot delay + retry
  var giveUpTimer = setTimeout(showFallback, 12000);

  // Stall detector: if no response in 3.5s, reboot Firestore network and retry once
  var stallTimer = setTimeout(function () {
    if (done) return;
    console.warn('Members fetch stalled — rebooting Firestore network...');
    db.disableNetwork()
      .then(function () {
        return db.enableNetwork();
      })
      .then(function () {
        if (done || currentGroup !== targetGroup || !membersPanelIsOpen) return;
        executeMembersFetch();
      })
      .catch(function () {});
  }, 3500);

  function executeMembersFetch() {
    db.collection('groups')
      .doc(targetGroup)
      .collection('members')
      .get()
      .then(function (snap) {
        if (done) return;
        done = true;
        clearTimeout(stallTimer);
        clearTimeout(giveUpTimer);

        var members = [];
        snap.forEach(function (d) {
          var m = d.data();
          m._id = d.id;
          members.push(m);
        });

        if (members.length > 0) {
          saveMembersCache(targetGroup, members);
          renderMembersListFromData(members);
        } else if (!cache && listEl) {
          listEl.innerHTML =
            '<div class="cg-empty-note">Members couldn\'t be loaded. Check back shortly.</div>';
        }
        // Empty result with stale cache already on screen — leave it.
      })
      .catch(function (err) {
        if (done) return;
        done = true;
        clearTimeout(stallTimer);
        clearTimeout(giveUpTimer);
        if (!cache && listEl) {
          listEl.innerHTML =
            '<div class="cg-empty-note">Members couldn\'t be loaded. Check back shortly.</div>';
        }
        console.error('Members load error:', err);
      });
  }

  executeMembersFetch();
}

// Approve: update member doc + sync identity doc
function approveMember(memberUid) {
  var memberRef = db.collection('groups').doc(currentGroup).collection('members').doc(memberUid);
  memberRef
    .update({
      approved: true,
      removalRequested: false,
      removalRequestedAt: firebase.firestore.FieldValue.delete()
    })
    .then(function () {
      return memberRef.get();
    })
    .then(function (snap) {
      if (snap.exists && snap.data().normalizedName) {
        db.collection('groups')
          .doc(currentGroup)
          .collection('identities')
          .doc(snap.data().normalizedName)
          .update({ approved: true });
      }
      clearMembersCache(currentGroup);
      loadMembersList(true);
    });
}

// Helper: delete ALL member docs for a given normalizedName, then set identity approved:false
function deleteAllSessionsForPerson(normalized) {
  return db
    .collection('groups')
    .doc(currentGroup)
    .collection('members')
    .where('normalizedName', '==', normalized)
    .get()
    .then(function (snap) {
      var deletes = [];
      snap.forEach(function (d) {
        deletes.push(d.ref.delete());
      });
      return Promise.all(deletes);
    })
    .then(function () {
      return db
        .collection('groups')
        .doc(currentGroup)
        .collection('identities')
        .doc(normalized)
        .update({ approved: false });
    });
}

// Deny: delete ALL UID sessions for this person + mark identity not approved
function denyMember(memberUid) {
  var memberRef = db.collection('groups').doc(currentGroup).collection('members').doc(memberUid);

  memberRef
    .get()
    .then(function (snap) {
      var normalized = snap.exists ? snap.data().normalizedName : null;

      if (!normalized) {
        return memberRef.delete();
      }

      return deleteAllSessionsForPerson(normalized);
    })
    .then(function () {
      clearMembersCache(currentGroup);
      loadMembersList(true);
    })
    .catch(function (err) {
      console.error('Deny member failed:', err);
      alert('Unable to deny this member right now.');
    });
}

// Remove: delete ALL UID sessions for this person + mark identity not approved
function removeMember(memberUid, isSelf) {
  var confirmMsg = isSelf ? 'Leave this group?' : 'Remove this member from the group?';
  if (!confirm(confirmMsg)) return;

  var leavingGroup = currentGroup;
  var memberRef = db.collection('groups').doc(leavingGroup).collection('members').doc(memberUid);

  // For self-leave: exit UI immediately, then let cleanup continue in background
  if (isSelf) {
    memberRef
      .update({
        removalRequested: true,
        removalRequestedAt: Date.now()
      })
      .then(function () {
        clearMembersCache(leavingGroup);
        clearSavedUser(leavingGroup);
        clearUnreadCount(leavingGroup);
        setPendingCount(leavingGroup, 0);

        currentUser = null;
        currentGroup = null;
        currentGroupName = null;
        currentMemberKey = null;

        showCGScreen('select');
      })
      .catch(function (err) {
        console.error('Failed to flag removal request:', err);
        alert('Something went wrong leaving the chat. Try again.');
      });

    return;
  }

  memberRef
    .get()
    .then(function (snap) {
      var normalized = snap.exists ? snap.data().normalizedName : null;
      if (normalized) {
        return deleteAllSessionsForPerson(normalized);
      } else {
        return memberRef.delete();
      }
    })
    .then(function () {
      clearMembersCache(leavingGroup);

      if (!isSelf) {
        loadMembersList(true);
      }
    })
    .catch(function (err) {
      console.error('Remove member failed:', err);

      if (!isSelf) {
        alert('Unable to remove this member right now.');
      }
    });
}

function clearRemovalFlag(memberUid) {
  var memberRef = db.collection('groups').doc(currentGroup).collection('members').doc(memberUid);
  memberRef
    .update({
      removalRequested: false,
      removalRequestedAt: firebase.firestore.FieldValue.delete()
    })
    .then(function () {
      clearMembersCache(currentGroup);
      loadMembersList(true);
    })
    .catch(function (err) {
      console.error('Failed to clear removal flag:', err);
      alert('Unable to update this member right now.');
    });
}

// ---- CHANGE PASSWORD ----
function showChangePassword() {
  showCGScreen('changepassword');
  // Clear fields
  var fields = ['cg-cp-current', 'cg-cp-new', 'cg-cp-confirm'];
  fields.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var errEl = document.getElementById('cg-cp-error');
  var okEl = document.getElementById('cg-cp-success');
  if (errEl) errEl.textContent = '';
  if (okEl) okEl.textContent = '';
}

function submitChangePassword() {
  var currentPw = document.getElementById('cg-cp-current').value.trim();
  var newPw = document.getElementById('cg-cp-new').value.trim();
  var confirmPw = document.getElementById('cg-cp-confirm').value.trim();
  var errEl = document.getElementById('cg-cp-error');
  var okEl = document.getElementById('cg-cp-success');
  errEl.textContent = '';
  okEl.textContent = '';

  if (!currentPw || !newPw || !confirmPw) {
    errEl.textContent = 'Please fill in all fields.';
    return;
  }
  if (newPw.length < 4) {
    errEl.textContent = 'New password must be at least 4 characters.';
    return;
  }
  if (newPw !== confirmPw) {
    errEl.textContent = "Passwords don't match.";
    return;
  }
  if (newPw === currentPw) {
    errEl.textContent = 'New password must be different from current password.';
    return;
  }
  if (!currentMemberKey) {
    errEl.textContent = 'Session error. Please log in again.';
    return;
  }

  var identityRef = db
    .collection('groups')
    .doc(currentGroup)
    .collection('identities')
    .doc(currentMemberKey);

  identityRef
    .get()
    .then(function (snap) {
      if (!snap.exists) {
        errEl.textContent = 'Identity not found. Please log in again.';
        return;
      }
      var identity = snap.data();

      hashInput(currentPw, identity.passwordSalt).then(function (enteredHash) {
        if (enteredHash !== identity.passwordHash) {
          errEl.textContent = 'Current password is incorrect.';
          return;
        }

        // Current password verified — generate new salt and hash
        var newSalt = generateSalt();
        hashInput(newPw, newSalt).then(function (newHash) {
          identityRef
            .update({
              passwordSalt: newSalt,
              passwordHash: newHash
            })
            .then(function () {
              okEl.textContent = 'Password changed successfully!';
              // Clear fields
              ['cg-cp-current', 'cg-cp-new', 'cg-cp-confirm'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
              });
            })
            .catch(function (err) {
              errEl.textContent = 'Error saving password: ' + err.message;
            });
        });
      });
    })
    .catch(function (err) {
      errEl.textContent = 'Error reading identity: ' + err.message;
    });
}

// ---- LOCAL STORAGE ----

function getSavedUsers() {
  var raw = localStorage.getItem('mhbc_cg_users');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveUser(user) {
  var users = getSavedUsers();
  users[user.group] = user;
  localStorage.setItem('mhbc_cg_users', JSON.stringify(users));
}

function getSavedUser(groupId) {
  var users = getSavedUsers();
  if (!groupId) return null;
  return users[groupId] || null;
}

function clearSavedUser(groupId) {
  if (!groupId) {
    localStorage.removeItem('mhbc_cg_users');
    localStorage.removeItem('mhbc_cg_last_group');
    return;
  }
  var users = getSavedUsers();
  delete users[groupId];
  localStorage.setItem('mhbc_cg_users', JSON.stringify(users));

  if (localStorage.getItem('mhbc_cg_last_group') === groupId) {
    localStorage.removeItem('mhbc_cg_last_group');
  }
}

function setLastGroup(groupId) {
  if (groupId) localStorage.setItem('mhbc_cg_last_group', groupId);
}

function getLastGroup() {
  return localStorage.getItem('mhbc_cg_last_group');
}
function getMembersCacheKey(groupId) {
  return ROOM_MEMBERS_CACHE_PREFIX + groupId;
}

function saveMembersCache(groupId, members) {
  try {
    localStorage.setItem(
      getMembersCacheKey(groupId),
      JSON.stringify({
        savedAt: Date.now(),
        members: members
      })
    );
  } catch (e) {
    console.warn('Members cache save skipped:', e);
  }
}

function getMembersCache(groupId) {
  var raw = localStorage.getItem(getMembersCacheKey(groupId));
  if (!raw) return null;

  try {
    var parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.members)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function clearMembersCache(groupId) {
  if (groupId) {
    localStorage.removeItem(getMembersCacheKey(groupId));
  }
}

function isMembersCacheFresh(cacheObj) {
  if (!cacheObj || !cacheObj.savedAt) return false;
  return Date.now() - cacheObj.savedAt < ROOM_MEMBERS_CACHE_TTL_MS;
}
function getRoomCacheKey(groupId) {
  return ROOM_MESSAGE_CACHE_PREFIX + groupId;
}

function createEmptyRoomMessageState() {
  return {
    messagesById: {},
    orderedIds: [],
    newestTimestamp: 0,
    oldestTimestamp: 0,
    newestUpdatedAt: 0,
    hasOlderMessages: false,
    newMessageBoundaryTs: 0
  };
}

function cacheMessageForStorage(msg) {
  return {
    _id: msg._id,
    text: msg.text || '',
    author: msg.author || '',
    authorKey: msg.authorKey || null,
    authorUid: msg.authorUid || null,
    replyTo: msg.replyTo || null,
    replyToAuthor: msg.replyToAuthor || null,
    edited: msg.edited === true,
    deleted: msg.deleted === true,
    timestampMs: getMessageTime(msg),
    updatedAtMs: getUpdatedTime(msg)
  };
}

function restoreCachedMessage(raw) {
  return {
    _id: raw._id,
    text: raw.text || '',
    author: raw.author || '',
    authorKey: raw.authorKey || null,
    authorUid: raw.authorUid || null,
    replyTo: raw.replyTo || null,
    replyToAuthor: raw.replyToAuthor || null,
    edited: raw.edited === true,
    deleted: raw.deleted === true,
    timestamp: raw.timestampMs
      ? {
          toMillis: function () {
            return raw.timestampMs;
          }
        }
      : null,
    updatedAt:
      raw.updatedAtMs || raw.timestampMs
        ? {
            toMillis: function () {
              return raw.updatedAtMs || raw.timestampMs;
            }
          }
        : null
  };
}

function recomputeRoomStateBounds(state) {
  var boundary = state.newMessageBoundaryTs || 0;

  if (!state.orderedIds.length) {
    state.newestTimestamp = 0;
    state.oldestTimestamp = 0;
    state.newestUpdatedAt = 0;
    state.newMessageBoundaryTs = boundary;
    return;
  }

  var firstId = state.orderedIds[0];
  var lastId = state.orderedIds[state.orderedIds.length - 1];

  state.oldestTimestamp = getMessageTime(state.messagesById[firstId]);
  state.newestTimestamp = getMessageTime(state.messagesById[lastId]);

  var maxUpdatedAt = 0;
  state.orderedIds.forEach(function (id) {
    var updated = getUpdatedTime(state.messagesById[id]);
    if (updated > maxUpdatedAt) maxUpdatedAt = updated;
  });

  state.newestUpdatedAt = maxUpdatedAt;
  state.newMessageBoundaryTs = boundary;
}

function getRoomMessageCache(groupId) {
  var raw = localStorage.getItem(getRoomCacheKey(groupId));
  if (!raw) return createEmptyRoomMessageState();

  try {
    var parsed = JSON.parse(raw);
    var state = createEmptyRoomMessageState();

    (parsed.messages || []).forEach(function (rawMsg) {
      var msg = restoreCachedMessage(rawMsg);
      state.messagesById[msg._id] = msg;
      state.orderedIds.push(msg._id);
    });

    state.orderedIds.sort(function (a, b) {
      return getMessageTime(state.messagesById[a]) - getMessageTime(state.messagesById[b]);
    });

    recomputeRoomStateBounds(state);
    return state;
  } catch (e) {
    return createEmptyRoomMessageState();
  }
}

function saveRoomMessageCache(groupId, state) {
  try {
    var idsToPersist = state.orderedIds.slice(-ROOM_MESSAGE_CACHE_MAX);
    var messages = idsToPersist.map(function (id) {
      return cacheMessageForStorage(state.messagesById[id]);
    });

    localStorage.setItem(
      getRoomCacheKey(groupId),
      JSON.stringify({
        messages: messages
      })
    );
  } catch (e) {
    console.warn('Room cache save skipped:', e);
  }
}

function clearRoomMessageCache(groupId) {
  if (groupId) {
    localStorage.removeItem(getRoomCacheKey(groupId));
  }
}

function getCurrentRoomState() {
  if (!currentGroup) return createEmptyRoomMessageState();

  if (!roomMessageStateByGroup[currentGroup]) {
    roomMessageStateByGroup[currentGroup] = getRoomMessageCache(currentGroup);
  }

  return roomMessageStateByGroup[currentGroup];
}

function mergeMessagesIntoRoomState(state, messages) {
  messages.forEach(function (msg) {
    state.messagesById[msg._id] = msg;
    if (state.orderedIds.indexOf(msg._id) === -1) {
      state.orderedIds.push(msg._id);
    }
  });

  state.orderedIds.sort(function (a, b) {
    return getMessageTime(state.messagesById[a]) - getMessageTime(state.messagesById[b]);
  });

  recomputeRoomStateBounds(state);
}

function removeMessageFromRoomState(state, messageId) {
  if (!state.messagesById[messageId]) return;

  delete state.messagesById[messageId];
  state.orderedIds = state.orderedIds.filter(function (id) {
    return id !== messageId;
  });

  recomputeRoomStateBounds(state);
}

function normalizeFirestoreMessage(doc) {
  var msg = doc.data();
  msg._id = doc.id;
  return msg;
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

function openChurchAlerts() {
  showPage('church-alerts');
  if (currentUID) {
    db.collection('users').doc(currentUID).update({ hasUnreadAlert: false });
  }

  const container = document.getElementById('church-alert-content');
  if (container) {
    container.innerHTML =
      '<p style="text-align:center; padding:60px 20px; color:#c9a84c;">Loading latest alert...</p>';
  }

  var done = false;

  // Stall detector: if no response in 3.5s, reboot Firestore network and retry once.
  // Same fix as loadMembersList — a hung connection sometimes needs a kick
  // before it'll resolve; disable/enable network mimics a force-close + reopen.
  var stallTimer = setTimeout(function () {
    if (done) return;
    console.warn('Church alert fetch stalled — rebooting Firestore network...');
    db.disableNetwork()
      .then(function () {
        return db.enableNetwork();
      })
      .then(function () {
        if (done) return;
        executeAlertFetch();
      })
      .catch(function () {});
  }, 3500);

  // Overall give-up: 12s covers first attempt + reboot delay + retry
  var giveUpTimer = setTimeout(function () {
    if (done) return;
    done = true;
    const container = document.getElementById('church-alert-content');
    if (container) {
      container.innerHTML =
        '<p style="text-align:center; padding:40px; color:#7a8fa8;">Unable to connect. Check your connection and try again.</p>';
    }
  }, 12000);

  function executeAlertFetch() {
    db.collection('churchAlerts')
      .orderBy('sentAt', 'desc')
      .limit(1)
      .get()
      .then((snapshot) => {
        if (done) return;
        done = true;
        clearTimeout(stallTimer);
        clearTimeout(giveUpTimer);

        const container = document.getElementById('church-alert-content');
        if (!container) return;

        if (snapshot.empty) {
          if (snapshot.metadata.fromCache) {
            container.innerHTML =
              '<p style="text-align:center; padding:40px; color:#7a8fa8;">Unable to connect. Check your connection and try again.</p>';
          } else {
            container.innerHTML =
              '<p style="text-align:center; padding:40px; color:#7a8fa8;">No church alerts yet.</p>';
          }
          return;
        }

        const data = snapshot.docs[0].data() || {};
        const time = data.sentAt
          ? new Date(data.sentAt.toMillis()).toLocaleString()
          : 'Unknown time';

        container.innerHTML = `
          <div class="alert-item">
            <div class="alert-title">${escapeHtml(data.title) || 'Church Alert'}</div>
            <div class="alert-body">${linkifyEscaped(escapeHtml(data.body))}</div>
            <div class="alert-time">${time}</div>
          </div>
        `;
      })
      .catch((err) => {
        if (done) return;
        done = true;
        clearTimeout(stallTimer);
        clearTimeout(giveUpTimer);
        console.error('Error loading alert:', err); // keep this one for troubleshooting
        const container = document.getElementById('church-alert-content');
        if (container) {
          container.innerHTML =
            '<p style="color:#ff6b6b; text-align:center;">Error loading alert.</p>';
        }
      });
  }

  executeAlertFetch();
}
// ---- INIT ----
window.onload = function () {
  initFirebase();
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(function (err) {
      console.error('Service worker registration failed:', err);
    });
  }
  checkChurchPrompt();
  // Enable Notifications button (iOS requires user interaction)
  var enableChurchRow = document.getElementById('enableChurchNotificationsRow');
  if (enableChurchRow) {
    enableChurchRow.addEventListener('click', function (e) {
      e.preventDefault();
      requestPermission('church');
    });
  }

  var manageNotificationsRow = document.getElementById('manageNotificationsRow');
  if (manageNotificationsRow) {
    manageNotificationsRow.addEventListener('click', function () {
      showPage('manage-notifications');
    });
  }

  var manageNotificationsBack = document.getElementById('manage-notifications-back');
  if (manageNotificationsBack) {
    manageNotificationsBack.addEventListener('click', function () {
      showPage('more');
    });
  }

  var mainInput = document.getElementById('cg-msg-input');
  if (mainInput) {
    var mainInputFocused = false;
    var keyboardTrackingRAF = null;

    function jumpToBottomForMainInput() {
      if (replyingTo) {
        clearReply();
      }
      setTimeout(function () {
        window.scrollTo(0, document.body.scrollHeight);
      }, 100);
    }

    function updateSendBtnLabel() {
      var btn = document.getElementById('cg-send-btn');
      if (btn) btn.textContent = mainInput.value.trim() ? 'Send' : 'Return';
    }

    // iOS keyboard fix: keep the input bar pinned above the keyboard even
    // while the message list is being scrolled. Only acts while the main
    // input is actually focused, so it never touches other pages/devices
    // where no keyboard is up (e.g. Safari's toolbar collapsing on scroll).
    function adjustInputBarForKeyboard() {
      if (!mainInputFocused) return;
      var inputBar = document.querySelector('.cg-input-bar');
      if (!inputBar || !window.visualViewport) return;
      var vv = window.visualViewport;
      // Account for both the keyboard shrinking the visible area (vv.height)
      // AND the visible area sliding down within the page (vv.offsetTop) —
      // iOS does the latter during scroll while the keyboard is open.
      var offset = window.innerHeight - vv.height - vv.offsetTop;
      inputBar.style.bottom = (offset > 0 ? offset : 0) + 'px';
    }

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', adjustInputBarForKeyboard);
      window.visualViewport.addEventListener('scroll', adjustInputBarForKeyboard);
    }

    // visualViewport's resize/scroll events can be throttled by iOS during a
    // fast scroll gesture, causing the bar to visibly lag before catching up.
    // Polling once per animation frame while focused guarantees it stays in
    // sync regardless of event timing, and costs nothing once you blur.
    function keyboardTrackingLoop() {
      adjustInputBarForKeyboard();
      if (mainInputFocused) {
        keyboardTrackingRAF = requestAnimationFrame(keyboardTrackingLoop);
      }
    }

    // Input handling for chat
    mainInput.addEventListener('focus', function () {
      mainInputFocused = true;
      jumpToBottomForMainInput();
      updateSendBtnLabel();

      var nav = document.querySelector('.bottom-nav');
      var inputBar = document.querySelector('.cg-input-bar');
      var msgs = document.querySelector('.cg-messages');

      if (nav) nav.style.display = 'none';
      if (inputBar) inputBar.style.bottom = '0';
      if (msgs) msgs.style.paddingBottom = '0';

      setTimeout(function () {
        window.scrollTo(0, document.body.scrollHeight);
        adjustInputBarForKeyboard();
      }, 120);

      if (keyboardTrackingRAF) cancelAnimationFrame(keyboardTrackingRAF);
      keyboardTrackingRAF = requestAnimationFrame(keyboardTrackingLoop);
    });

    mainInput.addEventListener('blur', function () {
      mainInputFocused = false;
      if (keyboardTrackingRAF) {
        cancelAnimationFrame(keyboardTrackingRAF);
        keyboardTrackingRAF = null;
      }
      var nav = document.querySelector('.bottom-nav');
      var inputBar = document.querySelector('.cg-input-bar');
      var msgs = document.querySelector('.cg-messages');

      if (nav) nav.style.display = '';
      if (inputBar) inputBar.style.bottom = '';
      if (msgs) msgs.style.paddingBottom = '';

      // Reset button label
      var btn = document.getElementById('cg-send-btn');
      if (btn) btn.textContent = 'Send';

      // Sparse rooms (content fits screen): scroll to 0 so fixed nav lands correctly.
      // Full rooms: scroll to bottom as before.
      setTimeout(function () {
        var scrollTarget =
          document.body.scrollHeight > window.innerHeight + 10 ? document.body.scrollHeight : 0;
        window.scrollTo({ top: scrollTarget, behavior: 'smooth' });
      }, 200);
    });

    mainInput.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 200) + 'px';
      updateSendBtnLabel();
    });
  }

  var ls = localStorage.getItem('mhbc_lastseen');
  if (ls) {
    try {
      lastSeenTimestamps = JSON.parse(ls);
    } catch (e) {}
  }

  populateChapters('JHN', 1);
  var bookSel = document.getElementById('bibleBook');
  if (bookSel)
    bookSel.addEventListener('change', function () {
      populateChapters(this.value, 1);
    });

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
      unlockAudio();
      var page = this.getAttribute('data-page');
      if (page) showPage(page);
    });
  });

  document.querySelectorAll('.quick-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      unlockAudio();

      var action = this.getAttribute('data-action');
      var url = this.getAttribute('data-url');

      // Handle Church Alerts
      if (action === 'church-alerts') {
        openChurchAlerts();
        return;
      }

      if (action) showPage(action);
      else if (url) window.open(url, '_blank');
    });
  });

  document.querySelectorAll('.cg-group-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      unlockAudio();
      var groupId = this.getAttribute('data-group');
      var groupName = this.getAttribute('data-name');
      if (groupId && groupName) selectGroup(groupId, groupName);
    });
    btn.style.opacity = '0.4';
    btn.style.pointerEvents = 'none';
  });

  var loginBtn = document.getElementById('cg-login-submit');
  if (loginBtn)
    loginBtn.addEventListener('click', function () {
      unlockAudio();
      submitLogin();
    });

  var checkBtn = document.getElementById('cg-check-btn');
  if (checkBtn) checkBtn.addEventListener('click', checkApproval);

  var startOverBtn = document.getElementById('cg-start-over-btn');
  if (startOverBtn) startOverBtn.addEventListener('click', startOver);

  var backToSelect = document.getElementById('cg-back-to-select');
  if (backToSelect)
    backToSelect.addEventListener('click', function () {
      navToken++;
      leaveCurrentRoom();
      currentGroup = null;
      currentGroupName = null;
      showCGScreen('select');
    });

  var backToSelectFromPending = document.getElementById('cg-back-to-select-pending');
  if (backToSelectFromPending)
    backToSelectFromPending.addEventListener('click', function () {
      navToken++;
      showCGScreen('select');
    });

  var backToChatFromMembers = document.getElementById('cg-back-to-chat-members');
  if (backToChatFromMembers) {
    backToChatFromMembers.addEventListener('click', function () {
      membersPanelIsOpen = false;
      setPendingCount(currentGroup, pendingCountsByGroup[currentGroup] || 0);
      showCGScreen('chat');

      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          window.scrollTo(0, document.body.scrollHeight);
        });
      });
    });
  }

  var leaveChatBtn = document.getElementById('cg-leave-chat');
  if (leaveChatBtn) leaveChatBtn.addEventListener('click', leaveChat);

  var membersBtn = document.getElementById('cg-members-btn');
  if (membersBtn) membersBtn.addEventListener('click', showMembersPanel);

  var changePwBtn = document.getElementById('cg-change-pw-btn');
  if (changePwBtn) changePwBtn.addEventListener('click', showChangePassword);

  var backToChatFromCP = document.getElementById('cg-back-to-members-from-cp');
  if (backToChatFromCP)
    backToChatFromCP.addEventListener('click', function () {
      showCGScreen('members');
    });

  var cpSubmitBtn = document.getElementById('cg-cp-submit');
  if (cpSubmitBtn) cpSubmitBtn.addEventListener('click', submitChangePassword);

  var cpCancelBtn = document.getElementById('cg-cp-cancel');
  if (cpCancelBtn)
    cpCancelBtn.addEventListener('click', function () {
      showCGScreen('members');
    });

  var cpEyeCurrent = document.getElementById('cg-cp-eye-current');
  if (cpEyeCurrent)
    cpEyeCurrent.addEventListener('click', function () {
      toggleVisible('cg-cp-current', this);
    });

  var cpEyeNew = document.getElementById('cg-cp-eye-new');
  if (cpEyeNew)
    cpEyeNew.addEventListener('click', function () {
      toggleVisible('cg-cp-new', this);
    });

  var cpEyeConfirm = document.getElementById('cg-cp-eye-confirm');
  if (cpEyeConfirm)
    cpEyeConfirm.addEventListener('click', function () {
      toggleVisible('cg-cp-confirm', this);
    });

  var sendBtn = document.getElementById('cg-send-btn');
  if (sendBtn) {
    function handleSend() {
      unlockAudio();
      var input = document.getElementById('cg-msg-input');
      if (!input) return;

      if (!input.value.trim()) {
        // Empty → Return mode: just dismiss keyboard
        input.blur();
        return;
      }

      // Has text → Send AND close keyboard (same as Return behavior)
      sendMessage();
      input.blur(); // ← This closes the keyboard
    }

    // touchend fires before blur on iOS, preventing the two-tap problem.
    sendBtn.addEventListener('touchend', function (e) {
      e.preventDefault();
      handleSend();
    });
    sendBtn.addEventListener('click', handleSend); // desktop fallback
  }

  var replyCancel = document.getElementById('cg-reply-cancel');
  if (replyCancel) replyCancel.addEventListener('click', clearReply);

  var eyeRoom = document.getElementById('cg-eye-room');
  if (eyeRoom)
    eyeRoom.addEventListener('click', function () {
      toggleVisible('cg-room-password', this);
    });

  var eyePin = document.getElementById('cg-eye-pin');
  if (eyePin)
    eyePin.addEventListener('click', function () {
      toggleVisible('cg-user-pin', this);
    });

  var msgInput = document.getElementById('cg-msg-input');
  if (msgInput) {
    msgInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        // Enter just makes a new line (no auto-send)
        // The textarea will naturally grow thanks to the existing 'input' listener
      }
    });
  }

  var locationCard = document.getElementById('location-card');
  if (locationCard)
    locationCard.addEventListener('click', function () {
      window.open(
        'https://www.google.com/maps/search/?api=1&query=301+Teel+Road+Beckley+WV+25801',
        '_blank'
      );
    });

  var ytLaunch = document.getElementById('yt-launch');
  if (ytLaunch)
    ytLaunch.addEventListener('click', function () {
      window.open('https://www.youtube.com/@maxwellhillbaptistchurch9695/streams', '_blank');
    });

  var liveBadge = document.getElementById('liveBadge');
  if (liveBadge)
    liveBadge.addEventListener('click', function () {
      showPage('watch');
    });

  checkLiveBadge();
  setInterval(checkLiveBadge, 60000);
  tryGenerateQR();

  var loginBtn = document.getElementById('cg-login-submit');
  if (loginBtn) {
    loginBtn.disabled = true;
    loginBtn.style.opacity = '0.6';
    setTimeout(function () {
      if (loginBtn.disabled) {
        loginBtn.disabled = false;
        loginBtn.style.opacity = '';
      }
    }, 4000);
  }

  auth.onAuthStateChanged(function (user) {
    if (user) {
      authReady = true;
      updateSelectConnectionStatus();
      if (navigator.onLine) {
        document.querySelectorAll('.cg-group-btn').forEach(function (btn) {
          btn.style.opacity = '';
          btn.style.pointerEvents = '';
        });
      }

      var loginBtn = document.getElementById('cg-login-submit');
      if (loginBtn) {
        loginBtn.disabled = false;
        loginBtn.style.opacity = '';
      }
      currentUID = user.uid;

      db.collection('users').doc(currentUID).set(
        {
          uid: currentUID
        },
        { merge: true }
      );

      listenForBadgeUpdates();

      if (Notification.permission === 'granted') {
        initMessaging();
      }

      var lastGroup = getLastGroup();
      var savedUser = lastGroup ? getSavedUser(lastGroup) : null;

      if (savedUser && savedUser.group && savedUser.name && savedUser.normalizedName) {
        currentGroup = savedUser.group;
        currentGroupName = savedUser.groupName;
        currentUser = savedUser;
        currentMemberKey = savedUser.normalizedName;
      }

      // Silently migrate all saved groups to new UID if needed
      var allSaved = getSavedUsers();
      if (allSaved && Object.keys(allSaved).length > 0) {
        var groupsToMigrate = [];
        Object.keys(allSaved).forEach(function (groupId) {
          var s = allSaved[groupId];
          if (s && s.normalizedName) {
            groupsToMigrate.push({
              groupId: groupId,
              normalizedName: s.normalizedName
            });
          }
        });
        if (groupsToMigrate.length > 0) {
          var migrateAll = firebase.functions().httpsCallable('migrateAllGroupsV2');
          migrateAll({ groups: groupsToMigrate })
            .then(function (result) {
              console.log('Multi-group migration result:', result.data);
            })
            .catch(function (err) {
              console.log('Multi-group migration skipped or failed:', err.message);
            });
        }
      }
    } else {
      authReady = false;
      auth.signInAnonymously().catch(function (err) {
        console.error('Sign in failed:', err.code, err.message);
      });
    }
  });

  var alertBtn = document.getElementById('church-alert-btn');
  if (alertBtn) {
    alertBtn.addEventListener('click', function () {
      document.getElementById('church-alert-modal').style.display = 'flex';
    });
  }

  var alertCancel = document.getElementById('church-alert-cancel');
  if (alertCancel) {
    alertCancel.addEventListener('click', function () {
      document.getElementById('church-alert-modal').style.display = 'none';
    });
  }

  var alertSend = document.getElementById('church-alert-send');
  if (alertSend) {
    alertSend.addEventListener('click', function () {
      var title = document.getElementById('church-alert-title').value.trim();
      var body = document.getElementById('church-alert-body').value.trim();

      if (!title || !body) {
        alert('Please enter both a title and message.');
        return;
      }

      db.collection('churchAlerts')
        .add({
          title: title,
          body: body,
          createdBy: currentUID,
          createdByName: currentUser ? currentUser.name : '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        })
        .then(function () {
          document.getElementById('church-alert-title').value = '';
          document.getElementById('church-alert-body').value = '';
          document.getElementById('church-alert-modal').style.display = 'none';
          alert('Church alert sent.');
        })
        .catch(function (err) {
          alert('Alert failed: ' + err.message);
        });
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && currentGroup) {
      loadMessages();
    }
  });

  window.addEventListener('offline', function () {
    document.querySelectorAll('.cg-group-btn').forEach(function (btn) {
      btn.style.opacity = '0.4';
      btn.style.pointerEvents = 'none';
    });
    updateSelectConnectionStatus();
    document
      .querySelectorAll('#cg-msg-input, .cg-inline-reply-input, .cg-edit-input')
      .forEach(function (input) {
        input.disabled = true;
        input.placeholder = 'No connection...';
      });
    document
      .querySelectorAll('#cg-send-btn, .cg-inline-reply-send, .cg-edit-save-btn, .msg-menu-delete')
      .forEach(function (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.5';
      });
  });

  window.addEventListener('online', function () {
    if (authReady) {
      document.querySelectorAll('.cg-group-btn').forEach(function (btn) {
        btn.style.opacity = '';
        btn.style.pointerEvents = '';
      });
    }
    updateSelectConnectionStatus();
    document
      .querySelectorAll('#cg-msg-input, .cg-inline-reply-input, .cg-edit-input')
      .forEach(function (input) {
        input.disabled = false;
        if (input.id === 'cg-msg-input') input.placeholder = 'Type a message...';
        if (input.classList.contains('cg-inline-reply-input'))
          input.placeholder = 'Write a reply...';
      });
    document
      .querySelectorAll('#cg-send-btn, .cg-inline-reply-send, .cg-edit-save-btn, .msg-menu-delete')
      .forEach(function (btn) {
        btn.disabled = false;
        btn.style.opacity = '1';
      });
  });
};
