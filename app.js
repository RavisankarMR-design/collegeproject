// ID Barcode Roll Call — continuous scan-list-export tool.
// Standalone, offline-first: no server, no network calls. Everything (the
// scanned list, the Excel file) is produced entirely in this browser tab.

const READER_ID = 'reader';
const DUPLICATE_COOLDOWN_MS = 1500; // ignore the same code re-firing while still in frame
const STORAGE_KEY = 'rollcall_state_v1';
const ROSTER_KEY = 'rollcall_roster_v1';
// Roll numbers are always "240" + 6 digits (e.g. 240701424) — the prefix is
// fixed, the 6 digits vary per department/year/student. Only enforced on
// manual/edited entries: a real scanned barcode is trusted as-is, since
// forcing this pattern on it could reject a genuine card over a benign
// encoding difference.
const ROLL_NO_RE = /^240\d{6}$/;

let scanner = null;
let scanning = false;
const rows = []; // { rollNo, scannedAt: Date }
const seenRollNos = new Set();
let dupeCount = 0;
const dupeLog = []; // { rollNo, at: Date } — which roll numbers actually got flagged, not just a bare count
let lastDecoded = { text: null, at: 0 };
const roster = new Map(); // rollNo -> name, loaded separately from the scan session (see ROSTER_KEY)

// Everything lived only in a JS variable — a reload, an accidentally-closed
// tab, or the OS killing a backgrounded tab (common on both Android and iOS
// once you switch away to check something else) wiped the whole scanned
// list with no way back. Persisted to localStorage on every change instead,
// so the list survives all of that and is only ever gone when "Clear list"
// is used on purpose.
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      rows: rows.map((r) => ({ rollNo: r.rollNo, scannedAt: r.scannedAt.toISOString() })),
      dupeCount,
      dupeLog: dupeLog.map((d) => ({ rollNo: d.rollNo, at: d.at.toISOString() })),
    }));
  } catch { /* storage full/unavailable — scanning still works, just unsaved */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const r of saved.rows || []) {
      const scannedAt = new Date(r.scannedAt);
      if (!r.rollNo || Number.isNaN(scannedAt.getTime())) continue; // skip corrupt entries, don't crash the whole restore
      rows.push({ rollNo: r.rollNo, scannedAt });
      seenRollNos.add(r.rollNo);
    }
    dupeCount = Number(saved.dupeCount) || 0;
    for (const d of saved.dupeLog || []) {
      const at = new Date(d.at);
      if (!d.rollNo || Number.isNaN(at.getTime())) continue;
      dupeLog.push({ rollNo: d.rollNo, at });
    }
  } catch { /* corrupt/unavailable storage — start fresh rather than crash */ }
}

// Roster is separate from the scan session on purpose — a teacher loads it
// once for a class and it should survive "Clear list" between periods/days,
// only going away via its own "Clear roster".
function saveRoster() {
  try { localStorage.setItem(ROSTER_KEY, JSON.stringify([...roster])); } catch { /* not critical */ }
}
function loadRoster() {
  try {
    const raw = localStorage.getItem(ROSTER_KEY);
    if (!raw) return;
    for (const [rollNo, name] of JSON.parse(raw)) {
      if (typeof rollNo === 'string') roster.set(rollNo, typeof name === 'string' ? name : '');
    }
  } catch { /* corrupt/unavailable — start with no roster rather than crash */ }
}

