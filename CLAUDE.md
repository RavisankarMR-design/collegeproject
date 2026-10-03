# Project 3 — ID Barcode Roll Call — Project Notes

Standalone barcode-scan-to-Excel PWA. Independent of the attendance web app
(Project 1) in this same repo — three separate deliverables per staff's
instruction: "all 3 are independent projects, don't combine." See
`README.md` in this folder for the original build history/backstory/prior-art
research; this file covers everything since (branding, locking, export
format, hosting, and the roster-sync plan).

**Live URL:** https://ravisankarmr-design.github.io/collegeproject/
(GitHub Pages, `gh-pages` branch of `RavisankarMR-design/collegeproject`)

## Stack

Pure static HTML/CSS/JS, no server, no backend. `html5-qrcode` for scanning
(vendored locally, not CDN), SheetJS (`xlsx`) for Excel export (vendored
locally). PWA via `manifest.json` + `sw.js` — offline after first load,
including first-load-only internet dependency removed by vendoring both
libraries.

- `index.html` — page structure
- `app.js` — all scan/roster/lock/export/splash logic
- `style.css` — REC purple/lavender theme
- `manifest.json` + `sw.js` — PWA installability + offline caching
  (`CACHE_NAME` bump required on every asset change — currently `roll-call-v23`)
- `roster-class1.js` — hardcoded Trial Class 1 roster (roll → name), 140 students
- `vendor/html5-qrcode.min.js`, `vendor/xlsx.full.min.js` — vendored, not CDN
- `icons/` — app icons + splash logo (see Branding below)
- `FIREBASE-ROSTER-PLAN.md` — agreed architecture for real per-staff roster
  sync, not built yet (see below)

## Branding (2026-09-29/30 session)

Reskinned to match Rajalakshmi Engineering College's own sites
(rec-db-official.web.app, rectransport.com, rajalakshmi.org) after
gathering their design language:

- **Colors:** purple `#6a1b9a` → `#9c27b0` gradient primary, light lavender
  background `#eeeef2`, white cards. Defined as CSS variables in `style.css`.
- **Buttons:** pill-shaped (border-radius: 999px), matches REC sites' CTAs.
- **Font:** Poppins/Montserrat stack with system-sans fallback — **no CDN
  font fetch**, keeps the offline-first PWA guarantee (a web font @import
  would break first-load-offline).
- **App icons:** real college logo. Pulled `logo.svg` from rajalakshmi.org
  (embeds a base64 PNG, 2684×867, full "R-torch emblem + RAJALAKSHMI
  ENGINEERING COLLEGE" text lockup). Cropped just the R/torch emblem
  (no text) for `icons/icon-192.png`, `icons/icon-512.png`,
  `icons/apple-touch-icon.png` (white background — iOS ignores alpha and
  renders odd corners with transparency). Kept the **full lockup**
  (with text) separately as `icons/college-logo-full.png` for the splash
  screen. `theme_color`/`background_color` in `manifest.json` updated to
  match (`#6a1b9a` / `#eeeef2`).
- **Splash screen:** shows on every load (browser tab or installed PWA) —
  `#splash` div in `index.html`, full college logo lockup + "ID Barcode
  Roll Call", white background. Minimum 600ms display (`SPLASH_MIN_MS` in
  `app.js`) so a fast/cached load doesn't just flash it, then fades via
  `.splash.hide` (opacity transition). All assets already in the SW
  precache list, so it works offline too.
- **Contrast/accessibility fixes:** success-status text darkened
  `#15803d`→`#166534` (was 4.4:1 against its tint, failed strict AA for
  normal text; now 6.2:1). `h1`'s gradient text (`background-clip: text`)
  wrapped in an `@supports` query with a solid-color fallback — without it,
  a browser lacking that support would render the heading fully invisible
  (transparent text, no fallback color). `roster-input`/`manual-input`
  (now `manual-input` only, see Roster below) got real `<label>` elements
  via `.sr-only` (previously placeholder-only, a screen-reader gap).

## Locked scan mode + staff PIN (2026-09-28/29 session)

**Scenario:** staff's one phone gets passed around a class for students to
scan their own cards — need every in-page control except the camera itself
unreachable while it's in students' hands. **A web page cannot prevent
someone from leaving/exiting it** — that's Android app pinning ("ask for
PIN before unpinning") or iOS Guided Access, done at the OS level, outside
this app's control. This feature only locks the *in-page* UI on top of
that OS-level pin.

- `body.locked` + `.lockable` class (in `style.css`) hides everything
  except the camera view, Start/scan-notification banner, and Unlock.
