// ============================================================
// MHBC APP — app.js v14 — Anonymous Auth + Secure Architecture
// ============================================================

var db = null;
var auth = null;
var currentUID = null;
var currentGroup = null;
var currentGroupName = null;
var currentUser = null;
var messageListener = null;
var unreadListener = null;
var lastSeenTimestamps = {};
var replyingTo = null;
var longPressTimer = null;

// ---- BUBBLE COLORS ----
var BUBBLE_COLORS = [
  '#1a5276','#1a3a6e','#6c3483','#145a32','#784212',
  '#1b4f72','#4a235a','#0e6655','#7b241c','#1f618d'
];

function getBubbleColor(name) {
  var hash = 0;
  for (var i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return BUBBLE_COLORS[Math.abs(hash) % BUBBLE_COLORS.length];
}

// ---- HASH FUNCTION ----
async function hashInput(input, salt) {
  var encoder = new TextEncoder();
  var data = encoder.encode(input + salt);
  var hashBuffer = await crypto.subtle.digest('SHA-256', data);
  var hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

// ---- INIT FIREBASE ----
function initFirebase() {
  var firebaseConfig = {
    apiKey: "AIzaSyBYt5RR0YGB9u9n7QgvAGXnvmrb7-xTg-Y",
    authDomain: "mhbc-app.firebaseapp.com",
    projectId: "mhbc-app",
    storageBucket: "mhbc-app.firebasestorage.app",
    messagingSenderId: "482094427911",
    appId: "1:482094427911:web:7ed5ec06b716ae66a4dfa2"
  };
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  auth = firebase.auth();
}

// ---- SIGN IN ANONYMOUSLY ----
function signInAnonymously() {
  return auth.signInAnonymously().then(function(result) {
    currentUID = result.user.uid;
    // Check if we have a saved UID mapping
    var savedUID = localStorage.getItem('mhbc_uid');
    if (!savedUID) {
      localStorage.setItem('mhbc_uid', currentUID);
    } else {
      // Use the saved UID for consistency
      currentUID = savedUID;
    }
  }).catch(function(err) {
    console.error('Auth error:', err);
  });
}

// ---- INPUT BAR ----
function hideInputBar() {
  var bar = document.getElementById('cg-input-bar');
  if (bar) bar.style.display = 'none';
}
function showInputBar() {
  var bar = document.getElementById('cg-input-bar');
  if (bar) bar.style.display = 'flex';
}

// ---- NOTIFICATION SOUND ----
function playNotificationSound() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 520;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch(e) {}
}

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
      currentGroup = saved.group;
      currentGroupName = saved.groupName;
      currentUser = saved;
      checkApprovalAndEnter();
    } else {
      showCGScreen('select');
    }
  }
}

// ---- CARE GROUPS SCREENS ----
function showCGScreen(screen) {
  var screens = ['select','login','pending','chat','admin'];
  screens.forEach(function(s) {
    var el = document.getElementById('cg-' + s + '-screen');
    if (el) el.style.display = 'none';
  });
  var show = document.getElementById('cg-' + screen + '-screen');
  if (show) show.style.display = 'block';
  if (screen === 'chat') showInputBar();
  else hideInputBar();
}

// ---- TOGGLE PASSWORD VISIBILITY ----
function toggleVisible(inputId, btn) {
  var input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
  else { input.type = 'password'; btn.textContent = '👁'; }
}

// ---- START OVER ----
function startOver() {
  clearSavedUser();
  currentUser = null; currentGroup = null; currentGroupName = null;
  showCGScreen('select');
}

// ---- SELECT GROUP ----
function selectGroup(groupId, groupName) {
  currentGroup = groupId;
  currentGroupName = groupName;
  var saved = getSavedUser();
  if (saved && saved.group === groupId) {
    currentUser = saved;
    checkApprovalAndEnter();
    return;
  }
  document.getElementById('cg-login-title').textContent = groupName;
  document.getElementById('cg-room-password').value = '';
  document.getElementById('cg-user-name').value = '';
  document.getElementById('cg-user-pin').value = '';
  document.getElementById('cg-login-error').textContent = '';
  showCGScreen('login');
}