const els = {
  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  torchBtn: document.getElementById('torch-btn'),
  status: document.getElementById('scan-status'),
  count: document.getElementById('count'),
  dupeCountEl: document.getElementById('dupe-count'),
  list: document.getElementById('roll-list'),
  exportBtn: document.getElementById('export-btn'),
  exportFilename: document.getElementById('export-filename'),
  clearBtn: document.getElementById('clear-btn'),
  manualToggle: document.getElementById('manual-toggle'),
  manualEntry: document.getElementById('manual-entry'),
  manualInput: document.getElementById('manual-input'),
  manualAddBtn: document.getElementById('manual-add-btn'),
  dupeToggle: document.getElementById('dupe-toggle'),
  dupeList: document.getElementById('dupe-list'),
  countLabel: document.getElementById('count-label'),
  rosterToggle: document.getElementById('roster-toggle'),
  rosterSection: document.getElementById('roster-section'),
  rosterInput: document.getElementById('roster-input'),
  rosterLoadBtn: document.getElementById('roster-load-btn'),
  rosterClearBtn: document.getElementById('roster-clear-btn'),
  rosterStatus: document.getElementById('roster-status'),
  absentCard: document.getElementById('absent-card'),
  absentList: document.getElementById('absent-list'),
  absentCount: document.getElementById('absent-count'),
};

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = `status show ${kind}`;
}

function clearStatus() {
  els.status.className = 'status';
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => ctx.close();
  } catch { /* audio not available — silent is fine, not critical */ }
  if (navigator.vibrate) navigator.vibrate(60);
}

function renderList() {
  if (rows.length === 0) {
    els.list.innerHTML = '<li class="empty">No scans yet.</li>';
  } else {
    els.list.innerHTML = rows
      .slice()
      .reverse()
      .map((r, i) => {
        const realIndex = rows.length - 1 - i;
        const name = roster.get(r.rollNo);
        return `
          <li>
            <span>
              <span class="roll">${escapeHtml(r.rollNo)}</span>${name ? ` — ${escapeHtml(name)}` : ''}<br/>
              <span class="time">${r.scannedAt.toLocaleTimeString()}</span>
            </span>
            <span style="display:flex; flex-shrink:0;">
              <button class="remove" data-action="edit" data-index="${realIndex}" title="Edit">✏️</button>
              <button class="remove" data-action="remove" data-index="${realIndex}" title="Remove">✕</button>
            </span>
          </li>`;
      })
      .join('');
  }
  els.count.textContent = roster.size > 0 ? `${rows.length} / ${roster.size}` : String(rows.length);
  els.dupeCountEl.textContent = dupeCount;
  els.exportBtn.disabled = rows.length === 0;
  // Was tied to rows.length alone — a repeats count could sit stuck at,
  // say, 1 with an empty list (every scan removed) and Clear had no way
  // to reach it, since the button was disabled too. Enabled whenever
  // there's anything at all to clear.
  els.clearBtn.disabled = rows.length === 0 && dupeCount === 0;
  renderDupeLog();
  renderAbsent();
}

// Only meaningful once a roster is loaded — otherwise there's nothing to
// compare "who scanned" against, so the whole card stays hidden.
function renderAbsent() {
  if (roster.size === 0) {
    els.absentCard.style.display = 'none';
    return;
  }
  const absent = [...roster.entries()].filter(([rollNo]) => !seenRollNos.has(rollNo));
  els.absentCard.style.display = 'block';
  els.absentCount.textContent = absent.length;
  els.absentList.innerHTML = absent.length === 0
    ? '<li class="empty">Everyone on the roster has been scanned.</li>'
    : absent
        .map(([rollNo, name]) => `
          <li><span class="roll">${escapeHtml(rollNo)}</span>${name ? ` — ${escapeHtml(name)}` : ''}</li>`)
        .join('');
}

