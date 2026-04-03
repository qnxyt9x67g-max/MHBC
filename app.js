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
var unreadListener = null;
var unreadCount = 0;
var lastSeenTimestamps = {};
var replyingTo = null;
var longPressTimer = null;
var audioUnlocked = false;
var audioCtx = null;
var authReady = false;
var appInitialized = false;

// ---- SPLASH OVERLAY ----
function hideSplash() {
  var splash = document.getElementById('app-splash');
  if (splash && !splash.classList.contains('splash-hidden')) {
    splash.classList.add('splash-hidden');
    // Remove from DOM after fade completes
    setTimeout(function() {
      if (splash.parentNode) splash.parentNode.removeChild(splash);
    }, 400);
  }
}

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
function setUnreadCount(groupId, count) {
  unreadCount = count;
  var roomBadge = document.getElementById('badge-' + groupId);
  var navBadge = document.getElementById('nav-badge-care');
  if (count > 0) {
    var label = count > 99 ? '99+' : String(count);
    if (roomBadge) { roomBadge.textContent = label; roomBadge.style.display = 'flex'; }
    if (navBadge) { navBadge.textContent = label; navBadge.style.display = 'flex'; }
  } else {
    if (roomBadge) roomBadge.style.display = 'none';
    if (navBadge) navBadge.style.display = 'none';
  }
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
    var saved = getSavedUser();
    if (saved) {
      currentGroup = saved.group; currentGroupName = saved.groupName;
      currentUser = saved; currentMemberKey = saved.normalizedName;
      // Hide all care screens during async approval check to prevent flash
      ['select','login','pending','chat','members','changepassword'].forEach(function(s) {
        var el = document.getElementById('cg-' + s + '-screen');
        if (el) el.style.display = 'none';
      });
      checkApprovalAndEnter();
    } else { showCGScreen('select'); }
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
  clearSavedUser();
  currentUser = null; currentGroup = null; currentGroupName = null; currentMemberKey = null;
  showCGScreen('select');
}

function selectGroup(groupId, groupName) {
  currentGroup = groupId; currentGroupName = groupName;
  var saved = getSavedUser();
  if (saved && saved.group === groupId) {
    currentUser = saved; currentMemberKey = saved.normalizedName;
    checkApprovalAndEnter(); return;
  }
  document.getElementById('cg-login-title').textContent = groupName;
  ['cg-room-password','cg-user-name','cg-user-pin'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = '';
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
                startUnreadWatcher(currentGroup, identity.displayName);
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
                  startUnreadWatcher(currentGroup, identity.displayName);
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
              startUnreadWatcher(currentGroup, userName);
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
      saveUser(currentUser); enterChat();
    } else { alert('Not approved yet. Please wait for your group leader to approve you.'); }
  });
}

function checkApprovalAndEnter() {
  if (!currentUID || !currentGroup) { showCGScreen('select'); return; }
  db.collection('groups').doc(currentGroup).collection('members').doc(currentUID).get().then(function(snap) {
    if (snap.exists && snap.data().approved) {
      currentUser.isAdmin = snap.data().isAdmin === true;
      saveUser(currentUser); enterChat();
    } else if (snap.exists) {
      document.getElementById('cg-pending-title').textContent = currentGroupName;
      showCGScreen('pending');
    } else { clearSavedUser(); showCGScreen('select'); }
  }).catch(function() { clearSavedUser(); showCGScreen('select'); });
}

function enterChat() {
  document.getElementById('cg-chat-title').textContent = currentGroupName;
  var mb = document.getElementById('cg-members-btn'); if (mb) mb.style.display = 'block';
  showCGScreen('chat'); loadMessages(); markAsRead(); setUnreadCount(currentGroup, 0);
}

// ---- UNREAD WATCHER ----
function startUnreadWatcher(groupId, userName) {
  if (unreadListener) { unreadListener(); unreadListener = null; }
  var initialized = false, lastCount = 0;

  unreadListener = db.collection('groups').doc(groupId).collection('messages')
    .orderBy('timestamp', 'asc').onSnapshot(function(snapshot) {
      var lastSeen = lastSeenTimestamps[groupId] || 0;
      var total = snapshot.size;
      var newUnread = 0;
      snapshot.forEach(function(d) {
        var msg = d.data();
        if (msg.author !== userName && msg.timestamp && msg.timestamp.toMillis() > lastSeen) newUnread++;
      });
      if (!initialized) {
        initialized = true; lastCount = total;
        if (!isInChat()) setUnreadCount(groupId, newUnread); return;
      }
      var hasNew = total > lastCount; lastCount = total;
      if (hasNew) {
        if (newUnread > 0) playNotificationSound();
        if (isInChat()) { markAsRead(); setUnreadCount(groupId, 0); }
        else { setUnreadCount(groupId, newUnread); }
      }
    }, function(err) { console.log('Watcher error:', err.message); });
}

function setReply(messageId, authorName) {
  replyingTo = { id: messageId, author: authorName };
  var bar = document.getElementById('cg-reply-bar');
  var label = document.getElementById('cg-reply-label');
  if (bar) bar.style.display = 'flex';
  if (label) label.textContent = 'Replying to ' + authorName;
  document.getElementById('cg-msg-input').focus();
}

function clearReply() {
  replyingTo = null;
  var bar = document.getElementById('cg-reply-bar'); if (bar) bar.style.display = 'none';
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
        db.collection('groups').doc(currentGroup).collection('messages').doc(msgId).delete();
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
      msgRef.update({ text: newText.trim(), edited: true });
    }
  });
}