// ---- SUBMIT LOGIN ----
function submitLogin() {
  var roomPass = document.getElementById('cg-room-password').value.trim();
  var userName = document.getElementById('cg-user-name').value.trim();
  var userPin = document.getElementById('cg-user-pin').value.trim();
  var errEl = document.getElementById('cg-login-error');
  errEl.textContent = '';

  if (!roomPass || !userName || !userPin) { errEl.textContent = 'Please fill in all fields.'; return; }
  if (userPin.length < 4) { errEl.textContent = 'PIN must be at least 4 characters.'; return; }
  if (!currentUID) { errEl.textContent = 'Connection error. Please refresh and try again.'; return; }

  db.collection('config').doc('rooms').get().then(function(snap) {
    if (!snap.exists) { errEl.textContent = 'Configuration error. Contact your admin.'; return; }
    var config = snap.data();
    var roomSalt = config[currentGroup + '_salt'];
    var roomHash = config[currentGroup + '_hash'];
    var adminSalt = config['adminPin_salt'];
    var adminHash = config['adminPin_hash'];

    hashInput(roomPass, roomSalt).then(function(enteredRoomHash) {
      if (enteredRoomHash !== roomHash) {
        errEl.textContent = 'Incorrect room password. Check with your group leader.';
        return;
      }

      hashInput(userPin, adminSalt).then(function(enteredAdminHash) {
        var isAdmin = (enteredAdminHash === adminHash);

        // Check if this UID already has a member record
        var memberRef = db.collection('groups').doc(currentGroup)
                          .collection('members').doc(currentUID);

        memberRef.get().then(function(memberSnap) {
          if (memberSnap.exists) {
            // Existing member — verify PIN from privateMembers
            var privateRef = db.collection('groups').doc(currentGroup)
                               .collection('privateMembers').doc(currentUID);
            privateRef.get().then(function(privateSnap) {
              if (!privateSnap.exists) {
                errEl.textContent = 'Account error. Please use Start Over.';
                return;
              }
              var pinData = privateSnap.data();
              hashInput(userPin, pinData.pinSalt).then(function(enteredPinHash) {
                if (enteredPinHash !== pinData.pinHash) {
                  errEl.textContent = 'Incorrect PIN. Try again.';
                  return;
                }
                if (isAdmin && !memberSnap.data().approved) {
                  memberRef.update({ approved: true });
                }
                currentUser = {
                  group: currentGroup,
                  groupName: currentGroupName,
                  name: memberSnap.data().name,
                  uid: currentUID,
                  isAdmin: isAdmin
                };
                saveUser(currentUser);
                if (memberSnap.data().approved || isAdmin) { enterChat(); }
                else {
                  document.getElementById('cg-pending-title').textContent = currentGroupName;
                  showCGScreen('pending');
                }
              });
            });
          } else {
            // New member — create public + private records
            var pinSalt = generateSalt();
            hashInput(userPin, pinSalt).then(function(pinHash) {
              // Public record
              memberRef.set({
                name: userName,
                approved: isAdmin,
                joinedAt: Date.now()
              }).then(function() {
                // Private record — PIN stored separately
                return db.collection('groups').doc(currentGroup)
                          .collection('privateMembers').doc(currentUID)
                          .set({ pinHash: pinHash, pinSalt: pinSalt });
              }).then(function() {
                currentUser = {
                  group: currentGroup,
                  groupName: currentGroupName,
                  name: userName,
                  uid: currentUID,
                  isAdmin: isAdmin
                };
                saveUser(currentUser);
                if (isAdmin) { enterChat(); }
                else {
                  document.getElementById('cg-pending-title').textContent = currentGroupName;
                  showCGScreen('pending');
                }
              });
            });
          }
        });
      });
    });
  });
}

function generateSalt() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var salt = '';
  for (var i = 0; i < 8; i++) salt += chars[Math.floor(Math.random() * chars.length)];
  return salt;
}

// ---- CHECK APPROVAL ----
function checkApproval() {
  if (!currentUser) return;
  db.collection('groups').doc(currentGroup)
    .collection('members').doc(currentUID).get().then(function(snap) {
      if (snap.exists && snap.data().approved) { enterChat(); }
      else { alert('Not approved yet. Please wait for your group leader to approve you.'); }
    });
}

function checkApprovalAndEnter() {
  if (!currentUser) return;
  var uid = currentUser.uid || currentUID;
  db.collection('groups').doc(currentGroup)
    .collection('members').doc(uid).get().then(function(snap) {
      if (snap.exists && snap.data().approved) { enterChat(); }
      else if (snap.exists) {
        document.getElementById('cg-pending-title').textContent = currentGroupName;
        showCGScreen('pending');
      } else { clearSavedUser(); showCGScreen('select'); }
    });
}

// ---- ENTER CHAT ----
function enterChat() {
  document.getElementById('cg-chat-title').textContent = currentGroupName;
  var adminBtn = document.getElementById('cg-admin-btn');
  adminBtn.style.display = currentUser.isAdmin ? 'block' : 'none';
  showCGScreen('chat');
  loadMessages();
  markAsRead();
}

// ---- IS IN CHAT ----
function isInChat() {
  var chatScreen = document.getElementById('cg-chat-screen');
  var carePage = document.getElementById('page-care');
  return chatScreen &&
         chatScreen.style.display !== 'none' &&
         carePage &&
         carePage.classList.contains('active');
}

// ---- BACKGROUND UNREAD WATCHER ----
function startUnreadWatcher(groupId, userName) {
  if (unreadListener) { unreadListener(); unreadListener = null; }
  var initialized = false;
  var last​​​​​​​​​​​​​​​​
