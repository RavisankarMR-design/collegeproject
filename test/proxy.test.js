// Attack-scenario suite for the anti-proxy attendance rules. Run: node test/proxy.test.js
// Starts its own server (typed-email login, fresh Mongo DB, throwaway secret) so it can
// exercise every role. Needs a local MongoDB on 127.0.0.1:27017. Never touches prod.
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');

const PORT = 4500 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}`;
const SECRET = 'test-secret-abcdefghijklmnop';
const RUN = Date.now().toString(36).replace(/[^a-z0-9]/g, '');
const LAT = 12.9716, LNG = 77.5946;
const north = (m) => LAT + m / 111320;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, { token, body, raw, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let data;
  if (raw !== undefined) { headers['Content-Type'] = 'application/json'; data = raw; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; data = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: data });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (/"secret"s*:/.test(text)) throw new Error(`session secret leaked by ${method} ${url}`);
  return { status: res.status, body: json, text };
}

let counter = 0;
async function login(email) {
  const r = await api('POST', '/api/auth/login', { body: { email } });
  assert.strictEqual(r.status, 200, `login ${email}: ${r.text}`);
  return r.body.token;
}
async function newStudent(tag = 's') {
  const n = ++counter; // captured before any await so parallel callers stay unique
  const email = `${tag}${n}x${RUN}.2024.cse@rajalakshmi.edu.in`;
  return { email, token: await login(email), roll: `24070${String(1000 + n).padStart(4, '0')}`, device: `dev-${RUN}-${n}` };
}
async function mkSession(token, over = {}) {
  const r = await api('POST', '/api/sessions', { token, body: { subject: 'T', lat: LAT, lng: LNG, radiusMeters: 30, durationMinutes: 30, ...over } });
  assert.strictEqual(r.status, 201, `create session: ${r.text}`);
  return { id: r.body.sessionId, code: r.body.displayCode, owner: token };
}
const live = async (s) => (await api('GET', `/api/sessions/${s.id}/current-qr?code=${s.code}`)).body;

// Marks with sensible defaults; `over` overrides any field (use undefined to drop one).
async function mark(st, s, over = {}) {
  const base = { rollNo: st.roll, lat: LAT, lng: LNG, accuracy: 8, deviceId: st.device };
  const q = await live(s);
  if (over.useCode) base.code = q.shortCode; else base.payload = q.payload;
  const body = { ...base, ...over }; delete body.useCode;
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return api('POST', '/api/attendance/mark', { token: st.token, body });
}
const flags = async (s) => (await api('GET', `/api/sessions/${s.id}/flagged?code=${s.code}`)).body;

const tests = [];
const t = (name, fn, opts = {}) => tests.push({ name, fn, ...opts });
const eq = (r, status, msg) => assert.strictEqual(r.status, status, `${msg || ''} -> got ${r.status} ${r.text.slice(0, 160)}`);

let staff1, staff2, admin, stale;

// ---------- setup ----------
t('setup: logins', async () => {
  staff1 = await login('bhuvaneswaran@rajalakshmi.edu.in');
  staff2 = await login('staff2@rajalakshmi.edu.in');
  admin = await login('mrravisankar7@gmail.com');
  // captured now, replayed after >2 rotation windows (see stale-* tests at the end)
  const s = await mkSession(staff1);
  const q = await live(s);
  stale = { s, q, at: Date.now() };
});

// ---------- AUTH ----------
t('auth: no token -> 401 on mark / create session / history', async () => {
  eq(await api('POST', '/api/attendance/mark', { body: {} }), 401);
  eq(await api('POST', '/api/sessions', { body: {} }), 401);
  eq(await api('GET', '/api/sessions'), 401);
});
t('auth: student token cannot create/extend/end sessions or reset students (403)', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  eq(await api('POST', '/api/sessions', { token: st.token, body: { subject: 'x', lat: 1, lng: 1, durationMinutes: 5 } }), 403);
  eq(await api('POST', `/api/sessions/${s.id}/extend`, { token: st.token, body: { minutes: 5 } }), 403);
  eq(await api('POST', `/api/sessions/${s.id}/end`, { token: st.token }), 403);
  eq(await api('POST', `/api/students/${st.roll}/reset-device`, { token: st.token }), 403);
  eq(await api('POST', `/api/students/${st.roll}/reset-identity`, { token: st.token }), 403);
  eq(await api('GET', '/api/sessions', { token: st.token }), 403);
});
t('auth: staff token cannot mark attendance (403)', async () => {
  const s = await mkSession(staff1); const q = await live(s);
  eq(await api('POST', '/api/attendance/mark', { token: staff1, body: { payload: q.payload, rollNo: '240701999', lat: LAT, lng: LNG, accuracy: 5, deviceId: 'x-staff' } }), 403);
});
t('auth: JWT signed with wrong secret -> 401', async () => {
  const forged = jwt.sign({ email: 'a@rajalakshmi.edu.in', name: 'A', role: 'staff' }, 'not-the-secret', { expiresIn: '1h' });
  eq(await api('GET', '/api/sessions', { token: forged }), 401);
});
t('auth: role escalation by re-signing payload with wrong secret -> 401', async () => {
  const st = await newStudent();
  const { iat, exp, ...p } = jwt.decode(st.token); void iat; void exp;
  const forged = jwt.sign({ ...p, role: 'admin' }, 'guess', { expiresIn: '1h' });
  eq(await api('POST', '/api/sessions', { token: forged, body: { subject: 'x', lat: 1, lng: 1, durationMinutes: 5 } }), 401);
});
t('auth: alg=none token -> 401', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ email: 'x@rajalakshmi.edu.in', name: 'X', role: 'admin', exp: 9999999999 })}.`;
  eq(await api('GET', '/api/sessions', { token: none }), 401);
});
t('auth: expired token -> 401', async () => {
  const expired = jwt.sign({ email: 'e@rajalakshmi.edu.in', name: 'E', role: 'student' }, SECRET, { expiresIn: -10 });
  eq(await api('POST', '/api/attendance/mark', { token: expired, body: {} }), 401);
});
t('auth: non-college email cannot sign in (typed mode)', async () => {
  eq(await api('POST', '/api/auth/login', { body: { email: 'someone@gmail.com' } }), 401);
  eq(await api('POST', '/api/auth/login', { body: { email: 'x@rajalakshmi.edu.in.evil.com' } }), 401);
  eq(await api('POST', '/api/auth/login', { body: { email: 'a b@rajalakshmi.edu.in' } }), 401);
  eq(await api('POST', '/api/auth/login', { body: {} }), 401);
});

