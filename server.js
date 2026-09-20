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
const { JWT_SECRET, GOOGLE_CLIENT_ID } = require('./utils/auth');

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
app.set('trust proxy', 1); // Render sits behind a proxy — needed for req.ip (rate limiting) to see the real client IP
app.use(cors());
app.use(express.json());
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

io.on('connection', (socket) => {
  socket.on('join', (sessionId) => {
    if (typeof sessionId === 'string') socket.join(sessionId);
  });
});

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/attendance-app';

mongoose
  .connect(MONGO_URI)
  .then(() => Student.init()) // waits for index build — a unique index (email/rollNo/deviceId)
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
