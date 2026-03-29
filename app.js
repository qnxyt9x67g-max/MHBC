// ============================================================
// MHBC APP — app.js v18
// ============================================================

var db = null;
var auth = null;
var currentUID = null;
var currentGroup = null;
var currentGroupName = null;
var currentUser = null;
var messageListener = null;
var unreadListener = null;
var unreadCount = 0;
var lastSeenTimestamps = {};
var replyingTo = null;
var longPressTimer = null;
var audioUnlocked = false;
var audioCtx = null;

// –– BUBBLE COLORS ––
var BUBBLE_COLORS = [
‘#1a5276’,’#1a3a6e’,’#6c3483’,’#145a32’,’#784212’,
‘#1b4f72’,’#4a235a’,’#0e6655’,’#7b241c’,’#1f618d’
];

function getBubbleColor(name) {
var hash = 0;
for (var i = 0; i < name.length; i++) {
hash = name.charCodeAt(i) + ((hash << 5) - hash);
}
return BUBBLE_COLORS[Math.abs(hash) % BUBBLE_COLORS.length];
}

// –– HASH FUNCTION ––
async function hashInput(input, salt) {
var encoder = new TextEncoder();
var data = encoder.encode(input + salt);
var hashBuffer = await crypto.subtle.digest(‘SHA-256’, data);
var hashArray = Array.from(new Uint8Array(hashBuffer));
return hashArray.map(function(b) { return b.toString(16).padStart(2, ‘0’); }).join(’’);
}

// –– INIT FIREBASE ––
function initFirebase() {
var firebaseConfig = {
apiKey: “AIzaSyBYt5RR0YGB9u9n7QgvAGXnvmrb7-xTg-Y”,
authDomain: “mhbc-app.firebaseapp.com”,
projectId: “mhbc-app”,
storageBucket: “mhbc-app.firebasestorage.app”,
messagingSenderId: “482094427911”,
appId: “1:482094427911:web:7ed5ec06b716ae66a4dfa2”
};
firebase.initializeApp(firebaseConfig);
db = firebase.firestore();
auth = firebase.auth();
}

// –– AUDIO ––
function unlockAudio() {
if (audioUnlocked) return;
try {
audioCtx = new (window.AudioContext || window.webkitAudioContext)();
var buffer = audioCtx.createBuffer(1, 1, 22050);
var source = audioCtx.createBufferSource();
source.buffer = buffer;
source.connect(audioCtx.destination);
source.start(0);
audioUnlocked = true;
} catch(e) {}
}

function playNotificationSound() {
if (!audioCtx) return;
try {
if (audioCtx.state === ‘suspended’) audioCtx.resume();
var osc = audioCtx.createOscillator();
var gain = audioCtx.createGain();
osc.connect(gain);
gain.connect(audioCtx.destination);
osc.frequency.value = 520;
osc.type = ‘sine’;
gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
osc.start(audioCtx.currentTime);
osc.stop(audioCtx.currentTime + 0.4);
} catch(e) {}
}

// –– BADGES — pass groupId explicitly ––
function setUnreadCount(groupId, count) {
unreadCount = count;
var roomBadge = document.getElementById(‘badge-’ + groupId);
var navBadge = document.getElementById(‘nav-badge-care’);
if (count > 0) {
var label = count > 99 ? ‘99+’ : String(count);
if (roomBadge) { roomBadge.textContent = label; roomBadge.style.display = ‘flex’; }
if (navBadge) { navBadge.textContent = label; navBadge.style.display = ‘flex’; }
} else {
if (roomBadge) roomBadge.style.display = ‘none’;
if (navBadge) navBadge.style.display = ‘none’;
}
}

// –– INPUT BAR ––
function hideInputBar() {
var bar = document.getElementById(‘cg-input-bar’);
if (bar) bar.style.display = ‘none’;
}
function showInputBar() {
var bar = document.getElementById(‘cg-input-bar’);
if (bar) bar.style.display = ‘flex’;
}

// –– PAGE NAVIGATION ––
function showPage(id) {
document.querySelectorAll(’.page’).forEach(function(p) { p.classList.remove(‘active’); });
document.querySelectorAll(’.nav-btn’).forEach(function(b) { b.classList.remove(‘active’); });
var target = document.getElementById(‘page-’ + id);
if (target) { target.classList.add(‘active’); window.scrollTo(0, 0); }
var activeBtn = document.querySelector(’.nav-btn[data-page=”’ + id + ‘”]’);
if (activeBtn) activeBtn.classList.add(‘active’);
hideInputBar();
if (id === ‘care’) {
var saved = getSavedUser();
if (saved) {
currentGroup = saved.group;
currentGroupName = saved.groupName;
currentUser = saved;
checkApprovalAndEnter();
} else {
showCGScreen(‘select’);
}
}
}