// ---------- QR TOKEN ----------
t('qr: valid scan marks present', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  const r = await mark(st, s); eq(r, 201); assert.strictEqual(r.body.ok, true);
});
t('qr: tampered token -> 400', async () => {
  const st = await newStudent(); const s = await mkSession(staff1); const q = await live(s);
  const [id, w, tk] = q.payload.split('|');
  eq(await mark(st, s, { payload: `${id}|${w}|${tk.slice(0, -1)}${tk.endsWith('0') ? '1' : '0'}` }), 400);
});
t('qr: session A token replayed against session B id -> 400', async () => {
  const st = await newStudent(); const a = await mkSession(staff1); const b = await mkSession(staff1);
  const [, w, tk] = (await live(a)).payload.split('|');
  eq(await mark(st, b, { payload: `${b.id}|${w}|${tk}` }), 400);
});
t('qr: window index bumped into the future -> 400', async () => {
  const st = await newStudent(); const s = await mkSession(staff1); const q = await live(s);
  const [id, w, tk] = q.payload.split('|');
  eq(await mark(st, s, { payload: `${id}|${Number(w) + 5}|${tk}` }), 400);
});
t('qr: malformed payloads never 500', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  for (const p of ['', 'a|b', 'a|b|c|d', '|||', 'zzzz|1|2', `${s.id}|abc|def`, 123, { a: 1 }, ['x'], 'x'.repeat(5000)]) {
    const r = await mark(st, s, { payload: p });
    assert.ok([400, 404].includes(r.status), `payload ${JSON.stringify(p).slice(0, 40)} -> ${r.status} ${r.text.slice(0, 100)}`);
  }
});
t('qr: ended session rejects scans (410)', async () => {
  const st = await newStudent(); const s = await mkSession(staff1); const q = await live(s);
  eq(await api('POST', `/api/sessions/${s.id}/end`, { token: staff1 }), 200);
  eq(await api('POST', '/api/attendance/mark', { token: st.token, body: { payload: q.payload, rollNo: st.roll, lat: LAT, lng: LNG, accuracy: 8, deviceId: st.device } }), 410);
});
t('qr: same live QR shared to two phones at the same spot -> possible_proxy_pattern flag', async () => {
  const a = await newStudent(); const b = await newStudent(); const s = await mkSession(staff1);
  eq(await mark(a, s), 201); eq(await mark(b, s), 201);
  await sleep(800);
  const f = await flags(s);
  assert.ok(f.some((x) => x.reason === 'possible_proxy_pattern'), 'expected possible_proxy_pattern flag');
});

// ---------- 4-DIGIT CODE ----------
t('code: live 4-digit code marks present', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  eq(await mark(st, s, { useCode: true, payload: undefined }), 201);
});
t('code: wrong code -> 404, never 500', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  eq(await mark(st, s, { payload: undefined, code: 'ZZZZ' }), 404);
});
t('code: weird code types never 500', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  for (const c of [{ $ne: 1 }, [1, 2], 12345, true, '', ' ', 'x'.repeat(1000)]) {
    const r = await mark(st, s, { payload: undefined, code: c });
    assert.ok([400, 404, 429].includes(r.status), `code ${JSON.stringify(c).slice(0, 30)} -> ${r.status} ${r.text.slice(0, 100)}`);
  }
});
t('code: brute forcing the 4-digit code locks the account out (429) even for the right code', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  let locked = false;
  for (let i = 0; i < 12; i++) {
    const r = await mark(st, s, { payload: undefined, code: `AAA${i}` });
    if (r.status === 429) { locked = true; break; }
  }
  assert.ok(locked, 'never rate-limited wrong-code guessing');
  eq(await mark(st, s, { useCode: true, payload: undefined }), 429, 'right code while locked out');
});
t('code: a couple of honest typos do not lock a student out', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  eq(await mark(st, s, { payload: undefined, code: 'AAA1' }), 404);
  eq(await mark(st, s, { payload: undefined, code: 'AAA2' }), 404);
  eq(await mark(st, s, { useCode: true, payload: undefined }), 201);
});
t('code: one account being locked out does not affect another', async () => {
  const a = await newStudent(); const b = await newStudent(); const s = await mkSession(staff1);
  for (let i = 0; i < 12; i++) await mark(a, s, { payload: undefined, code: `AAB${i}` });
  eq(await mark(b, s, { useCode: true, payload: undefined }), 201);
});

