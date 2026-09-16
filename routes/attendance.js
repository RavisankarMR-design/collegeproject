const express = require('express');
const mongoose = require('mongoose');
const Session = require('../models/Session');
const Student = require('../models/Student');
const Attendance = require('../models/Attendance');
const FlaggedAttempt = require('../models/FlaggedAttempt');
const { verifyToken, verifyShortCode } = require('../utils/token');
const { distanceMeters } = require('../utils/geo');
const { requireAuth } = require('../utils/auth');

async function flag(io, session, { rollNo, name, deviceId }, reason, detail, distance, accuracy) {
  try {
    const attempt = await FlaggedAttempt.create({
      session: session._id,
      rollNo,
      name,
      reason,
      detail,
      distanceMeters: distance,
      accuracyMeters: accuracy,
      deviceId,
    });
    io.to(String(session._id)).emit('flagged', attempt);
  } catch {
    // logging/pushing a flag must never block the actual reject response
  }
}

// A GPS fix this coarse (common indoors, where phones fall back to
// WiFi/cell-tower positioning) can be tens of meters off in any direction —
// not worth comparing to a room-scale geofence at all.
// ponytail: fixed cap, not per-session-configurable; revisit if a session
// ever needs a much larger legitimate radius (e.g. an outdoor field).
const MAX_ACCEPTABLE_ACCURACY_METERS = 100;

const router = express.Router();

