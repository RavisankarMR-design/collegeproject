const mongoose = require('mongoose');

const AttendanceSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  markedAt: { type: Date, default: Date.now },
  distanceMeters: { type: Number, required: true },
  // The student's own reported fix (not just distance from the classroom
  // center) — needed to tell whether two students' scans were suspiciously
  // close to EACH OTHER (see routes/attendance.js checkPassAlong), which
  // distanceMeters alone can't show since a whole class is expected to be
  // near the center anyway.
  lat: { type: Number },
  lng: { type: Number },
  // GPS accuracy radius (meters) the browser reported for this fix, so a
  // "0m from center" reading that was actually a noisy ±40m fix is visible
  // later instead of looking perfectly precise.
  accuracyMeters: { type: Number, default: null },
  // True when the GPS uncertainty circle crosses the geofence boundary —
  // distance and accuracy alone can't tell whether this student was
  // actually inside or outside, so it's accepted but flagged for the
  // teacher to see rather than silently guessed either way.
  borderline: { type: Boolean, default: false },
  deviceId: { type: String, required: true },
});

// One attendance record per student per session — a second scan attempt
// (accidental or deliberate re-marking) is rejected at the DB level.
AttendanceSchema.index({ session: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', AttendanceSchema);
