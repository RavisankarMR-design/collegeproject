const express = require('express');
const Student = require('../models/Student');
const Session = require('../models/Session');
const { requireAuth } = require('../utils/auth');

const router = express.Router();

// When the caller passes the sessionId they're acting from (the flagged-list
// buttons in teacher.html do), require that it's actually their session —
// one staff account can't reach into another's roster. No sessionId given
// (e.g. a direct API call) falls back to the old any-staff behavior.
async function checkOwnsSession(req, res) {
  if (!req.body.sessionId || req.user.role === 'admin') return true;
  const session = await Session.findById(req.body.sessionId).select('teacherEmail');
  if (!session) {
    res.status(404).json({ error: 'Session not found.' });
    return false;
  }
  if (session.teacherEmail !== req.user.email) {
    res.status(403).json({ error: 'This session belongs to a different staff account.' });
    return false;
  }
  return true;
}

// Staff-only. Lets a legitimate phone swap (lost/broken/new device) recover
// instead of being permanently locked out by the device-uniqueness
// constraint on Student.deviceId (see models/Student.js) — without this,
// that constraint would have no recovery path at all.
router.post('/:rollNo/reset-device', requireAuth('staff'), async (req, res) => {
  try {
    if (!(await checkOwnsSession(req, res))) return;
    const rollNo = String(req.params.rollNo).trim().toUpperCase();
    const student = await Student.findOneAndUpdate(
      { rollNo },
      { deviceId: null },
      { new: true }
    );
    if (!student) return res.status(404).json({ error: 'No student found with that roll number.' });
    res.json({ ok: true, rollNo: student.rollNo, email: student.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Staff-only. Fully releases a roll number — clears both the device lock
// and the email<->rollNo identity lock (see routes/attendance.js step 4/5).
// Needed when a roll number got bound to the wrong account (typo, stray
// test scan, etc) and the affected student can't self-recover otherwise.
router.post('/:rollNo/reset-identity', requireAuth('staff'), async (req, res) => {
  try {
    if (!(await checkOwnsSession(req, res))) return;
    const rollNo = String(req.params.rollNo).trim().toUpperCase();
    const student = await Student.findOneAndDelete({ rollNo });
    if (!student) return res.status(404).json({ error: 'No student found with that roll number.' });
    res.json({ ok: true, rollNo: student.rollNo, releasedFrom: student.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
