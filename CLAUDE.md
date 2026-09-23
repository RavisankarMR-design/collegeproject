# Attendance App — Project Notes

College attendance-tracking web app. Node/Express/MongoDB/Socket.io. Deployed on Render (free tier) + MongoDB Atlas. Repo: github.com/RavisankarMR-design/collegeproject. Live: https://collegeproject-igj6.onrender.com

## Stack & structure

- **Backend**: Express, Mongoose/MongoDB, Socket.io (real-time push), JWT auth, `google-auth-library` (server-side Google token verify)
- **routes/**: `attendance.js` (mark/scan logic, browser gate, session-code matching), `auth.js` (login, Google OAuth), `sessions.js` (create/manage class sessions, QR/code rotation), `students.js` (roster)
- **models/**: `Attendance.js`, `FlaggedAttempt.js`, `Session.js`, `Student.js`
- **utils/**: `access.js`, `auth.js` (JWT), `failureTracker.js` (lockout), `geo.js`, `http.js`, `ip.js`, `rateLimit.js` (per-key, key fn defaults to client IP, periodic cleanup via `setInterval().unref()`)
- **public/**: `index.html` (merged landing+login, Google Sign-In), `auth-client.js` (shared auth/fetch helpers), `teacher.html` (dashboard), `student.html` (scan page), `history.html`, `geo-filter.js` (client-side Kalman GPS filter), `privacy.html`, `style.css`

## Core mechanism

- **Session code**: HMAC-based rotating 4-digit code, per-session secret, 10s window + grace period. Purely cryptographic — `findSessionByShortCode()` scans all active sessions matching a bare 4-digit code against each session's HMAC secret. No session identifier needed from student, no location dependency. Proven via concurrent multi-classroom sims (below) — zero cross-contamination even with identical GPS coords on stacked floors.
- **Geofence**: GPS radius check around session's lat/lng at scan time.
- **Device binding**: `deviceId` = browser/hardware fingerprint + random per-install ID (localStorage/cookie). Blocks a *different* device from claiming an already-bound roll number/account (`device_mismatch` flag). Does NOT stop the same person using a second device they physically hold (see Known Limitations).
- **Browser gate**: Android = Chrome-only; iOS = Safari + Chrome-only (WebKit-engine mandate; India has no DMA/CMA exception unlike EU/UK). Enforced via User-Agent regex, server-side (`isAllowedBrowser()` in `routes/attendance.js`) + client mirror in `student.html` (heads-up only). **Known bypass: UA header is client-supplied and trivially spoofable** (curl/devtools/script) — this is a heads-up gate, not a security boundary, same tier as geofence.
- **IP mismatch check**: `checkIpMismatch()` — IP-geolocation heuristic. **Informational only**, never blocks the scan, just flags for teacher to eyeball.
- **Rate limiting**: per-client-IP (via Cloudflare `CF-Connecting-IP` header, fallback `req.ip`) — login capped 300/min. `/mark` is keyed **per signed-in user email**, not IP, specifically to handle shared campus WiFi/CGNAT (common on Indian carriers — Jio/Airtel/BSNL/ACT all use CGNAT heavily).
- **Account lockout**: `failureTracker.js` — 6 wrong codes/forged tokens → 10-min lock. Separate in-memory throttle, not a `FlaggedAttempt` entry.

## FlaggedAttempt reasons (models/FlaggedAttempt.js)

6 total. Blocking (scan rejected): `outside_geofence`, `device_mismatch`, `not_enrolled`, `identity_mismatch`. Non-blocking/informational (scan still succeeds, just logged): `roll_number_changed` (self-correction), `ip_location_mismatch` (possible GPS spoofing nudge for teacher).

`possible_proxy_pattern` was REMOVED (see below) — do not reintroduce without solving the false-positive problem first.

## Auth

- Real Google OAuth (Google Identity Services / GIS) — Client ID + JWT_SECRET set as Render env vars. `google-auth-library` verifies server-side.
- Fallback: unverified typed-email sign-in (shown only if `googleClientId` isn't configured).
- `Student.init()` called after `mongoose.connect()` in server.js — makes index-build failures crash loudly instead of silently disabling unique constraints (email/deviceId).

## Known limitations (honestly documented, not bugs to "fix")

1. **UA spoofing bypasses browser gate.** No cheap fix without TLS/JA3 fingerprinting or app-level attestation — out of scope for a web app.
2. **One person, two phones = undetected proxy.** Device binding only stops a *stranger's* device. If the same person is physically present holding both phones (their own + an absent friend's, using the friend's real login), both scans look completely legitimate — real GPS, real device-account pairing. No cheap fix without hardware attestation or a human proctor.
3. **Facial/biometric verification** — not implemented. Out of scope unless requested.

See README.md "Known limitations" section for the user-facing writeup, including the exact false-positive numbers from the proximity-heuristic experiment below.

## Removed: `possible_proxy_pattern` heuristic (checkPassAlong)

Tried and removed. It flagged two scans as "possible proxy" if they landed within 3m/90s of each other (same-place-same-time). Simulated a realistic 100-student class: **192 false-positive flags among 96 completely honest, unrelated students (4.21% of all possible pairs)**, purely from real indoor GPS noise (8–40m accuracy, no satellite signal indoors) being larger than both the true-positive gap (two phones in one hand) and the false-positive gap (two students in nearby seats) — a measurement-precision problem, not a tuning problem. Removed entirely: the function, its call site, the enum value, UI labels in `teacher.html`/`history.html`, README docs, related tests. Re-ran the same sim after removal: 0 false positives.

## Optimizations done

- **QR/code polling** (`teacher.html`): was polling server every 1s just to animate a countdown ring, even though the code only rotates once per 10s window. Fixed: countdown ring now ticks locally off the wall clock every 200ms (`renderCountdown()`), server only re-fetched once per actual rotation. Cut teacher-page network traffic ~10x. Verified live: ~10 req/10s → 3 req/10s.
- **Fallback poll intervals** (`refreshList`/`refreshFlagged` in `teacher.html`): 3000ms → 10000ms, since Socket.io is the primary real-time path and already pushes updates instantly (verified live: 9 concurrent marks appeared instantly with no poll firing).
- **Client-side network timeouts**: neither `authFetch()` (`auth-client.js`) nor login `fetch()` (`index.html`) had a timeout — could hang indefinitely on stalled mobile data with a stuck spinner. Added `AbortController`-based 20s timeouts to both, surfacing "Network is too slow right now" / "Could not reach the server" messages.

## Real bugs found & fixed via simulation testing

1. **Edge-for-Android bypass**: `isAllowedBrowser()` excluded `Edg\/` (desktop Edge token) but Android Edge uses `EdgA/` — slash-anchored regex missed it. Fixed: broadened exclusion from `Edg\/` to `Edg` in both `routes/attendance.js` and `public/student.html`. Regression test added with real `EdgA/` UA string.
2. **Duplicate Google Sign-In button rendering**: root cause was Google's own cross-origin iframe rendering an extra personalized row on some navigation paths (e.g. session-expired redirect) — not something JS could suppress from our side. Fixed via CSS clip: `overflow:hidden; height:40px` on the button container, regardless of cause. Plus `google.accounts.id.cancel()` + `auto_select:false` before render to clear leftover One Tap state.
3. **Production MongoDB index-build silently failing**: pre-Google-login-era junk docs (no `email` field, old roll formats) were blocking `email`/`deviceId` unique index builds silently. Fixed by deleting junk docs + adding `Student.init()` to crash loudly on future index failures.

## Testing approach (established pattern — follow this for future changes)

Always use isolated sandbox: unique port + throwaway MongoDB DB name (`sandbox-<purpose>-<timestamp>`), never touch prod/dev data, drop DB after. Simulation scripts live in the session scratchpad (not committed — regenerate as needed):
- Single classroom, 100 students, 60/40 Android/iPhone split, real UA strings, real GPS jitter (8-40m accuracy) — found the Edge-Android bug.
- Two concurrent classrooms, ~25m apart, overlapping 30m geofences (realistic same-campus adjacency, not far-apart "proof" — user explicitly rejected an easier 290km-apart test as a cop-out). Verified zero cross-contamination.
- Four floors, 4 concurrent classrooms, 2 pairs sharing IDENTICAL lat/lng (simulates floor-stacking — GPS has no altitude signal indoors). Verified zero cross-contamination even under this adversarial setup. Had to stagger logins (~230-290ms apart) to respect the real 300/min-per-IP login rate limit — realistic for a whole campus behind CGNAT/shared WiFi.

`test/proxy.test.js` — automated suite, currently 80 tests. Uses `REAL_DEVICE_UA` constant as default UA (needed since browser-gate rejects unrecognized UAs).

## Deployment

- GitHub → Render auto-deploy on push to `main`.
- Render free tier: ~22.8s cold start measured live; warm latency 270-710ms.
- Env vars on Render: `GOOGLE_CLIENT_ID`, `JWT_SECRET`, `EXTRA_STAFF_EMAILS` (status on Render unconfirmed — verify if staff-role edge cases come up), MongoDB Atlas connection string.

## Future ideas (not built)

- [Camera+YOLO headcount cross-check](../../.claude/projects/C--Users-Admin-Desktop-college-project-attendance-app/memory/project_headcount_idea.md) — compare live classroom person-count (YOLOv5n) against marked-attendance count as a coarse group-level fraud signal. Seen in reference repo scan. Doesn't solve the two-phones proxy gap (no identity check), needs camera infra. Not worth building unless proxy abuse becomes a demonstrated real problem.

## Reference repos scanned (github reference/, Desktop/college project/)

Checked 3 repos for new techniques (2026 scan): `Automatic_Attendance_systemV2-main` (only the YOLO headcount idea above was novel), `QR-Code-Based-Attendance-Management-System-main` (static UUID QR, no rotation/geofence/binding — strictly weaker, nothing to take), `smart-attendance-system-main` (fixed 50m Haversine geofence + plain device_id string, no HMAC/crypto binding — cruder version of what we already have). No other new ideas found.

## User's working style

- Demands genuine rigor: real UA strings, real GPS math, isolated sandboxes, honest reporting over "all done" overclaiming.
- Pushes back hard on unrealistic test assumptions (e.g. rejected a 290km-apart "two classrooms" test as a cop-out — wanted same-campus overlapping geofences).
- Wants limitations documented honestly rather than papered over with false-positive-prone heuristics.
- Prefers direct answers; asks to "refer online for info or doubts" when something needs verification rather than assumption (e.g. WebKit/DMA rules, CGNAT prevalence — both confirmed via WebSearch before acting on them).