function renderDupeLog() {
  els.dupeList.innerHTML = dupeLog.length === 0
    ? '<li class="empty">No repeats yet.</li>'
    : dupeLog
        .slice()
        .reverse()
        .map((d) => `
          <li>
            <span class="roll">${escapeHtml(d.rollNo)}</span>
            <span class="time">${d.at.toLocaleTimeString()}</span>
          </li>`)
        .join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

els.list.addEventListener('click', (e) => {
  const btn = e.target.closest('button.remove');
  if (!btn) return;
  const idx = Number(btn.dataset.index);

  if (btn.dataset.action === 'edit') {
    editEntry(idx);
    return;
  }

  const removed = rows.splice(idx, 1)[0];
  if (removed) seenRollNos.delete(removed.rollNo);
  saveState();
  renderList();
});

// For fixing a barcode that scanned/decoded wrong — a mistyped manual entry
// is just as easily removed and retyped, but a scan is trusted as correct
// by default, so there was previously no way to correct one without
// deleting and re-scanning the same card again.
function editEntry(idx) {
  const row = rows[idx];
  if (!row) return;

  const next = prompt('Edit roll number:', row.rollNo);
  if (next === null) return; // cancelled
  const rollNo = next.trim();
  if (!rollNo || rollNo === row.rollNo) return;

  if (!ROLL_NO_RE.test(rollNo)) {
    alert('Roll number must be 240 followed by 6 digits (e.g. 240701424).');
    return;
  }
  if (seenRollNos.has(rollNo)) {
    alert(`${rollNo} is already in the list.`);
    return;
  }

  seenRollNos.delete(row.rollNo);
  seenRollNos.add(rollNo);
  row.rollNo = rollNo;
  saveState();
  renderList();
}

function onDecoded(decodedText) {
  const rollNo = String(decodedText).trim();
  if (!rollNo) return;

  const now = Date.now();
  if (lastDecoded.text === rollNo && now - lastDecoded.at < DUPLICATE_COOLDOWN_MS) {
    return; // same code still sitting in front of the camera — not a new event
  }
  lastDecoded = { text: rollNo, at: now };

  if (seenRollNos.has(rollNo)) {
    dupeCount++;
    dupeLog.push({ rollNo, at: new Date() });
    setStatus(`Already scanned: ${rollNo}`, 'info');
    saveState();
    renderList();
    return;
  }

  seenRollNos.add(rollNo);
  rows.push({ rollNo, scannedAt: new Date() });
  beep();
  setStatus(`Added: ${rollNo}`, 'ok');
  saveState();
  renderList();
}

// Screen Wake Lock — without this, the phone's own screen timeout dims/locks
// the screen mid-class (idle hands, camera pointed at a card, no touches),
// which stops the camera stream entirely and forces restarting the scanner.
// Supported on iOS Safari 16.4+ and effectively every current browser; where
// it isn't supported, scanning still works exactly as before, just without
// the extra protection.
let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* e.g. battery saver mode refusing it — scanning still works, just no lock */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
// The lock is auto-released whenever the tab is hidden (spec behavior) — if
// still scanning when the tab becomes visible again, re-request it so a
// brief app-switch (checking something else) doesn't silently drop the lock
// for the rest of the class.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && scanning) acquireWakeLock();
});

// Torch/flashlight — only actually controllable via getUserMedia on some
// Android/Chromium combinations; iOS Safari doesn't expose it at all, so
// this button only appears where the running camera track reports the
// capability, instead of showing a button that would silently do nothing.
async function updateTorchButton() {
  els.torchBtn.style.display = 'none';
  if (!scanner) return;
  try {
    const caps = scanner.getRunningTrackCameraCapabilities();
    if (caps && caps.torchFeature && caps.torchFeature().isSupported()) {
      els.torchBtn.style.display = 'block';
      els.torchBtn.dataset.on = 'false';
      els.torchBtn.textContent = '🔦';
    }
  } catch { /* capability check itself unsupported — just skip the button */ }
}
async function toggleTorch() {
  if (!scanner) return;
  const isOn = els.torchBtn.dataset.on === 'true';
  try {
    const caps = scanner.getRunningTrackCameraCapabilities();
    await caps.torchFeature().apply(!isOn);
    els.torchBtn.dataset.on = String(!isOn);
    els.torchBtn.textContent = isOn ? '🔦' : '💡';
  } catch { /* device refused mid-session — leave state as it was */ }
}

