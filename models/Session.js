const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  subject: { type: String, required: true },
  teacherName: { type: String, required: true },
  // Never exposed to any client response — used server-side only to compute tokens.
  secret: { type: String, required: true },
  classroom: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    radiusMeters: { type: Number, default: 30 },
  },
  windowSeconds: { type: Number, default: 10 },
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date, required: true },
  active: { type: Boolean, default: true },
  // Enrolled roll numbers for this session. Empty = any roll number accepted
  // (open mode). Non-empty = only these roll numbers can be marked present,
  // so a class of 30 can never end up with 31 attendance records.
  roster: { type: [String], default: [] },
});

module.exports = mongoose.model('Session', SessionSchema);
