// ============================================================
// MHBC APP — app.js v2
// ============================================================

function showPage(id) {
  // Hide all pages
  var pages = document.querySelectorAll('.page');
  for (var i = 0; i < pages.length; i++) {
    pages[i].classList.remove('active');
  }

  // Deactivate all nav buttons
  var btns = document.querySelectorAll('.nav-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.remove('active');
  }

  // Show the selected page
  var target = document.getElementById('page-' + id);
  if (target) {
    target.classList.add('active');
    window.scrollTo(0, 0);
  }

  // Activate the matching nav button
  var activeBtn = document.querySelector('.nav-btn[data-page="' + id + '"]');
  if (activeBtn) {
    activeBtn.classList.add('active');
  }
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

window.onload = function() {

  // Init Bible chapter dropdown
  populateChapters('JHN', 1);

  // Book change
  var bookSel = document.getElementById('bibleBook');
  if (bookSel) {
    bookSel.addEventListener('change', function() {
      populateChapters(this.value, 1);
    });
  }

  // Translation pills
  var pills = document.querySelectorAll('.pill');
  for (var i = 0; i < pills.length; i++) {
    pills[i].addEventListener('click', function() {
      var allPills = document.querySelectorAll('.pill');
      for (var j = 0; j < allPills.length; j++) {
        allPills[j].classList.remove('active');
      }
      this.classList.add('active');
      currentTrans = this.getAttribute('data-trans');
      currentCode = this.getAttribute('data-code');
    });
  }

  // Open Bible button
  var bibleBtn = document.getElementById('openBibleBtn');
  if (bibleBtn) {
    bibleBtn.addEventListener('click', openBible);
  }

  // Show LIVE badge on Sundays and Wednesdays
  var day = new Date().getDay();
  if (day === 0 || day === 3) {
    var badge = document.getElementById('liveBadge');
    if (badge) badge.style.display = 'flex';
  }

};