// ---------- GEOFENCE / INPUT VALIDATION ----------
t('geo: 200m away -> 403 + outside_geofence flag', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  eq(await mark(st, s, { lat: north(200) }), 403);
  assert.ok((await flags(s)).some((f) => f.reason === 'outside_geofence'));
});
t('geo: honest borderline (45m, +-20m, radius 30) accepted and marked borderline', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  const r = await mark(st, s, { lat: north(45), accuracy: 20 }); eq(r, 201); assert.strictEqual(r.body.borderline, true);
});
t('geo: claiming accuracy=100 must not stretch a 30m fence to 130m', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  eq(await mark(st, s, { lat: north(100), accuracy: 100 }), 403);
});
t('geo: max reach with a fake huge accuracy is bounded to ~2x radius', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  eq(await mark(st, s, { lat: north(75), accuracy: 100 }), 403);
});
t('geo: non-numeric / non-finite coordinates are rejected (no NaN bypass)', async () => {
  const s = await mkSession(staff1);
  const bad = [
    { lat: 'abc' }, { lng: 'abc' }, { lat: null }, { lat: [1] }, { lat: {} }, { lat: 999 }, { lng: -999 },
    { lat: '12.9716' }, { accuracy: 'abc' }, { accuracy: -5 }, { accuracy: '8' }, { accuracy: [] },
  ];
  for (const o of bad) {
    const st = await newStudent();
    const r = await mark(st, s, { lat: north(5000), ...o });
    assert.ok([400].includes(r.status), `override ${JSON.stringify(o)} -> ${r.status} ${r.text.slice(0, 120)}`);
  }
});
t('geo: Infinity via 1e999 cannot bypass the fence', async () => {
  const st = await newStudent(); const s = await mkSession(staff1); const q = await live(s);
  const raw = `{"payload":"${q.payload}","rollNo":"${st.roll}","lat":1e999,"lng":${LNG},"accuracy":8,"deviceId":"${st.device}"}`;
  eq(await api('POST', '/api/attendance/mark', { token: st.token, raw }), 400);
  const raw2 = `{"payload":"${q.payload}","rollNo":"${st.roll}","lat":${north(9000)},"lng":${LNG},"accuracy":1e999,"deviceId":"${st.device}"}`;
  const r2 = await api('POST', '/api/attendance/mark', { token: st.token, raw: raw2 });
  assert.ok(r2.status === 400 || r2.status === 403, `infinite accuracy -> ${r2.status}`);
});
t('geo: missing fields -> 400', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  for (const k of ['rollNo', 'lat', 'lng', 'deviceId']) eq(await mark(st, s, { [k]: undefined }), 400, k);
});
t('geo: GPS accuracy worse than 100m rejected', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  eq(await mark(st, s, { accuracy: 250 }), 400);
});

// ---------- ROLL NUMBER ----------
t('roll: only 24070 + 4 digits accepted', async () => {
  const s = await mkSession(staff1);
  for (const bad of ['', '24070', '2407012345', '240691234', 'abcdefghi', '24070123x', '２４０７０１２３４', '24070 1234', '240701234;', "24070'--"]) {
    const st = await newStudent();
    const r = await mark(st, s, { rollNo: bad });
    assert.ok([400].includes(r.status), `roll ${JSON.stringify(bad)} -> ${r.status} ${r.text.slice(0, 100)}`);
  }
});
t('roll: non-string rollNo never 500', async () => {
  const s = await mkSession(staff1);
  for (const bad of [240701234, { a: 1 }, ['240701234'], true]) {
    const st = await newStudent();
    const r = await mark(st, s, { rollNo: bad });
    assert.strictEqual(r.status, 400, `roll ${JSON.stringify(bad)} -> ${r.status} ${r.text.slice(0, 100)}`);
  }
});
t('roll: surrounding whitespace is trimmed', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  eq(await mark(st, s, { rollNo: `  ${st.roll}\n` }), 201);
});
t('roster: off-roster roll rejected + flagged; on-roster accepted', async () => {
  const a = await newStudent(); const b = await newStudent();
  const s = await mkSession(staff1, { roster: [a.roll] });
  eq(await mark(b, s), 403);
  assert.ok((await flags(s)).some((f) => f.reason === 'not_enrolled'));
  eq(await mark(a, s), 201);
});
t('roster: mixed case / whitespace roster entries are normalised', async () => {
  const a = await newStudent();
  const s = await mkSession(staff1, { roster: [`  ${a.roll}  `, 'x'] });
  eq(await mark(a, s), 201);
});

