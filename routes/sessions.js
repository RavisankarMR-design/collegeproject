const express = require('express');
const crypto = require('crypto');
const Session = require('../models/Session');
const Attendance = require('../models/Attendance');
const FlaggedAttempt = require('../models/FlaggedAttempt');
const { currentWindow, generateToken } = require('../utils/token');

const router = express.Router();

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Past + current sessions for the history page, newest first, with how many
// students were marked present in each. `secret` must never leave the server.
router.get('/', async (req, res) => {
  try {
    const sessions = await Session.find().select('-secret').sort({ startTime: -1 }).limit(100);

    const counts = await Attendance.aggregate([{ $group: { _id: '$session', count: { $sum: 1 } } }]);
    const countBySession = Object.fromEntries(counts.map((c) => [String(c._id), c.count]));

    res.json(sessions.map((s) => ({
      sessionId: s._id,
      subject: s.subject,
      teacherName: s.teacherName,
      startTime: s.startTime,
      endTime: s.endTime,
      active: s.active,
      rosterSize: s.roster.length,
      presentCount: countBySession[String(s._id)] || 0,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Teacher starts a session. classroom lat/lng is normally captured from the
// teacher's own device (browser Geolocation API) at the moment class starts.
// `roster` (optional) is the list of roll numbers enrolled in this class —
// when set, only those roll numbers can be marked present.
router.post('/', async (req, res) => {
  try {
    const { subject, teacherName, lat, lng, radiusMeters, durationMinutes, roster } = req.body;
    if (!subject || !teacherName || lat == null || lng == null || !durationMinutes) {
      return res.status(400).json({ error: 'subject, teacherName, lat, lng, durationMinutes are required' });
    }

    const normalizedRoster = Array.isArray(roster)
      ? [...new Set(roster.map((r) => String(r).trim().toUpperCase()).filter(Boolean))]
      : [];

    const session = await Session.create({
      subject,
      teacherName,
      secret: crypto.randomBytes(16).toString('hex'),
      classroom: { lat, lng, radiusMeters: radiusMeters || 30 },
      endTime: new Date(Date.now() + durationMinutes * 60000),
      roster: normalizedRoster,
    });

    res.status(201).json({
      sessionId: session._id,
      subject: session.subject,
      teacherName: session.teacherName,
      classroom: session.classroom,
      windowSeconds: session.windowSeconds,
      endTime: session.endTime,
      rosterSize: session.roster.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Session summary for the teacher panel (subject, roster size, live status).
router.get('/:id', async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({
      sessionId: session._id,
      subject: session.subject,
      teacherName: session.teacherName,
      classroom: session.classroom,
      windowSeconds: session.windowSeconds,
      endTime: session.endTime,
      active: session.active,
      rosterSize: session.roster.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Flagged (rejected, proxy-like) scan attempts for the teacher panel.
router.get('/:id/flagged', async (req, res) => {
  try {
    const flags = await FlaggedAttempt.find({ session: req.params.id }).sort({ createdAt: -1 });
    res.json(flags);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Polled by the teacher's projector/display page every few seconds.
// Returns the QR payload string for the CURRENT rotating window.
router.get('/:id/current-qr', async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.active || Date.now() > session.endTime.getTime()) {
      return res.status(410).json({ error: 'Session has ended' });
    }

    const windowIndex = currentWindow(session.windowSeconds);
    const token = generateToken(session.secret, session._id, windowIndex);
    const payload = `${session._id}|${windowIndex}|${token}`;

    const msIntoWindow = Date.now() % (session.windowSeconds * 1000);
    const msLeftInWindow = session.windowSeconds * 1000 - msIntoWindow;

    res.json({ payload, msLeftInWindow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live list for the teacher dashboard.
router.get('/:id/attendance', async (req, res) => {
  try {
    const records = await Attendance.find({ session: req.params.id })
      .populate('student', 'rollNo name')
      .sort({ markedAt: 1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Attendance for one session as a downloadable CSV.
// deviceId is deliberately left out — it's a fingerprint hash the teacher has
// no use for, and this endpoint is unauthenticated.
router.get('/:id/export.csv', async (req, res) => {
  try {
    const session = await Session.findById(req.params.id).select('-secret');
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const records = await Attendance.find({ session: session._id })
      .populate('student', 'rollNo name')
      .sort({ markedAt: 1 });

    const rows = [
      ['Roll No', 'Name', 'Marked At', 'Distance (m)', 'GPS Accuracy (m)', 'Borderline'],
      ...records.map((r) => [
        r.student ? r.student.rollNo : '',
        r.student ? r.student.name : '',
        new Date(r.markedAt).toISOString(),
        Math.round(r.distanceMeters),
        r.accuracyMeters == null ? '' : Math.round(r.accuracyMeters),
        r.borderline ? 'yes' : '',
      ]),
    ];

    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
    const filename = `attendance-${session.subject.replace(/[^a-z0-9]+/gi, '-')}-${new Date(session.startTime).toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push a live session's end time further out, e.g. class ran long.
router.post('/:id/extend', async (req, res) => {
  try {
    const minutes = Number(req.body.minutes) || 15;
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Extend from now if it already ended, otherwise add onto the current end time.
    const base = Math.max(session.endTime.getTime(), Date.now());
    session.endTime = new Date(base + minutes * 60000);
    session.active = true;
    await session.save();

    res.json({ ok: true, endTime: session.endTime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/end', async (req, res) => {
  try {
    const session = await Session.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
