const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const ALLOWED_DOMAIN = 'rajalakshmi.edu.in';

// To add a staff member: add their exact @rajalakshmi.edu.in email below.
// Anyone else with an email on the allowed domain is treated as a student.
const STAFF_EMAILS = ['bhuvaneswaran@rajalakshmi.edu.in'];

// Admins bypass the domain check entirely and can access any page/action —
// no student/staff restriction applies to them.
const ADMIN_EMAILS = ['mrravisankar7@gmail.com'];

// JWT_SECRET must be a real, stable env var in production — if it falls back
// to the dev default, every login becomes forgeable. Checked at server
// startup (see server.js), not silently here.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
const SESSION_LIFETIME = '12h'; // a school day, with buffer

const EMAIL_RE = /^[a-z0-9._+-]+@rajalakshmi\.edu\.in$/;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Shared by both login paths below — decides role from an email that's
// already been established as real (Google-verified, or in dev mode the
// self-typed fallback). Never call this with an unverified email.
function identityFor(email) {
  if (ADMIN_EMAILS.includes(email)) {
    return { email, name: 'Admin', role: 'admin' };
  }
  if (!EMAIL_RE.test(email)) {
    throw new Error(`Enter a valid @${ALLOWED_DOMAIN} email address.`);
  }

  const role = STAFF_EMAILS.includes(email) ? 'staff' : 'student';
  // Just the first dot-separated segment (e.g. "ravisankar.mr.2024.cse" ->
  // "Ravisankar") — the rest (initials, year, branch) isn't part of the name.
  const firstSegment = email.split('@')[0].split('.')[0];
  const name = firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1);
  return { email, name, role };
}

// Real identity check — verifies the ID token's signature, audience, issuer
// and expiry against Google's own keys, so the email in it can't be typed
// or forged (see routes/auth.js). Only live when GOOGLE_CLIENT_ID is set.
async function verifyGoogleIdToken(idToken) {
  const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload.email_verified) {
    throw new Error('Google account email is not verified.');
  }
  return identityFor(String(payload.email).toLowerCase().trim());
}

// ponytail: self-declared email, not Google-verified — anyone can type any
// @rajalakshmi.edu.in address. Only reachable when GOOGLE_CLIENT_ID isn't
// configured, and never in production (see server.js) — a dev-only stand-in
// until real Google sign-in is set up.
function verifyEmail(rawEmail) {
  return identityFor(String(rawEmail || '').toLowerCase().trim());
}

function issueSessionToken({ email, name, role }) {
  return jwt.sign({ email, name, role }, JWT_SECRET, { expiresIn: SESSION_LIFETIME });
}

// Express middleware factory. requireAuth() accepts any signed-in user;
// requireAuth('staff') / requireAuth('student') also enforces the role.
function requireAuth(role) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sign in required.' });

    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (role && user.role !== role && user.role !== 'admin') {
        return res.status(403).json({ error: `This action requires a ${role} account.` });
      }
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: 'Session expired or invalid — please sign in again.' });
    }
  };
}

module.exports = { verifyEmail, verifyGoogleIdToken, issueSessionToken, requireAuth, JWT_SECRET, GOOGLE_CLIENT_ID };