// ---------- IDENTITY ----------
t('identity: second account cannot claim an already-registered roll', async () => {
  const a = await newStudent(); const b = await newStudent(); b.roll = a.roll;
  const s1 = await mkSession(staff1); const s2 = await mkSession(staff1);
  eq(await mark(a, s1), 201);
  eq(await mark(b, s2), 403);
  assert.ok((await flags(s2)).some((f) => f.reason === 'identity_mismatch'));
});
t('identity: one self-correction allowed, the second is locked', async () => {
  const a = await newStudent();
  const s1 = await mkSession(staff1), s2 = await mkSession(staff1), s3 = await mkSession(staff1);
  eq(await mark(a, s1), 201);
  const b = await newStudent(); const c = await newStudent();
  eq(await mark(a, s2, { rollNo: b.roll }), 201);
  eq(await mark(a, s3, { rollNo: c.roll }), 403);
});
t('identity: correcting into a roll owned by someone else is refused', async () => {
  const a = await newStudent(); const b = await newStudent();
  const s1 = await mkSession(staff1), s2 = await mkSession(staff1);
  eq(await mark(a, s1), 201); eq(await mark(b, s1), 201);
  eq(await mark(a, s2, { rollNo: b.roll }), 403);
});
t('identity: 2 accounts racing for one brand-new roll -> exactly one wins', async () => {
  const a = await newStudent(); const b = await newStudent(); b.roll = a.roll;
  const s = await mkSession(staff1);
  const [ra, rb] = await Promise.all([mark(a, s), mark(b, s)]);
  const codes = [ra.status, rb.status].sort();
  assert.deepStrictEqual(codes, [201, 403], `got ${codes}`);
});
t('identity: same account double-submitting in parallel -> one record, no 500s, no false flags', async () => {
  const a = await newStudent(); const s = await mkSession(staff1); const q = await live(s);
  const body = { payload: q.payload, rollNo: a.roll, lat: LAT, lng: LNG, accuracy: 8, deviceId: a.device };
  const rs = await Promise.all(Array.from({ length: 8 }, () => api('POST', '/api/attendance/mark', { token: a.token, body })));
  const ok = rs.filter((r) => r.status === 201).length;
  assert.strictEqual(ok, 1, `expected exactly 1 success, got ${rs.map((r) => r.status)}`);
  assert.ok(rs.every((r) => [201, 409].includes(r.status)), `unexpected statuses ${rs.map((r) => r.status)}`);
  const att = (await api('GET', `/api/sessions/${s.id}/attendance?code=${s.code}`)).body;
  assert.strictEqual(att.length, 1);
  assert.ok(!(await flags(s)).some((f) => f.reason === 'device_mismatch'), 'false device_mismatch flag from own double-tap');
});
t('identity: duplicate mark in same session -> 409', async () => {
  const a = await newStudent(); const s = await mkSession(staff1);
  eq(await mark(a, s), 201); eq(await mark(a, s), 409);
});

// ---------- DEVICE ----------
t('device: one phone cannot mark two different accounts', async () => {
  const a = await newStudent(); const b = await newStudent(); b.device = a.device;
  const s1 = await mkSession(staff1), s2 = await mkSession(staff1);
  eq(await mark(a, s1), 201); eq(await mark(b, s2), 403);
});
t('device: two new accounts racing on one phone -> exactly one wins', async () => {
  const a = await newStudent(); const b = await newStudent(); b.device = a.device;
  const s = await mkSession(staff1);
  const [ra, rb] = await Promise.all([mark(a, s), mark(b, s)]);
  assert.deepStrictEqual([ra.status, rb.status].sort(), [201, 403]);
});
t('device: account moved to a new phone is blocked + flagged, staff reset fixes it', async () => {
  const a = await newStudent();
  const s1 = await mkSession(staff1), s2 = await mkSession(staff1), s3 = await mkSession(staff1);
  eq(await mark(a, s1), 201);
  const oldDev = a.device; a.device = `${a.device}-new`;
  eq(await mark(a, s2), 403);
  assert.ok((await flags(s2)).some((f) => f.reason === 'device_mismatch'));
  eq(await api('POST', `/api/students/${a.roll}/reset-device`, { token: staff1, body: { sessionId: s2.id } }), 200);
  eq(await mark(a, s3), 201);
  void oldDev;
});
t('device: deviceId must be a sane string', async () => {
  const s = await mkSession(staff1);
  for (const bad of [123, { a: 1 }, [], '', 'x'.repeat(500), true]) {
    const st = await newStudent();
    const r = await mark(st, s, { deviceId: bad });
    assert.strictEqual(r.status, 400, `deviceId ${JSON.stringify(bad).slice(0, 30)} -> ${r.status} ${r.text.slice(0, 100)}`);
  }
});
t('device: after a mid-class device reset, one phone still cannot mark two people in the same session', async () => {
  const a = await newStudent(); const b = await newStudent(); b.device = a.device;
  const s = await mkSession(staff1);
  eq(await mark(a, s), 201);
  eq(await api('POST', `/api/students/${a.roll}/reset-device`, { token: staff1, body: { sessionId: s.id } }), 200);
  eq(await mark(b, s), 403);
});
t('device: many resets and many unbound accounts never trip the unique index (no null collisions)', async () => {
  const s = await mkSession(staff1); const sts = [];
  for (let i = 0; i < 4; i++) { const st = await newStudent(); eq(await mark(st, s), 201); sts.push(st); }
  for (const st of sts) eq(await api('POST', `/api/students/${st.roll}/reset-device`, { token: staff1, body: { sessionId: s.id } }), 200);
  const admin2 = await login('mrravisankar7@gmail.com'); void admin2;
  const adm = await mkSession(admin); eq(await api('POST', '/api/attendance/mark', { token: admin, body: { payload: (await live(adm)).payload, rollNo: 'x', lat: LAT, lng: LNG, accuracy: 8, deviceId: 'adm-dev' } }), 201);
});
t('qr: a ring of scripted clients all reporting identical made-up coordinates gets flagged', async () => {
  const s = await mkSession(staff1); const ring = [];
  for (let i = 0; i < 3; i++) ring.push(await newStudent());
  for (const st of ring) eq(await mark(st, s, { lat: LAT + 0.00001, lng: LNG + 0.00001, accuracy: 3 }), 201);
  await sleep(800);
  const n = (await flags(s)).filter((f) => f.reason === 'possible_proxy_pattern').length;
  assert.ok(n >= 2, `expected the ring to be flagged, got ${n}`);
});
t('KNOWN LIMIT: a scripted client can invent a fresh deviceId per account (no server-side hardware proof)', async () => {
  const a = await newStudent(); const b = await newStudent(); // same "phone", two invented ids
  const s = await mkSession(staff1);
  const ra = await mark(a, s, { deviceId: 'invented-1' }); const rb = await mark(b, s, { deviceId: 'invented-2' });
  console.log(`      (informational) same-phone/two-accounts via scripted deviceIds -> ${ra.status}/${rb.status}; caught only by the same-spot heuristic`);
}, { info: true });

