const express = require('express');
const Student = require('../models/Student');
const { requireAuth } = require('../utils/auth');

const router = express.Router();

// Staff-only. Lets a legitimate phone swap (lost/broken/new device) recover
// instead of being permanently locked out by the device-uniqueness
// constraint on Student.deviceId (see models/Student.js) — without this,
// that constraint would have no recovery path at all.
router.post('/:rollNo/reset-device', requireAuth('staff'), async (req, res) => {
  try {
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

module.exports = router;
