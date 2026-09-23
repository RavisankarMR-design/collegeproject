# Project 3 — Continuous Barcode Scanner → Excel

Standalone project. **Independent of the attendance web app in this repo** —
not combined with Project 1 (online attendance, this repo) or Project 2
(offline/hotspot attendance, not yet built). Three separate deliverables per
staff's instruction: "all 3 are independent projects, don't combine."

## Origin / backstory

- Staff (the department's attendance-verification contact) uses a dedicated
  handheld barcode scanner device costing ~₹5000 to scan student ID cards
  (1D barcode on the card encodes the roll number).
- Challenged that a phone could do the same job. Demonstrated live using a
  free existing barcode-scanning phone app — turned out **~1 second faster**
  than the ₹5000 device. Staff was stunned it worked with a free app.
- Gap found in that free app: it only does **one scan at a time** — scans,
  shows the result, stops. No way to scan a whole class continuously and
  build up a saved list.
- Staff's response: "build that then."

## Requirement (as given, verbatim intent)

1. Scan **continuously** — after each successful decode, the scanner
   immediately re-arms for the next card. No manual re-trigger per student.
2. Each decoded roll number **appends live to an on-screen list** as it's
   scanned (staff can see the count grow, catch a misread immediately).
3. At the end, **one action exports the whole list to Excel** (`.xlsx`).
4. That's the whole scope — nothing more asked for by staff at this stage.

## Constraints from staff

- **Cost-effective** — this is the entire premise (free app replacing a
  ₹5000 device). No paid tooling, no recurring cost.
- **Speed / time-saving** — already proven faster than the hardware
  scanner in the live demo; the build must not regress that.

## Platform decision: Web app (PWA), not a native APK

Reasoning, given staff needs it usable by staff on **both Android and
iPhone**, and **offline** (poor college network was the stated reason for
wanting an offline mode on Project 2 as well):

- A web page runs in any browser on both Android and iPhone — one build
  covers both. A native APK only covers Android; covering iPhone too would
  need a second native app + Apple Developer Program ($99/yr), which
  conflicts with "cost-effective."
- Made installable as a **PWA** (manifest + service worker): after the
  first load, it caches itself and needs **zero internet** afterward —
  tapping the home-screen icon opens it like a native app, works with no
  signal at all.
- Both the barcode decode library and the Excel-export library run
  **entirely client-side in the browser** — no server, no API calls needed
  for the actual scan → list → export flow.
- To be internet-independent even on *first* load (not just after
  caching), bundle the JS libraries locally instead of pulling from a CDN
  (see prior-art caveat below).

## Tech choice

- **Scanning**: `html5-qrcode` — same library already used and proven in
  this repo's own `public/student.html`, so it's a known quantity (fast,
  works on both platforms via camera).
- **Excel export**: **SheetJS (`xlsx` library)** — generates `.xlsx`
  client-side, no backend needed.
- Both are free/open-source, no licensing cost.

## Prior art researched (2026-09-23 web search)

Closest existing free/open-source projects found — used as reference, not
directly forked (build our own clean-room version):

1. **[venkatasairao/Smart_Barcode_Scanner](https://github.com/venkatasairao/Smart_Barcode_Scanner)**
   — closest match to the exact spec:
   - Uses `html5-qrcode`, scans multiple barcodes continuously.
   - Keeps a running session list, **auto-dedupes** repeated barcodes.
   - One-click export to `.xlsx` via SheetJS; filename auto-stamped with
     export timestamp (e.g. `Scanned_Barcodes_2026-09-23_14-40-15.xlsx`).
   - Pure HTML/CSS/JS, no framework, no backend.
   - **Caveat**: loads its libraries from a CDN at page-load, so first
     open needs internet; scanning itself is local/offline after that.
     Fix: vendor the libraries locally for true zero-internet-ever.
   - No license currently set on the repo — treat as reference/inspiration
     only, not something to redistribute directly.

2. **[georapbox/barcode-scanner](https://github.com/georapbox/barcode-scanner)**
   — uses the browser's native Barcode Detection API instead of a JS
   library (no external scanning lib needed at all). **Ruled out**: that
   API is Chromium-only (Android Chrome, macOS) — fails on iPhone/Safari,
   which is a hard requirement here.

3. **[suneel122/qr-attendance-system](https://github.com/suneel122/qr-attendance-system)**
   — different stack (PHP/MySQL/Apache, QR not 1D barcode), but useful as
   proof that "runs entirely on local Wi-Fi, no internet, exports to
   Excel/CSV" is a well-trodden, workable pattern (served over
   `http://192.168.x.x/...`).

Other references checked and set aside: `gamzegezgin/barcode_scanner`
(Excel export still unfinished), `qr-scanner`/`nimiq` and ZXing (scanning
libraries only, no list/export layer — `html5-qrcode` already covers this
need and is already proven in this codebase).

## Build plan (not yet built — pending go-ahead)

Combine + modify the above into our own version:
- Continuous scan loop (re-arm scanner immediately after each decode,
  don't stop like the original free app did).
- Live on-screen list with dedupe-on-scan (skip a barcode already in the
  list this session, same idea as Smart_Barcode_Scanner).
- One "Export to Excel" button at the end using bundled (not CDN) copies
  of `html5-qrcode` + SheetJS, so it's usable with **zero internet ever**,
  including first load.
- Package as an installable PWA (manifest + service worker) so it behaves
  like an app icon on both Android and iPhone home screens.
- Single static page, no server, no database — matches "cost-effective"
  and "independent, don't combine with the other two projects."

## Status

**Built.** Files:
- `index.html` — the page (scan area, live list, export/clear buttons)
- `app.js` — continuous-scan handling, dedupe, list rendering, Excel export
- `style.css` — mobile-first dark UI
- `manifest.json` + `sw.js` — PWA installability + offline caching
- `icons/` — generated app icons (192/512/apple-touch)
- `vendor/html5-qrcode.min.js`, `vendor/xlsx.full.min.js` — vendored
  locally (not CDN), so the app needs internet only for its very first
  page load; every load after that (including the actual scanning and
  Excel export) works with zero internet.

### How it works

- Tap **Start scanning** once (grants camera permission). The scanner then
  stays active — it does not stop after a successful decode, unlike the
  original free app.
- Each new barcode's decoded text (the roll number) is added to the list
  instantly, with a beep/vibration. Scanning the same card again is
  recognized and ignored (counted under "Repeats ignored"), not added
  twice.
- A misread entry can be removed individually via the ✕ button.
- **Export to Excel** generates a `.xlsx` file (Roll No + Scanned At
  columns) client-side and downloads it — no server involved.
- **Clear list** wipes the session (asks for confirmation first).

### Verified (this session, headless Chromium + a fake camera device)

- Page loads with zero console/JS errors; `Html5Qrcode` and `XLSX` both
  load correctly from the local `vendor/` copies (no CDN dependency).
- Simulated scans confirm: new roll numbers add to the list, a repeat is
  correctly caught and counted separately, row removal works.
- Exported `.xlsx` opened and inspected directly (it's a real ZIP/OOXML
  file) — confirmed the scanned roll numbers are actually inside the
  sheet data, not just a correctly-named empty file.
- Reloaded the page with the network fully disabled (after one prior
  load) — page still loads and runs completely, confirming the
  offline-after-first-load behavior actually works, not just in theory.
- **Not yet verified**: a real barcode decode from an actual camera aimed
  at a real ID card, and installing/running it as a home-screen PWA on
  real Android/iPhone hardware — this sandbox has no camera, so that step
  is on a real phone next.

### To test on a phone

1. Serve this folder over your local network (anything that serves static
   files works, e.g. `python3 -m http.server 8099` from inside
   `project-3-barcode-scanner/`) or deploy it anywhere static hosting is
   free (GitHub Pages, Netlify, etc.) — one-time, needs internet for the
   very first load only.
2. Open the page on the phone once, tap Start scanning to confirm camera
   permission works, and let the service worker cache finish (a couple
   of seconds).
3. Optionally "Add to Home Screen" (Android Chrome) / "Add to Home Screen"
   (iPhone Safari share sheet) to install it as an app icon.
4. Turn on airplane mode / hotspot-only and confirm it still opens and
   scans — that's the real offline test this sandbox couldn't run.