// ---------- SESSION DATA GATING ----------
t('gating: GET /sessions/:id leaks neither displayCode nor classroom coords to strangers', async () => {
  const s = await mkSession(staff1);
  const r = await api('GET', `/api/sessions/${s.id}`);
  assert.ok(!JSON.stringify(r.body).includes(s.code), 'displayCode leaked');
  assert.ok(!r.body.classroom, 'classroom coordinates leaked');
});
t('gating: a student who scanned a QR (so knows the sessionId) still cannot pull live QR/attendance/flags/exports', async () => {
  const st = await newStudent(); const s = await mkSession(staff1); const q = await live(s);
  const sid = q.payload.split('|')[0];
  const info = await api('GET', `/api/sessions/${sid}`);
  assert.ok(!JSON.stringify(info.body).includes(s.code), 'displayCode leaked via GET /:id');
  for (const p of ['current-qr', 'attendance', 'flagged', 'export.csv', 'export.xls']) {
    const r = await api('GET', `/api/sessions/${sid}/${p}`, { token: st.token });
    eq(r, 403, p);
  }
});
t('gating: wrong displayCode -> 403 on every gated endpoint', async () => {
  const s = await mkSession(staff1);
  for (const p of ['current-qr', 'attendance', 'flagged', 'export.csv', 'export.xls']) eq(await api('GET', `/api/sessions/${s.id}/${p}?code=AAAAAA`), 403, p);
});
t('gating: owner staff / admin allowed, other staff denied', async () => {
  const s = await mkSession(staff1);
  eq(await api('GET', `/api/sessions/${s.id}/attendance`, { token: staff1 }), 200);
  eq(await api('GET', `/api/sessions/${s.id}/attendance`, { token: admin }), 200);
  eq(await api('GET', `/api/sessions/${s.id}/attendance`, { token: staff2 }), 403);
});
t('gating: by-code resolves only real codes', async () => {
  const s = await mkSession(staff1);
  eq(await api('GET', '/api/sessions/by-code/AAAAAA'), 404);
  const r = await api('GET', `/api/sessions/by-code/${s.code.toLowerCase()}`); eq(r, 200);
  assert.strictEqual(String(r.body.sessionId), String(s.id));
});
t('gating: by-code is rate limited against enumeration', async () => {
  let limited = false;
  for (let i = 0; i < 150; i++) {
    const r = await api('GET', `/api/sessions/by-code/BBBB${String(i).padStart(2, '0')}`);
    if (r.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'by-code never rate limited');
});
t('gating: history scoped per owner, students denied', async () => {
  const mine = await mkSession(staff1, { subject: `mine-${RUN}` }); const theirs = await mkSession(staff2, { subject: `theirs-${RUN}` });
  const h1 = (await api('GET', '/api/sessions', { token: staff1 })).body.map((x) => x.subject);
  assert.ok(h1.includes(`mine-${RUN}`) && !h1.includes(`theirs-${RUN}`));
  const ha = (await api('GET', '/api/sessions', { token: admin })).body.map((x) => x.subject);
  assert.ok(!ha.includes(`mine-${RUN}`) && !ha.includes(`theirs-${RUN}`), 'admin history mixes with staff data');
  void mine; void theirs;
});

// ---------- SOCKETS ----------
function connect() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'], reconnection: false });
    const events = [];
    s.on('present', (e) => events.push(['present', e]));
    s.on('flagged', (e) => events.push(['flagged', e]));
    s.on('connect', () => resolve({ s, events }));
    s.on('connect_error', reject);
  });
}
t('socket: joining a session room with only its id (from a QR) receives nothing', async () => {
  const st = await newStudent(); const s = await mkSession(staff1); const q = await live(s);
  const sid = q.payload.split('|')[0];
  const spy = await connect();
  spy.s.emit('join', sid); spy.s.emit('join', { sessionId: sid }); spy.s.emit('join', { sessionId: sid, code: 'WRONG1' });
  await sleep(300);
  eq(await mark(st, s), 201); await sleep(800);
  spy.s.close();
  assert.strictEqual(spy.events.length, 0, `spy received ${JSON.stringify(spy.events).slice(0, 200)}`);
});
t('socket: legit teacher (displayCode or owner token) still gets live pushes', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  const a = await connect(), b = await connect();
  a.s.emit('join', { sessionId: s.id, code: s.code });
  b.s.emit('join', { sessionId: s.id, token: staff1 });
  await sleep(400);
  eq(await mark(st, s), 201); await sleep(800);
  a.s.close(); b.s.close();
  assert.ok(a.events.some((e) => e[0] === 'present'), 'code-joined socket missed present');
  assert.ok(b.events.some((e) => e[0] === 'present'), 'token-joined socket missed present');
});

