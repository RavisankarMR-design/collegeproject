const express = require('express');
const mongoose = require('mongoose');
const Session = require('../models/Session');
const Student = require('../models/Student');
const Attendance = require('../models/Attendance');
const FlaggedAttempt = require('../models/FlaggedAttempt');
const { verifyToken, verifyShortCode } = require('../utils/token');
const { distanceMeters } = require('../utils/geo');
const { requireAuth } = require('../utils/auth');
const { rateLimit } = require('../utils/rateLimit');
const { createFailureTracker } = require('../utils/failureTracker');
const { serverError, isNum } = require('../utils/http');
const { clientIp } = require('../utils/ip');

// Students only ever see/type the 4-digit rotating code, never a session
// identifier — so a code alone has to be matched against every currently
// active session's current (and previous) window. Cheap: only sessions
// with active:true and a future endTime are candidates, which in practice
// is a handful of concurrently running classes, not the whole collection.
// Two concurrent classes can (rarely, ~1 in 10,000) show the same 4 digits in
// the same window — when that happens, the student's own GPS picks the
// session whose classroom they're actually standing in.
async function findSessionByShortCode(code, lat, lng) {
  const candidates = await Session.find({ active: true, endTime: { $gt: new Date() } });
  const matches = candidates.filter((s) => verifyShortCode(s.secret, s._id, code, s.windowSeconds).valid);
  if (matches.length <= 1) return matches[0] || null;
  const dist = (s) => distanceMeters(lat, lng, s.classroom.lat, s.classroom.lng);
  return matches.reduce((best, s) => (dist(s) < dist(best) ? s : best));
}

// One identical flag per account/session/reason per 30s — otherwise a single
// student replaying a bad request can bury the teacher's flag list.
const recentFlags = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of recentFlags) if (now - t > 30_000) recentFlags.delete(k);
}, 30_000).unref();

async function flag(io, session, { rollNo, name, deviceId, email }, reason, detail, distance, accuracy) {
  try {
    const key = `${session._id}|${email || rollNo}|${reason}`;
    if (recentFlags.has(key) && Date.now() - recentFlags.get(key) < 30_000) return;
    recentFlags.set(key, Date.now());

    const attempt = await FlaggedAttempt.create({
      session: session._id,
      rollNo: String(rollNo).slice(0, 30),
      name,
      reason,
      detail: String(detail).slice(0, 300),
      distanceMeters: distance,
      accuracyMeters: accuracy,
      deviceId,
    });
    const { deviceId: _omit, ...safe } = attempt.toObject(); // never push the device credential
    void _omit;
    io.to(String(session._id)).emit('flagged', safe);
  } catch {
    // logging/pushing a flag must never block the actual reject response
  }
}

// Neither of these ever blocks the scan or changes the response — they're a
// heuristic nudge logged for the teacher to eyeball (via the existing
// flagged-attempts list), not proof of cheating. False positives here are
// expected and cheap; a false REJECTION would not be.

// One person walking in with two already-registered phones (their own +
// an absent friend's) passes geofence and device-binding cleanly — both
// phones are genuinely inside the room. The one shared signal that setup
// still leaves behind: the two scans land within a couple meters and
// seconds of each other, session after session. It also catches a ring of
// scripted clients all reporting the same made-up coordinates.
async function checkPassAlong(io, session, record, student, lat, lng, deviceId) {
  try {
    const since = new Date(record.markedAt.getTime() - 90_000);
    const nearby = await Attendance.find({
      session: session._id,
      _id: { $ne: record._id },
      markedAt: { $gte: since },
      lat: { $ne: null },
      lng: { $ne: null },
    }).populate('student', 'rollNo name');

    for (const other of nearby) {
      if (!other.student || other.deviceId === deviceId) continue;
      const gap = distanceMeters(lat, lng, other.lat, other.lng);
      if (gap <= 3) {
        const seconds = Math.round(Math.abs(record.markedAt - other.markedAt) / 1000);
        const detail = `Within ~${Math.round(gap)}m and ${seconds}s of roll "${other.student.rollNo}" — possibly one person carrying two phones.`;
        await flag(io, session, { rollNo: student.rollNo, name: student.name, deviceId, email: `${student.email}|${other.student.rollNo}` }, 'possible_proxy_pattern', detail, null, null);
      }
    }
  } catch {
    // best-effort heuristic only
  }
}

