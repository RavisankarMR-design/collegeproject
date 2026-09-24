const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  subject: { type: String, required: true },
  teacherName: { type: String, required: true },
  teacherEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
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
  // Short human-typeable code so a second device (e.g. a classroom PC/smart
  // board with no camera or easy way to paste a link) can join this exact
  // session by typing a few characters instead of a full URL.
  displayCode: { type: String, required: true, unique: true },
  // Enrolled roll numbers for this session. Empty = any roll number accepted
  // (open mode). Non-empty = only these roll numbers can be marked present,
  // so a class of 30 can never end up with 31 attendance records.
  roster: { type: [String], default: [] },
  // Opt-in per session — when true, exports look up real names from the
  // trial class's roster (data/class1-roster.json) instead of the
  // account-derived name. Off by default: without this, a roll number that
  // happens to coincidentally match that roster (a different class, a demo)
  // must never get someone else's real name substituted in.
  useClassRoster: { type: Boolean, default: false },
});

module.exports = mongoose.model('Session', SessionSchema);
