// ID Barcode Roll Call — continuous scan-list-export tool.
// Standalone, offline-first: no server, no network calls. Everything (the
// scanned list, the Excel file) is produced entirely in this browser tab.

const READER_ID = 'reader';
const DUPLICATE_COOLDOWN_MS = 1500; // ignore the same code re-firing while still in frame
const STORAGE_KEY = 'rollcall_state_v1';

let scanner = null;
let scanning = false;
const rows = []; // { rollNo, scannedAt: Date }
const seenRollNos = new Set();
let dupeCount = 0;
let lastDecoded = { text: null, at: 0 };

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
  } catch { /* corrupt/unavailable storage — start fresh rather than crash */ }
}

const els = {
  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  status: document.getElementById('scan-status'),
  count: document.getElementById('count'),
  dupeCountEl: document.getElementById('dupe-count'),
  list: document.getElementById('roll-list'),
  exportBtn: document.getElementById('export-btn'),
  clearBtn: document.getElementById('clear-btn'),
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
        return `
          <li>
            <span>
              <span class="roll">${escapeHtml(r.rollNo)}</span><br/>
              <span class="time">${r.scannedAt.toLocaleTimeString()}</span>
            </span>
            <button class="remove" data-index="${realIndex}" title="Remove">✕</button>
          </li>`;
      })
      .join('');
  }
  els.count.textContent = rows.length;
  els.dupeCountEl.textContent = dupeCount;
  els.exportBtn.disabled = rows.length === 0;
  els.clearBtn.disabled = rows.length === 0;
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
  const removed = rows.splice(idx, 1)[0];
  if (removed) seenRollNos.delete(removed.rollNo);
  saveState();
  renderList();
});

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
  clearStatus();
}

function exportToExcel() {
  const data = [
    ['Roll No', 'Scanned At'],
    ...rows.map((r) => [r.rollNo, r.scannedAt.toLocaleString()]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 18 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Roll Call');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  XLSX.writeFile(wb, `RollCall_${stamp}.xlsx`);
}

function clearList() {
  if (rows.length === 0) return;
  if (!confirm(`Clear all ${rows.length} scanned entries? This cannot be undone (export first if you need them).`)) return;
  rows.length = 0;
  seenRollNos.clear();
  dupeCount = 0;
  lastDecoded = { text: null, at: 0 };
  saveState();
  renderList();
}

els.startBtn.addEventListener('click', startScanning);
els.stopBtn.addEventListener('click', stopScanning);
els.exportBtn.addEventListener('click', exportToExcel);
els.clearBtn.addEventListener('click', clearList);

loadState();
renderList();
if (rows.length > 0) setStatus(`Restored ${rows.length} scan${rows.length === 1 ? '' : 's'} from before — keep going or export.`, 'info');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline-first still works without SW registration succeeding —
      // this only affects installability/first-load caching, not scanning.
    });
  });
}
