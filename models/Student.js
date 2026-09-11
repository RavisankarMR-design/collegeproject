const mongoose = require('mongoose');

const StudentSchema = new mongoose.Schema({
  rollNo: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true },
  // Set on first successful scan. Any later scan for this roll number must
  // come from the same device, or it's rejected as a likely proxy.
  deviceId: { type: String, default: null },
});

module.exports = mongoose.model('Student', StudentSchema);
