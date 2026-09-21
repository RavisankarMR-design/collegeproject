require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const sessionRoutes = require('./routes/sessions');
const attendanceRoutes = require('./routes/attendance');
const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/students');
const Student = require('./models/Student');
const Session = require('./models/Session');
const { JWT_SECRET, GOOGLE_CLIENT_ID } = require('./utils/auth');
const { canAccessSession } = require('./utils/access');

if (JWT_SECRET === 'dev-only-insecure-secret-change-me') {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET is not set. Refusing to start in production with a forgeable default secret.');
    process.exit(1);
  }
  console.warn('WARNING: JWT_SECRET is not set — using an insecure default. Every login session can be forged. Set a real JWT_SECRET env var.');
}

if (!GOOGLE_CLIENT_ID) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: GOOGLE_CLIENT_ID is not set. Refusing to start in production with self-declared (unverified) login.');
    process.exit(1);
  }
  console.warn('WARNING: GOOGLE_CLIENT_ID is not set — falling back to self-typed email login (anyone can type any @rajalakshmi.edu.in address). Set GOOGLE_CLIENT_ID for real Google sign-in.');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy — needed for req.ip (rate limiting) to see the real client IP
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(cors());
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/sessions', sessionRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/students', studentRoutes);

const server = http.createServer(app);
// Rooms are keyed by sessionId, so a push only reaches teacher panels
// watching that specific session, not every open tab on the server.
const io = new Server(server, { cors: { origin: '*' } });
app.set('io', io);

// Joining a session room (live 'present'/'flagged' pushes carry names, roll
// numbers and device ids) needs the same proof as the REST endpoints: the
// session's displayCode, or the owning staff/admin token. Knowing the sessionId
// — which every student who scans a QR learns — is not enough.
io.on('connection', (socket) => {
  socket.on('join', async (creds, ack) => {
    const reply = (ok) => { if (typeof ack === 'function') ack({ ok }); };
    try {
      if (!creds || typeof creds !== 'object' || typeof creds.sessionId !== 'string' || !mongoose.Types.ObjectId.isValid(creds.sessionId)) return reply(false);
      if (socket.rooms.size > 4) return reply(false); // own id + a few sessions, not a scraper
      const session = await Session.findById(creds.sessionId).select('teacherEmail displayCode');
      if (!session || !canAccessSession(session, { code: typeof creds.code === 'string' ? creds.code : null, token: typeof creds.token === 'string' ? creds.token : null })) return reply(false);
      socket.join(String(session._id));
      reply(true);
    } catch {
      reply(false);
    }
  });
});

// Anything that slips past a route's own handling (bad JSON body, oversized body)
// gets a plain JSON error — never an HTML page with a stack trace.
app.use((err, req, res, next) => {
  void next;
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong — please try again.' : 'Bad request.' });
});

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/attendance-app';

mongoose
  .connect(MONGO_URI)
  .then(() => Student.syncIndexes()) // also swaps the old sparse deviceId index for the partial one; waits for the build — a unique index (email/rollNo/deviceId)
  // that fails to build because duplicates already exist in the collection would
  // otherwise fail silently in the background, quietly disabling that constraint
  // (confirmed live: this is exactly how two accounts once shared a device undetected).
  .then(() => {
    server.listen(PORT, () => console.log(`Attendance server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection or index build failed:', err.message);
    process.exit(1);
  });
