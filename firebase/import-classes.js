// Loads the class documents into Firestore (one doc per class, id = classId).
// Safe to re-run: it overwrites each class with the current data.
//
//   cd firebase && npm install firebase-admin
//   node import-classes.js <classes-import.json> <service-account-key.json>
//
// The service-account key is a secret: keep it and the JSON outside this repo.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

const [dataPath, keyPath] = process.argv.slice(2);
if (!dataPath || !keyPath) { console.error('usage: node import-classes.js <classes-import.json> <service-account-key.json>'); process.exit(1); }

initializeApp({ credential: cert(JSON.parse(fs.readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();
const classes = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

(async () => {
  const batch = db.batch(); // 51 classes, far under the 500-write batch limit
  for (const c of classes) batch.set(db.collection('classes').doc(c.classId), c);
  await batch.commit();
  console.log(`Imported ${classes.length} classes.`);
})().catch((e) => { console.error(e); process.exit(1); });