async function startScanning() {
  clearStatus();
  els.startBtn.disabled = true;

  // Restrict to 1D formats commonly printed on ID cards — narrows what the
  // decoder looks for each frame, which is both faster and avoids
  // accidentally treating an unrelated QR code in the room as a scan.
  const formatsToSupport = [
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.CODE_93,
    Html5QrcodeSupportedFormats.CODABAR,
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.ITF,
  ];

  scanner = new Html5Qrcode(READER_ID, { formatsToSupport, verbose: false });

  try {
    await scanner.start(
      { facingMode: 'environment' },
      // A wide, short box matches a 1D barcode's shape better than a square
      // one — easier to line up the card without hunting for the frame.
      { fps: 15, qrbox: { width: 280, height: 110 } },
      (decodedText) => onDecoded(decodedText),
      () => {} // per-frame "nothing found" — expected constantly, ignore
    );
    scanning = true;
    els.startBtn.style.display = 'none';
    els.stopBtn.style.display = 'block';
    setStatus('Scanning — hold each ID card steady in the box.', 'info');
    acquireWakeLock();
    updateTorchButton();
  } catch (err) {
    els.startBtn.disabled = false;
    setStatus('Could not access camera: ' + (err && err.message ? err.message : err), 'err');
  }
}

async function stopScanning() {
  if (!scanner || !scanning) return;
  try {
    await scanner.stop();
    scanner.clear();
  } catch { /* already stopped/cleared — fine */ }
  scanning = false;
  els.startBtn.style.display = 'block';
  els.startBtn.disabled = false;
  els.stopBtn.style.display = 'none';
  els.torchBtn.style.display = 'none';
  releaseWakeLock();
  clearStatus();
}

function addManualEntry() {
  const rollNo = els.manualInput.value.trim();
  if (!rollNo) return;
  if (!ROLL_NO_RE.test(rollNo)) {
    setStatus('Roll number must be 240 followed by 6 digits (e.g. 240701424).', 'err');
    return;
  }
  onDecoded(rollNo); // same dedupe/persistence/beep path as a real scan
  els.manualInput.value = '';
  els.manualInput.focus();
}