// –– CARE GROUPS SCREENS ––
function showCGScreen(screen) {
var screens = [‘select’,‘login’,‘pending’,‘chat’,‘members’];
screens.forEach(function(s) {
var el = document.getElementById(‘cg-’ + s + ‘-screen’);
if (el) el.style.display = ‘none’;
});
var show = document.getElementById(‘cg-’ + screen + ‘-screen’);
if (show) show.style.display = ‘block’;
if (screen === ‘chat’) showInputBar();
else hideInputBar();
}

// –– TOGGLE PASSWORD VISIBILITY ––
function toggleVisible(inputId, btn) {
var input = document.getElementById(inputId);
if (!input) return;
if (input.type === ‘password’) { input.type = ‘text’; btn.textContent = ‘🙈’; }
else { input.type = ‘password’; btn.textContent = ‘👁’; }
}

// –– START OVER ––
function startOver() {
clearSavedUser();
currentUser = null; currentGroup = null; currentGroupName = null;
showCGScreen(‘select’);
}

// –– SELECT GROUP ––
function selectGroup(groupId, groupName) {
currentGroup = groupId;
currentGroupName = groupName;
var saved = getSavedUser();
if (saved && saved.group === groupId) {
currentUser = saved;
checkApprovalAndEnter();
return;
}
document.getElementById(‘cg-login-title’).textContent = groupName;
document.getElementById(‘cg-room-password’).value = ‘’;
document.getElementById(‘cg-user-name’).value = ‘’;
document.getElementById(‘cg-user-pin’).value = ‘’;
document.getElementById(‘cg-login-error’).textContent = ‘’;
showCGScreen(‘login’);
}

// –– SUBMIT LOGIN ––
function submitLogin() {
var roomPass = document.getElementById(‘cg-room-password’).value.trim();
var userName = document.getElementById(‘cg-user-name’).value.trim();
var userPin = document.getElementById(‘cg-user-pin’).value.trim();
var errEl = document.getElementById(‘cg-login-error’);
errEl.textContent = ‘’;

if (!roomPass || !userName || !userPin) { errEl.textContent = ‘Please fill in all fields.’; return; }
if (userPin.length < 4) { errEl.textContent = ‘Password must be at least 4 characters.’; return; }

var authUser = auth.currentUser;
if (!authUser) {
errEl.textContent = ‘Connecting… please wait a moment and try again.’;
auth.signInAnonymously().then(function(result) {
currentUID = result.user.uid;
errEl.textContent = ‘Ready! Please tap Log In again.’;
}).catch(function(err) { errEl.textContent = ’Auth error: ’ + err.message; });
return;
}

currentUID = authUser.uid;

db.collection(‘config’).doc(‘rooms’).get().then(function(snap) {
if (!snap.exists) { errEl.textContent = ‘Configuration error. Contact your admin.’; return; }
var config = snap.data();
var roomSalt = config[currentGroup + ‘_salt’];
var roomHash = config[currentGroup + ‘_hash’];
var adminSalt = config[‘adminPin_salt’];
var adminHash = config[‘adminPin_hash’];

```
hashInput(roomPass, roomSalt).then(function(enteredRoomHash) {
  if (enteredRoomHash !== roomHash) { errEl.textContent = 'Incorrect room password. Check with your group leader.'; return; }
  hashInput(userPin, adminSalt).then(function(enteredAdminHash) {
    var isAdmin = (enteredAdminHash === adminHash);
    var memberRef = db.collection('groups').doc(currentGroup).collection('members').doc(currentUID);

    memberRef.get().then(function(memberSnap) {
      if (memberSnap.exists) {
        var privateRef = db.collection('groups').doc(currentGroup).collection('privateMembers').doc(currentUID);
        privateRef.get().then(function(privateSnap) {
          if (!privateSnap.exists) { errEl.textContent = 'Account error. Please use Start Over.'; return; }
          var pinData = privateSnap.data();
          hashInput(userPin, pinData.pinSalt).then(function(enteredPinHash) {
            if (enteredPinHash !== pinData.pinHash) { errEl.textContent = 'Incorrect password. Try again.'; return; }
            if (isAdmin && !memberSnap.data().approved) memberRef.update({ approved: true });
            currentUser = { group: currentGroup, groupName: currentGroupName, name: memberSnap.data().name, uid: currentUID, isAdmin: isAdmin };
            saveUser(currentUser);
            startUnreadWatcher(currentGroup, memberSnap.data().name);
            if (memberSnap.data().approved || isAdmin) { enterChat(); }
            else { document.getElementById('cg-pending-title').textContent = currentGroupName; showCGScreen('pending'); }
          });
        });
      } else {
        var pinSalt = generateSalt();
        hashInput(userPin, pinSalt).then(function(pinHash) {
          memberRef.set({ name: userName, approved: isAdmin, joinedAt: Date.now() }).then(function() {
            return db.collection('groups').doc(currentGroup).collection('privateMembers').doc(currentUID)
                      .set({ pinHash: pinHash, pinSalt: pinSalt });
          }).then(function() {
            currentUser = { group: currentGroup, groupName: currentGroupName, name: userName, uid: currentUID, isAdmin: isAdmin };
            saveUser(currentUser);
            startUnreadWatcher(currentGroup, userName);
            if (isAdmin) { enterChat(); }
            else { document.getElementById('cg-pending-title').textContent = currentGroupName; showCGScreen('pending'); }
          }).catch(function(err) { errEl.textContent = 'Save error: ' + err.message; });
        });
      }
    }).catch(function(err) { errEl.textContent = 'Database error: ' + err.message; });
  });
});
```

}).catch(function(err) { errEl.textContent = ’Config error: ’ + err.message; });
}