// ---------- OWNERSHIP / SESSION MANAGEMENT ----------
t('ownership: other staff cannot extend/end your session; owner and admin can', async () => {
  const s = await mkSession(staff1);
  eq(await api('POST', `/api/sessions/${s.id}/extend`, { token: staff2, body: { minutes: 5 } }), 403);
  eq(await api('POST', `/api/sessions/${s.id}/end`, { token: staff2 }), 403);
  eq(await api('POST', `/api/sessions/${s.id}/extend`, { token: staff1, body: { minutes: 5 } }), 200);
  eq(await api('POST', `/api/sessions/${s.id}/extend`, { token: admin, body: { minutes: 5 } }), 200);
  eq(await api('POST', `/api/sessions/${s.id}/end`, { token: staff1 }), 200);
});
t('ownership: extend minutes are validated and capped', async () => {
  const s = await mkSession(staff1);
  for (const m of [-30, 0, 'abc', 1e9, [1], {}, NaN]) {
    const r = await api('POST', `/api/sessions/${s.id}/extend`, { token: staff1, body: { minutes: m } });
    assert.ok([200, 400].includes(r.status), `minutes ${m} -> ${r.status}`);
    if (r.status === 200) assert.ok(new Date(r.body.endTime) - Date.now() < 6 * 3600e3, `minutes ${m} pushed the end time absurdly far`);
  }
  const s2 = await mkSession(staff1);
  const before = (await api('GET', `/api/sessions/${s2.id}`, { token: staff1 })).body.endTime;
  await api('POST', `/api/sessions/${s2.id}/extend`, { token: staff1, body: { minutes: -600 } });
  const after = (await api('GET', `/api/sessions/${s2.id}`, { token: staff1 })).body.endTime;
  assert.ok(new Date(after) >= new Date(before), 'negative minutes shortened the session');
});
t('ownership: staff reset endpoints require an owned sessionId', async () => {
  const st = await newStudent(); const mine = await mkSession(staff1);
  eq(await mark(st, mine), 201);
  eq(await api('POST', `/api/students/${st.roll}/reset-device`, { token: staff2, body: { sessionId: mine.id } }), 403);
  eq(await api('POST', `/api/students/${st.roll}/reset-device`, { token: staff2 }), 400, 'no sessionId');
  eq(await api('POST', `/api/students/${st.roll}/reset-identity`, { token: staff2, body: { sessionId: mine.id } }), 403);
  eq(await api('POST', `/api/students/${st.roll}/reset-device`, { token: staff1, body: { sessionId: mine.id } }), 200);
  eq(await api('POST', `/api/students/${st.roll}/reset-identity`, { token: admin }), 200);
});
t('session create: absurd/invalid inputs rejected', async () => {
  const bad = [
    { lat: 'abc' }, { lng: null }, { lat: 999 }, { radiusMeters: -5 }, { radiusMeters: 1e7 }, { radiusMeters: 'x' },
    { durationMinutes: 1e9 }, { durationMinutes: -5 }, { durationMinutes: 'x' }, { subject: {} }, { subject: 'x'.repeat(500) },
    { roster: 'notarray' }, { roster: Array.from({ length: 5000 }, (_, i) => String(i)) },
  ];
  for (const o of bad) {
    const r = await api('POST', '/api/sessions', { token: staff1, body: { subject: 'T', lat: LAT, lng: LNG, radiusMeters: 30, durationMinutes: 30, ...o } });
    assert.ok(r.status === 400 || r.status === 413, `create with ${JSON.stringify(o).slice(0, 50)} -> ${r.status} ${r.text.slice(0, 80)}`);
  }
});