- PIN set on first lock (4–6 digits), stored as a SHA-256 hash in
  `localStorage` (`rollcall_pin_v1`) — keeps out students poking buttons,
  **not** someone with dev tools or who clears site data (clearing site
  data also wipes the PIN, which doubles as recovery).
- 5 wrong tries → 30-second lockout.
- **Reset PIN button** — only ever visible/reachable while *unlocked*
  (hidden by `.lockable` during lock, for the obvious reason: showing it
  while locked would let a student bypass the whole thing). Clears the
  stored PIN; next lock asks to set a fresh one.
- Native `confirm()`/`prompt()` replaced with a themed modal
  (`#modal-overlay` in `index.html`, `askConfirm()`/`askPrompt()` in
  `app.js`) so every dialog (edit roll, clear list, clear roster, reset
  PIN) matches the app instead of the browser's default popup.

## Export format (2026-09-29 session)

Single sheet named "Attendance", **not** separate Present/Absent sheets
(the earlier format). Columns: **Email id | Register id | Attendance**.
Matches the real college DB's expected default export shape — every
roster entry defaults to `Absent`; a scan flips just that row to
`Present`. `Register id` includes the real `2116` college prefix
(`fullRollNo()` in `app.js`).

**Email id is a best-effort guess**, not verified data —
`guessEmail(name, rollNo)` in `app.js`. Pattern reverse-engineered from a
real ID (`ravisankar.mr.2024.cse@rajalakshmi.edu.in` for "Ravi Sankar M R",
roll 240701424): first+middle name run together lowercase, trailing 1-2
letter initial words joined separately, then `.year.dept`. Verified to
match that one real example exactly. **Known to misfire**:
- `DEPT_CODE` is hardcoded `'cse'` — wrong for any roster from another
  department.
- Any name that doesn't end in short trailing initials (e.g. a plain
  surname like "Subedi" instead of Tamil-style initials) gets no `.initials`
  segment and is more likely wrong.

This gets replaced with real verified email/name data once the actual
flat department DB (see Firebase plan below) is available — `guessEmail()`
is explicitly a stand-in, not the end state.

## Roster loading (changed 2026-09-30)

**Manual roster paste was removed.** Previously staff could paste
`roll,name` lines freehand; now the only way to load a roster is picking
one (currently just "Trial Class 1" — 140 students, `roster-class1.js`).
This was intentional ahead of the Firebase plan landing: "class selection
only, DB will drive it later" — once real per-staff class data exists,
the class list becomes DB-backed instead of a single hardcoded button.

