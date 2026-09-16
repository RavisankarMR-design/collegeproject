const express = require('express');
const crypto = require('crypto');
const Session = require('../models/Session');
const Attendance = require('../models/Attendance');
const FlaggedAttempt = require('../models/FlaggedAttempt');
const { currentWindow, generateToken } = require('../utils/token');
const { requireAuth } = require('../utils/auth');

const router = express.Router();

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Excludes visually ambiguous characters (0/O, 1/I/L) so a code read off a
// phone screen and typed on a remote/keyboard is never misread.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateDisplayCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

// Past + current sessions for the history page, newest first, with how many
// students were marked present in each. `secret` must never leave the server.
// Staff-only, and scoped to that staff member's own sessions — admin
// sessions are a separate email and never mix into a staff member's history.
router.get('/', requireAuth('staff'), async (req, res) => {
  try {
    const sessions = await Session.find({ teacherEmail: req.user.email }).select('-secret').sort({ startTime: -1 }).limit(100);

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
// when set, only those roll numbers can be marked present. teacherName comes
// from the verified Google sign-in, not a typed field — only a signed-in
// staff account can start a session at all now.
router.post('/', requireAuth('staff'), async (req, res) => {
  try {
    const teacherName = req.user.name;
    const teacherEmail = req.user.email;
    const { subject, lat, lng, radiusMeters, durationMinutes, roster } = req.body;
    if (!subject || lat == null || lng == null || !durationMinutes) {
      return res.status(400).json({ error: 'subject, lat, lng, durationMinutes are required' });
    }

    const normalizedRoster = Array.isArray(roster)
      ? [...new Set(roster.map((r) => String(r).trim().toUpperCase()).filter(Boolean))]
      : [];

    // displayCode has a uniqueness constraint; collisions are astronomically
    // rare at 32^6 combinations but a create() can still race one, so retry
    // a couple of times rather than fail the whole session start on it.
    let session;
    for (let attempt = 0; !session; attempt++) {
      try {
        session = await Session.create({
          subject,
          teacherName,
          teacherEmail,
          secret: crypto.randomBytes(16).toString('hex'),
          classroom: { lat, lng, radiusMeters: radiusMeters || 30 },
          endTime: new Date(Date.now() + durationMinutes * 60000),
          roster: normalizedRoster,
          displayCode: generateDisplayCode(),
        });
      } catch (err) {
        if (err.code !== 11000 || attempt >= 4) throw err;
      }
    }

    res.status(201).json({
      sessionId: session._id,
      subject: session.subject,
      teacherName: session.teacherName,
      classroom: session.classroom,
      windowSeconds: session.windowSeconds,
      endTime: session.endTime,
      rosterSize: session.roster.length,
      displayCode: session.displayCode,
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
      displayCode: session.displayCode,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolves a short human-typed join code to the same session-summary shape
// as GET /:id, so a second device (a smart board with no easy way to paste
// a link) can join a live session by typing a few characters instead.
router.get('/by-code/:code', async (req, res) => {
  try {
    const code = String(req.params.code).trim().toUpperCase();
    const session = await Session.findOne({ displayCode: code });
    if (!session) return res.status(404).json({ error: 'No session found for that code.' });
    res.json({
      sessionId: session._id,
      subject: session.subject,
      teacherName: session.teacherName,
      classroom: session.classroom,
      windowSeconds: session.windowSeconds,
      endTime: session.endTime,
      active: session.active,
      rosterSize: session.roster.length,
      displayCode: session.displayCode,
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

// Shared by the CSV and Excel exports below — deviceId is deliberately left
// out, it's a fingerprint hash the teacher has no use for.
async function loadExportRows(sessionId) {
  const session = await Session.findById(sessionId).select('-secret');
  if (!session) return null;

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

  const filenameBase = `attendance-${session.subject.replace(/[^a-z0-9]+/gi, '-')}-${new Date(session.startTime).toISOString().slice(0, 10)}`;
  return { rows, filenameBase };
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Attendance for one session as a downloadable CSV. This endpoint is
// unauthenticated (see the read-only session-display design note elsewhere
// in this file).
router.get('/:id/export.csv', async (req, res) => {
  try {
    const data = await loadExportRows(req.params.id);
    if (!data) return res.status(404).json({ error: 'Session not found' });

    const csv = data.rows.map((row) => row.map(csvCell).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${data.filenameBase}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Same data as an .xls file Excel opens directly — an HTML table served
// with the Excel MIME type/extension, no xlsx-writing library needed.
router.get('/:id/export.xls', async (req, res) => {
  try {
    const data = await loadExportRows(req.params.id);
    if (!data) return res.status(404).json({ error: 'Session not found' });

    const [header, ...body] = data.rows;
    const html = `<html><head><meta charset="utf-8"></head><body><table>
      <tr>${header.map((c) => `<th>${escHtml(c)}</th>`).join('')}</tr>
      ${body.map((row) => `<tr>${row.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('\n')}
    </table></body></html>`;

    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${data.filenameBase}.xls"`);
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push a live session's end time further out, e.g. class ran long.
router.post('/:id/extend', requireAuth('staff'), async (req, res) => {
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

router.post('/:id/end', requireAuth('staff'), async (req, res) => {
  try {
    const session = await Session.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
