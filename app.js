// ============================================================
// MHBC APP — app.js v4 — with Firebase Care Groups
// ============================================================

// ---- FIREBASE CONFIG ----
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, query, orderBy, onSnapshot, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAH_vFWzh9kvi5ad63EDov2KeXkpgCMmv0",
  authDomain: "mhbc-app.firebaseapp.com",
  projectId: "mhbc-app",
  storageBucket: "mhbc-app.firebasestorage.app",
  messagingSenderId: "482094427911",
  appId: "1:482094427911:web:7ed5ec06b716ae66a4dfa2"
};

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

// ---- ROOM PASSWORDS (change these to your actual passwords) ----
const ROOM_PASSWORDS = {
  c101: 'MHBCC101',
  narthex: 'MHBCNarthex',
  fellowship1: 'MHBCF1',
  fellowship2: 'MHBCF2'
};

// ---- ADMIN PINS (one per room — only admin sees the gear icon) ----
const ADMIN_PINS = {
  c101: '7381',
  narthex: '0179',
  fellowship1: '2573',
  fellowship2: '4618'
};

// ---- STATE ----
var currentGroup = null;
var currentGroupName = null;
var currentUser = null;
var messageListener = null;
var lastSeenTimestamps = {};

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
    // Check if already logged into a group
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

// ---- CARE GROUPS: SCREEN MANAGEMENT ----
function showCGScreen(screen) {
  var screens = ['select','login','pending','chat','admin'];
  for (var i = 0; i < screens.length; i++) {
    var el = document.getElementById('cg-' + screens[i] + '-screen');
    if (el) el.style.display = 'none';
  }
  var show = document.getElementById('cg-' + screen + '-screen');
  if (show) show.style.display = 'block';
}

