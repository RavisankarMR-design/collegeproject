// One-time roster seed for a trial class: reads an Excel/CSV file of
// (email, rollNo, name) and upserts Student records so students never type
// their roll number — the server looks it up by their signed-in email.
//
// Usage:
//   npm install xlsx --no-save   (only needed once, not a permanent dependency)
//   node scripts/import-roster.js path/to/roster.xlsx
//
// Expected columns (case-insensitive, any order): email, rollNo (or "roll no"/"roll"), name
const path = require('path');
const mongoose = require('mongoose');
const Student = require('../models/Student');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-roster.js <roster.xlsx>');
    process.exit(1);
  }

  const XLSX = require('xlsx'); // ponytail: not a permanent dep, install ad hoc when running this script
  const workbook = XLSX.readFile(path.resolve(file));
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);

  const pick = (row, ...keys) => {
    for (const k of Object.keys(row)) {
      if (keys.includes(k.trim().toLowerCase())) return String(row[k]).trim();
    }
    return null;
  };

  const students = rows.map((row) => ({
    email: pick(row, 'email')?.toLowerCase(),
    rollNo: pick(row, 'rollno', 'roll no', 'roll')?.toUpperCase(),
    name: pick(row, 'name'),
  }));

  const bad = students.filter((s) => !s.email || !s.rollNo || !s.name);
  if (bad.length) {
    console.error(`${bad.length} row(s) missing email/rollNo/name — fix the file and rerun. First bad row:`, bad[0]);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/attendance');
  console.log(`Connected. Upserting ${students.length} students...`);

  let created = 0, updated = 0;
  for (const s of students) {
    const res = await Student.updateOne(
      { email: s.email },
      { $set: { rollNo: s.rollNo, name: s.name } },
      { upsert: true }
    );
    if (res.upsertedCount) created++; else updated++;
  }

  console.log(`Done. Created ${created}, updated ${updated}.`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
