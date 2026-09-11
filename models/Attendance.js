const mongoose = require('mongoose');

const AttendanceSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  markedAt: { type: Date, default: Date.now },
  distanceMeters: { type: Number, required: true },
  deviceId: { type: String, required: true },
});

// One attendance record per student per session — a second scan attempt
// (accidental or deliberate re-marking) is rejected at the DB level.
AttendanceSchema.index({ session: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', AttendanceSchema);
