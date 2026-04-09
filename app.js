// ============================================================
// MHBC APP — app.js v21 final
// Hybrid model: UID = trusted session, name+password = recovery
// Admin assigned backend-only via Firebase console
// ============================================================

var db = null;
var auth = null;
var currentUID = null;
var currentGroup = null;
var currentGroupName = null;
var currentUser = null;
var currentMemberKey = null;
var messageListener = null;
var unreadListeners = {};
var unreadCountsByGroup = {};
var unreadCount = 0;
var lastSeenTimestamps = {};
var replyingTo = null;
var longPressTimer = null;
var audioUnlocked = false;
var audioCtx = null;
var authReady = false;
var suppressNextAutoScroll = false;
var suppressAutoScrollUntil = 0;
var pendingCountsByGroup = {};

var BUBBLE_COLORS = [
  '#1a5276','#1a3a6e','#6c3483','#145a32','#784212',
  '#1b4f72','#4a235a','#0e6655','#7b241c','#1f618d'
];

function getBubbleColor(name) {
  var hash = 0;
  for (var i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return BUBBLE_COLORS[Math.abs(hash) % BUBBLE_COLORS.length];
}

function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

async function hashInput(input, salt) {
  var encoder = new TextEncoder();
  var data = encoder.encode(input + salt);
  var hashBuffer = await crypto.subtle.digest('SHA-256', data);
  var hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
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
  } catch(e) { return { failedCount: 0, lockoutUntil: 0 }; }
}

function setLoginGuard(groupId, normalizedName, failedCount, lockoutUntil) {
  var key = getLoginGuardKey(groupId, normalizedName);
  localStorage.setItem(key, JSON.stringify({ failedCount: failedCount, lockoutUntil: lockoutUntil }));
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

function initFirebase() {
  firebase.initializeApp({
    apiKey: "AIzaSyBYt5RR0YGB9u9n7QgvAGXnvmrb7-xTg-Y",
    authDomain: "mhbc-app.firebaseapp.com",
    projectId: "mhbc-app",
    storageBucket: "mhbc-app.firebasestorage.app",
    messagingSenderId: "482094427911",
    appId: "1:482094427911:web:7ed5ec06b716ae66a4dfa2"
  });
  db = firebase.firestore();
  auth = firebase.auth();
}

// ---- AUDIO ----
function unlockAudio() {
  if (audioUnlocked) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var buf = audioCtx.createBuffer(1, 1, 22050);
    var src = audioCtx.createBufferSource();
    src.buffer = buf; src.connect(audioCtx.destination); src.start(0);
    audioUnlocked = true;
  } catch(e) {}
}

function playNotificationSound() {
  if (!audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.value = 520; osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.4);
  } catch(e) {}
}

// ---- BADGES ----
// ---- BADGES ----

// ---- APP ICON BADGE (iOS) ----
function updateAppBadge(count) {
  if (!('setAppBadge' in navigator)) return;

  if (count > 0) {
    navigator.setAppBadge(count).catch(function() {});
  } else {
    navigator.clearAppBadge().catch(function() {});
  }
}

function requestBadgePermission() {
  if (!('Notification' in window)) return;

  if (Notification.permission === 'default') {
    Notification.requestPermission().then(function(permission) {
      console.log('Notification permission:', permission);
    });
  }
}

