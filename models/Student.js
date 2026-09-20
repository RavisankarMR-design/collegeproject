const mongoose = require('mongoose');

const StudentSchema = new mongoose.Schema({
  // The real identity anchor, now that login is Google-verified — unlike
  // rollNo (self-typed every scan), this can't be faked or mistyped as
  // someone else's.
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  // Stored uppercase so a roll number is one value regardless of how it was
  // typed. Bound to this email on first scan (see routes/attendance.js) and
  // rejected as a mismatch if a later scan from the same email types a
  // different one — so one verified person can't drift across roll numbers
  // by mistake or on purpose.
  rollNo: { type: String, required: true, uppercase: true, trim: true, unique: true },
  name: { type: String, required: true },
  // Set true after a student self-corrects a mistyped roll number once (see
  // routes/attendance.js). A second attempt is blocked — squatting someone
  // else's unclaimed roll by repeatedly "correcting" is no longer free;
  // staff must use reset-identity for anything past the first fix.
  rollLocked: { type: Boolean, default: false },
  // Set on first successful scan. unique+sparse: a device can only ever be
  // the first-binder for one student, globally — closes the gap where one
  // phone marked several different roll numbers present (confirmed live
  // before this fix). sparse allows many students to still have deviceId:
  // null before their first scan.
  deviceId: { type: String, default: null, unique: true, sparse: true },
});

module.exports = mongoose.model('Student', StudentSchema);