function isPrivateIp(ip) {
  const v4 = String(ip || '').replace('::ffff:', '');
  return v4 === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v4);
}

// A spoofed GPS fix (fake-GPS app, DevTools override) can claim to be
// inside the classroom while the connection's real IP address geolocates
// somewhere else entirely — IP geolocation is coarse (city-level, and
// useless on carrier NAT/VPNs) so this is a loose sanity check, not proof.
// Off unless IP_GEOLOOKUP=1: ip-api.com's free tier is plain HTTP only, so this
// sends each student's IP to a third party unencrypted — which public/privacy.html
// says never happens. Enable only after updating that page.
async function checkIpMismatch(io, session, record, student, deviceId, ip) {
  try {
    if (process.env.IP_GEOLOOKUP !== '1') return;
    if (!ip || isPrivateIp(ip)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,lat,lon`, { signal: controller.signal });
    clearTimeout(timer);
    const geo = await res.json();
    if (geo.status !== 'success') return;

    const gap = distanceMeters(geo.lat, geo.lon, session.classroom.lat, session.classroom.lng);
    if (gap > 50_000) {
      const detail = `Reported GPS is inside the classroom, but this connection's IP geolocates ~${Math.round(gap / 1000)}km away — possible location spoofing.`;
      await flag(io, session, { rollNo: student.rollNo, name: student.name, deviceId, email: student.email }, 'ip_location_mismatch', detail, null, null);
    }
  } catch {
    // best-effort network heuristic — a slow/failed lookup must never affect the response already sent
  }
}

// A GPS fix this coarse (common indoors, where phones fall back to
// WiFi/cell-tower positioning) can be tens of meters off in any direction —
// not worth comparing to a room-scale geofence at all.
// ponytail: fixed cap, not per-session-configurable; revisit if a session
// ever needs a much larger legitimate radius (e.g. an outdoor field).
const MAX_ACCEPTABLE_ACCURACY_METERS = 100;

// Real Chrome-on-Android or real Safari-on-iOS only. On iOS every browser
// (Chrome, Firefox, Edge) is required by Apple to use Safari's WebKit engine
// and still reports "Safari" in its UA, so they're told apart by their own
// extra token (CriOS/FxiOS/EdgiOS/OPiOS). On Android, browsers built on
// Chromium (Samsung Internet, Edge, Opera, Brave) also include "Chrome" in
// their UA, so those are excluded the same way.
function isAllowedBrowser(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone|iPad|iPod/.test(ua)) {
    return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  }
  return /Chrome/.test(ua) && !/SamsungBrowser|Edg\/|OPR\/|Firefox|UCBrowser|MiuiBrowser/.test(ua);
}

const router = express.Router();

// Bounds abuse of the mark endpoint. Keyed per signed-in user, not per IP: a
// whole class shares one campus WiFi IP.
const markLimiter = rateLimit({ windowMs: 60_000, max: 20, key: (req) => req.user.email });

// 6 wrong codes / forged tokens in 10 minutes -> locked out for 10 minutes.
const guessTracker = createFailureTracker({ maxFailures: 6, windowMs: 10 * 60_000, lockMs: 10 * 60_000 });

