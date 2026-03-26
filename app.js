// ============================================================
// MHBC APP — app.js v6 — Secure, Firebase-backed
// ============================================================

var db = null;
var currentGroup = null;
var currentGroupName = null;
var currentUser = null;
var messageListener = null;
var lastSeenTimestamps = {};

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
}

// ---- PAGE NAVIGATION ----
function showPage(id) {
  var pages = document.querySelectorAll('.page');
  for (var i = 0; i < pages.length; i++) {
    pages[i].classList.remove('active');
  }
  var btns = document.querySelectorAll('.nav-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.remove('active');
  }
  var target = document.getElementById('page-' + id);
  if (target) {
    target.classList.add('active');
    window.scrollTo(0, 0);
  }
  var activeBtn = document.querySelector('.nav-btn[data-page="' + id + '"]');
  if (activeBtn) activeBtn.classList.add('active');

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
  for (var i = 0; i < screens.length; i++) {
    var el = document.getElementById('cg-' + screens[i] + '-screen');
    if (el) el.style.display = 'none';
  }
  var show = document.getElementById('cg-' + screen + '-screen');
  if (show) show.style.display = 'block';
  var inputBar = document.getElementById('cg-input-bar');
  if (inputBar) inputBar.style.display = (screen === 'chat') ? 'flex' : 'none';
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
  showCGScreen('login');
}

// ---- SUBMIT LOGIN ----
function submitLogin() {
  var roomPass = document.getElementById('cg-room-password').value.trim();
  var userName = document.getElementById('cg-user-name').value.trim();
  var userPin = document.getElementById('cg-user-pin').value.trim();
  var errEl = document.getElementById('cg-login-error');
  errEl.textContent = '';

  if (!roomPass || !userName || !userPin) {
    errEl.textContent = 'Please fill in all fields.';
    return;
  }
  if (userPin.length !== 4 || isNaN(userPin)) {
    errEl.textContent = 'PIN must be exactly 4 digits.';
    return;
  }

  // Fetch passwords from Firebase
  db.collection('config').doc('rooms').get().then(function(snap) {
    if (!snap.exists) {
      errEl.textContent = 'Configuration error. Contact your admin.';
      return;
    }
    var config = snap.data();
    var correctPass = config[currentGroup];
    var adminPin = config.adminPin;

    if (roomPass !== correctPass) {
      errEl.textContent = 'Incorrect room password. Check with your group leader.';
      return;
    }

    var isAdmin = (userPin === adminPin);
    var memberId = currentGroup + '_' + userName.replace(/\s/g,'').toLowerCase();
    var memberRef = db.collection('groups').doc(currentGroup).collection('members').doc(memberId);

    memberRef.get().then(function(memberSnap) {
      if (memberSnap.exists) {
        var data = memberSnap.data();
        if (data.pin !== userPin) {
          errEl.textContent = 'Incorrect PIN for that name. Try again.';
          return;
        }
        currentUser = { group: currentGroup, groupName: currentGroupName, name: userName, pin: userPin, memberId: memberId, isAdmin: isAdmin };
        saveUser(currentUser);
        if (data.approved) {
          enterChat();
        } else {
          document.getElementById('cg-pending-title').textContent = currentGroupName;
          showCGScreen('pending');
        }
      } else {
        // New member — auto-approve if admin PIN used
        memberRef.set({
          name: userName,
          pin: userPin,
          approved: isAdmin ? true : false,
          requestedAt: firebase.firestore.FieldValue.serverTimestamp()
        }).then(function() {
          currentUser = { group: currentGroup, groupName: currentGroupName, name: userName, pin: userPin, memberId: memberId, isAdmin: isAdmin };
          saveUser(currentUser);
          if (isAdmin) {
            enterChat();
          } else {
            document.getElementById('cg-pending-title').textContent = currentGroupName;
            showCGScreen('pending');
          }
        });
      }
    });
  });
}

