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
const { JWT_SECRET } = require('./utils/auth');

if (JWT_SECRET === 'dev-only-insecure-secret-change-me') {
  console.warn('WARNING: JWT_SECRET is not set — using an insecure default. Every login session can be forged. Set a real JWT_SECRET env var.');
}
if (!process.env.GOOGLE_CLIENT_ID) {
  console.warn('WARNING: GOOGLE_CLIENT_ID is not set — sign-in will fail until it is.');
}

const app = express();
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
  .then(() => {
    server.listen(PORT, () => console.log(`Attendance server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
