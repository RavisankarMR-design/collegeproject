# Anti-Proxy Attendance System

Rotating signed QR + GPS geofence + device binding + roster enforcement +
flagged-attempt logging + session history. Live at:

**https://collegeproject-igj6.onrender.com**

## Why this design (for your viva)

A QR that just "changes every 10 seconds" only stops *replaying an old code
later*. It does **not** stop the real attack: a friend in class points a
camera at the *currently valid* QR and video-calls it to someone off-campus,
who scans that live frame within the same 10s window. That's why rotation
alone is not enough — this build stacks five independent checks, and a scan
is only accepted if it passes all of them:

1. **Rotating HMAC-signed token** (`utils/token.js`) — the secret used to
   sign each 10s token never leaves the server, so a token can't be forged
   and a captured QR image is worthless once its window closes.
2. **GPS geofence + accuracy floor** (`utils/geo.js`, `routes/attendance.js`)
   — the scan's coordinates must fall within a configurable radius of the
   classroom center captured at session start. A GPS fix worse than ±100m
   accuracy (common indoors, where phones fall back to WiFi/cell
   positioning) is rejected outright instead of being compared against the
   radius as if it were exact.
3. **Roster enrollment cap** (`Session.roster`) — when a teacher pastes in
   the class's roll numbers, only those exact roll numbers can ever be
   marked present. A 30-student class cannot produce a 31st record, and
   scanning with a roll number that isn't enrolled is rejected and logged.
4. **Device binding** (`models/Student.js`) — a roll number is locked to the
   first device it's scanned from (a browser fingerprint — canvas render +
   navigator/screen signals hashed with SHA-256, not a random ID, so
   clearing storage doesn't reset it); a second phone can't mark attendance
   for that roll number. Matching is case-insensitive — `21cs001` and
   `21CS001` are the same student.
5. **One record per student per session** — enforced at the database level
   (unique index on `Attendance`), so a duplicate scan is rejected outright.

Every rejection from checks 2–4 is logged to `FlaggedAttempt` with the
reason, distance, GPS accuracy, and device ID, visible live on the teacher
panel — not just refused, but recorded as evidence of a likely proxy
attempt.

## Real bugs found and fixed during testing

Not just features — these were caught by actually using the deployed app,
not by inspection, and are worth stating in a report as evidence of testing
rigor:

- **Case-sensitivity bypass** — the roster check normalized roll numbers to
  uppercase, but the student lookup used the raw string, so `CASE001` and
  `case001` became two different student records. One person could mark
  attendance twice, from two different devices, against a roster that only
  allowed one. Reproduced live against production, fixed, and re-verified
  with the same attack.
- **Stored XSS in the teacher panel** — student-supplied names and roll
  numbers were interpolated into `innerHTML` unescaped. A student naming
  themselves `<img src=x onerror=...>` would run arbitrary script in the
  teacher's browser. Fixed by HTML-escaping all student-controlled text
  before rendering; verified with a live payload that it now renders as
  literal text.
- **GPS distance shown with 13 decimal places** — cosmetic, but a present
  list showing `19.82972579175938m` looks broken in a demo. Rounded.
- **QR library 404** — the pinned `qrcode` CDN version's browser build had
  been removed upstream; the teacher's QR canvas would have stayed blank in
  any real run. Repinned to a version confirmed to still ship a working
  build.

## Features added beyond the original 4-check design

- **GPS accuracy is captured and shown**, not discarded — the student sees
  their own fix quality while scanning ("Verifying (GPS accuracy ~14m)..."),
  and every present/flagged record stores it for the teacher to see how
  reliable each reading actually was.
- **Extend session** — a teacher can push a live session's end time forward
  from the panel (works even if it already expired) instead of ending it and
  starting a fresh one, which would have orphaned students already marked
  present.
- **Session survives a page refresh** — the running session id used to live
  only in a JS variable; reloading the teacher tab silently lost the QR,
  present list, and ability to extend/end. Now persisted to `localStorage`
  and restored on load (an ended, expired, or unknown id is not restored).
- **Session history + CSV export** (`history.html`) — every past session is
  now readable after the fact: who was present, what got flagged and why,
  and a downloadable CSV per session. Before this, ending a session made its
  data effectively write-only.
