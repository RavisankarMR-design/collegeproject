const mongoose = require('mongoose');

// Every rejected scan that looks like a proxy attempt (not a benign stale
// QR frame) gets logged here so the teacher can see who tried it and why —
// scanning from outside the room, from a device already bound to someone
// else, or with a roll number that isn't even enrolled in this class.
const FlaggedAttemptSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
  rollNo: { type: String, required: true },
  name: { type: String },
  reason: {
    type: String,
    enum: [
      'outside_geofence', 'device_mismatch', 'not_enrolled', 'identity_mismatch', 'roll_number_changed',
      // Informational only — these two never block the scan, the attendance
      // record is still created. They're a heuristic nudge for the teacher
      // to eyeball, not proof of cheating (see routes/attendance.js).
      'possible_proxy_pattern', 'ip_location_mismatch',
    ],
    required: true,
  },
  detail: { type: String, required: true },
  distanceMeters: { type: Number },
  accuracyMeters: { type: Number, default: null },
  deviceId: { type: String },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('FlaggedAttempt', FlaggedAttemptSchema);