// ---- ATTACH LONG PRESS — touch + desktop ----
function attachLongPress(wrapper, msgId, isMe) {
  if (!isMe && !currentUser.isAdmin) return;

  // Mobile touch
  wrapper.addEventListener('touchstart', function() {
    longPressTimer = setTimeout(function() { showMessageMenu(msgId, isMe); }, 600);
  });
  wrapper.addEventListener('touchend', function() { clearTimeout(longPressTimer); });
  wrapper.addEventListener('touchmove', function() { clearTimeout(longPressTimer); });

  // Desktop right-click
  wrapper.addEventListener('contextmenu', function(e) {
    e.preventDefault(); showMessageMenu(msgId, isMe);
  });

  // Desktop mouse long press
  var mouseTimer = null;
  wrapper.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    mouseTimer = setTimeout(function() { showMessageMenu(msgId, isMe); }, 600);
  });
  wrapper.addEventListener('mouseup', function() { clearTimeout(mouseTimer); });
  wrapper.addEventListener('mouseleave', function() { clearTimeout(mouseTimer); });
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
      topLevel.forEach(function(msg, index) {
        renderThread(msg, replyMap[msg._id] || [], messagesEl, index < topLevel.length - 1);
      });
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (isInChat()) { markAsRead(); setUnreadCount(currentGroup, 0); }
    });
}

function buildMessageRow(msg, isPrimary) {
  var isMe = isMyMessage(msg);
  var color = getBubbleColor(msg.author);
  var time = msg.timestamp ? new Date(msg.timestamp.toMillis()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';

  var row = document.createElement('div');
  row.className = isPrimary ? 'cg-primary-row' : 'cg-reply-row';

  var avatar = document.createElement('div');
  avatar.className = isPrimary ? 'cg-avatar' : 'cg-avatar cg-avatar-sm';
  avatar.textContent = msg.author.charAt(0).toUpperCase();
  avatar.style.background = color;
  row.appendChild(avatar);

  var content = document.createElement('div');
  content.className = isPrimary ? 'cg-primary-content' : 'cg-reply-content';

  var header = document.createElement('div'); header.className = 'cg-primary-header';
  var nameSpan = document.createElement('span'); nameSpan.className = 'cg-primary-name';
  nameSpan.textContent = msg.author; nameSpan.style.color = color;
  var timeSpan = document.createElement('span'); timeSpan.className = 'cg-primary-time';
  timeSpan.textContent = time;
  header.appendChild(nameSpan); header.appendChild(timeSpan);
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
  var thread = document.createElement('div'); thread.className = 'cg-thread';
  renderPrimaryMessage(msg, thread);

  var commentBar = document.createElement('div'); commentBar.className = 'cg-comment-bar';
  var replyBtn = document.createElement('button'); replyBtn.className = 'cg-comment-btn';
  replyBtn.textContent = replies.length > 0
    ? '💬 ' + replies.length + (replies.length === 1 ? ' Comment' : ' Comments')
    : '💬 Reply';
  replyBtn.addEventListener('click', (function(id, author) {
    return function() { setReply(id, author); };
  })(msg._id, msg.author));
  commentBar.appendChild(replyBtn); thread.appendChild(commentBar);

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
  if (replyingTo) { msgData.replyTo = replyingTo.id; msgData.replyToAuthor = replyingTo.author; clearReply(); }
  db.collection('groups').doc(currentGroup).collection('messages').add(msgData);
}

function leaveChat() {
  clearSavedUser(); clearReply();
  currentUser = null; currentGroup = null; currentGroupName = null; currentMemberKey = null;
  hideInputBar(); showCGScreen('select');
}

function markAsRead() {
  if (!currentGroup) return;
  lastSeenTimestamps[currentGroup] = Date.now();
  localStorage.setItem('mhbc_lastseen', JSON.stringify(lastSeenTimestamps));
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

function saveUser(user) { localStorage.setItem('mhbc_cg_user', JSON.stringify(user)); }
function getSavedUser() {
  var raw = localStorage.getItem('mhbc_cg_user');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(e) { return null; }
}
function clearSavedUser() { localStorage.removeItem('mhbc_cg_user'); }

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
  var est = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (-5 * 3600000));
  var day = est.getDay(), totalMins = est.getHours() * 60 + est.getMinutes();
  var badge = document.getElementById('liveBadge');
  if (badge) badge.style.display = ((day === 0 && totalMins >= 570 && totalMins <= 660) || (day === 3 && totalMins >= 1140 && totalMins <= 1200)) ? 'flex' : 'none';
}

// ---- INIT ----
window.onload = function() {
  initFirebase();

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
      var savedUser = getSavedUser();
      if (savedUser && savedUser.group && savedUser.name && savedUser.normalizedName) {
        currentGroup = savedUser.group; currentGroupName = savedUser.groupName;
        currentUser = savedUser; currentMemberKey = savedUser.normalizedName;
        startUnreadWatcher(savedUser.group, savedUser.name);
      }
      // Auth is ready — hide the splash overlay
      if (!appInitialized) {
        appInitialized = true;
        hideSplash();
      }
    } else {
      authReady = false;
      auth.signInAnonymously().catch(function(err) {
        console.error('Sign in failed:', err.code, err.message);
        // Sign-in failed — still hide splash so app isn't stuck
        hideSplash();
      });
    }
  });
};
