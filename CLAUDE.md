# Project 3 — REC Scan — Project Notes

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

## Naming (2026-10-08)

Renamed from "ID Barcode Roll Call" ("Roll Call" read as an informal school
phrase and isn't what the college's own data calls it). Final name, chosen
by the project owner: **"REC Scan"** — everywhere: `<title>`, splash, page
heading, `manifest.json` `name` and `short_name`, and the
`apple-mobile-web-app-title` meta tag. (An earlier same-day pass used "REC
Attendance Scanner" as the long name; dropped in favor of the short one.)
It's 8 characters, so it also fits the home-screen label — launchers cut
labels longer than about 12 characters (guidance from several PWA sources).

- **Deliberately NOT renamed:** the `rollcall_*` localStorage keys (renaming
  would wipe every phone's saved scans, roster and PIN) and the
  `RollCall_<timestamp>` default export filename (staff may already file
  exports by that name — rename only if asked).
- Already-installed copies may keep showing "Roll Call" under the icon
  until reinstalled: Android and iOS cache the label at install time.
- The "REC" name and logo are used without confirmed college approval for a
  student-built tool — worth confirming with staff before wider rollout.

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
  `#splash` div in `index.html`, full college logo lockup + the app name
  (see Naming below), white background. Minimum 600ms display (`SPLASH_MIN_MS` in
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
roster entry defaults to `ABSENT`; a scan flips just that row to
`PRESENT` (all caps, matches the college DB's format). `Register id` includes the real `2116` college prefix
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

**Decision (2026-10-08): keep the guessed emails for now; the owner will supply
the real student email list later.** The three DigiCampus sheets contain no
student emails (only staff emails, in Faculties.xlsx). Measured on the 1,677
real students: 82% of names end in initials (the shape the one verified
example, the owner's own address, fits), 10% start with initials, 8% have none,
and 62% are not CSE so the hardcoded `.cse` is wrong for them. Open question
for the owner: does the college upload match on email or on register ID (if
register ID, the email column matters little)? When the real list arrives, join
it by roll number, drop `guessEmail()`, and store `email` per student in the
class documents (`students: [{roll, name, email}]`).

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
  real sign-in popup (picking an account, completing consent) was tested
  by the project owner on a real phone and confirmed working
  (2026-10-08).** Not yet checked on a real phone: the fully-offline
  reopen after signing in, and wrong-domain rejection with a real
  non-college Google account (both only verified headless with fake
  tokens).

## Staff class picker (2026-10-08 — built, Firebase set up, real sign-in untested)

Owner's plan: each staff member signs in, sees only their own classes and
student lists, taps a class, scanning starts. Owner chose **Firebase
(private server)** over bundling the data in the app, because anything
shipped inside the app is readable by anyone with the link (confirmed: the
bundled roster file downloads with a plain `curl`, no login) — bundling
would have published 1,677 students' names/roll numbers and 22 staff emails.

- **Data source:** DigiCampus exports `Faculties.xlsx`, `No Code.xlsx`,
  `Low Code.xlsx` (Zoho Creator, 5th sem, batch 2024). 1,677 students, 22
  staff, 51 classes (22 lecture groups + 29 practical classes), every class
  one faculty member, every student exactly one Lecture + one Practical
  class. Faculty ID joins cleanly; Registration Id = `2116` + the 9-digit
  roll (all pass the app's `24 + 7 digits` rule). Trial Class 1 =
  Bhuvaneswaran B's `CSE_2024_Group_1` (140 students). Details and the
  combined workbook are in `FIREBASE-ROSTER-PLAN.md`'s build-status section.
- **Data quirks to remember:** DOBs appended to some student names (17,
  stripped before storing; never put DOBs on shared phones); faculty
  "Sachin Adith 0" in the export was corrected to "Sachin Adith" (owner's call,
  2026-10-08; his email sachinadith.nkn@… shows initials NKN; fixed in the
  combined workbook, the class data and Firestore; the original Faculties.xlsx
  is untouched); AIDS rows use a different
  Intake Name format; Bhuvaneswaran B (101077) vs Bhuvaneswari R (101327)
  differ by one letter — always key on email/ID, never the name.
- **App:** `#classes-card` / `selectClass()` / `fetchClassesFromFirestore()`
  in `app.js`, `FIREBASE_CONFIG` set to project `rec-scan`. The old "Trial
  Class 1" rejection text is now `activeClassLabel`. If the class fetch
  fails, the card shows the Firebase error code and the Trial Class 1
  button still works. **Permanent offline cache (owner's requirement,
  2026-10-08):** after one sign-in the staff member's classes and student
  lists stay saved on the phone for good. Sign-out only ends the login (after a
  confirm) and keeps the classes, roster and selected class; the same account
  signing back in sees them instantly, and a failed re-sync never erases them.
  They are replaced only by a successful re-sync, and wiped only when a
  *different* account signs in. The app also calls `navigator.storage.persist()`
  so the browser doesn't evict them under storage pressure. Trade-off the
  owner accepted: student names remain on the phone after sign-out, protected
  by the phone lock and the staff PIN, not by signing out.
- **Firebase (done, see FIREBASE-ROSTER-PLAN.md):** project `rec-scan`
  (Spark, Mumbai), 51 classes imported, rules published and tested live (12
  checks), one-time admin key revoked. **Not yet verified:** a *real* Google
  ID token being accepted by Firebase (only a fake one was rejected with
  `auth/invalid-credential`), and the picker on a real phone.
- **View students (2026-10-08):** each class in the picker has a "View
  students" link that expands its names (roll — name, scrollable) without
  selecting the class; selecting keeps it open; "Hide students" collapses it.
  State is the `expandedClasses` Set in `app.js`.
- **Extra access (2026-10-08):** the owner's student account
  `ravisankar.mr.2024.cse@rajalakshmi.edu.in` is also in `staffEmails` of
  `CB23F35__CSE_2024_Group_1` only (Trial Class 1), added in the Firebase
  console, so it sees just that class. A re-import overwrites it; see
  FIREBASE-ROSTER-PLAN.md.
- **Do not delete "My First Project"** (Google Cloud project that owns P1's
  login): Firebase got attached to it by mistake and deleting either would
  delete both. P3's data is in the separate `rec-scan` project.
- **Private data lives outside the repo:** `../p3-private-data/classes-import.json`.

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
  class IDs) → `classes/{classId}` (`staffEmails`, timetable slot, and the
  **full student list embedded**: `[{roll, name, email}]` — the part the
  flat DB can't provide). `students/{rollNo}` is the admin-side source the
  import copies from, not read by the app at login. Real name/email
  replaces `guessEmail()`.
- **Scale (stated 2026-10-06): ~500 staff**, each with a timetable and
  per-class student lists; a staff member only ever sees their own.
  **Hard rule: after the first login everything is cached on the phone, no
  internet needed again.** Consequences recorded in
  `FIREBASE-ROSTER-PLAN.md` "Scale" section. Owner's mental model (keep it
  this simple): Firebase stores the data and gives each staff only their
  own; phone caches it at first login. "Reads" are just Firebase's usage
  meter — build so a login is a handful of fetches (embed rosters in class
  docs), nothing for the owner to manage. Rule = read only classes whose
  `staffEmails` has your
  email (which also finally separates staff from students — the current
  gate lets any college account in); explicit "Re-sync" button needed since
  nothing refreshes automatically; (superseded 2026-10-08: the cache is now
  permanent and sign-out keeps it, see the class picker section); verify Firestore rules'
  Firebase-Auth requirement can reuse the existing Google ID token before
  building; import via one-time admin script from the DigiCampus export.
- **Blocked on:** no Firebase project created yet (account-level step,
  same category as the GitHub org above), no real department DB in hand,
  no real staff/timetable data in hand. **Sign-in method is resolved** —
  P3 now has its own Google Identity Services login (see section above),
  separate from P1's, which this feature would reuse (that identity's
  email is already the natural key for `staff/{email}` above). Still
  deferred: how rosters get uploaded into Firestore initially (CSV-paste
  admin tool vs. manual Firebase-console entry).

## Known limitation: proxy scans via screen images (discussed 2026-10-06, not fixed)

Staff want to keep passing the phone to students to scan their own cards.
**A photo of a friend's ID on another phone screen scans exactly like the
real card**, and since the barcode is just the roll number (not secret,
sequential), anyone can generate one for any classmate even without their
card. The camera can't tell card from screen or whose hand holds it. Same
class of limit as P1's "one person, two phones" — inherent to ID-barcode
scanning, not a bug. Detecting "this is a screen" reliably isn't realistic
in a free offline web page and would flag honest students.

Mitigations, cheapest first (**none built yet — saved for later**):
1. **Head-count check:** app already shows `scanned / roster` (e.g. 42/60).
   Staff compare with people actually in the room; scanned > present =
   proxies. Possible small feature: a "people present" box that warns when
   the scan count exceeds it. Offered, not requested yet.
2. Keep the phone in staff's view instead of fully handing it over — a held-
   up phone screen is then obvious.
3. Make the scanned name larger / linger longer on screen (already shows
   "Added: roll — name") so a proxy scan is visible to the whole class.
4. Show student photo on scan (needs photos in the DigiCampus export; only
   helps if someone is watching).
Real fix = unforgeable, expiring credential (P3 v2 signed rotating QR
below) — still can't stop a friend sending a live code from their own
phone, and changes the whole "scan ID cards" model.

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