// ---- SELECT GROUP ----
function selectGroup(groupId, groupName) {
  currentGroup = groupId;
  currentGroupName = groupName;

  // Check if already saved/approved for this group
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
async function submitLogin() {
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
  if (roomPass !== ROOM_PASSWORDS[currentGroup]) {
    errEl.textContent = 'Incorrect room password. Check with your group leader.';
    return;
  }

  // Check if user already exists in this group
  var memberId = currentGroup + '_' + userName.replace(/\s/g,'').toLowerCase();
  var memberRef = doc(db, 'groups', currentGroup, 'members', memberId);
  var memberSnap = await getDoc(memberRef);

  if (memberSnap.exists()) {
    var data = memberSnap.data();
    if (data.pin !== userPin) {
      errEl.textContent = 'Incorrect PIN for that name. Try again.';
      return;
    }
    // Existing user — check approval
    currentUser = { group: currentGroup, groupName: currentGroupName, name: userName, pin: userPin, memberId: memberId, isAdmin: (userPin === ADMIN_PINS[currentGroup]) };
    saveUser(currentUser);
    if (data.approved) {
      enterChat();
    } else {
      document.getElementById('cg-pending-title').textContent = currentGroupName;
      showCGScreen('pending');
    }
  } else {
    // New user — create pending request
    await setDoc(memberRef, {
      name: userName,
      pin: userPin,
      approved: false,
      requestedAt: serverTimestamp()
    });
    currentUser = { group: currentGroup, groupName: currentGroupName, name: userName, pin: userPin, memberId: memberId, isAdmin: (userPin === ADMIN_PINS[currentGroup]) };
    saveUser(currentUser);
    document.getElementById('cg-pending-title').textContent = currentGroupName;
    showCGScreen('pending');
  }
}

// ---- CHECK APPROVAL ----
async function checkApproval() {
  if (!currentUser) return;
  var memberRef = doc(db, 'groups', currentGroup, 'members', currentUser.memberId);
  var snap = await getDoc(memberRef);
  if (snap.exists() && snap.data().approved) {
    enterChat();
  } else {
    alert('Not approved yet. Please wait for your group leader to approve you.');
  }
}

async function checkApprovalAndEnter() {
  if (!currentUser) return;
  var memberRef = doc(db, 'groups', currentGroup, 'members', currentUser.memberId);
  var snap = await getDoc(memberRef);
  if (snap.exists() && snap.data().approved) {
    enterChat();
  } else if (snap.exists()) {
    document.getElementById('cg-pending-title').textContent = currentGroupName;
    showCGScreen('pending');
  } else {
    showCGScreen('select');
  }
}

// ---- ENTER CHAT ----
function enterChat() {
  document.getElementById('cg-chat-title').textContent = currentGroupName;
  var adminBtn = document.getElementById('cg-admin-btn');
  if (currentUser.isAdmin || currentUser.pin === ADMIN_PINS[currentGroup]) {
    adminBtn.style.display = 'block';
  } else {
    adminBtn.style.display = 'none';
  }
  showCGScreen('chat');
  loadMessages();
  markAsRead();
}

// ---- LOAD MESSAGES ----
function loadMessages() {
  if (messageListener) messageListener();
  var messagesEl = document.getElementById('cg-messages');
  messagesEl.innerHTML = '<div class="cg-loading">Loading messages...</div>';

  var q = query(collection(db, 'groups', currentGroup, 'messages'), orderBy('timestamp', 'asc'));
  messageListener = onSnapshot(q, function(snapshot) {
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
async function sendMessage() {
  var input = document.getElementById('cg-msg-input');
  var text = input.value.trim();
  if (!text) return;
  input.value = '';
  await addDoc(collection(db, 'groups', currentGroup, 'messages'), {
    text: text,
    author: currentUser.name,
    timestamp: serverTimestamp()
  });
}

// Allow Enter key to send
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    var chatScreen = document.getElementById('cg-chat-screen');
    if (chatScreen && chatScreen.style.display !== 'none') {
      sendMessage();
    }
  }
});

// ---- LEAVE CHAT ----
function leaveChat() {
  if (messageListener) {
    messageListener();
    messageListener = null;
  }
  showCGScreen('select');
}

// ---- MARK AS READ ----
function markAsRead() {
  if (!currentGroup) return;
  lastSeenTimestamps[currentGroup] = Date.now();
  localStorage.setItem('mhbc_lastseen', JSON.stringify(lastSeenTimestamps));
  updateBadge(currentGroup, 0);
}

// ---- UNREAD BADGES ----
function updateBadge(groupId, count) {
  var badge = document.getElementById('badge-' + groupId);
  var navBadge = document.getElementById('nav-badge-care');
  if (badge) {
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }
  // Update nav badge with total unread across all groups user belongs to
  var totalUnread = 0;
  var badges = document.querySelectorAll('.cg-badge');
  badges.forEach(function(b) {
    if (b.style.display !== 'none') totalUnread += parseInt(b.textContent || '0');
  });
  if (navBadge) {
    if (totalUnread > 0) {
      navBadge.textContent = totalUnread;
      navBadge.style.display = 'flex';
    } else {
      navBadge.style.display = 'none';
    }
  }
}

function watchUnreadForGroup(groupId) {
  var saved = getSavedUser();
  if (!saved || saved.group !== groupId) return;
  var lastSeen = lastSeenTimestamps[groupId] || 0;
  var q = query(collection(db, 'groups', groupId, 'messages'), orderBy('timestamp', 'asc'));
  onSnapshot(q, function(snapshot) {
    var unread = 0;
    snapshot.forEach(function(d) {
      var msg = d.data();
      if (msg.timestamp && msg.timestamp.toMillis() > lastSeen && msg.author !== saved.name) {
        unread++;
      }
    });
    updateBadge(groupId, unread);
  });
}

// ---- ADMIN PANEL ----
async function showAdminPanel() {
  showCGScreen('admin');
  loadAdminLists();
}

async function loadAdminLists() {
  var pendingEl = document.getElementById('admin-pending-list');
  var approvedEl = document.getElementById('admin-approved-list');
  pendingEl.innerHTML = '<div class="cg-loading">Loading...</div>';
  approvedEl.innerHTML = '<div class="cg-loading">Loading...</div>';

  var membersSnap = await getDocs(collection(db, 'groups', currentGroup, 'members'));
  var pending = [];
  var approved = [];
  membersSnap.forEach(function(d) {
    var data = d.data();
    data._id = d.id;
    if (data.approved) approved.push(data);
    else pending.push(data);
  });

  // Render pending
  if (pending.length === 0) {
    pendingEl.innerHTML = '<div class="cg-empty-note">No pending requests</div>';
  } else {
    pendingEl.innerHTML = '';
    pending.forEach(function(m) {
      var div = document.createElement('div');
      div.className = 'cg-member-row';
      div.innerHTML = '<span class="cg-member-name">' + m.name + '</span>' +
        '<button class="cg-approve-btn" onclick="approveMember(\'' + m._id + '\')">Approve</button>' +
        '<button class="cg-deny-btn" onclick="denyMember(\'' + m._id + '\')">Deny</button>';
      pendingEl.appendChild(div);
    });
  }

  // Render approved
  if (approved.length === 0) {
    approvedEl.innerHTML = '<div class="cg-empty-note">No approved members yet</div>';
  } else {
    approvedEl.innerHTML = '';
    approved.forEach(function(m) {
      var div = document.createElement('div');
      div.className = 'cg-member-row';
      div.innerHTML = '<span class="cg-member-name">' + m.name + '</span>' +
        '<button class="cg-deny-btn" onclick="removeMember(\'' + m._id + '\')">Remove</button>';
      approvedEl.appendChild(div);
    });
  }
}

async function approveMember(memberId) {
  await updateDoc(doc(db, 'groups', currentGroup, 'members', memberId), { approved: true });
  loadAdminLists();
}

async function denyMember(memberId) {
  await deleteDoc(doc(db, 'groups', currentGroup, 'members', memberId));
  loadAdminLists();
}

async function removeMember(memberId) {
  if (confirm('Remove this member from the group?')) {
    await deleteDoc(doc(db, 'groups', currentGroup, 'members', memberId));
    loadAdminLists();
  }
}

// ---- LOCAL STORAGE HELPERS ----
function saveUser(user) {
  localStorage.setItem('mhbc_cg_user', JSON.stringify(user));
}

function getSavedUser() {
  var raw = localStorage.getItem('mhbc_cg_user');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(e) { return null; }
}

// ---- BIBLE PICKER ----
var chaptersMap = {
  GEN:50, EXO:40, LEV:27, NUM:36, DEU:34, JOS:24, JDG:21, RUT:4,
  '1SA':31, '2SA':24, '1KI':22, '2KI':25, '1CH':29, '2CH':36, EZR:10,
  NEH:13, EST:10, JOB:42, PSA:150, PRO:31, ECC:12, SNG:8, ISA:66,
  JER:52, LAM:5, EZK:48, DAN:12, HOS:14, JOL:3, AMO:9, OBA:1,
  JON:4, MIC:7, NAM:3, HAB:3, ZEP:3, HAG:2, ZEC:14, MAL:4,
  MAT:28, MRK:16, LUK:24, JHN:21, ACT:28, ROM:16, '1CO':16,
  '2CO':13, GAL:6, EPH:6, PHP:4, COL:4, '1TH':5, '2TH':3,
  '1TI':6, '2TI':4, TIT:3, PHM:1, HEB:13, JAS:5, '1PE':5,
  '2PE':3, '1JN':5, '2JN':1, '3JN':1, JUD:1, REV:22
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
  var url = 'https://www.bible.com/bible/' + currentTrans + '/' + book + '.' + chapter + '.' + currentCode;
  window.open(url, '_blank');
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
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---- INIT ----
window.onload = function() {
  populateChapters('JHN', 1);

  var bookSel = document.getElementById('bibleBook');
  if (bookSel) bookSel.addEventListener('change', function() { populateChapters(this.value, 1); });

  var pills = document.querySelectorAll('.pill');
  for (var i = 0; i < pills.length; i++) {
    pills[i].addEventListener('click', function() {
      document.querySelectorAll('.pill').forEach(function(p) { p.classList.remove('active'); });
      this.classList.add('active');
      currentTrans = this.getAttribute('data-trans');
      currentCode = this.getAttribute('data-code');
    });
  }

  var bibleBtn = document.getElementById('openBibleBtn');
  if (bibleBtn) bibleBtn.addEventListener('click', openBible);

  var day = new Date().getDay();
  if (day === 0 || day === 3) {
    var badge = document.getElementById('liveBadge');
    if (badge) badge.style.display = 'flex';
  }

  // Load last seen timestamps
  var ls = localStorage.getItem('mhbc_lastseen');
  if (ls) { try { lastSeenTimestamps = JSON.parse(ls); } catch(e) {} }

  // Watch for unread messages in the user's group
  var saved = getSavedUser();
  if (saved) {
    currentGroup = saved.group;
    currentGroupName = saved.groupName;
    currentUser = saved;
    watchUnreadForGroup(saved.group);
  }

  tryGenerateQR();
};