function exportToExcel() {
  const data = [
    ['Roll No', 'Name', 'Scanned At'],
    ...rows.map((r) => [r.rollNo, roster.get(r.rollNo) || '', r.scannedAt.toLocaleString()]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Present');

  // Only meaningful with a roster loaded — otherwise there's no "expected
  // list" to compare against, so a second sheet would just be noise.
  if (roster.size > 0) {
    const absentData = [
      ['Roll No', 'Name'],
      ...[...roster.entries()].filter(([rollNo]) => !seenRollNos.has(rollNo)),
    ];
    const wsAbsent = XLSX.utils.aoa_to_sheet(absentData);
    wsAbsent['!cols'] = [{ wch: 18 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, wsAbsent, 'Absent');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultName = `RollCall_${stamp}`;
  // Optional rename before download — e.g. "Physics_240923" instead of a
  // bare timestamp. Sanitised so a stray / or \ in what they typed can't
  // turn into a nested path in the downloaded filename.
  const typed = els.exportFilename.value.trim().replace(/[\\/:*?"<>|]/g, '');
  const base = typed || defaultName;
  XLSX.writeFile(wb, `${base.replace(/\.xlsx$/i, '')}.xlsx`);
}

function clearList() {
  if (rows.length === 0 && dupeCount === 0) return;
  const msg = rows.length > 0
    ? `Clear all ${rows.length} scanned entries and the repeats count? This cannot be undone (export first if you need them).`
    : `Clear the repeats count (${dupeCount})? There's no scanned list to lose.`;
  if (!confirm(msg)) return;
  rows.length = 0;
  seenRollNos.clear();
  dupeCount = 0;
  dupeLog.length = 0;
  lastDecoded = { text: null, at: 0 };
  saveState();
  renderList();
}

els.startBtn.addEventListener('click', startScanning);
els.stopBtn.addEventListener('click', stopScanning);
els.torchBtn.addEventListener('click', toggleTorch);
els.exportBtn.addEventListener('click', exportToExcel);
els.clearBtn.addEventListener('click', clearList);

els.manualToggle.addEventListener('click', (e) => {
  e.preventDefault();
  const isHidden = els.manualEntry.style.display === 'none';
  els.manualEntry.style.display = isHidden ? 'flex' : 'none';
  e.target.textContent = isHidden ? 'Hide manual entry' : "Can't scan a barcode? Enter it manually";
  if (isHidden) els.manualInput.focus();
});
els.manualAddBtn.addEventListener('click', addManualEntry);
els.manualInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addManualEntry(); });

els.dupeToggle.addEventListener('click', (e) => {
  e.preventDefault();
  const isHidden = els.dupeList.style.display === 'none';
  els.dupeList.style.display = isHidden ? 'block' : 'none';
  e.target.textContent = isHidden ? 'Hide repeats' : 'View repeats';
});

function setRosterStatus(text, kind) {
  els.rosterStatus.textContent = text;
  els.rosterStatus.className = `status show ${kind}`;
}

function loadRosterFromInput() {
  const lines = els.rosterInput.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) { setRosterStatus('Paste at least one line first.', 'err'); return; }

  roster.clear();
  let skipped = 0;
  for (const line of lines) {
    const [rawRoll, ...rest] = line.split(',');
    const rollNo = (rawRoll || '').trim().toUpperCase();
    if (!ROLL_NO_RE.test(rollNo)) { skipped++; continue; }
    roster.set(rollNo, rest.join(',').trim());
  }

  if (roster.size === 0) { setRosterStatus('No valid roll numbers found (format: 240 + 6 digits).', 'err'); return; }

  saveRoster();
  els.rosterClearBtn.style.display = 'block';
  els.rosterInput.value = '';
  setRosterStatus(`Loaded ${roster.size} student${roster.size === 1 ? '' : 's'}.${skipped ? ` (${skipped} line${skipped === 1 ? '' : 's'} skipped — bad format)` : ''}`, 'ok');
  renderList();
}

els.rosterLoadBtn.addEventListener('click', loadRosterFromInput);
els.rosterClearBtn.addEventListener('click', () => {
  if (!confirm(`Clear the loaded roster (${roster.size} students)? Already-scanned entries stay, but names/absent-tracking go away.`)) return;
  roster.clear();
  saveRoster();
  els.rosterClearBtn.style.display = 'none';
  setRosterStatus('Roster cleared.', 'info');
  renderList();
});

// Hidden by default — most classes don't have a roster yet (college DB isn't
// wired in), so showing an empty paste-box up front would just be clutter.
// Only opt in if there's actually a reason to.
els.rosterToggle.addEventListener('click', (e) => {
  e.preventDefault();
  const isHidden = els.rosterSection.style.display === 'none';
  els.rosterSection.style.display = isHidden ? 'block' : 'none';
  e.target.textContent = isHidden ? 'Hide class roster' : "Have a class roster? Tap to add names + absent tracking";
});

loadRoster();
if (roster.size > 0) {
  els.rosterClearBtn.style.display = 'block';
  setRosterStatus(`${roster.size} students loaded from before.`, 'info');
  // A roster was already loaded on a previous visit — open the section so
  // "Clear roster" and the count are actually visible, not hidden behind
  // the toggle with no visible sign a roster exists.
  els.rosterSection.style.display = 'block';
  els.rosterToggle.textContent = 'Hide class roster';
}

loadState();
renderList();
if (rows.length > 0) setStatus(`Restored ${rows.length} scan${rows.length === 1 ? '' : 's'} from before — keep going or export.`, 'info');

if ('serviceWorker' in navigator) {
  // Captured before registering: distinguishes "first-ever install" (no
  // prior controller, controllerchange fires once with nothing meaningful
  // to reload) from a genuine update on a return visit.
  const hadController = !!navigator.serviceWorker.controller;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline-first still works without SW registration succeeding —
      // this only affects installability/first-load caching, not scanning.
    });
  });

  // sw.js already calls skipWaiting()+clients.claim(), so a new version
  // takes over silently in the background — but the tab's already-running
  // JS doesn't change until an actual reload. Best practice (confirmed via
  // search) is to notify, not force-reload: a mid-scan auto-refresh would
  // drop whatever the teacher was doing. Fires once per real update, not on
  // the very first install (no pre-existing controller to change from yet).
  let notified = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (notified || !hadController) return;
    notified = true;
    setStatus('Updated — reload the page to get the latest version.', 'info');
  });
}