`trialActive` flag: true only when Trial Class 1 specifically is loaded —
while true, a scanned roll number **not** on that roster is rejected
outright (real known class, shouldn't accept an unrelated ID). This flag
existed for the paste-roster path too before removal; now it's Trial-Class-
1-only.

## Hosting / URL situation (2026-09-28/29 session)

Currently lives at `ravisankarmr-design.github.io/collegeproject/` —
personal GitHub username in the URL, which the project owner wants gone
for a student-facing tool. **Agreed fix, not yet done:** create a free
GitHub *Organization* (not a second personal account — restricted by
GitHub's rules and wouldn't solve the naming problem anyway), push just
this P3 folder into a new repo inside that org, enable GitHub Pages there.
**Explicitly scoped to not touch P1** — P1's Render deployment and its
repo/remote stay exactly as-is; only P3 would move to get a clean URL.
Blocked on the user actually creating the org (an account-level action
only they can do) and picking a name.

## Real-phone testing status

- **Continuous scan + list + Excel export: tested and confirmed working**
  on real hardware (per user, 2026-09-29) — the README's earlier "not yet
  verified" caveat for this is resolved.
- **Multi-phone sharing one scan session: not yet decided/tested** — user
  is unsure whether this is actually needed for their use case.
- PIN lock, themed modals, new export format, new branding, splash screen:
  tested in a sandboxed browser (headless Chromium via the coding
  assistant's own browser tool) each time before shipping, **not yet
  re-verified on real phone hardware** after all these changes stacked up.

## Staff Google sign-in gate (2026-10-02 session)

Resolves one of the two deferred decisions in the Firebase plan below —
**sign-in method** — but scoped to *just the login gate*, not the
roster-sync feature. The two are separable: a gate answering "who's
allowed to open the scanner" doesn't need Firestore or a backend at all,
so it was built with **Google Identity Services directly, not Firebase**.
Firestore/Firebase stays reserved for roster-sync specifically, still
blocked exactly as described below.

- `#login-screen` in `index.html` — full-page overlay, same pattern as
  `#splash`, shown until a valid session exists (cached or fresh).
  `body.login-pending` hides every other top-level element outright (not
  just visually covered — removed from tab order/screen readers too).
- Restricted to `@rajalakshmi.edu.in` via the sign-in request's `hd`
  param, re-checked client-side against the returned token's own claim.
  **Not signature-verified** — there's no backend to verify against and
  nothing sensitive is protected server-side, same soft-gate threat model
  as the staff PIN lock above (keeps out casual access, not a determined
  bypass via dev tools).
- First sign-in needs internet (loads `accounts.google.com/gsi/client`) —
  the one deliberate exception to this app's offline-first rule, same
  tradeoff the Firebase plan below already accepted for its own login
  step. Signed-in email cached in `localStorage` (`rollcall_user_v1`);
  every session after is fully offline, confirmed with the server killed
  outright in testing.
- Sign-out link clears the cached session and reloads to the login
  screen.
- **`GOOGLE_CLIENT_ID` in `app.js` is the same OAuth client Project 1
  uses** (a public value — P1 serves it at `/api/auth/config`). Google only
  honors it from origins authorized for that client, so
  `https://ravisankarmr-design.github.io` was added under Authorized
  JavaScript origins in Google Cloud Console (APIs & Services →
  Credentials → "Web client 1") on 2026-10-03; verified afterwards that
  Google's button endpoint returns 200 for the live origin (it returned
  403 "origin is not allowed" before). **If P3 moves to a GitHub
  organization URL, that new origin must be added there too.**
- Tested headless (6/6, since the in-app browser pane can't register a
  service worker on `localhost`): no-session gate, wrong-domain
  rejection, valid sign-in, cached-session reload, fully-offline reload,
  sign-out. Export format and scan flow spot-checked unaffected. **The
  real sign-in popup itself (picking an account, completing consent) is
  not yet tested end-to-end** — it needs a real @rajalakshmi.edu.in login,
  which has to be done by hand on a phone.

## Firebase roster-sync plan (not built — see FIREBASE-ROSTER-PLAN.md)

Full detail in `FIREBASE-ROSTER-PLAN.md` in this folder. Summary:

- **Problem:** every roster today lives only in one phone's `localStorage`.
  No way for a different staff member with a different class to get their
  roster onto their phone except manual entry or the maintainer hardcoding
  another file per class. Also: the real department DB is **flat** (name,
  email, roll — no class/section field), so it can never by itself answer
  "who's in this specific class" — that grouping needs separate
  staff/timetable data no matter what.
- **Agreed direction:** login is opt-in, local-only stays the default (no
  regression, no forced dependency). First-time login pulls **every**
  class assigned to that staff (their whole timetable) in one shot and
  caches all of it — not a per-session/per-day fetch. Every session after
  that is 100% local: the app auto-highlights whichever cached class
  matches the phone's current day/time against that class's cached
  timetable slot; staff can still tap a different one manually. Re-login
  only on explicit re-sync request.
- **Data model:** `staff/{email}` → `staff/{email}/classes` (assigned
  class IDs) → `classes/{classId}` (roll list + timetable slot — the part
  the flat DB can't provide) → `students/{rollNo}` (real name/email
  lookup, replaces `guessEmail()`).
- **Blocked on:** no Firebase project created yet (account-level step,
  same category as the GitHub org above), no real department DB in hand,
  no real staff/timetable data in hand. **Sign-in method is resolved** —
  P3 now has its own Google Identity Services login (see section above),
  separate from P1's, which this feature would reuse (that identity's
  email is already the natural key for `staff/{email}` above). Still
  deferred: how rosters get uploaded into Firestore initially (CSV-paste
  admin tool vs. manual Firebase-console entry).

## Related ideas discussed, not part of this project

- **P3 v2 (signed rotating QR):** discussed as a way to make attendance
  student-self-serve, offline, and proxy-resistant (each student's phone
  signs `roll+timestamp` with a device-local key, staff phone verifies
  offline against a cached public-key roster). Not built, not scoped as
  part of this repo — floated as a bigger future direction distinct from
  the barcode-ID-card approach this project actually uses.
- **In-page exit lock / "password to leave the page":** established this
  is **not possible** for a web page — only the OS (Android screen
  pinning, iOS Guided Access) can require a PIN to exit. The staff-PIN
  lock in this project only hides in-page controls on top of that,
  doesn't replace it. Chosen mitigation: don't hand the phone to
  students at all (stand/hold it, let them just show the card), plus
  strict verbal instruction not to touch the screen.
