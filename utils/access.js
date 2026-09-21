const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./auth');

function userFromToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Names, roll numbers, the live rotating QR and the exports are only for the
// teacher who owns the session, an admin, or a second screen (smart board)
// that has the session's displayCode. Knowing the sessionId alone is NOT
// enough — every student who scans a QR learns it.
function canAccessSession(session, { code, token }) {
  if (code && String(code).trim().toUpperCase() === session.displayCode) return true;
  const user = userFromToken(token);
  return !!user && (user.role === 'admin' || (user.role === 'staff' && user.email === session.teacherEmail));
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Owner-or-admin check for actions that change a session.
function ownsSession(session, user) {
  return user.role === 'admin' || session.teacherEmail === user.email;
}

module.exports = { canAccessSession, bearer, ownsSession, userFromToken };