// Student submits either the raw QR payload they scanned, OR — when the QR
// can't be displayed (broken projector, etc) — the live 4-digit code read off
// the teacher's screen (see findSessionByShortCode). Either way: their roll
// number, current GPS coords, and a per-device id generated client-side (see
// public/student.html) and stored persistently on that device. Identity
// (email + name) comes only from the verified Google sign-in, never from the
// request body.
router.post('/mark', requireAuth('student'), markLimiter, async (req, res) => {
  try {
    const io = req.app.get('io');
    const { email, name, role } = req.user;
    const isAdmin = role === 'admin';
    const { payload, code, rollNo, lat, lng, accuracy, deviceId } = req.body;
    const bad = (msg) => res.status(400).json({ error: msg });

    // ---- shape validation: anything malformed is a 400 before it can reach
    // ---- the geofence math, the database, or the flag log.
    if ((!payload && !code) || !rollNo || lat == null || lng == null || !deviceId) {
      return bad('A QR scan (or live code), rollNo, lat, lng, deviceId are all required');
    }
    if (payload !== undefined && (typeof payload !== 'string' || payload.length > 200)) return bad('Malformed QR — please rescan');
    if (!payload && (!['string', 'number'].includes(typeof code) || String(code).trim().length < 1 || String(code).trim().length > 8)) {
      return bad('Enter the live code shown on the teacher\'s screen.');
    }
    if (typeof rollNo !== 'string' || rollNo.trim().length > 30) return bad('Wrong roll number format — must be 24070 followed by 4 digits (e.g. 240701424).');
    if (typeof deviceId !== 'string' || deviceId.length > 128) return bad('Invalid device id.');
    // Strict numbers only: a string/NaN/Infinity here would make every distance
    // comparison below silently false and wave the scan through the geofence.
    if (!isNum(lat) || !isNum(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return bad('Invalid location.');
    if (accuracy != null && (!isNum(accuracy) || accuracy < 0)) return bad('Invalid location accuracy.');
    if (accuracy != null && accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
      return bad(`Your location isn't precise enough right now (~${Math.round(accuracy)}m accuracy). Move near a window or wait a few seconds for GPS to lock, then rescan.`);
    }
    // ponytail: User-Agent is client-reported and trivially spoofed by anyone
    // who opens devtools — this stops "just open a different browser app to
    // get a fresh device id" (the common, low-effort version of that trick),
    // not a deliberate attacker willing to edit headers. Admin is exempt,
    // same as the format/roster bypass — it's a test account run from
    // whatever browser is convenient.
    if (!isAdmin && !isAllowedBrowser(req.headers['user-agent'])) {
      return res.status(403).json({ error: 'Please use Chrome (Android) or Safari (iPhone) to mark attendance.' });
    }

    const normalizedRoll = rollNo.trim().toUpperCase();
    // Roll numbers here are always "24070" + 4 digits (e.g. 240701424) — the
    // prefix is fixed, only the last 4 digits vary per student. Admin is
    // exempt — it uses arbitrary test values, isolated from real students.
    // Keep in sync with public/student.html's validRollNo — that's just a
    // client-side pre-check, this is the rule that's actually enforced.
    if (!isAdmin && !/^24070\d{4}$/.test(normalizedRoll)) {
      return bad('Wrong roll number format — must be 24070 followed by 4 digits (e.g. 240701424).');
    }

    // Guessing the code / forging tokens locks the account out for a while.
    if (!isAdmin) {
      const lockedMs = guessTracker.lockedFor(email);
      if (lockedMs) {
        return res.status(429).json({ error: `Too many wrong codes — try again in ${Math.ceil(lockedMs / 60_000)} minute(s).` });
      }
    }

    let session;
    if (payload) {
      const parts = payload.split('|');
      if (parts.length !== 3) return bad('Malformed QR — please rescan');
      const [sessionId, windowIndex, token] = parts;
      if (!mongoose.Types.ObjectId.isValid(sessionId)) return bad('Malformed QR — please rescan');

      session = await Session.findById(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!session.active || Date.now() > session.endTime.getTime()) {
        return res.status(410).json({ error: 'This session has ended' });
      }

      // 1. Rotating-token check — blocks a QR photo/screenshot taken earlier.
      const tokenCheck = verifyToken(session.secret, sessionId, windowIndex, token, session.windowSeconds);
      if (!tokenCheck.valid) {
        if (tokenCheck.forged && !isAdmin) guessTracker.record(email);
        return bad(tokenCheck.reason);
      }
    } else {
      // 1. Rotating-code check — same guarantee as the QR's rotating token,
      // just typed instead of scanned. The 4-digit code alone doesn't name a
      // session, so it's checked against every currently active session.
      session = await findSessionByShortCode(String(code).trim(), lat, lng);
      if (!session) {
        if (!isAdmin) guessTracker.record(email);
        return res.status(404).json({ error: 'Code expired or incorrect — check the live code and try again' });
      }
    }

    const who = { rollNo: normalizedRoll, name, deviceId, email };

    // 2. Geofence check — blocks scanning the (still-valid) QR from outside class,
    //    e.g. a friend photographing/video-calling the live code to someone off-campus.
    //
    // A raw "distance <= radius" comparison treats the GPS reading as exact,
    // which it isn't — accuracy is itself a margin of error. So the reported
    // uncertainty circle is used to split into three cases instead of one
    // cutoff: definitely inside (accept), definitely outside even in the best
    // case (reject), and the boundary straddling both (accept, but flagged as
    // borderline so the teacher can see it wasn't a clean read).
    //
    // The margin is capped at the radius itself. `accuracy` is client-reported,
    // so an uncapped margin would let anyone claim +-100m and stand 130m away
    // from a 30m fence; capped, the farthest a scan can ever be is 2x the radius.
    const distance = distanceMeters(lat, lng, session.classroom.lat, session.classroom.lng);
    const radius = session.classroom.radiusMeters;
    const margin = Math.min(accuracy == null ? 0 : accuracy, radius);

    if (distance - margin > radius) {
      const detail = `~${Math.round(distance)}m from the classroom (limit ${radius}m)`;
      await flag(io, session, who, 'outside_geofence', detail, distance, accuracy);
      return res.status(403).json({ error: `You appear to be ${detail}.` });
    }
    const borderline = distance + margin > radius;

    // 3. Roster check — with an enrolled list set, only those roll numbers can
    //    ever be marked present, so a 30-student class can't end up with 31 records.
    //    Admin is exempt, same as the format check above — it's a test/demo
    //    account, never a real enrolled roll number.
    if (!isAdmin && session.roster.length > 0 && !session.roster.includes(normalizedRoll)) {
      await flag(io, session, who, 'not_enrolled', `Roll number "${normalizedRoll}" is not on this session's roster`, distance, accuracy);
      return res.status(403).json({ error: 'This roll number is not enrolled in this class session.' });
    }

    // 4/5. Identity consistency + device binding — skipped entirely for
    // admin. Admin is a testing/demo account, not a real student: it must
    // never touch the deviceId uniqueness lock (that would burn a real
    // device slot or get locked out by one) or the email<->rollNo lock
    // (admin needs to run arbitrary roll numbers through the flow).
    let student;
    if (isAdmin) {
      // A fixed, namespaced roll number derived from the admin's own email —
      // never whatever they typed — so a test scan can never occupy (or
      // collide with) a real student's roll number, and two different admin
      // accounts can't collide with each other now that rollNo is unique.
      student = await Student.findOne({ email });
      if (!student) student = await Student.create({ email, rollNo: `ADMIN-${email.split('@')[0].toUpperCase()}`, name });
    } else {
      // Returns { student } or { deny: [status, message] }. Throws on an
      // unexpected DB error, and on a duplicate-email race (see below).
      const bind = async () => {
        const [studentByEmail, studentByRoll] = await Promise.all([
          Student.findOne({ email }),
          Student.findOne({ rollNo: normalizedRoll }),
        ]);

        // Still blocks two different accounts from claiming the same roll number.
        if (studentByRoll && studentByRoll.email !== email) {
          await flag(io, session, who, 'identity_mismatch', `Roll number "${normalizedRoll}" is already registered to a different account`, distance, accuracy);
          return { deny: [403, 'This roll number is already registered to a different account.'] };
        }

        if (studentByEmail && studentByEmail.rollNo !== normalizedRoll) {
          // A student gets exactly one self-service correction (a mistyped
          // roll the first time). Locking it after that closes the gap where
          // an account could keep hopping onto other unclaimed roll numbers —
          // any change past the first needs staff to reset-identity.
          if (studentByEmail.rollLocked) {
            return { deny: [403, 'Your roll number is locked to your account. Ask a staff member to release it if it needs to change again.'] };
          }
          const oldRoll = studentByEmail.rollNo;
          studentByEmail.rollNo = normalizedRoll;
          studentByEmail.rollLocked = true;
          try {
            await studentByEmail.save();
          } catch (err) {
            if (err.code === 11000) {
              await flag(io, session, who, 'identity_mismatch', `Roll number "${normalizedRoll}" is already registered to a different account`, distance, accuracy);
              return { deny: [403, 'This roll number is already registered to a different account.'] };
            }
            throw err;
          }
          await flag(io, session, who, 'roll_number_changed', `Account switched from roll "${oldRoll}" to "${normalizedRoll}"`, distance, accuracy);
        }

        // Device-binding check — a device can only ever be the first-binder
        // for one student (models/Student.js enforces this with a unique
        // index on deviceId), so one phone can't mark several different
        // people present across their first-ever scans.
        let found = studentByEmail;
        try {
          if (!found) {
            found = await Student.create({ email, rollNo: normalizedRoll, name, deviceId });
          } else if (!found.deviceId) {
            found.deviceId = deviceId;
            await found.save();
          } else if (found.deviceId !== deviceId) {
            await flag(io, session, who, 'device_mismatch', 'Account already bound to a different device', distance, accuracy);
            return { deny: [403, 'Your account is already bound to a different device. Ask the teacher to reset it if this is a new phone.'] };
          }
        } catch (err) {
          if (err.code === 11000) {
            // Same account submitted twice at once: the other request created
            // the record first. Not a device problem — let the caller retry.
            if (err.keyPattern && err.keyPattern.email) throw err;
            const dupField = err.keyPattern && err.keyPattern.rollNo ? 'roll number' : 'device';
            await flag(io, session, who, 'device_mismatch', `This ${dupField} is already registered to a different account`, distance, accuracy);
            return { deny: [403, `This ${dupField} is already registered to a different account.`] };
          }
          throw err;
        }
        return { student: found };
      };

      let result;
      try {
        result = await bind();
      } catch (err) {
        if (err.code === 11000 && err.keyPattern && err.keyPattern.email) result = await bind();
        else throw err;
      }
      if (result.deny) return res.status(result.deny[0]).json({ error: result.deny[1] });
      student = result.student;

      // Defence in depth: even if device bindings were reset mid-class, one
      // phone still can't mark two different people in the same session.
      const clash = await Attendance.exists({ session: session._id, deviceId, student: { $ne: student._id } });
      if (clash) {
        await flag(io, session, who, 'device_mismatch', 'This device already marked a different student in this session', distance, accuracy);
        return res.status(403).json({ error: 'This device already marked a different student in this session.' });
      }
    }

    // 6. Duplicate-scan check — the unique (session, student) index does the
    //    actual enforcement; this catch just turns the DB error into a clean message.
    try {
      const record = await Attendance.create({
        session: session._id,
        student: student._id,
        distanceMeters: distance,
        accuracyMeters: accuracy,
        borderline,
        deviceId,
        lat,
        lng,
      });
      if (!isAdmin) guessTracker.clear(email);
      io.to(String(session._id)).emit('present', {
        student: { rollNo: student.rollNo, name: student.name },
        distanceMeters: distance,
        accuracyMeters: accuracy,
        borderline,
        markedAt: record.markedAt,
      });

      // Fire-and-forget — heuristics, must never delay or affect this response.
      if (!isAdmin) {
        checkPassAlong(io, session, record, student, lat, lng, deviceId);
        checkIpMismatch(io, session, record, student, deviceId, clientIp(req));
      }

      return res.status(201).json({
        ok: true,
        distanceMeters: Math.round(distance),
        accuracyMeters: accuracy,
        borderline,
        markedAt: record.markedAt,
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Attendance already marked for this session.' });
      }
      throw err;
    }
  } catch (err) {
    serverError(res, err);
  }
});

module.exports = router;