function refreshCareNavBadge() {
  var navBadge = document.getElementById('nav-badge-care');
  var total = 0;

  Object.keys(unreadCountsByGroup).forEach(function(groupId) {
  var unread = unreadCountsByGroup[groupId] || 0;
  var pending = pendingCountsByGroup[groupId] || 0;
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

  updateAppBadge(total); // 👈 this is the key addition
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
function setPendingCount(groupId, count) {
  pendingCountsByGroup[groupId] = Math.max(0, count || 0);

  var unread = unreadCountsByGroup[groupId] || 0;
  var total = unread + pendingCountsByGroup[groupId];

  var roomBadge = document.getElementById('badge-' + groupId);
  if (roomBadge) {
    if (total > 0) {
      roomBadge.textContent = total > 99 ? '99+' : String(total);
      roomBadge.style.display = 'flex';
    } else {
      roomBadge.style.display = 'none';
    }
  }

  refreshCareNavBadge();
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

function hideInputBar() { var b = document.getElementById('cg-input-bar'); if (b) b.style.display = 'none'; }
function showInputBar() { var b = document.getElementById('cg-input-bar'); if (b) b.style.display = 'flex'; }

// ---- PAGE NAVIGATION ----
function showPage(id) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
  var target = document.getElementById('page-' + id);
  if (target) { target.classList.add('active'); window.scrollTo(0, 0); }
  var activeBtn = document.querySelector('.nav-btn[data-page="' + id + '"]');
  if (activeBtn) activeBtn.classList.add('active');
  hideInputBar();
  if (id === 'care') {
  var lastGroup = getLastGroup();
  var saved = lastGroup ? getSavedUser(lastGroup) : null;

  if (saved) {
    currentGroup = saved.group;
    currentGroupName = saved.groupName;
    currentUser = saved;
    currentMemberKey = saved.normalizedName;

    ['select','login','pending','chat','members','changepassword'].forEach(function(s) {
      var el = document.getElementById('cg-' + s + '-screen');
      if (el) el.style.display = 'none';
    });

    checkApprovalAndEnter();
  } else {
    showCGScreen('select');
  }
}
}

function showCGScreen(screen) {
  ['select','login','pending','chat','members','changepassword'].forEach(function(s) {
    var el = document.getElementById('cg-' + s + '-screen');
    if (el) el.style.display = 'none';
  });
  var show = document.getElementById('cg-' + screen + '-screen');
  if (show) show.style.display = 'block';
  if (screen === 'chat') showInputBar(); else hideInputBar();
}

function toggleVisible(inputId, btn) {
  var input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
  else { input.type = 'password'; btn.textContent = '👁'; }
}

function startOver() {
  stopUnreadWatcher(currentGroup);
  clearUnreadCount(currentGroup);
  clearSavedUser(currentGroup);
  currentUser = null;
  currentGroup = null;
  currentGroupName = null;
  currentMemberKey = null;
  showCGScreen('select');
}

function selectGroup(groupId, groupName) {
  currentGroup = groupId;
  currentGroupName = groupName;

  var saved = getSavedUser(groupId);
  if (saved) {
    currentUser = saved;
    currentMemberKey = saved.normalizedName;
    setLastGroup(groupId);
    checkApprovalAndEnter();
    return;
  }

  document.getElementById('cg-login-title').textContent = groupName;
  ['cg-room-password','cg-user-name','cg-user-pin'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('cg-login-error').textContent = '';
  showCGScreen('login');
}

// ---- PENDING SCREEN MESSAGES ----
function showFirstTimeMessage() {
  var el = document.getElementById('cg-pending-msg');
  if (el) el.textContent = 'Your request to join has been sent! Your group leader will approve you shortly.';
}

function showReturningUserMessage() {
  var el = document.getElementById('cg-pending-msg');
  if (el) el.textContent = 'We recognize your account. This device or browser needs to be approved by your group leader before you can continue.';
}

// ---- SUBMIT LOGIN ----
function submitLogin() {
  var roomPass = document.getElementById('cg-room-password').value.trim();
  var userName = document.getElementById('cg-user-name').value.trim();
  var userPassword = document.getElementById('cg-user-pin').value.trim();
  var errEl = document.getElementById('cg-login-error');
  errEl.textContent = '';

  if (!roomPass || !userName || !userPassword) { errEl.textContent = 'Please fill in all fields.'; return; }
  if (userPassword.length < 4) { errEl.textContent = 'Password must be at least 4 characters.'; return; }

  if (!authReady || !auth.currentUser) {
    errEl.textContent = 'Connecting... please try again in a moment.';
    return;
  }

  currentUID = auth.currentUser.uid;
  var normalized = normalizeName(userName);
  if (!normalized) { errEl.textContent = 'Please enter a valid name.'; return; }

  // Brute-force guard — check before any Firebase calls
  var remainingLockout = getRemainingLockoutMs(currentGroup, normalized);
  if (remainingLockout > 0) {
    errEl.textContent = 'Too many failed attempts. Please wait ' + formatRemainingLockout(remainingLockout) + ' before trying again.';
    return;
  }

  db.collection('config').doc('rooms').get().then(function(snap) {
    if (!snap.exists) { errEl.textContent = 'Configuration error. Contact your admin.'; return; }
    var config = snap.data();

    hashInput(roomPass, config[currentGroup + '_salt']).then(function(enteredRoomHash) {
      if (enteredRoomHash !== config[currentGroup + '_hash']) {
        recordFailedLogin(currentGroup, normalized);
        var remainingAfterRoomFailure = getRemainingLockoutMs(currentGroup, normalized);
        if (remainingAfterRoomFailure > 0) {
          errEl.textContent = 'Too many failed attempts. Please wait ' + formatRemainingLockout(remainingAfterRoomFailure) + ' before trying again.';
        } else {
          errEl.textContent = 'Incorrect room password. Check with your group leader.';
        }
        return;
      }

      var identityRef = db.collection('groups').doc(currentGroup).collection('identities').doc(normalized);

      identityRef.get().then(function(identitySnap) {
        if (identitySnap.exists) {
          // Known identity — verify personal password
          var identity = identitySnap.data();
          hashInput(userPassword, identity.passwordSalt).then(function(enteredHash) {
            if (enteredHash !== identity.passwordHash) {
              recordFailedLogin(currentGroup, normalized);
              var remainingAfterFailure = getRemainingLockoutMs(currentGroup, normalized);
              if (remainingAfterFailure > 0) {
                errEl.textContent = 'Too many failed attempts. Please wait ' + formatRemainingLockout(remainingAfterFailure) + ' before trying again.';
              } else {
                errEl.textContent = 'Incorrect password. Try again.';
              }
              return;
            }

            // Password correct — clear any accumulated failed attempts
            clearLoginGuard(currentGroup, normalized);

            var memberRef = db.collection('groups').doc(currentGroup).collection('members').doc(currentUID);
            memberRef.get().then(function(memberSnap) {
              if (memberSnap.exists) {
                // Same device — just update lastLoginAt and enter
                memberRef.update({ lastLoginAt: Date.now() });
                var memberData = memberSnap.data();
                currentMemberKey = normalized;
                currentUser = {
                  group: currentGroup, groupName: currentGroupName,
                  name: identity.displayName, normalizedName: normalized,
                  isAdmin: memberData.isAdmin === true
                };
                saveUser(currentUser);
                setLastGroup(currentGroup);
                startAllUnreadWatchers();
                if (memberData.approved) { enterChat(); }
                else {
                  document.getElementById('cg-pending-title').textContent = currentGroupName;
                  showReturningUserMessage(); showCGScreen('pending');
                }
              } else {
                // New device / cleared browser — create pending doc, nothing more
                memberRef.set({
                  uid: currentUID, normalizedName: normalized,
                  displayName: identity.displayName,
                  approved: false, isAdmin: false,
                  createdAt: Date.now(), lastLoginAt: Date.now()
                }).then(function() {
                  currentMemberKey = normalized;
                  currentUser = {
                    group: currentGroup, groupName: currentGroupName,
                    name: identity.displayName, normalizedName: normalized,
                    isAdmin: false
                  };
                  saveUser(currentUser);
                  setLastGroup(currentGroup);
                  startAllUnreadWatchers();
                  document.getElementById('cg-pending-title').textContent = currentGroupName;
                  showReturningUserMessage();
                  showCGScreen('pending');
                }).catch(function(err) { errEl.textContent = 'Session error: ' + err.message; });
              }
            }).catch(function(err) { errEl.textContent = 'Member lookup error: ' + err.message; });
          });

        } else {
          // Brand new user
          var passwordSalt = generateSalt();
          hashInput(userPassword, passwordSalt).then(function(passwordHash) {
            identityRef.set({
              displayName: userName, normalizedName: normalized,
              passwordHash: passwordHash, passwordSalt: passwordSalt,
              approved: false, isAdmin: false, createdAt: Date.now()
            }).then(function() {
              return db.collection('groups').doc(currentGroup).collection('members').doc(currentUID).set({
                uid: currentUID, normalizedName: normalized, displayName: userName,
                approved: false, isAdmin: false,
                createdAt: Date.now(), lastLoginAt: Date.now()
              });
            }).then(function() {
              // Both docs created successfully — clear guard
              clearLoginGuard(currentGroup, normalized);
              currentMemberKey = normalized;
              currentUser = {
                group: currentGroup, groupName: currentGroupName,
                name: userName, normalizedName: normalized, isAdmin: false
              };
              saveUser(currentUser);
              setLastGroup(currentGroup);
              startAllUnreadWatchers();
              document.getElementById('cg-pending-title').textContent = currentGroupName;
              showFirstTimeMessage(); showCGScreen('pending');
            }).catch(function(err) { errEl.textContent = 'Registration error: ' + err.message; });
          });
        }
      }).catch(function(err) { errEl.textContent = 'Identity lookup error: ' + err.message; });
    });
  }).catch(function(err) { errEl.textContent = 'Config error: ' + err.message; });
}

// ---- CHECK APPROVAL ----
function checkApproval() {
  if (!currentUID || !currentGroup) return;
  db.collection('groups').doc(currentGroup).collection('members').doc(currentUID).get().then(function(snap) {
    if (snap.exists && snap.data().approved) {
      currentUser.isAdmin = snap.data().isAdmin === true;
      saveUser(currentUser);
setLastGroup(currentGroup);
startAllUnreadWatchers();
enterChat();
    } else {
      alert('Not approved yet. Please wait for your group leader to approve you.');
    }
  });
}

function checkApprovalAndEnter() {
  if (!currentUID || !currentGroup) { showCGScreen('select'); return; }
  db.collection('groups').doc(currentGroup).collection('members').doc(currentUID).get().then(function(snap) {
    if (snap.exists && snap.data().approved) {
      currentUser.isAdmin = snap.data().isAdmin === true;
      saveUser(currentUser);
setLastGroup(currentGroup);
startAllUnreadWatchers();
enterChat();
    } else if (snap.exists) {
      document.getElementById('cg-pending-title').textContent = currentGroupName;
      showCGScreen('pending');
    } else {
  stopUnreadWatcher(currentGroup);
  clearUnreadCount(currentGroup);
  clearSavedUser(currentGroup);
  showCGScreen('select');
}
  }).catch(function() {
  stopUnreadWatcher(currentGroup);
  clearUnreadCount(currentGroup);
  clearSavedUser(currentGroup);
  showCGScreen('select');
});
}

function enterChat() {
  document.getElementById('cg-chat-title').textContent = currentGroupName;
  var mb = document.getElementById('cg-members-btn'); if (mb) mb.style.display = 'block';
  showCGScreen('chat');
loadMessages();
markAsRead();
  setTimeout(function() {
  window.scrollTo(0, document.body.scrollHeight);
}, 300);
}

// ---- UNREAD WATCHER ----
function startUnreadWatcher(groupId, userName) {
  if (!groupId || !userName) return;

  if (unreadListeners[groupId]) {
    unreadListeners[groupId]();
    delete unreadListeners[groupId];
  }

  var initialized = false;
  var lastCount = 0;

  unreadListeners[groupId] = db.collection('groups').doc(groupId)
    .collection('messages')
    .orderBy('timestamp', 'asc')
    .onSnapshot(function(snapshot) {
      var lastSeen = lastSeenTimestamps[groupId] || 0;
      var count = 0;

      snapshot.forEach(function(doc) {
        var msg = doc.data();
        var ts = msg.timestamp ? msg.timestamp.toMillis() : 0;

        if (ts > lastSeen && msg.author !== userName) {
          count++;
        }
      });

      if (initialized && count > lastCount && !isInChat()) {
        playNotificationSound();
      }

      initialized = true;
      lastCount = count;

      if (isInChat() && currentGroup === groupId) {
        setUnreadCount(groupId, 0);
      } else {
        setUnreadCount(groupId, count);
      }
    }, function(err) {
      console.error('Unread watcher error for', groupId, err);
    });
}

function stopUnreadWatcher(groupId) {
  if (unreadListeners[groupId]) {
    unreadListeners[groupId]();
    delete unreadListeners[groupId];
  }
}

function stopAllUnreadWatchers() {
  Object.keys(unreadListeners).forEach(function(groupId) {
    unreadListeners[groupId]();
  });
  unreadListeners = {};
}

function startAllUnreadWatchers() {
  stopAllUnreadWatchers();

  var users = getSavedUsers();
  Object.keys(users).forEach(function(groupId) {
    var user = users[groupId];
    if (user && user.name) {
      startUnreadWatcher(groupId, user.name);
    }
  });
}

function setReply(messageId, authorName) {
  replyingTo = { id: messageId, author: authorName };

  var bar = document.getElementById('cg-reply-bar');
  if (bar) bar.style.display = 'none';

  loadMessages();

  setTimeout(function() {
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
  loadMessages();
}
function sendInlineReply(parentId) {
  var input = document.getElementById('inline-reply-input-' + parentId);
  if (!input || !db || !currentUID) return;

  var text = input.value.trim();
  if (!text) return;

  input.value = '';

  var msgData = {
    text: text,
    author: currentUser.name,
    authorKey: currentMemberKey,
    authorUid: currentUID,
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    replyTo: parentId,
    replyToAuthor: replyingTo ? replyingTo.author : ''
  };

  db.collection('groups').doc(currentGroup).collection('messages').add(msgData).then(function() {
  suppressAutoScrollUntil = Date.now() + 2000;
  clearReply();

  setTimeout(function() {
    var thread = document.getElementById('thread-' + parentId);
    if (thread) {
      thread.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 150);
});
}

// ---- MESSAGE OWNERSHIP — three-tier fallback ----
function isMyMessage(msg) {
  if (msg.authorUid && currentUID && msg.authorUid === currentUID) return true;
  if (msg.authorKey && currentMemberKey && msg.authorKey === currentMemberKey) return true;
  if (!msg.authorUid && !msg.authorKey && msg.author && currentUser && msg.author === currentUser.name) return true;
  return false;
}

// ---- LONG PRESS MENU ----
function showMessageMenu(msgId, isMe) {
  var existing = document.getElementById('msg-menu'); if (existing) existing.remove();
  var menu = document.createElement('div');
  menu.id = 'msg-menu'; menu.className = 'msg-menu';

  if (isMe) {
    var editBtn = document.createElement('button');
    editBtn.className = 'msg-menu-btn'; editBtn.textContent = '✏️ Edit';
    editBtn.addEventListener('click', function() { menu.remove(); editMessage(msgId); });
    menu.appendChild(editBtn);
  }
  if (isMe || currentUser.isAdmin) {
    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'msg-menu-btn msg-menu-delete'; deleteBtn.textContent = '🗑️ Delete';
    deleteBtn.addEventListener('click', function() {
      menu.remove();
      if (confirm('Delete this message?')) {
        suppressAutoScrollUntil = Date.now() + 2000;

db.collection('groups').doc(currentGroup)
  .collection('messages').doc(msgId)
  .delete();
      }
    });
    menu.appendChild(deleteBtn);
  }
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'msg-menu-btn msg-menu-cancel'; cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function() { menu.remove(); });
  menu.appendChild(cancelBtn);
  document.body.appendChild(menu);
  setTimeout(function() {
    document.addEventListener('click', function dismiss() {
      menu.remove(); document.removeEventListener('click', dismiss);
    });
  }, 100);
}

function editMessage(msgId) {
  var msgRef = db.collection('groups').doc(currentGroup).collection('messages').doc(msgId);

  msgRef.get().then(function(snap) {
    if (!snap.exists) return;

    var newText = prompt('Edit your message:', snap.data().text);

    if (newText !== null && newText.trim() !== '' && newText.trim() !== snap.data().text) {

      suppressAutoScrollUntil = Date.now() + 2000;

      msgRef.update({ text: newText.trim(), edited: true });
    }
  });
}

function attachLongPress(wrapper, msgId, isMe) {
  // No long press behavior anymore
  return;
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
    var match = url.match(patterns[i]); if (match) return match[1];
  }
  return null;
}

// ---- RICH MEDIA RENDERER ----
function renderMessageContent(text, container) {
  var parts = text.split(/(https?:\/\/[^\s]+)/g);
  parts.forEach(function(part) {
    if (!part) return;
    if (part.match(/^https?:\/\//)) {
      var url = part;
      var ytId = extractYouTubeId(url);
      if (ytId) {
        var wrap = document.createElement('div'); wrap.className = 'msg-yt-wrap';
        var thumb = document.createElement('img');
        thumb.src = 'https://img.youtube.com/vi/' + ytId + '/hqdefault.jpg';
        thumb.className = 'msg-image msg-yt-thumb'; thumb.setAttribute('loading', 'lazy');
        thumb.addEventListener('click', function() { window.open(url, '_blank'); });
        var play = document.createElement('div');
        play.className = 'msg-yt-play'; play.textContent = '▶';
        play.addEventListener('click', function() { window.open(url, '_blank'); });
        wrap.appendChild(thumb); wrap.appendChild(play); container.appendChild(wrap); return;
      }
      if (url.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i)) {
        var img = document.createElement('img');
        img.src = url; img.className = 'msg-image'; img.setAttribute('loading', 'lazy');
        img.addEventListener('click', function() { window.open(url, '_blank'); });
        container.appendChild(img); return;
      }
      if (url.match(/\.(mp4|webm|ogg)(\?.*)?$/i)) {
        var video = document.createElement('video');
        video.src = url; video.className = 'msg-video';
        video.controls = true; video.setAttribute('playsinline', '');
        container.appendChild(video); return;
      }
      var link = document.createElement('a');
      link.href = url; link.textContent = url; link.target = '_blank'; link.className = 'msg-link';
      container.appendChild(link);
    } else {
      if (part.trim()) {
        var span = document.createElement('span'); span.textContent = part; container.appendChild(span);
      }
    }
  });
}

// ---- LOAD MESSAGES ----
function loadMessages() {
  if (messageListener) messageListener();
  var messagesEl = document.getElementById('cg-messages');
  messagesEl.innerHTML = '<div class="cg-loading">Loading messages...</div>';

  messageListener = db.collection('groups').doc(currentGroup)
    .collection('messages').orderBy('timestamp', 'asc')
    .onSnapshot(function(snapshot) {
      messagesEl.innerHTML = '';
      if (snapshot.empty) {
        messagesEl.innerHTML = '<div class="cg-no-msgs">No messages yet. Say hello! 👋</div>'; return;
      }
      var topLevel = [], replyMap = {};
      snapshot.forEach(function(d) {
        var msg = d.data(); msg._id = d.id;
        if (!msg.replyTo) { topLevel.push(msg); replyMap[d.id] = []; }
      });
      snapshot.forEach(function(d) {
        var msg = d.data(); msg._id = d.id;
        if (msg.replyTo && replyMap[msg.replyTo]) replyMap[msg.replyTo].push(msg);
      });
            // Hide while rendering to prevent top-flash
      messagesEl.style.visibility = 'hidden';
      topLevel.forEach(function(msg, index) {
        renderThread(msg, replyMap[msg._id] || [], messagesEl, index < topLevel.length - 1);
      });
      setTimeout(function() {
  if (!replyingTo && Date.now() > suppressAutoScrollUntil) {
    window.scrollTo(0, document.body.scrollHeight);
  }
  messagesEl.style.visibility = 'visible';
}, 150);
      if (isInChat()) { markAsRead(); }

    });
}

function buildMessageRow(msg, isPrimary) {
  var isMe = isMyMessage(msg);
  var color = getBubbleColor(msg.author);
  var time = '';
if (msg.timestamp) {
  var dt = new Date(msg.timestamp.toMillis());
  time = dt.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }) + ' · ' + dt.toLocaleTimeString([], {
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
  menuBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    showMessageMenu(msg._id, isMe);
  });
  header.appendChild(menuBtn);
}

content.appendChild(header);

  var wrapper = document.createElement('div'); wrapper.className = 'msg-wrapper';
  renderMessageContent(msg.text, wrapper);
  if (msg.edited) {
    var editedTag = document.createElement('span');
    editedTag.className = 'msg-edited'; editedTag.textContent = ' (edited)';
    wrapper.appendChild(editedTag);
  }
  attachLongPress(wrapper, msg._id, isMe);
  content.appendChild(wrapper);
  row.appendChild(content);
  return row;
}

function renderPrimaryMessage(msg, container) { container.appendChild(buildMessageRow(msg, true)); }
function renderReplyMessage(msg, container) { container.appendChild(buildMessageRow(msg, false)); }

function renderThread(msg, replies, container, showDivider) {
  var thread = document.createElement('div');
thread.className = 'cg-thread';
thread.id = 'thread-' + msg._id;
  renderPrimaryMessage(msg, thread);

  var commentBar = document.createElement('div'); commentBar.className = 'cg-comment-bar';
  var replyBtn = document.createElement('button'); replyBtn.className = 'cg-comment-btn';
  replyBtn.textContent = replies.length > 0
  ? '💬 Reply · ' + replies.length + (replies.length === 1 ? ' Comment' : ' Comments')
  : '💬 Reply';
  replyBtn.addEventListener('click', (function(id, author) {
    return function() { setReply(id, author); };
  })(msg._id, msg.author));
  commentBar.appendChild(replyBtn); thread.appendChild(commentBar);
  if (replyingTo && replyingTo.id === msg._id) {
  var inlineReplyBox = document.createElement('div');
  inlineReplyBox.className = 'cg-inline-reply-box';

  var inlineReplyHeader = document.createElement('div');
  inlineReplyHeader.className = 'cg-inline-reply-header';
  inlineReplyHeader.textContent = 'Replying to ' + replyingTo.author;

  var inlineReplyRow = document.createElement('div');
  inlineReplyRow.className = 'cg-inline-reply-row';

  var inlineInput = document.createElement('input');
  inlineInput.type = 'text';
  inlineInput.className = 'cg-inline-reply-input';
  inlineInput.id = 'inline-reply-input-' + msg._id;
  inlineInput.placeholder = 'Write a reply...';

  inlineInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendInlineReply(msg._id);
  });

  var inlineSend = document.createElement('button');
  inlineSend.className = 'cg-inline-reply-send';
  inlineSend.type = 'button';
  inlineSend.textContent = 'Send';
  inlineSend.addEventListener('click', function() {
    sendInlineReply(msg._id);
  });

  var inlineCancel = document.createElement('button');
  inlineCancel.className = 'cg-inline-reply-cancel';
  inlineCancel.type = 'button';
  inlineCancel.textContent = 'Cancel';
  inlineCancel.addEventListener('click', function() {
    clearReply();
  });

  inlineReplyRow.appendChild(inlineInput);
  inlineReplyRow.appendChild(inlineSend);
  inlineReplyRow.appendChild(inlineCancel);

  inlineReplyBox.appendChild(inlineReplyHeader);
  inlineReplyBox.appendChild(inlineReplyRow);

  thread.appendChild(inlineReplyBox);
}

  if (replies.length > 0) {
    var repliesContainer = document.createElement('div'); repliesContainer.className = 'cg-replies-container';
    replies.forEach(function(reply) { renderReplyMessage(reply, repliesContainer); });
    thread.appendChild(repliesContainer);
  }
  if (showDivider) {
    var divider = document.createElement('div'); divider.className = 'cg-thread-divider';
    thread.appendChild(divider);
  }
  container.appendChild(thread);
}

function sendMessage() {
  var input = document.getElementById('cg-msg-input');
  var text = input.value.trim();
  if (!text || !db || !currentUID) return;
  input.value = '';
  var msgData = {
    text: text, author: currentUser.name,
    authorKey: currentMemberKey, authorUid: currentUID,
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  };
  
  db.collection('groups').doc(currentGroup).collection('messages').add(msgData).then(function() {
    var messagesEl = document.getElementById('cg-messages');
    if (messagesEl) {
            setTimeout(function() {
  window.scrollTo(0, document.body.scrollHeight);
}, 300);
    }
  });
}

function leaveChat() {
  clearReply();
  currentUser = null;
  currentGroup = null;
  currentGroupName = null;
  currentMemberKey = null;
  hideInputBar();
  showCGScreen('select');
}

function markAsRead() {
  if (!currentGroup) return;

  lastSeenTimestamps[currentGroup] = Date.now();
  localStorage.setItem('mhbc_lastseen', JSON.stringify(lastSeenTimestamps));
  setUnreadCount(currentGroup, 0);
}

// ---- MEMBERS PANEL ----
function showMembersPanel() { showCGScreen('members'); loadMembersList(); }

function loadMembersList() {
  var listEl = document.getElementById('members-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="cg-loading">Loading...</div>';

  db.collection('groups').doc(currentGroup).collection('members').get().then(function(snap) {
    listEl.innerHTML = '';
    if (snap.empty) { listEl.innerHTML = '<div class="cg-empty-note">No members yet</div>'; return; }

    // Dedupe by normalizedName — keep most recently active UID per person
    var personMap = {};
    snap.forEach(function(d) {
      var data = d.data(); data._id = d.id;
      var key = data.normalizedName || d.id;
      if (!personMap[key]) {
        personMap[key] = data;
      } else {
        var existing = personMap[key];
        var existingTime = existing.lastLoginAt || existing.createdAt || 0;
        var newTime = data.lastLoginAt || data.createdAt || 0;
        if (newTime > existingTime) personMap[key] = data;
      }
    });

        var approved = [], pending = [];
    Object.keys(personMap).forEach(function(key) {
      var m = personMap[key];
      if (m.approved) approved.push(m); else pending.push(m);
    });

    // Sort both lists alphabetically by first name
    function sortByName(a, b) {
      var nameA = (a.displayName || a._id || '').toLowerCase();
      var nameB = (b.displayName || b._id || '').toLowerCase();
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    }
    approved.sort(sortByName);
    pending.sort(sortByName);


    if (currentUser.isAdmin && pending.length > 0) {
      var pendingLabel = document.createElement('div');
      pendingLabel.className = 'section-label'; pendingLabel.textContent = 'PENDING REQUESTS';
      listEl.appendChild(pendingLabel);
      var pendingList = document.createElement('div'); pendingList.className = 'cg-member-list';
      pending.forEach(function(m) {
        var div = document.createElement('div'); div.className = 'cg-member-row';
        var nameSpan = document.createElement('span'); nameSpan.className = 'cg-member-name';
        nameSpan.textContent = m.displayName || m._id;
        var approveBtn = document.createElement('button'); approveBtn.className = 'cg-approve-btn'; approveBtn.textContent = 'Approve';
        approveBtn.addEventListener('click', (function(id) { return function() { approveMember(id); }; })(m._id));
        var denyBtn = document.createElement('button'); denyBtn.className = 'cg-deny-btn'; denyBtn.textContent = 'Deny';
        denyBtn.addEventListener('click', (function(id) { return function() { denyMember(id); }; })(m._id));
        div.appendChild(nameSpan); div.appendChild(approveBtn); div.appendChild(denyBtn);
        pendingList.appendChild(div);
      });
      listEl.appendChild(pendingList);
    }

    var approvedLabel = document.createElement('div');
    approvedLabel.className = 'section-label'; approvedLabel.textContent = 'MEMBERS';
    listEl.appendChild(approvedLabel);
    var approvedList = document.createElement('div'); approvedList.className = 'cg-member-list';

    if (approved.length === 0) {
      approvedList.innerHTML = '<div class="cg-empty-note">No approved members yet</div>';
    } else {
      approved.forEach(function(m) {
        var div = document.createElement('div'); div.className = 'cg-member-row';
        var nameSpan = document.createElement('span'); nameSpan.className = 'cg-member-name';
        nameSpan.textContent = (m.displayName || m._id) + (m.isAdmin ? ' ⭐' : '');
        div.appendChild(nameSpan);
        if (currentUser.isAdmin) {
          var removeBtn = document.createElement('button'); removeBtn.className = 'cg-deny-btn'; removeBtn.textContent = 'Remove';
          removeBtn.addEventListener('click', (function(id) { return function() { removeMember(id); }; })(m._id));
          div.appendChild(removeBtn);
        }
        approvedList.appendChild(div);
      });
    }
    listEl.appendChild(approvedList);
  });
}

// Approve: update member doc + sync identity doc
function approveMember(memberUid) {
  var memberRef = db.collection('groups').doc(currentGroup).collection('members').doc(memberUid);
  memberRef.update({ approved: true }).then(function() {
    return memberRef.get();
  }).then(function(snap) {
    if (snap.exists && snap.data().normalizedName) {
      db.collection('groups').doc(currentGroup).collection('identities')
        .doc(snap.data().normalizedName).update({ approved: true });
    }
    loadMembersList();
  });
}

// Helper: delete ALL member docs for a given normalizedName, then set identity approved:false
function deleteAllSessionsForPerson(normalized) {
  return db.collection('groups').doc(currentGroup).collection('members')
    .where('normalizedName', '==', normalized).get()
    .then(function(snap) {
      var deletes = [];
      snap.forEach(function(d) { deletes.push(d.ref.delete()); });
      return Promise.all(deletes);
    }).then(function() {
      return db.collection('groups').doc(currentGroup).collection('identities')
        .doc(normalized).update({ approved: false });
    });
}

// Deny: delete ALL UID sessions for this person + mark identity not approved
function denyMember(memberUid) {
  var memberRef = db.collection('groups').doc(currentGroup).collection('members').doc(memberUid);
  memberRef.get().then(function(snap) {
    var normalized = snap.exists ? snap.data().normalizedName : null;
    if (normalized) {
      return deleteAllSessionsForPerson(normalized);
    } else {
      return memberRef.delete();
    }
  }).then(loadMembersList);
}

// Remove: delete ALL UID sessions for this person + mark identity not approved
function removeMember(memberUid) {
  if (!confirm('Remove this member from the group?')) return;
  var memberRef = db.collection('groups').doc(currentGroup).collection('members').doc(memberUid);
  memberRef.get().then(function(snap) {
    var normalized = snap.exists ? snap.data().normalizedName : null;
    if (normalized) {
      return deleteAllSessionsForPerson(normalized);
    } else {
      return memberRef.delete();
    }
  }).then(loadMembersList);
}

// ---- CHANGE PASSWORD ----
function showChangePassword() {
  showCGScreen('changepassword');
  // Clear fields
  var fields = ['cg-cp-current','cg-cp-new','cg-cp-confirm'];
  fields.forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
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

  if (!currentPw || !newPw || !confirmPw) { errEl.textContent = 'Please fill in all fields.'; return; }
  if (newPw.length < 4) { errEl.textContent = 'New password must be at least 4 characters.'; return; }
  if (newPw !== confirmPw) { errEl.textContent = "Passwords don't match."; return; }
  if (newPw === currentPw) { errEl.textContent = 'New password must be different from current password.'; return; }
  if (!currentMemberKey) { errEl.textContent = 'Session error. Please log in again.'; return; }

  var identityRef = db.collection('groups').doc(currentGroup).collection('identities').doc(currentMemberKey);

  identityRef.get().then(function(snap) {
    if (!snap.exists) { errEl.textContent = 'Identity not found. Please log in again.'; return; }
    var identity = snap.data();

    hashInput(currentPw, identity.passwordSalt).then(function(enteredHash) {
      if (enteredHash !== identity.passwordHash) {
        errEl.textContent = 'Current password is incorrect.'; return;
      }

      // Current password verified — generate new salt and hash
      var newSalt = generateSalt();
      hashInput(newPw, newSalt).then(function(newHash) {
        identityRef.update({
          passwordSalt: newSalt,
          passwordHash: newHash
        }).then(function() {
          okEl.textContent = 'Password changed successfully!';
          // Clear fields
          ['cg-cp-current','cg-cp-new','cg-cp-confirm'].forEach(function(id) {
            var el = document.getElementById(id); if (el) el.value = '';
          });
        }).catch(function(err) {
          errEl.textContent = 'Error saving password: ' + err.message;
        });
      });
    });
  }).catch(function(err) {
    errEl.textContent = 'Error reading identity: ' + err.message;
  });
}

// ---- LOCAL STORAGE ----

function getSavedUsers() {
  var raw = localStorage.getItem('mhbc_cg_users');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
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

// ---- BIBLE PICKER ----
var chaptersMap = {
  GEN:50,EXO:40,LEV:27,NUM:36,DEU:34,JOS:24,JDG:21,RUT:4,
  '1SA':31,'2SA':24,'1KI':22,'2KI':25,'1CH':29,'2CH':36,EZR:10,
  NEH:13,EST:10,JOB:42,PSA:150,PRO:31,ECC:12,SNG:8,ISA:66,
  JER:52,LAM:5,EZK:48,DAN:12,HOS:14,JOL:3,AMO:9,OBA:1,
  JON:4,MIC:7,NAM:3,HAB:3,ZEP:3,HAG:2,ZEC:14,MAL:4,
  MAT:28,MRK:16,LUK:24,JHN:21,ACT:28,ROM:16,'1CO':16,
  '2CO':13,GAL:6,EPH:6,PHP:4,COL:4,'1TH':5,'2TH':3,
  '1TI':6,'2TI':4,TIT:3,PHM:1,HEB:13,JAS:5,'1PE':5,
  '2PE':3,'1JN':5,'2JN':1,'3JN':1,JUD:1,REV:22
};
var currentTrans = '111';
var currentCode = 'NIV';

function populateChapters(book, selected) {
  var sel = document.getElementById('bibleChapter'); if (!sel) return;
  var count = chaptersMap[book] || 1; sel.innerHTML = '';
  for (var i = 1; i <= count; i++) {
    var opt = document.createElement('option');
    opt.value = i; opt.textContent = 'Chapter ' + i;
    if (i === (selected || 1)) opt.selected = true;
    sel.appendChild(opt);
  }
}

function openBible() {
  var book = document.getElementById('bibleBook').value;
  var chapter = document.getElementById('bibleChapter').value;
  window.open('https://www.bible.com/bible/' + currentTrans + '/' + book + '.' + chapter + '.' + currentCode, '_blank');
}

function tryGenerateQR() {
  var qrEl = document.getElementById('appQR'); if (!qrEl) return;
  if (typeof QRCode !== 'undefined') {
    new QRCode(qrEl, { text: 'https://qnxyt9x67g-max.github.io/MHBC/', width: 90, height: 90, colorDark: '#0a1628', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H });
  } else { setTimeout(tryGenerateQR, 500); }
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

  parts.forEach(function(part) {
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

  var badge = document.getElementById('liveBadge');
  if (badge) {
    badge.style.display =
      ((day === 0 && totalMins >= 565 && totalMins <= 660) ||   // Sun 9:25–11:00
       (day === 3 && totalMins >= 1135 && totalMins <= 1200))   // Wed 6:55–8:00
      ? 'flex'
      : 'none';
  }
}

// ---- INIT ----
window.onload = function() {
  initFirebase();
  // Enable Notifications button (iOS requires user interaction)
var enableRow = document.getElementById('enableNotificationsRow');
if (enableRow) {
  enableRow.addEventListener('click', function () {
    requestBadgePermission();

    alert('If prompted, tap "Allow" to enable notifications and badges.');
  });
}
var mainInput = document.getElementById('cg-msg-input');
if (mainInput) {
  function jumpToBottomForMainInput() {
    if (replyingTo) {
      clearReply();
    }
    setTimeout(function() {
      window.scrollTo(0, document.body.scrollHeight);
    }, 100);
  }

  mainInput.addEventListener('focus', jumpToBottomForMainInput);
  mainInput.addEventListener('click', jumpToBottomForMainInput);
}
  var ls = localStorage.getItem('mhbc_lastseen');
  if (ls) { try { lastSeenTimestamps = JSON.parse(ls); } catch(e) {} }

  populateChapters('JHN', 1);
  var bookSel = document.getElementById('bibleBook');
  if (bookSel) bookSel.addEventListener('change', function() { populateChapters(this.value, 1); });

  document.querySelectorAll('.pill').forEach(function(pill) {
    pill.addEventListener('click', function() {
      document.querySelectorAll('.pill').forEach(function(p) { p.classList.remove('active'); });
      this.classList.add('active');
      currentTrans = this.getAttribute('data-trans');
      currentCode = this.getAttribute('data-code');
    });
  });

  var bibleBtn = document.getElementById('openBibleBtn');
  if (bibleBtn) bibleBtn.addEventListener('click', openBible);

  document.querySelectorAll('.nav-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      unlockAudio();
      var page = this.getAttribute('data-page'); if (page) showPage(page);
    });
  });

  document.querySelectorAll('.quick-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      unlockAudio();
      var action = this.getAttribute('data-action');
      var url = this.getAttribute('data-url');
      if (action) showPage(action); else if (url) window.open(url, '_blank');
    });
  });

  document.querySelectorAll('.cg-group-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      unlockAudio();
      var groupId = this.getAttribute('data-group');
      var groupName = this.getAttribute('data-name');
      if (groupId && groupName) selectGroup(groupId, groupName);
    });
  });

  var loginBtn = document.getElementById('cg-login-submit');
  if (loginBtn) loginBtn.addEventListener('click', function() { unlockAudio(); submitLogin(); });

  var checkBtn = document.getElementById('cg-check-btn');
  if (checkBtn) checkBtn.addEventListener('click', checkApproval);

  var startOverBtn = document.getElementById('cg-start-over-btn');
  if (startOverBtn) startOverBtn.addEventListener('click', startOver);

  var backToSelect = document.getElementById('cg-back-to-select');
  if (backToSelect) backToSelect.addEventListener('click', function() { showCGScreen('select'); });

  var backToSelectFromPending = document.getElementById('cg-back-to-select-pending');
  if (backToSelectFromPending) backToSelectFromPending.addEventListener('click', function() { showCGScreen('select'); });

  var backToChatFromMembers = document.getElementById('cg-back-to-chat-members');
  if (backToChatFromMembers) backToChatFromMembers.addEventListener('click', function() { showCGScreen('chat'); });

  var leaveChatBtn = document.getElementById('cg-leave-chat');
  if (leaveChatBtn) leaveChatBtn.addEventListener('click', leaveChat);

  var membersBtn = document.getElementById('cg-members-btn');
  if (membersBtn) membersBtn.addEventListener('click', showMembersPanel);

  var changePwBtn = document.getElementById('cg-change-pw-btn');
  if (changePwBtn) changePwBtn.addEventListener('click', showChangePassword);

  var backToChatFromCP = document.getElementById('cg-back-to-members-from-cp');
  if (backToChatFromCP) backToChatFromCP.addEventListener('click', function() { showCGScreen('members'); });

  var cpSubmitBtn = document.getElementById('cg-cp-submit');
  if (cpSubmitBtn) cpSubmitBtn.addEventListener('click', submitChangePassword);

  var cpCancelBtn = document.getElementById('cg-cp-cancel');
  if (cpCancelBtn) cpCancelBtn.addEventListener('click', function() { showCGScreen('members'); });

  var cpEyeCurrent = document.getElementById('cg-cp-eye-current');
  if (cpEyeCurrent) cpEyeCurrent.addEventListener('click', function() { toggleVisible('cg-cp-current', this); });

  var cpEyeNew = document.getElementById('cg-cp-eye-new');
  if (cpEyeNew) cpEyeNew.addEventListener('click', function() { toggleVisible('cg-cp-new', this); });

  var cpEyeConfirm = document.getElementById('cg-cp-eye-confirm');
  if (cpEyeConfirm) cpEyeConfirm.addEventListener('click', function() { toggleVisible('cg-cp-confirm', this); });

  var sendBtn = document.getElementById('cg-send-btn');
  if (sendBtn) sendBtn.addEventListener('click', function() { unlockAudio(); sendMessage(); });

  var replyCancel = document.getElementById('cg-reply-cancel');
  if (replyCancel) replyCancel.addEventListener('click', clearReply);

  var eyeRoom = document.getElementById('cg-eye-room');
  if (eyeRoom) eyeRoom.addEventListener('click', function() { toggleVisible('cg-room-password', this); });

  var eyePin = document.getElementById('cg-eye-pin');
  if (eyePin) eyePin.addEventListener('click', function() { toggleVisible('cg-user-pin', this); });

  var msgInput = document.getElementById('cg-msg-input');
  if (msgInput) msgInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendMessage(); });

  var locationCard = document.getElementById('location-card');
  if (locationCard) locationCard.addEventListener('click', function() {
    window.open('https://www.google.com/maps/search/?api=1&query=301+Teel+Road+Beckley+WV+25801', '_blank');
  });

  var ytLaunch = document.getElementById('yt-launch');
  if (ytLaunch) ytLaunch.addEventListener('click', function() {
    window.open('https://www.youtube.com/@maxwellhillbaptistchurch9695', '_blank');
  });

  var liveBadge = document.getElementById('liveBadge');
  if (liveBadge) liveBadge.addEventListener('click', function() { showPage('watch'); });

  checkLiveBadge();
  setInterval(checkLiveBadge, 60000);
  tryGenerateQR();

  auth.onAuthStateChanged(function(user) {
    if (user) {
      authReady = true;
      currentUID = user.uid;
      var lastGroup = getLastGroup();
var savedUser = lastGroup ? getSavedUser(lastGroup) : null;

if (savedUser && savedUser.group && savedUser.name && savedUser.normalizedName) {
  currentGroup = savedUser.group;
  currentGroupName = savedUser.groupName;
  currentUser = savedUser;
  currentMemberKey = savedUser.normalizedName;
}

startAllUnreadWatchers();
      
    } else {
      authReady = false;
      auth.signInAnonymously().catch(function(err) {
        console.error('Sign in failed:', err.code, err.message);
      });
    }
  });
};
