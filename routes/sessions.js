const express = require('express');
const crypto = require('crypto');
const Session = require('../models/Session');
const Attendance = require('../models/Attendance');
const FlaggedAttempt = require('../models/FlaggedAttempt');
const { currentWindow, generateToken, shortCode } = require('../utils/token');
const { requireAuth } = require('../utils/auth');
const { canAccessSession, bearer, ownsSession } = require('../utils/access');
const { rateLimit } = require('../utils/rateLimit');
const { serverError, isNum } = require('../utils/http');

const router = express.Router();

// What a caller has to prove to see a session's live data (see utils/access.js).
const creds = (req) => ({ code: req.query.code, token: bearer(req) });

// Looking a session up by its 6-char code is the one unauthenticated way in, so
// it is throttled against enumeration (32^6 combinations, but still).
const byCodeLimiter = rateLimit({ windowMs: 60_000, max: 60 });

// A spreadsheet treats a cell starting with = + - @ as a formula. Names/roll
// numbers are student-influenced, so neutralise them in exports.
function safeCell(value) {
  const s = value == null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

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

// Full summary — only ever returned to someone who passed canAccessSession.
function fullSummary(session) {
  return {
    sessionId: session._id,
    subject: session.subject,
    teacherName: session.teacherName,
    classroom: session.classroom,
    windowSeconds: session.windowSeconds,
    endTime: session.endTime,
    active: session.active,
    rosterSize: session.roster.length,
    displayCode: session.displayCode,
  };
}

// Past + current sessions for the history page, newest first, with how many
// students were marked present in each. `secret` must never leave the server.
// Staff-only, and scoped to that staff member's own sessions — admin
// sessions are a separate email and never mix into a staff member's history.
router.get('/', requireAuth('staff'), async (req, res) => {
  try {
    const sessions = await Session.find({ teacherEmail: req.user.email }).select('-secret').sort({ startTime: -1 }).limit(100);

    const counts = await Attendance.aggregate([
      { $match: { session: { $in: sessions.map((s) => s._id) } } },
      { $group: { _id: '$session', count: { $sum: 1 } } },
    ]);
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
    serverError(res, err);
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
    const bad = (msg) => res.status(400).json({ error: msg });

    if (typeof subject !== 'string' || !subject.trim() || subject.length > 100) return bad('A subject (up to 100 characters) is required.');
    if (!isNum(lat) || !isNum(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return bad('A valid classroom location is required.');
    if (radiusMeters != null && (!isNum(radiusMeters) || radiusMeters < 5 || radiusMeters > 500)) return bad('Radius must be between 5 and 500 metres.');
    if (!isNum(durationMinutes) || durationMinutes < 1 || durationMinutes > 480) return bad('Duration must be between 1 and 480 minutes.');
    if (roster != null && (!Array.isArray(roster) || roster.length > 500 || roster.some((r) => typeof r !== 'string' && typeof r !== 'number'))) {
      return bad('Roster must be a list of at most 500 roll numbers.');
    }

    const normalizedRoster = Array.isArray(roster)
      ? [...new Set(roster.map((r) => String(r).trim().toUpperCase().slice(0, 30)).filter(Boolean))]
      : [];

    // displayCode has a uniqueness constraint; collisions are astronomically
    // rare at 32^6 combinations but a create() can still race one, so retry
    // a couple of times rather than fail the whole session start on it.
    let session;
    for (let attempt = 0; !session; attempt++) {
      try {
        session = await Session.create({
          subject: subject.trim(),
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

    res.status(201).json(fullSummary(session));
  } catch (err) {
    serverError(res, err);
  }
});

// Session summary. The sessionId alone (which every scanning student learns
// from the QR) only gets a bare status; the displayCode and the classroom
// coordinates need proof of access — otherwise this endpoint would hand the
// displayCode to anyone and undo the gating on every endpoint below.
router.get('/:id', async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (canAccessSession(session, creds(req))) return res.json(fullSummary(session));
    res.json({ sessionId: session._id, subject: session.subject, active: session.active, endTime: session.endTime });
  } catch (err) {
    serverError(res, err);
  }
});

// Resolves a short human-typed join code to the same session-summary shape
// as GET /:id, so a second device (a smart board with no easy way to paste
// a link) can join a live session by typing a few characters instead.
router.get('/by-code/:code', byCodeLimiter, async (req, res) => {
  try {
    const code = String(req.params.code).trim().toUpperCase();
    const session = await Session.findOne({ displayCode: code });
    if (!session) return res.status(404).json({ error: 'No session found for that code.' });
    res.json(fullSummary(session));
  } catch (err) {
    serverError(res, err);
  }
});

// No lockout on wrong displayCode guesses, on purpose: 32^6 (~1 billion) codes make
// guessing pointless, whereas any per-IP lockout would let one student (or a whole
// campus sharing an IP) lock the teacher's own board out mid-class.
// Loads a session and enforces canAccessSession in one place for the gated GETs.
async function gatedSession(req, res, fields = 'teacherEmail displayCode') {
  const session = await Session.findById(req.params.id).select(fields);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return null; }
  if (!canAccessSession(session, creds(req))) { res.status(403).json({ error: 'Not authorized for this session.' }); return null; }
  return session;
}

// Flagged (rejected, proxy-like) scan attempts for the teacher panel.
router.get('/:id/flagged', async (req, res) => {
  try {
    if (!(await gatedSession(req, res))) return;
    // deviceId is the credential the server trusts for device binding — never hand it out.
    const flags = await FlaggedAttempt.find({ session: req.params.id }).select('-deviceId').sort({ createdAt: -1 }).limit(500);
    res.json(flags);
  } catch (err) {
    serverError(res, err);
  }
});

// Polled by the teacher's projector/display page every few seconds.
// Returns the QR payload string for the CURRENT rotating window.
router.get('/:id/current-qr', async (req, res) => {
  try {
    const session = await gatedSession(req, res, '+secret');
    if (!session) return;
    if (!session.active || Date.now() > session.endTime.getTime()) {
      return res.status(410).json({ error: 'Session has ended' });
    }

    const windowIndex = currentWindow(session.windowSeconds);
    const token = generateToken(session.secret, session._id, windowIndex);
    const payload = `${session._id}|${windowIndex}|${token}`;

    const msIntoWindow = Date.now() % (session.windowSeconds * 1000);
    const msLeftInWindow = session.windowSeconds * 1000 - msIntoWindow;

    res.json({ payload, msLeftInWindow, shortCode: shortCode(token), displayCode: session.displayCode });
  } catch (err) {
    serverError(res, err);
  }
});

// Live list for the teacher dashboard.
router.get('/:id/attendance', async (req, res) => {
  try {
    if (!(await gatedSession(req, res))) return;
    const records = await Attendance.find({ session: req.params.id })
      .select('-deviceId')
      .populate('student', 'rollNo name')
      .sort({ markedAt: 1 });
    res.json(records);
  } catch (err) {
    serverError(res, err);
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
      safeCell(r.student ? r.student.rollNo : ''),
      safeCell(r.student ? r.student.name : ''),
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

// Attendance for one session as a downloadable CSV. Requires the session's
// displayCode (?code=) or the owning staff/admin's bearer token.
router.get('/:id/export.csv', async (req, res) => {
  try {
    if (!(await gatedSession(req, res))) return;
    const data = await loadExportRows(req.params.id);
    if (!data) return res.status(404).json({ error: 'Session not found' });

    const csv = data.rows.map((row) => row.map(csvCell).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${data.filenameBase}.csv"`);
    res.send(csv);
  } catch (err) {
    serverError(res, err);
  }
});

// Same data as an .xls file Excel opens directly — an HTML table served
// with the Excel MIME type/extension, no xlsx-writing library needed.
router.get('/:id/export.xls', async (req, res) => {
  try {
    if (!(await gatedSession(req, res))) return;
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
    serverError(res, err);
  }
});

// Push a live session's end time further out, e.g. class ran long. Only the
// session's own teacher (or an admin) — any staff account could otherwise
// stretch or kill another teacher's class.
router.post('/:id/extend', requireAuth('staff'), async (req, res) => {
  try {
    const minutes = req.body.minutes === undefined ? 15 : Number(req.body.minutes);
    if (!isNum(minutes) || minutes < 1 || minutes > 120) return res.status(400).json({ error: 'Extend by 1 to 120 minutes.' });

    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!ownsSession(session, req.user)) return res.status(403).json({ error: 'This session belongs to a different staff account.' });

    // Extend from now if it already ended, otherwise add onto the current end time.
    const base = Math.max(session.endTime.getTime(), Date.now());
    session.endTime = new Date(base + minutes * 60000);
    session.active = true;
    await session.save();

    res.json({ ok: true, endTime: session.endTime });
  } catch (err) {
    serverError(res, err);
  }
});

router.post('/:id/end', requireAuth('staff'), async (req, res) => {
  try {
    const session = await Session.findById(req.params.id).select('teacherEmail');
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!ownsSession(session, req.user)) return res.status(403).json({ error: 'This session belongs to a different staff account.' });
    await Session.updateOne({ _id: session._id }, { active: false });
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err);
  }
});

module.exports = router;
