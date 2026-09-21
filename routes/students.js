const express = require('express');
const mongoose = require('mongoose');
const Student = require('../models/Student');
const Session = require('../models/Session');
const { requireAuth } = require('../utils/auth');
const { serverError } = require('../utils/http');

const router = express.Router();

// A staff account must say which of ITS OWN sessions it is acting from (the
// flagged-list buttons in teacher.html do) — one staff account can't reach
// into another's roster, and can't reset arbitrary students with no context.
// Admin is exempt.
async function checkOwnsSession(req, res) {
  if (req.user.role === 'admin') return true;
  const { sessionId } = req.body;
  if (typeof sessionId !== 'string' || !mongoose.Types.ObjectId.isValid(sessionId)) {
    res.status(400).json({ error: 'sessionId of the session you are acting from is required.' });
    return false;
  }
  const session = await Session.findById(sessionId).select('teacherEmail');
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
    serverError(res, err);
  }
});

// Staff-only. Fully releases a roll number — clears both the device lock
// and the email<->rollNo identity lock (see routes/attendance.js).
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
    serverError(res, err);
  }
});

module.exports = router;