// ---- CHECK APPROVAL ----
function checkApproval() {
  if (!currentUser) return;
  db.collection('groups').doc(currentGroup).collection('members').doc(currentUser.memberId).get().then(function(snap) {
    if (snap.exists && snap.data().approved) {
      enterChat();
    } else {
      alert('Not approved yet. Please wait for your group leader to approve you.');
    }
  });
}

function checkApprovalAndEnter() {
  if (!currentUser) return;
  db.collection('groups').doc(currentGroup).collection('members').doc(currentUser.memberId).get().then(function(snap) {
    if (snap.exists && snap.data().approved) {
      enterChat();
    } else if (snap.exists) {
      document.getElementById('cg-pending-title').textContent = currentGroupName;
      showCGScreen('pending');
    } else {
      clearSavedUser();
      showCGScreen('select');
    }
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

// ---- LOAD MESSAGES ----
function loadMessages() {
  if (messageListener) messageListener();
  var messagesEl = document.getElementById('cg-messages');
  messagesEl.innerHTML = '<div class="cg-loading">Loading messages...</div>';

  messageListener = db.collection('groups').doc(currentGroup).collection('messages')
    .orderBy('timestamp', 'asc')
    .onSnapshot(function(snapshot) {
      messagesEl.innerHTML = '';
      if (snapshot.empty) {
        messagesEl.innerHTML = '<div class="cg-no-msgs">No messages yet. Say hello! 👋</div>';
        return;
      }
      snapshot.forEach(function(d) {
        var msg = d.data();
        var isMe = msg.author === currentUser.name;
        var div = document.createElement('div');
        div.className = 'cg-msg ' + (isMe ? 'cg-msg-me' : 'cg-msg-them');
        var time = msg.timestamp ? new Date(msg.timestamp.toMillis()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
        div.innerHTML = (!isMe ? '<div class="cg-msg-author">' + msg.author + '</div>' : '') +
          '<div class="cg-msg-bubble">' + escapeHtml(msg.text) + '</div>' +
          '<div class="cg-msg-time">' + time + '</div>';
        messagesEl.appendChild(div);
      });
      messagesEl.scrollTop = messagesEl.scrollHeight;
      markAsRead();
    });
}

// ---- SEND MESSAGE ----
function sendMessage() {
  var input = document.getElementById('cg-msg-input');
  var text = input.value.trim();
  if (!text || !db) return;
  input.value = '';
  db.collection('groups').doc(currentGroup).collection('messages').add({
    text: text,
    author: currentUser.name,
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// ---- LEAVE CHAT ----
function leaveChat() {
  if (messageListener) { messageListener(); messageListener = null; }
  clearSavedUser();
  currentUser = null;
  currentGroup = null;
  currentGroupName = null;
  showCGScreen('select');
}

// ---- MARK AS READ ----
function markAsRead() {
  if (!currentGroup) return;
  lastSeenTimestamps[currentGroup] = Date.now();
  localStorage.setItem('mhbc_lastseen', JSON.stringify(lastSeenTimestamps));
  updateBadge(currentGroup, 0);
}

// ---- BADGES ----
function updateBadge(groupId, count) {
  var badge = document.getElementById('badge-' + groupId);
  var navBadge = document.getElementById('nav-badge-care');
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
  var total = 0;
  document.querySelectorAll('.cg-badge').forEach(function(b) {
    if (b.style.display !== 'none') total += parseInt(b.textContent || '0');
  });
  if (navBadge) {
    navBadge.textContent = total;
    navBadge.style.display = total > 0 ? 'flex' : 'none';
  }
}

// ---- ADMIN PANEL ----
function showAdminPanel() {
  showCGScreen('admin');
  loadAdminLists();
}

function loadAdminLists() {
  var pendingEl = document.getElementById('admin-pending-list');
  var approvedEl = document.getElementById('admin-approved-list');
  pendingEl.innerHTML = '<div class="cg-loading">Loading...</div>';
  approvedEl.innerHTML = '<div class="cg-loading">Loading...</div>';

  db.collection('groups').doc(currentGroup).collection('members').get().then(function(snap) {
    var pending = [];
    var approved = [];
    snap.forEach(function(d) {
      var data = d.data();
      data._id = d.id;
      if (data.approved) approved.push(data);
      else pending.push(data);
    });

    pendingEl.innerHTML = pending.length === 0 ? '<div class="cg-empty-note">No pending requests</div>' : '';
    pending.forEach(function(m) {
      var div = document.createElement('div');
      div.className = 'cg-member-row';
      div.innerHTML = '<span class="cg-member-name">' + m.name + '</span>' +
        '<button class="cg-approve-btn" onclick="approveMember(\'' + m._id + '\')">Approve</button>' +
        '<button class="cg-deny-btn" onclick="denyMember(\'' + m._id + '\')">Deny</button>';
      pendingEl.appendChild(div);
    });

    approvedEl.innerHTML = approved.length === 0 ? '<div class="cg-empty-note">No approved members yet</div>' : '';
    approved.forEach(function(m) {
      var div = document.createElement('div');
      div.className = 'cg-member-row';
      div.innerHTML = '<span class="cg-member-name">' + m.name + '</span>' +
        '<button class="cg-deny-btn" onclick="removeMember(\'' + m._id + '\')">Remove</button>';
      approvedEl.appendChild(div);
    });
  });
}

function approveMember(memberId) {
  db.collection('groups').doc(currentGroup).collection('members').doc(memberId)
    .update({ approved: true }).then(loadAdminLists);
}

function denyMember(memberId) {
  db.collection('groups').doc(currentGroup).collection('members').doc(memberId)
    .delete().then(loadAdminLists);
}

function removeMember(memberId) {
  if (confirm('Remove this member from the group?')) {
    db.collection('groups').doc(currentGroup).collection('members').doc(memberId)
      .delete().then(loadAdminLists);
  }
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
  window.open('https://www.bible.com/bible/' + currentTrans + '/' + book + '.' + chapter + '.' + currentCode, '_blank');
}

function tryGenerateQR() {
  var qrEl = document.getElementById('appQR');
  if (!qrEl) return;
  if (typeof QRCode !== 'undefined') {
    new QRCode(qrEl, {
      text: 'https://qnxyt9x67g-max.github.io/MHBC/',
      width: 90, height: 90,
      colorDark: '#0a1628', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H
    });
  } else {
    setTimeout(tryGenerateQR, 500);
  }
}

function escapeHtml(text) {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---- LIVE BADGE — only during service times (EST) ----
function checkLiveBadge() {
  var now = new Date();
  // Convert to EST (UTC-5) or EDT (UTC-4)
  var utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  var est = new Date(utc + (-5 * 3600000));
  var day = est.getDay();    // 0=Sun, 3=Wed
  var hour = est.getHours();
  var min = est.getMinutes();
  var totalMins = hour * 60 + min;

  // Sunday 9:30am–11:00am = 570–660 mins
  var sundayLive = (day === 0 && totalMins >= 570 && totalMins <= 660);
  // Wednesday 7:00pm–8:00pm = 1140–1200 mins
  var wednesdayLive = (day === 3 && totalMins >= 1140 && totalMins <= 1200);

  var badge = document.getElementById('liveBadge');
  if (badge) {
    badge.style.display = (sundayLive || wednesdayLive) ? 'flex' : 'none';
  }
}

// ---- INIT ----
window.onload = function() {
  initFirebase();
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

  checkLiveBadge();
  setInterval(checkLiveBadge, 60000);

  var ls = localStorage.getItem('mhbc_lastseen');
  if (ls) { try { lastSeenTimestamps = JSON.parse(ls); } catch(e) {} }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      var chatScreen = document.getElementById('cg-chat-screen');
      if (chatScreen && chatScreen.style.display !== 'none') sendMessage();
    }
  });

  tryGenerateQR();
};