function generateSalt() {
var chars = ‘ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789’;
var salt = ‘’;
for (var i = 0; i < 8; i++) salt += chars[Math.floor(Math.random() * chars.length)];
return salt;
}

// –– CHECK APPROVAL ––
function checkApproval() {
if (!currentUser) return;
var uid = currentUser.uid || currentUID;
db.collection(‘groups’).doc(currentGroup).collection(‘members’).doc(uid).get().then(function(snap) {
if (snap.exists && snap.data().approved) { enterChat(); }
else { alert(‘Not approved yet. Please wait for your group leader to approve you.’); }
});
}

function checkApprovalAndEnter() {
if (!currentUser) return;
var uid = currentUser.uid || currentUID;
db.collection(‘groups’).doc(currentGroup).collection(‘members’).doc(uid).get().then(function(snap) {
if (snap.exists && snap.data().approved) { enterChat(); }
else if (snap.exists) { document.getElementById(‘cg-pending-title’).textContent = currentGroupName; showCGScreen(‘pending’); }
else { clearSavedUser(); showCGScreen(‘select’); }
}).catch(function() { clearSavedUser(); showCGScreen(‘select’); });
}

// –– ENTER CHAT ––
function enterChat() {
document.getElementById(‘cg-chat-title’).textContent = currentGroupName;
var membersBtn = document.getElementById(‘cg-members-btn’);
if (membersBtn) membersBtn.style.display = ‘block’;
showCGScreen(‘chat’);
loadMessages();
// Mark as read here — badge will clear after messages render
markAsRead();
}

// –– IS IN CHAT ––
function isInChat() {
var chatScreen = document.getElementById(‘cg-chat-screen’);
var carePage = document.getElementById(‘page-care’);
return chatScreen &&
chatScreen.style.display !== ‘none’ &&
carePage &&
carePage.classList.contains(‘active’);
}

