const mongoose = require('mongoose');

const StudentSchema = new mongoose.Schema({
  // Stored uppercase so a roll number is one student regardless of how the
  // student typed it — case variants used to create separate student records.
  rollNo: { type: String, required: true, unique: true, trim: true, uppercase: true },
  name: { type: String, required: true },
  // Set on first successful scan. Any later scan for this roll number must
  // come from the same device, or it's rejected as a likely proxy.
  deviceId: { type: String, default: null },
});

module.exports = mongoose.model('Student', StudentSchema);