// ---------- ABUSE / HARDENING ----------
t('abuse: flooding out-of-range scans does not spam the teacher flag list', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  for (let i = 0; i < 15; i++) await mark(st, s, { lat: north(500) });
  const n = (await flags(s)).filter((f) => f.reason === 'outside_geofence').length;
  assert.ok(n <= 3, `${n} duplicate flags created`);
});
t('abuse: junk roll numbers are rejected before anything is logged', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  const r = await mark(st, s, { rollNo: 'x'.repeat(50000), lat: north(500) });
  assert.ok([400, 413].includes(r.status), `junk roll -> ${r.status}`);
  assert.strictEqual((await flags(s)).length, 0, 'giant junk roll was written to the flag log');
});
t('abuse: invalid ids give 4xx without mongoose internals', async () => {
  for (const p of ['/api/sessions/notanid', '/api/sessions/notanid/current-qr', '/api/sessions/notanid/attendance', '/api/sessions/123/export.csv']) {
    const r = await api('GET', p);
    assert.ok(r.status >= 400 && r.status < 500, `${p} -> ${r.status}`);
    assert.ok(!/Cast to|ObjectId|mongoose/i.test(r.text), `${p} leaked internals: ${r.text.slice(0, 100)}`);
  }
});
t('abuse: 500 responses never leak internal error text', async () => {
  const r = await api('POST', '/api/attendance/mark', { token: (await newStudent()).token, raw: '{"bad json' });
  assert.ok(r.status >= 400 && r.status < 500, `bad JSON -> ${r.status}`);
  assert.ok(!/at .*\.js|node_modules|SyntaxError/.test(r.text), `stack leaked: ${r.text.slice(0, 200)}`);
});
t('abuse: export cells cannot carry spreadsheet formulas', async () => {
  const st = await newStudent('+cmd'); const s = await mkSession(staff1);
  eq(await mark(st, s), 201);
  for (const ext of ['csv', 'xls']) {
    const r = await api('GET', `/api/sessions/${s.id}/export.${ext}`, { token: staff1 });
    eq(r, 200, ext);
    assert.ok(!/(^|,|>)\+cmd/.test(r.text), `${ext} contains an unescaped formula cell: ${r.text.slice(0, 200)}`);
  }
});
t('abuse: XSS payloads in stored data are escaped in exports', async () => {
  const s = await mkSession(staff1, { subject: '<img src=x onerror=alert(1)>' });
  const st = await newStudent(); eq(await mark(st, s), 201);
  const r = await api('GET', `/api/sessions/${s.id}/export.xls`, { token: staff1 });
  assert.ok(!r.text.includes('<img'), 'raw HTML in xls');
});

// ---------- RATE LIMITS ----------
t('rate: a whole class on one IP (25 different accounts) is not throttled', async () => {
  const s = await mkSession(staff1);
  const sts = await Promise.all(Array.from({ length: 25 }, () => newStudent()));
  const rs = await Promise.all(sts.map((st) => mark(st, s)));
  assert.ok(rs.every((r) => r.status === 201), `statuses ${rs.map((r) => r.status)}`);
});
t('rate: one account hammering /mark is throttled', async () => {
  const st = await newStudent(); const s = await mkSession(staff1);
  let limited = false;
  for (let i = 0; i < 30; i++) { const r = await mark(st, s, { lat: north(500) }); if (r.status === 429) { limited = true; break; } }
  assert.ok(limited);
});

// ---------- ADMIN ISOLATION ----------
t('admin: test scans never occupy a real roll/device or skip-block real students', async () => {
  const s1 = await mkSession(admin); const s2 = await mkSession(staff1);
  const real = await newStudent();
  const r = await api('POST', '/api/attendance/mark', { token: admin, body: { payload: (await live(s1)).payload, rollNo: real.roll, lat: LAT, lng: LNG, accuracy: 8, deviceId: real.device } });
  eq(r, 201);
  eq(await mark(real, s2), 201);
});

// ---------- STALE REPLAY (waits for >2 rotation windows) ----------
t('stale: a QR / 4-digit code captured >20s ago is rejected', async () => {
  const wait = 21500 - (Date.now() - stale.at);
  if (wait > 0) await sleep(wait);
  const a = await newStudent(), b = await newStudent();
  eq(await api('POST', '/api/attendance/mark', { token: a.token, body: { payload: stale.q.payload, rollNo: a.roll, lat: LAT, lng: LNG, accuracy: 8, deviceId: a.device } }), 400);
  eq(await api('POST', '/api/attendance/mark', { token: b.token, body: { code: stale.q.shortCode, rollNo: b.roll, lat: LAT, lng: LNG, accuracy: 8, deviceId: b.device } }), 404);
});