- **No-camera fallback** — student page accepts an uploaded photo/screenshot
  of the QR (decoded client-side via the same library), for testing on a
  machine with no webcam or as a backup path.

## Known limitations (good to state upfront, not hide)

- **GPS accuracy is a hard physical limit, not a bug.** Tested live:
  standing still and 1 foot from the reference point reported ~25m off; after
  physically moving another 20m away, the next reading reported *closer*
  (~11m). This is normal indoor GPS/WiFi-positioning noise, not spoofing.
  The accuracy floor added above rejects obviously-bad fixes, but cannot fix
  a fix that's simply wrong. Two consequences worth stating directly:
  - GPS **cannot** reliably distinguish adjacent classrooms 10-30m apart, or
    classrooms stacked on different floors (same lat/lng, no altitude
    signal). A 30m radius is right at the edge of what consumer GPS can
    resolve indoors — 60-75m is a more realistic setting for real buildings.
  - This is exactly why BLE/RSSI is scoped as Phase 2 below, not a
    nice-to-have: Bluetooth signal strength degrades with walls/floors in a
    way GPS coordinates structurally cannot.
- **Identity is still self-declared.** Nothing verifies that the person
  typing a roll number into the student page is actually that student. The
  *first* scan for any never-seen roll number binds to whoever's phone
  submitted it — including a friend doing a one-time favor. Device binding
  stops *repeat* proxying on the same phone, not a single first-time favor.
  Fixed properly by college-DB login (see below), not by this codebase alone.
- **No teacher authentication.** Starting, ending, or extending a session,
  and reading session history, has no auth check — anyone with the URL can
  do any of it. Acceptable for a single-teacher demo; not for shared/real use.
- **Public GitHub repo.** Made public to unblock Render's free deploy flow.
  No secrets are committed (`.env` is gitignored), but the source itself is
  visible to anyone.

## Setup (local)

```bash
npm install
cp .env.example .env      # edit MONGO_URI if not running Mongo locally
npm start
```

Requires a running MongoDB (local `mongod`/Windows service, or a free Atlas
cluster — just point `MONGO_URI` at it).

## Using it

- Teacher: open `/teacher.html`, tap "Capture classroom location" while
  standing in the room, optionally paste enrolled roll numbers, start the
  session. Project this page — the QR rotates every 10s. Use "+5 min" to
  extend a running (or just-expired) session instead of restarting it.
- Student: open `/student.html` on a phone, enter roll number + name, tap
  "Scan classroom QR" (or upload a photo of it if no camera), allow camera +
  location permission.
- History: open `/history.html` to browse past sessions, see who was
  flagged and why, and download a CSV.

## Deployment

- **Code**: [github.com/RavisankarMR-design/collegeproject](https://github.com/RavisankarMR-design/collegeproject)
  (public) — pushing to `main` auto-deploys via Render's GitHub App
  connection.
- **Database**: MongoDB Atlas, free M0 cluster, network access open to
  `0.0.0.0/0` (Render's free tier has no static IP).
- **Host**: Render, free web service. Spins down after ~15 min idle — first
  request after a gap takes 30-50s to wake up. Fine for a demo, worth
  knowing about beforehand so it isn't mistaken for broken.

## Where to go next (Phase 2 — scoped, not built)

- **College DB login for students** — replaces self-typed roll
  number/name with real authentication (SSO, or whatever the college
  exposes), and lets device binding lock to a verified identity instead of
  "whoever scanned first." Also removes manual roster paste — the roster
  could be pulled automatically per section.
- **BLE/RSSI proximity** as a second, floor/room-precise signal alongside
  GPS — the actual fix for the GPS-precision limitation above, not a config
  tweak.
- **Confidence-scored geofence** instead of a hard 30m cutoff — combine
  distance + GPS accuracy + device history into a score; clear accepts and
  clear rejects go through automatically, borderline cases land in a
  teacher-reviewed queue instead of being silently wrong in either direction.
- **Admin panel** to reset a student's bound device (legitimate phone
  changes) without needing direct DB access.
- **Socket.io push** instead of polling for the live present/flagged lists.
- **Shared teacher passcode** on session start/end/extend/history endpoints.