// –– UNREAD WATCHER — fixed logic ––
function startUnreadWatcher(groupId, userName) {
if (unreadListener) { unreadListener(); unreadListener = null; }

var initialized = false;
var lastCount = 0;

unreadListener = db.collection(‘groups’).doc(groupId)
.collection(‘messages’)
.orderBy(‘timestamp’, ‘asc’)
.onSnapshot(function(snapshot) {
var lastSeen = lastSeenTimestamps[groupId] || 0;
var total = snapshot.size;

```
  // Count unread from others
  var newUnread = 0;
  snapshot.forEach(function(d) {
    var msg = d.data();
    if (msg.author !== userName && msg.timestamp && msg.timestamp.toMillis() > lastSeen) {
      newUnread++;
    }
  });

  if (!initialized) {
    initialized = true;
    lastCount = total;
    // Show existing unread on startup only if not in chat
    if (!isInChat()) setUnreadCount(groupId, newUnread);
    return;
  }

  // FIX: capture BEFORE updating lastCount
  var hasNewMessage = total > lastCount;
  lastCount = total;

  if (hasNewMessage) {
    // Sound plays always — inside or outside chat
    if (newUnread > 0) playNotificationSound();

    // Badge: only update if outside chat
    if (!isInChat()) {
      setUnreadCount(groupId, newUnread);
    }
    // If in chat, messages are being seen — mark read
    if (isInChat()) {
      markAsRead();
      setUnreadCount(groupId, 0);
    }
  }
}, function(err) {
  console.log('Watcher error:', err.message);
});
```

}

// –– REPLY ––
function setReply(messageId, authorName) {
replyingTo = { id: messageId, author: authorName };
var bar = document.getElementById(‘cg-reply-bar’);
var label = document.getElementById(‘cg-reply-label’);
if (bar) bar.style.display = ‘flex’;
if (label) label.textContent = ’Replying to ’ + authorName;
document.getElementById(‘cg-msg-input’).focus();
}

function clearReply() {
replyingTo = null;
var bar = document.getElementById(‘cg-reply-bar’);
if (bar) bar.style.display = ‘none’;
}

// –– LONG PRESS MENU ––
function showMessageMenu(msgId, isMe) {
// Remove any existing menu
var existing = document.getElementById(‘msg-menu’);
if (existing) existing.remove();

var menu = document.createElement(‘div’);
menu.id = ‘msg-menu’;
menu.className = ‘msg-menu’;

if (isMe || currentUser.isAdmin) {
if (isMe) {
var editBtn = document.createElement(‘button’);
editBtn.className = ‘msg-menu-btn’;
editBtn.textContent = ‘✏️ Edit’;
editBtn.addEventListener(‘click’, function() {
menu.remove();
editMessage(msgId);
});
menu.appendChild(editBtn);
}

```
var deleteBtn = document.createElement('button');
deleteBtn.className = 'msg-menu-btn msg-menu-delete';
deleteBtn.textContent = '🗑️ Delete';
deleteBtn.addEventListener('click', function() {
  menu.remove();
  if (confirm('Delete this message?')) {
    db.collection('groups').doc(currentGroup).collection('messages').doc(msgId).delete();
  }
});
menu.appendChild(deleteBtn);
```

}

var cancelBtn = document.createElement(‘button’);
cancelBtn.className = ‘msg-menu-btn msg-menu-cancel’;
cancelBtn.textContent = ‘Cancel’;
cancelBtn.addEventListener(‘click’, function() { menu.remove(); });
menu.appendChild(cancelBtn);

document.body.appendChild(menu);

// Dismiss on outside tap
setTimeout(function() {
document.addEventListener(‘click’, function dismiss() {
menu.remove();
document.removeEventListener(‘click’, dismiss);
});
}, 100);
}

// –– EDIT MESSAGE ––
function editMessage(msgId) {
var msgRef = db.collection(‘groups’).doc(currentGroup).collection(‘messages’).doc(msgId);
msgRef.get().then(function(snap) {
if (!snap.exists) return;
var current = snap.data().text;
var newText = prompt(‘Edit your message:’, current);
if (newText !== null && newText.trim() !== ‘’ && newText.trim() !== current) {
msgRef.update({ text: newText.trim(), edited: true });
}
});
}

// –– ATTACH LONG PRESS TO WRAPPER ––
function attachLongPress(wrapper, msgId, isMe) {
wrapper.addEventListener(‘touchstart’, function(e) {
if (!isMe && !currentUser.isAdmin) return;
longPressTimer = setTimeout(function() {
e.preventDefault();
showMessageMenu(msgId, isMe);
}, 600);
});
wrapper.addEventListener(‘touchend’, function() { clearTimeout(longPressTimer); });
wrapper.addEventListener(‘touchmove’, function() { clearTimeout(longPressTimer); });
}

// –– YOUTUBE ID EXTRACTOR ––
function extractYouTubeId(url) {
var patterns = [
/youtube.com/watch?.*v=([a-zA-Z0-9_-]{11})/,
/youtu.be/([a-zA-Z0-9_-]{11})/,
/youtube.com/shorts/([a-zA-Z0-9_-]{11})/,
/youtube.com/embed/([a-zA-Z0-9_-]{11})/,
/youtube.com/live/([a-zA-Z0-9_-]{11})/
];
for (var i = 0; i < patterns.length; i++) {
var match = url.match(patterns[i]);
if (match) return match[1];
}
return null;
}

// –– RICH MEDIA RENDERER ––
function renderMessageContent(text, container) {
var urlRegex = /(https?://[^\s]+)/g;
var parts = text.split(urlRegex);

parts.forEach(function(part) {
if (!part) return;

```
if (part.match(/^https?:\/\//)) {
  var url = part;

  // YouTube — always show thumbnail, also try iframe
  var ytId = extractYouTubeId(url);
  if (ytId) {
    var ytWrap = document.createElement('div');
    ytWrap.className = 'msg-yt-wrap';

    // Always render clickable thumbnail as primary
    var thumb = document.createElement('img');
    thumb.src = 'https://img.youtube.com/vi/' + ytId + '/hqdefault.jpg';
    thumb.className = 'msg-image msg-yt-thumb';
    thumb.setAttribute('loading', 'lazy');

    // Tapping thumbnail opens YouTube
    thumb.addEventListener('click', function() { window.open(url, '_blank'); });

    // Play button overlay
    var playOverlay = document.createElement('div');
    playOverlay.className = 'msg-yt-play';
    playOverlay.textContent = '▶';
    playOverlay.addEventListener('click', function() { window.open(url, '_blank'); });

    ytWrap.appendChild(thumb);
    ytWrap.appendChild(playOverlay);
    container.appendChild(ytWrap);
    return;
  }

  // Image
  if (url.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i)) {
    var img = document.createElement('img');
    img.src = url;
    img.className = 'msg-image';
    img.setAttribute('loading', 'lazy');
    img.addEventListener('click', function() { window.open(url, '_blank'); });
    container.appendChild(img);
    return;
  }

  // Video
  if (url.match(/\.(mp4|webm|ogg)(\?.*)?$/i)) {
    var video = document.createElement('video');
    video.src = url;
    video.className = 'msg-video';
    video.controls = true;
    video.setAttribute('playsinline', '');
    container.appendChild(video);
    return;
  }

  // Generic link
  var link = document.createElement('a');
  link.href = url;
  link.textContent = url;
  link.target = '_blank';
  link.className = 'msg-link';
  container.appendChild(link);

} else {
  if (part.trim() || part.includes('\n')) {
    var span = document.createElement('span');
    span.textContent = part;
    container.appendChild(span);
  }
}
```

});
}

// –– LOAD MESSAGES ––
function loadMessages() {
if (messageListener) messageListener();
var messagesEl = document.getElementById(‘cg-messages’);
messagesEl.innerHTML = ‘<div class="cg-loading">Loading messages…</div>’;

messageListener = db.collection(‘groups’).doc(currentGroup)
.collection(‘messages’).orderBy(‘timestamp’, ‘asc’)
.onSnapshot(function(snapshot) {
messagesEl.innerHTML = ‘’;
if (snapshot.empty) {
messagesEl.innerHTML = ‘<div class="cg-no-msgs">No messages yet. Say hello! 👋</div>’;
return;
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
// Mark as read after messages render
markAsRead();
setUnreadCount(currentGroup, 0);
});
}

// –– RENDER THREAD ––
function renderThread(msg, replies, container, showDivider) {
var thread = document.createElement(‘div’);
thread.className = ‘cg-thread’;
renderPrimaryMessage(msg, thread);
var commentBar = document.createElement(‘div’);
commentBar.className = ‘cg-comment-bar’;
var replyBtn = document.createElement(‘button’);
replyBtn.className = ‘cg-comment-btn’;
replyBtn.textContent = replies.length > 0 ? ‘💬 ’ + replies.length + (replies.length === 1 ? ’ Comment’ : ’ Comments’) : ‘💬 Reply’;
replyBtn.addEventListener(‘click’, (function(id, author) {
return function() { setReply(id, author); };
})(msg._id, msg.author));
commentBar.appendChild(replyBtn);
thread.appendChild(commentBar);
if (replies.length > 0) {
var repliesContainer = document.createElement(‘div’);
repliesContainer.className = ‘cg-replies-container’;
replies.forEach(function(reply) { renderReplyMessage(reply, repliesContainer); });
thread.appendChild(repliesContainer);
}
if (showDivider) {
var divider = document.createElement(‘div’);
divider.className = ‘cg-thread-divider’;
thread.appendChild(divider);
}
container.appendChild(thread);
}

// –– RENDER PRIMARY MESSAGE ––
function renderPrimaryMessage(msg, container) {
var isMe = msg.author === currentUser.name;
var color = getBubbleColor(msg.author);
var time = msg.timestamp ? new Date(msg.timestamp.toMillis()).toLocaleTimeString([], {hour:‘2-digit’,minute:‘2-digit’}) : ‘’;

var row = document.createElement(‘div’);
row.className = ‘cg-primary-row’;

var avatar = document.createElement(‘div’);
avatar.className = ‘cg-avatar’;
avatar.textContent = msg.author.charAt(0).toUpperCase();
avatar.style.background = color;
row.appendChild(avatar);

var content = document.createElement(‘div’);
content.className = ‘cg-primary-content’;

var header = document.createElement(‘div’);
header.className = ‘cg-primary-header’;
var nameSpan = document.createElement(‘span’);
nameSpan.className = ‘cg-primary-name’;
nameSpan.textContent = msg.author;
nameSpan.style.color = color;
var timeSpan = document.createElement(‘span’);
timeSpan.className = ‘cg-primary-time’;
timeSpan.textContent = time;
header.appendChild(nameSpan);
header.appendChild(timeSpan);
content.appendChild(header);

// Message wrapper — long press attaches here
var wrapper = document.createElement(‘div’);
wrapper.className = ‘msg-wrapper’;
renderMessageContent(msg.text, wrapper);

if (msg.edited) {
var editedTag = document.createElement(‘span’);
editedTag.className = ‘msg-edited’;
editedTag.textContent = ’ (edited)’;
wrapper.appendChild(editedTag);
}

// Attach long press to wrapper (works for all content types including iframes)
attachLongPress(wrapper, msg._id, isMe);

content.appendChild(wrapper);
row.appendChild(content);
container.appendChild(row);
}

// –– RENDER REPLY MESSAGE ––
function renderReplyMessage(msg, container) {
var isMe = msg.author === currentUser.name;
var color = getBubbleColor(msg.author);
var time = msg.timestamp ? new Date(msg.timestamp.toMillis()).toLocaleTimeString([], {hour:‘2-digit’,minute:‘2-digit’}) : ‘’;

var row = document.createElement(‘div’);
row.className = ‘cg-reply-row’;

var avatar = document.createElement(‘div’);
avatar.className = ‘cg-avatar cg-avatar-sm’;
avatar.textContent = msg.author.charAt(0).toUpperCase();
avatar.style.background = color;
row.appendChild(avatar);

var content = document.createElement(‘div’);
content.className = ‘cg-reply-content’;

var header = document.createElement(‘div’);
header.className = ‘cg-primary-header’;
var nameSpan = document.createElement(‘span’);
nameSpan.className = ‘cg-primary-name’;
nameSpan.textContent = msg.author;
nameSpan.style.color = color;
var timeSpan = document.createElement(‘span’);
timeSpan.className = ‘cg-primary-time’;
timeSpan.textContent = time;
header.appendChild(nameSpan);
header.appendChild(timeSpan);
content.appendChild(header);

var wrapper = document.createElement(‘div’);
wrapper.className = ‘msg-wrapper’;
renderMessageContent(msg.text, wrapper);

if (msg.edited) {
var editedTag = document.createElement(‘span’);
editedTag.className = ‘msg-edited’;
editedTag.textContent = ’ (edited)’;
wrapper.appendChild(editedTag);
}

attachLongPress(wrapper, msg._id, isMe);

content.appendChild(wrapper);
row.appendChild(content);
container.appendChild(row);
}

// –– SEND MESSAGE ––
function sendMessage() {
var input = document.getElementById(‘cg-msg-input’);
var text = input.value.trim();
if (!text || !db) return;
input.value = ‘’;
var msgData = { text: text, author: currentUser.name, timestamp: firebase.firestore.FieldValue.serverTimestamp() };
if (replyingTo) { msgData.replyTo = replyingTo.id; msgData.replyToAuthor = replyingTo.author; clearReply(); }
db.collection(‘groups’).doc(currentGroup).collection(‘messages’).add(msgData);
}

// –– LEAVE CHAT ––
function leaveChat() {
if (messageListener) { messageListener(); messageListener = null; }
clearSavedUser();
clearReply();
currentUser = null; currentGroup = null; currentGroupName = null;
hideInputBar();
showCGScreen(‘select’);
}

// –– MARK AS READ ––
function markAsRead() {
if (!currentGroup) return;
lastSeenTimestamps[currentGroup] = Date.now();
localStorage.setItem(‘mhbc_lastseen’, JSON.stringify(lastSeenTimestamps));
}

// –– MEMBERS PANEL ––
function showMembersPanel() {
showCGScreen(‘members’);
loadMembersList();
}

function loadMembersList() {
var listEl = document.getElementById(‘members-list’);
if (!listEl) return;
listEl.innerHTML = ‘<div class="cg-loading">Loading…</div>’;

db.collection(‘groups’).doc(currentGroup).collection(‘members’).get().then(function(snap) {
listEl.innerHTML = ‘’;
if (snap.empty) { listEl.innerHTML = ‘<div class="cg-empty-note">No members yet</div>’; return; }

```
var approved = [], pending = [];
snap.forEach(function(d) { var data = d.data(); data._id = d.id; if (data.approved) approved.push(data); else pending.push(data); });

// Pending — admin only
if (currentUser.isAdmin && pending.length > 0) {
  var pendingLabel = document.createElement('div');
  pendingLabel.className = 'section-label';
  pendingLabel.textContent = 'PENDING REQUESTS';
  listEl.appendChild(pendingLabel);
  var pendingList = document.createElement('div');
  pendingList.className = 'cg-member-list';
  pending.forEach(function(m) {
    var div = document.createElement('div'); div.className = 'cg-member-row';
    var nameSpan = document.createElement('span'); nameSpan.className = 'cg-member-name'; nameSpan.textContent = m.name;
    var approveBtn = document.createElement('button'); approveBtn.className = 'cg-approve-btn'; approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', (function(id) { return function() { approveMember(id); }; })(m._id));
    var denyBtn = document.createElement('button'); denyBtn.className = 'cg-deny-btn'; denyBtn.textContent = 'Deny';
    denyBtn.addEventListener('click', (function(id) { return function() { denyMember(id); }; })(m._id));
    div.appendChild(nameSpan); div.appendChild(approveBtn); div.appendChild(denyBtn);
    pendingList.appendChild(div);
  });
  listEl.appendChild(pendingList);
}

// Approved members — visible to everyone
var approvedLabel = document.createElement('div');
approvedLabel.className = 'section-label';
approvedLabel.textContent = 'MEMBERS';
listEl.appendChild(approvedLabel);

var approvedList = document.createElement('div');
approvedList.className = 'cg-member-list';

if (approved.length === 0) {
  approvedList.innerHTML = '<div class="cg-empty-note">No approved members yet</div>';
} else {
  approved.forEach(function(m) {
    var div = document.createElement('div'); div.className = 'cg-member-row';
    var nameSpan = document.createElement('span'); nameSpan.className = 'cg-member-name'; nameSpan.textContent = m.name;
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
```

});
}

function approveMember(memberId) {
db.collection(‘groups’).doc(currentGroup).collection(‘members’).doc(memberId)
.update({ approved: true }).then(loadMembersList);
}
function denyMember(memberId) {
db.collection(‘groups’).doc(currentGroup).collection(‘members’).doc(memberId).delete().then(function() {
db.collection(‘groups’).doc(currentGroup).collection(‘privateMembers’).doc(memberId).delete();
loadMembersList();
});
}
function removeMember(memberId) {
if (confirm(‘Remove this member from the group?’)) {
db.collection(‘groups’).doc(currentGroup).collection(‘members’).doc(memberId).delete().then(function() {
db.collection(‘groups’).doc(currentGroup).collection(‘privateMembers’).doc(memberId).delete();
loadMembersList();
});
}
}

// –– LOCAL STORAGE ––
function saveUser(user) { localStorage.setItem(‘mhbc_cg_user’, JSON.stringify(user)); }
function getSavedUser() { var raw = localStorage.getItem(‘mhbc_cg_user’); if (!raw) return null; try { return JSON.parse(raw); } catch(e) { return null; } }
function clearSavedUser() { localStorage.removeItem(‘mhbc_cg_user’); }

// –– BIBLE PICKER ––
var chaptersMap = {
GEN:50,EXO:40,LEV:27,NUM:36,DEU:34,JOS:24,JDG:21,RUT:4,
‘1SA’:31,‘2SA’:24,‘1KI’:22,‘2KI’:25,‘1CH’:29,‘2CH’:36,EZR:10,
NEH:13,EST:10,JOB:42,PSA:150,PRO:31,ECC:12,SNG:8,ISA:66,
JER:52,LAM:5,EZK:48,DAN:12,HOS:14,JOL:3,AMO:9,OBA:1,
JON:4,MIC:7,NAM:3,HAB:3,ZEP:3,HAG:2,ZEC:14,MAL:4,
MAT:28,MRK:16,LUK:24,JHN:21,ACT:28,ROM:16,‘1CO’:16,
‘2CO’:13,GAL:6,EPH:6,PHP:4,COL:4,‘1TH’:5,‘2TH’:3,
‘1TI’:6,‘2TI’:4,TIT:3,PHM:1,HEB:13,JAS:5,‘1PE’:5,
‘2PE’:3,‘1JN’:5,‘2JN’:1,‘3JN’:1,JUD:1,REV:22
};
var currentTrans = ‘111’;
var currentCode = ‘NIV’;

function populateChapters(book, selected) {
var sel = document.getElementById(‘bibleChapter’);
if (!sel) return;
var count = chaptersMap[book] || 1;
sel.innerHTML = ‘’;
for (var i = 1; i <= count; i++) {
var opt = document.createElement(‘option’);
opt.value = i; opt.textContent = ’Chapter ’ + i;
if (i === (selected || 1)) opt.selected = true;
sel.appendChild(opt);
}
}

function openBible() {
var book = document.getElementById(‘bibleBook’).value;
var chapter = document.getElementById(‘bibleChapter’).value;
window.open(‘https://www.bible.com/bible/’ + currentTrans + ‘/’ + book + ‘.’ + chapter + ‘.’ + currentCode, ‘_blank’);
}

function tryGenerateQR() {
var qrEl = document.getElementById(‘appQR’);
if (!qrEl) return;
if (typeof QRCode !== ‘undefined’) {
new QRCode(qrEl, { text: ‘https://qnxyt9x67g-max.github.io/MHBC/’, width: 90, height: 90, colorDark: ‘#0a1628’, colorLight: ‘#ffffff’, correctLevel: QRCode.CorrectLevel.H });
} else { setTimeout(tryGenerateQR, 500); }
}

// –– LIVE BADGE ––
function checkLiveBadge() {
var now = new Date();
var utc = now.getTime() + (now.getTimezoneOffset() * 60000);
var est = new Date(utc + (-5 * 3600000));
var day = est.getDay();
var totalMins = est.getHours() * 60 + est.getMinutes();
var badge = document.getElementById(‘liveBadge’);
if (badge) badge.style.display = ((day === 0 && totalMins >= 570 && totalMins <= 660) || (day === 3 && totalMins >= 1140 && totalMins <= 1200)) ? ‘flex’ : ‘none’;
}

// –– INIT ––
window.onload = function() {
initFirebase();

var ls = localStorage.getItem(‘mhbc_lastseen’);
if (ls) { try { lastSeenTimestamps = JSON.parse(ls); } catch(e) {} }

populateChapters(‘JHN’, 1);
var bookSel = document.getElementById(‘bibleBook’);
if (bookSel) bookSel.addEventListener(‘change’, function() { populateChapters(this.value, 1); });

document.querySelectorAll(’.pill’).forEach(function(pill) {
pill.addEventListener(‘click’, function() {
document.querySelectorAll(’.pill’).forEach(function(p) { p.classList.remove(‘active’); });
this.classList.add(‘active’);
currentTrans = this.getAttribute(‘data-trans’);
currentCode = this.getAttribute(‘data-code’);
});
});

var bibleBtn = document.getElementById(‘openBibleBtn’);
if (bibleBtn) bibleBtn.addEventListener(‘click’, openBible);

document.querySelectorAll(’.nav-btn’).forEach(function(btn) {
btn.addEventListener(‘click’, function() {
unlockAudio();
var page = this.getAttribute(‘data-page’);
if (page) showPage(page);
});
});

document.querySelectorAll(’.quick-btn’).forEach(function(btn) {
btn.addEventListener(‘click’, function() {
unlockAudio();
var action = this.getAttribute(‘data-action’);
var url = this.getAttribute(‘data-url’);
if (action) showPage(action);
else if (url) window.open(url, ‘_blank’);
});
});

document.querySelectorAll(’.cg-group-btn’).forEach(function(btn) {
btn.addEventListener(‘click’, function() {
unlockAudio();
var groupId = this.getAttribute(‘data-group’);
var groupName = this.getAttribute(‘data-name’);
if (groupId && groupName) selectGroup(groupId, groupName);
});
});

var loginBtn = document.getElementById(‘cg-login-submit’);
if (loginBtn) loginBtn.addEventListener(‘click’, function() { unlockAudio(); submitLogin(); });

var checkBtn = document.getElementById(‘cg-check-btn’);
if (checkBtn) checkBtn.addEventListener(‘click’, checkApproval);

var startOverBtn = document.getElementById(‘cg-start-over-btn’);
if (startOverBtn) startOverBtn.addEventListener(‘click’, startOver);

var backToSelect = document.getElementById(‘cg-back-to-select’);
if (backToSelect) backToSelect.addEventListener(‘click’, function() { showCGScreen(‘select’); });

var backToSelectFromPending = document.getElementById(‘cg-back-to-select-pending’);
if (backToSelectFromPending) backToSelectFromPending.addEventListener(‘click’, function() { showCGScreen(‘select’); });

var backToChatFromMembers = document.getElementById(‘cg-back-to-chat-members’);
if (backToChatFromMembers) backToChatFromMembers.addEventListener(‘click’, function() { showCGScreen(‘chat’); });

var leaveChatBtn = document.getElementById(‘cg-leave-chat’);
if (leaveChatBtn) leaveChatBtn.addEventListener(‘click’, leaveChat);

var membersBtn = document.getElementById(‘cg-members-btn’);
if (membersBtn) membersBtn.addEventListener(‘click’, showMembersPanel);

var sendBtn = document.getElementById(‘cg-send-btn’);
if (sendBtn) sendBtn.addEventListener(‘click’, function() { unlockAudio(); sendMessage(); });

var replyCancel = document.getElementById(‘cg-reply-cancel’);
if (replyCancel) replyCancel.addEventListener(‘click’, clearReply);

var eyeRoom = document.getElementById(‘cg-eye-room’);
if (eyeRoom) eyeRoom.addEventListener(‘click’, function() { toggleVisible(‘cg-room-password’, this); });

var eyePin = document.getElementById(‘cg-eye-pin’);
if (eyePin) eyePin.addEventListener(‘click’, function() { toggleVisible(‘cg-user-pin’, this); });

var msgInput = document.getElementById(‘cg-msg-input’);
if (msgInput) msgInput.addEventListener(‘keydown’, function(e) { if (e.key === ‘Enter’) sendMessage(); });

var locationCard = document.getElementById(‘location-card’);
if (locationCard) locationCard.addEventListener(‘click’, function() {
window.open(‘https://www.google.com/maps/search/?api=1&query=301+Teel+Road+Beckley+WV+25801’, ‘_blank’);
});

var ytLaunch = document.getElementById(‘yt-launch’);
if (ytLaunch) ytLaunch.addEventListener(‘click’, function() {
window.open(‘https://www.youtube.com/@maxwellhillbaptistchurch9695’, ‘_blank’);
});

var liveBadge = document.getElementById(‘liveBadge’);
if (liveBadge) liveBadge.addEventListener(‘click’, function() { showPage(‘watch’); });

checkLiveBadge();
setInterval(checkLiveBadge, 60000);
tryGenerateQR();

// –– AUTH ––
auth.onAuthStateChanged(function(user) {
if (user) {
currentUID = user.uid;
var savedUser = getSavedUser();
if (savedUser && savedUser.group && savedUser.name) {
currentGroup = savedUser.group;
startUnreadWatcher(savedUser.group, savedUser.name);
}
} else {
auth.signInAnonymously().catch(function(err) {
console.error(‘Sign in failed:’, err.code, err.message);
});
}
});
};
