// ============================================================
// MHBC APP — app.js
// ============================================================

// –– PAGE NAVIGATION ––
function showPage(id) {
document.querySelectorAll(’.page’).forEach(p => p.classList.remove(‘active’));
document.querySelectorAll(’.nav-btn’).forEach(b => b.classList.remove(‘active’));

const page = document.getElementById(‘page-’ + id);
if (page) page.classList.add(‘active’);

const btn = document.querySelector(’.nav-btn[data-page=”’ + id + ‘”]’);
if (btn) btn.classList.add(‘active’);

// Scroll to top of newly shown page
if (page) page.scrollTop = 0;
}

// –– EXTERNAL LINKS ––
function openExternal(url) {
window.open(url, ‘_blank’);
}

// –– BIBLE PICKER ––
const chaptersMap = {
GEN: 50, EXO: 40, LEV: 27, NUM: 36, DEU: 34, JOS: 24, JDG: 21, RUT: 4,
‘1SA’: 31, ‘2SA’: 24, ‘1KI’: 22, ‘2KI’: 25, ‘1CH’: 29, ‘2CH’: 36, EZR: 10,
NEH: 13, EST: 10, JOB: 42, PSA: 150, PRO: 31, ECC: 12, SNG: 8, ISA: 66,
JER: 52, LAM: 5, EZK: 48, DAN: 12, HOS: 14, JOL: 3, AMO: 9, OBA: 1,
JON: 4, MIC: 7, NAM: 3, HAB: 3, ZEP: 3, HAG: 2, ZEC: 14, MAL: 4,
MAT: 28, MRK: 16, LUK: 24, JHN: 21, ACT: 28, ROM: 16, ‘1CO’: 16,
‘2CO’: 13, GAL: 6, EPH: 6, PHP: 4, COL: 4, ‘1TH’: 5, ‘2TH’: 3,
‘1TI’: 6, ‘2TI’: 4, TIT: 3, PHM: 1, HEB: 13, JAS: 5, ‘1PE’: 5,
‘2PE’: 3, ‘1JN’: 5, ‘2JN’: 1, ‘3JN’: 1, JUD: 1, REV: 22
};

let currentTrans = ‘111’;
let currentCode = ‘NIV’;

function populateChapters(book, selectedChapter = 1) {
const sel = document.getElementById(‘bibleChapter’);
const count = chaptersMap[book] || 1;
sel.innerHTML = ‘’;
for (let i = 1; i <= count; i++) {
const opt = document.createElement(‘option’);
opt.value = i;
opt.textContent = ’Chapter ’ + i;
if (i === selectedChapter) opt.selected = true;
sel.appendChild(opt);
}
}

function updateBibleFrame() {
const book = document.getElementById(‘bibleBook’).value;
const chapter = document.getElementById(‘bibleChapter’).value;
const url = `https://www.bible.com/bible/${currentTrans}/${book}.${chapter}.${currentCode}`;
document.getElementById(‘bibleFrame’).src = url;
}

function openBible() {
const book = document.getElementById(‘bibleBook’).value;
const chapter = document.getElementById(‘bibleChapter’).value;
const url = `https://www.bible.com/bible/${currentTrans}/${book}.${chapter}.${currentCode}`;
window.open(url, ‘_blank’);
}

document.addEventListener(‘DOMContentLoaded’, () => {

// Init chapter dropdown
populateChapters(‘JHN’, 1);

// Book change → reset chapters
document.getElementById(‘bibleBook’).addEventListener(‘change’, function () {
populateChapters(this.value, 1);
updateBibleFrame();
});

// Chapter change
document.getElementById(‘bibleChapter’).addEventListener(‘change’, function () {
updateBibleFrame();
});

// Translation pills
document.querySelectorAll(’.pill’).forEach(pill => {
pill.addEventListener(‘click’, function () {
document.querySelectorAll(’.pill’).forEach(p => p.classList.remove(‘active’));
this.classList.add(‘active’);
currentTrans = this.dataset.trans;
currentCode = this.dataset.code;
updateBibleFrame();
});
});

// Open Bible button
document.getElementById(‘openBibleBtn’).addEventListener(‘click’, openBible);

// Check if it’s Sunday or Wednesday (show “Join Us Today” nudge)
const day = new Date().getDay(); // 0=Sun, 3=Wed
if (day === 0 || day === 3) {
const badge = document.getElementById(‘liveBadge’);
if (badge) {
badge.style.display = ‘flex’;
}
}

});

// –– SERVICE WORKER REGISTRATION ––
if (‘serviceWorker’ in navigator) {
window.addEventListener(‘load’, () => {
navigator.serviceWorker.register(’./sw.js’).catch(() => {
// Service worker optional — app works without it
});
});
}
