const express = require('express');
const mongoose = require('mongoose');
const Session = require('../models/Session');
const Student = require('../models/Student');
const Attendance = require('../models/Attendance');
const FlaggedAttempt = require('../models/FlaggedAttempt');
const { verifyToken } = require('../utils/token');
const { distanceMeters } = require('../utils/geo');

function flag(session, { rollNo, name, deviceId }, reason, detail, distance) {
  return FlaggedAttempt.create({
    session: session._id,
    rollNo,
    name,
    reason,
    detail,
    distanceMeters: distance,
    deviceId,
  }).catch(() => {}); // logging a flag must never block the actual response
}

const router = express.Router();

// Student submits: the raw QR payload they scanned, their roll no/name,
// their current GPS coords, and a per-device id generated client-side
// (see public/student.html) and stored persistently on that device.
router.post('/mark', async (req, res) => {
  try {
    const { payload, rollNo, name, lat, lng, deviceId } = req.body;

    if (!payload || !rollNo || !name || lat == null || lng == null || !deviceId) {
      return res.status(400).json({ error: 'payload, rollNo, name, lat, lng, deviceId are all required' });
    }

    const parts = String(payload).split('|');
    if (parts.length !== 3) return res.status(400).json({ error: 'Malformed QR — please rescan' });
    const [sessionId, windowIndex, token] = parts;
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ error: 'Malformed QR — please rescan' });
    }

    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.active || Date.now() > session.endTime.getTime()) {
      return res.status(410).json({ error: 'This session has ended' });
    }

    // 1. Rotating-token check — blocks a QR photo/screenshot taken earlier.
    const tokenCheck = verifyToken(session.secret, sessionId, windowIndex, token, session.windowSeconds);
    if (!tokenCheck.valid) return res.status(400).json({ error: tokenCheck.reason });

    // 2. Geofence check — blocks scanning the (still-valid) QR from outside class,
    //    e.g. a friend photographing/video-calling the live code to someone off-campus.
    const distance = distanceMeters(lat, lng, session.classroom.lat, session.classroom.lng);
    if (distance > session.classroom.radiusMeters) {
      const detail = `~${Math.round(distance)}m from the classroom (limit ${session.classroom.radiusMeters}m)`;
      await flag(session, { rollNo, name, deviceId }, 'outside_geofence', detail, distance);
      return res.status(403).json({ error: `You appear to be ${detail}.` });
    }

    // 3. Roster check — with an enrolled list set, only those roll numbers can
    //    ever be marked present, so a 30-student class can't end up with 31 records.
    const normalizedRoll = rollNo.trim().toUpperCase();
    if (session.roster.length > 0 && !session.roster.includes(normalizedRoll)) {
      await flag(session, { rollNo, name, deviceId }, 'not_enrolled', `Roll number "${rollNo}" is not on this session's roster`, distance);
      return res.status(403).json({ error: 'This roll number is not enrolled in this class session.' });
    }

    // 4. Device-binding check — blocks one phone marking attendance for
    //    multiple roll numbers.
    let student = await Student.findOne({ rollNo });
    if (!student) {
      student = await Student.create({ rollNo, name, deviceId });
    } else if (!student.deviceId) {
      student.deviceId = deviceId;
      await student.save();
    } else if (student.deviceId !== deviceId) {
      await flag(session, { rollNo, name, deviceId }, 'device_mismatch', 'Roll number already bound to a different device', distance);
      return res.status(403).json({
        error: 'This roll number is already bound to a different device. Ask the teacher/admin to reset it if this is a new phone.',
      });
    }

    // 5. Duplicate-scan check — the unique (session, student) index does the
    //    actual enforcement; this catch just turns the DB error into a clean message.
    try {
      const record = await Attendance.create({
        session: session._id,
        student: student._id,
        distanceMeters: distance,
        deviceId,
      });
      return res.status(201).json({ ok: true, distanceMeters: Math.round(distance), markedAt: record.markedAt });
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
