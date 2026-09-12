const mongoose = require('mongoose');

// Every rejected scan that looks like a proxy attempt (not a benign stale
// QR frame) gets logged here so the teacher can see who tried it and why —
// scanning from outside the room, from a device already bound to someone
// else, or with a roll number that isn't even enrolled in this class.
const FlaggedAttemptSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
  rollNo: { type: String, required: true },
  name: { type: String },
  reason: {
    type: String,
    enum: ['outside_geofence', 'device_mismatch', 'not_enrolled'],
    required: true,
  },
  detail: { type: String, required: true },
  distanceMeters: { type: Number },
  accuracyMeters: { type: Number, default: null },
  deviceId: { type: String },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('FlaggedAttempt', FlaggedAttemptSchema);
