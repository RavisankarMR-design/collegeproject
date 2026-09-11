# Anti-Proxy Attendance — Demo 1

Rotating signed QR + GPS geofence + device binding + one-scan-per-session enforcement.

## Why this design (for your viva)

A QR that just "changes every 10 seconds" only stops *replaying an old code later*.
It does **not** stop the real attack: a friend in class points a camera at the
*currently valid* QR and video-calls it to someone off-campus, who scans that
live frame within the same 10s window. That's why rotation alone is not enough —
this build stacks four independent checks, and a scan is only accepted if it
passes all of them:

1. **Rotating HMAC-signed token** (`utils/token.js`) — the secret used to sign
   each 10s token never leaves the server, so a token can't be forged and a
   captured QR image is worthless once its window closes.
2. **GPS geofence** (`utils/geo.js`) — the scan's coordinates must fall within
   a configurable radius of the classroom center captured at session start.
3. **Device binding** (`models/Student.js`) — a roll number is locked to the
   first device it's scanned from; a second phone can't mark attendance for
   that roll number.
4. **One record per student per session** — enforced at the database level
   (unique index on `Attendance`), so a duplicate scan is rejected outright.

## Known limitations (good to state upfront, not hide)

- GPS can be spoofed with mock-location tools, and is imprecise indoors.
  The natural Phase 2 upgrade is BLE proximity (teacher's device broadcasts a
  rotating token over Bluetooth, student app confirms via signal strength) —
  much harder to fake remotely, at the cost of needing native/React Native
  instead of a browser for full iOS + Android support.
- Device binding assumes a student doesn't factory-reset/clear storage to
  re-bind — an admin reset flow is the standard fix, not built here yet.

## Setup

```bash
npm install
cp .env.example .env      # edit MONGO_URI if not running Mongo locally
npm start
```

Requires a running MongoDB (local `mongod`, or a free Atlas cluster — just
point `MONGO_URI` at it).

## Using it

- Teacher: open `http://localhost:4000/teacher.html`, tap "Capture classroom
  location" while standing in the room, fill in the form, start the session.
  Project this page — the QR auto-refreshes every 2s (new token every 10s).
- Student: open `http://localhost:4000/student.html` on a phone, enter roll
  number + name, tap "Scan classroom QR", allow camera + location permission.

## Where to go next (Phase 2 ideas for your report)

- BLE/RSSI proximity as a second, harder-to-spoof signal alongside GPS.
- Admin panel to reset a student's bound device.
- Socket.io push instead of polling for the live present list.
- Export attendance as CSV/PDF per session.