// Student submits either the raw QR payload they scanned, OR — when the QR
// can't be displayed (broken projector, etc) — the session's short display
// code plus the 4-digit rotating code read off the teacher's screen. Either
// way: their roll number, current GPS coords, and a per-device id generated
// client-side (see public/student.html) and stored persistently on that
// device. Identity (email + name) comes only from the verified Google
// sign-in, never from the request body.
router.post('/mark', requireAuth('student'), async (req, res) => {
  try {
    const io = req.app.get('io');
    const { email, name, role } = req.user;
    const isAdmin = role === 'admin';
    const { payload, sessionCode, code, rollNo, lat, lng, accuracy, deviceId } = req.body;

    if ((!payload && !(sessionCode && code)) || !rollNo || lat == null || lng == null || !deviceId) {
      return res.status(400).json({ error: 'A QR scan (or session code + live code), rollNo, lat, lng, deviceId are all required' });
    }

    if (accuracy != null && accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
      return res.status(400).json({
        error: `Your location isn't precise enough right now (~${Math.round(accuracy)}m accuracy). Move near a window or wait a few seconds for GPS to lock, then rescan.`,
      });
    }

    let session;
    if (payload) {
      const parts = String(payload).split('|');
      if (parts.length !== 3) return res.status(400).json({ error: 'Malformed QR — please rescan' });
      const [sessionId, windowIndex, token] = parts;
      if (!mongoose.Types.ObjectId.isValid(sessionId)) {
        return res.status(400).json({ error: 'Malformed QR — please rescan' });
      }

      session = await Session.findById(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!session.active || Date.now() > session.endTime.getTime()) {
        return res.status(410).json({ error: 'This session has ended' });
      }

      // 1. Rotating-token check — blocks a QR photo/screenshot taken earlier.
      const tokenCheck = verifyToken(session.secret, sessionId, windowIndex, token, session.windowSeconds);
      if (!tokenCheck.valid) return res.status(400).json({ error: tokenCheck.reason });
    } else {
      session = await Session.findOne({ displayCode: String(sessionCode).trim().toUpperCase() });
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!session.active || Date.now() > session.endTime.getTime()) {
        return res.status(410).json({ error: 'This session has ended' });
      }

      // 1. Rotating-code check — same guarantee as the QR's rotating token,
      // just typed instead of scanned.
      const codeCheck = verifyShortCode(session.secret, session._id, code, session.windowSeconds);
      if (!codeCheck.valid) return res.status(400).json({ error: codeCheck.reason });
    }

    // 2. Geofence check — blocks scanning the (still-valid) QR from outside class,
    //    e.g. a friend photographing/video-calling the live code to someone off-campus.
    //
    // A raw "distance <= radius" comparison treats the GPS reading as exact,
    // which it isn't — accuracy is itself a margin of error. So the reported
    // uncertainty circle is used to split into three cases instead of one
    // cutoff: definitely inside (accept), definitely outside even in the best
    // case (reject), and the boundary straddling both (accept, but flagged as
    // borderline so the teacher can see it wasn't a clean read).
    const distance = distanceMeters(lat, lng, session.classroom.lat, session.classroom.lng);
    const radius = session.classroom.radiusMeters;
    const margin = accuracy == null ? 0 : accuracy;

    if (distance - margin > radius) {
      const detail = `~${Math.round(distance)}m from the classroom (limit ${radius}m)`;
      await flag(io, session, { rollNo, name, deviceId }, 'outside_geofence', detail, distance, accuracy);
      return res.status(403).json({ error: `You appear to be ${detail}.` });
    }
    const borderline = distance + margin > radius;

    const normalizedRoll = rollNo.trim().toUpperCase();

    // Roll numbers here are always 9 digits (e.g. 240701424). Admin is
    // exempt — it uses arbitrary test values, isolated from real students.
    if (!isAdmin && !/^\d{9}$/.test(normalizedRoll)) {
      return res.status(400).json({ error: 'Roll number must be 9 digits (e.g. 240701424).' });
    }

    // 3. Roster check — with an enrolled list set, only those roll numbers can
    //    ever be marked present, so a 30-student class can't end up with 31 records.
    if (session.roster.length > 0 && !session.roster.includes(normalizedRoll)) {
      await flag(io, session, { rollNo, name, deviceId }, 'not_enrolled', `Roll number "${rollNo}" is not on this session's roster`, distance, accuracy);
      return res.status(403).json({ error: 'This roll number is not enrolled in this class session.' });
    }

    // 4/5. Identity consistency + device binding — skipped entirely for
    // admin. Admin is a testing/demo account, not a real student: it must
    // never touch the deviceId uniqueness lock (that would burn a real
    // device slot or get locked out by one) or the email<->rollNo lock
    // (admin needs to run arbitrary roll numbers through the flow).
    let student;
    if (isAdmin) {
      // A fixed, namespaced roll number — never whatever the admin typed —
      // so a test scan can never occupy (or collide with) a real student's
      // roll number in the shared Student collection.
      student = await Student.findOne({ email });
      if (!student) student = await Student.create({ email, rollNo: 'ADMIN-TEST', name });
    } else {
      // Identity consistency — still blocks two different accounts from
      // claiming the same roll number. But a signed-in account correcting
      // its OWN roll number (mistyped it the first time) is no longer
      // blocked — no self-service fix existed for that until real college
      // DB roll numbers are wired in, so for now it just overwrites the
      // roll on the account and logs a flag for the teacher to see.
      const [studentByEmail, studentByRoll] = await Promise.all([
        Student.findOne({ email }),
        Student.findOne({ rollNo: normalizedRoll }),
      ]);

      if (studentByRoll && studentByRoll.email !== email) {
        await flag(io, session, { rollNo, name, deviceId }, 'identity_mismatch', `Roll number "${normalizedRoll}" is already registered to a different account`, distance, accuracy);
        return res.status(403).json({ error: 'This roll number is already registered to a different account.' });
      }
      if (studentByEmail && studentByEmail.rollNo !== normalizedRoll) {
        const oldRoll = studentByEmail.rollNo;
        studentByEmail.rollNo = normalizedRoll;
        await studentByEmail.save();
        await flag(io, session, { rollNo, name, deviceId }, 'roll_number_changed', `Account switched from roll "${oldRoll}" to "${normalizedRoll}"`, distance, accuracy);
      }

      // Device-binding check — a device can only ever be the first-binder
      // for one student (models/Student.js enforces this with a unique
      // index on deviceId), so one phone can't mark several different
      // people present across their first-ever scans.
      student = studentByEmail;
      try {
        if (!student) {
          student = await Student.create({ email, rollNo: normalizedRoll, name, deviceId });
        } else if (!student.deviceId) {
          student.deviceId = deviceId;
          await student.save();
        } else if (student.deviceId !== deviceId) {
          await flag(io, session, { rollNo, name, deviceId }, 'device_mismatch', 'Account already bound to a different device', distance, accuracy);
          return res.status(403).json({
            error: 'Your account is already bound to a different device. Ask the teacher to reset it if this is a new phone.',
          });
        }
      } catch (err) {
        if (err.code === 11000) {
          await flag(io, session, { rollNo, name, deviceId }, 'device_mismatch', 'This device is already registered to a different account', distance, accuracy);
          return res.status(403).json({ error: 'This device is already registered to a different account.' });
        }
        throw err;
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
      });
      io.to(String(session._id)).emit('present', {
        student: { rollNo: student.rollNo, name: student.name },
        distanceMeters: distance,
        accuracyMeters: accuracy,
        borderline,
        markedAt: record.markedAt,
      });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