// ---------- ROUND 2: credential exposure & guessing ----------
t('leak: attendance / flagged API and socket pushes never carry the deviceId credential', async () => {
  const a = await newStudent(); const s = await mkSession(staff1);
  const spy = await connect(); spy.s.emit('join', { sessionId: s.id, code: s.code }); await sleep(400);
  eq(await mark(a, s), 201);
  const b = await newStudent(); eq(await mark(b, s, { lat: north(900) }), 403);
  await sleep(700);
  const att = (await api('GET', `/api/sessions/${s.id}/attendance?code=${s.code}`)).text;
  const fl = (await api('GET', `/api/sessions/${s.id}/flagged?code=${s.code}`)).text;
  spy.s.close();
  assert.ok(!att.includes(a.device) && !/deviceId/.test(att), 'attendance API exposes deviceId');
  assert.ok(!fl.includes(b.device) && !/deviceId/.test(fl), 'flagged API exposes deviceId');
  assert.ok(spy.events.some((e) => e[0] === 'flagged'), 'expected a flagged push');
  assert.ok(!JSON.stringify(spy.events).includes('deviceId') && !JSON.stringify(spy.events).includes(b.device), 'socket push exposes deviceId');
});
t('guess: hammering wrong display codes locks the guesser out (per IP), on every gated route', async () => {
  const s = await mkSession(staff1); const h = { 'X-Forwarded-For': '10.77.0.1' };
  let limited = false;
  for (let i = 0; i < 60; i++) {
    const r = await api('GET', `/api/sessions/${s.id}/current-qr?code=QQQQ${String(i).padStart(2, '0')}`, { headers: h });
    if (r.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'wrong-code guessing on current-qr was never limited');
  eq(await api('GET', `/api/sessions/${s.id}/attendance?code=${s.code}`, { headers: h }), 429, 'even the right code from a locked IP');
  eq(await api('GET', `/api/sessions/${s.id}?code=${s.code}`, { headers: h }), 429, 'GET /:id from a locked IP');
  eq(await api('GET', `/api/sessions/${s.id}/attendance?code=${s.code}`, { headers: { 'X-Forwarded-For': '10.77.0.2' } }), 200, 'other IPs unaffected');
});
t('guess: brute-forcing the code through GET /:id is limited too', async () => {
  const s = await mkSession(staff1); const h = { 'X-Forwarded-For': '10.77.0.3' };
  let limited = false;
  for (let i = 0; i < 60; i++) {
    const r = await api('GET', `/api/sessions/${s.id}?code=WWWW${String(i).padStart(2, '0')}`, { headers: h });
    if (r.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'GET /:id?code= guessing was never limited');
});
t('guess: a legit board polling every second is never locked out', async () => {
  const s = await mkSession(staff1); const h = { 'X-Forwarded-For': '10.77.0.4' };
  for (let i = 0; i < 80; i++) {
    const r = await api('GET', `/api/sessions/${s.id}/current-qr?code=${s.code}`, { headers: h });
    assert.strictEqual(r.status, 200, `poll ${i} -> ${r.status}`);
  }
});
t('code: stale/expired QRs (honest slow scans) never count toward the lockout', async () => {
  const wait = 21500 - (Date.now() - stale.at); if (wait > 0) await sleep(wait);
  const a = await newStudent();
  for (let i = 0; i < 9; i++) {
    const r = await api('POST', '/api/attendance/mark', { token: a.token, body: { payload: stale.q.payload, rollNo: a.roll, lat: LAT, lng: LNG, accuracy: 8, deviceId: a.device } });
    assert.strictEqual(r.status, 400, `stale attempt ${i} -> ${r.status} ${r.text.slice(0, 80)}`);
  }
  const s = await mkSession(staff1); eq(await mark(a, s), 201, 'still able to mark after many stale scans');
});
t('code: forging QR tokens locks the account out just like guessing codes', async () => {
  const a = await newStudent(); const s = await mkSession(staff1); const [id, w] = (await live(s)).payload.split('|');
  let locked = false;
  for (let i = 0; i < 12; i++) {
    const r = await mark(a, s, { payload: `${id}|${w}|${String(i).padStart(10, 'a')}` });
    if (r.status === 429) { locked = true; break; }
  }
  assert.ok(locked, 'token forging was never limited');
});
t('robustness: odd login bodies never 500', async () => {
  for (const raw of ['[]', '"str"', '{"email":{"$ne":1}}', '{"email":["a@rajalakshmi.edu.in"]}', '{"email":12345}', '{"email":null}']) {
    const r = await api('POST', '/api/auth/login', { raw });
    assert.ok(r.status >= 400 && r.status < 500, `login body ${raw} -> ${r.status} ${r.text.slice(0, 80)}`);
  }
});
t('headers: basic hardening headers are set', async () => {
  const res = await fetch(BASE + '/api/auth/config');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('x-frame-options'));
  assert.ok(!res.headers.get('x-powered-by'), 'x-powered-by advertises the framework');
});

// ---------- runner ----------
async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), MONGO_URI: `mongodb://127.0.0.1:27017/proxytest-${RUN}`, GOOGLE_CLIENT_ID: '', JWT_SECRET: SECRET, EXTRA_STAFF_EMAILS: 'staff2@rajalakshmi.edu.in', NODE_ENV: 'test', IP_GEOLOOKUP: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/api/auth/config`); if (r.ok) break; } catch {} await sleep(250); }

  const only = process.argv[2];
  let pass = 0; const fails = [];
  for (const tc of tests) {
    if (only && !tc.name.includes(only) && !tc.name.startsWith('setup')) continue;
    try { await tc.fn(); pass++; console.log(`  PASS  ${tc.name}`); }
    catch (e) { fails.push(tc.name); console.log(`  FAIL  ${tc.name}\n        ${String(e.message).split('\n')[0]}`); }
  }
  console.log(`\n${pass} passed, ${fails.length} failed of ${pass + fails.length}`);
  server.kill();
  process.exit(fails.length ? 1 : 0);
}
main();
