const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const ALLOWED_DOMAIN = 'rajalakshmi.edu.in';

// To add a staff member: add their exact @rajalakshmi.edu.in email below.
// Anyone else with a verified email on the allowed domain is treated as a
// student. A small hand-maintained list is far more reliable here than
// guessing from email format (one staff example is not enough patterns to
// build a safe regex from, and a wrong guess would route a student into the
// teacher UI).
const STAFF_EMAILS = ['bhuvaneswaran@rajalakshmi.edu.in'];

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// JWT_SECRET must be a real, stable env var in production — if it falls back
// to the dev default, every login becomes forgeable. Checked at server
// startup (see server.js), not silently here.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
const SESSION_LIFETIME = '12h'; // a school day, with buffer

// Verifies a Google ID token server-side (never trust a client-supplied
// email/name directly) and returns our own app identity for it.
async function verifyGoogleToken(idToken) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();

  const email = String(payload.email || '').toLowerCase().trim();
  if (!payload.email_verified || !email.endsWith('@' + ALLOWED_DOMAIN)) {
    throw new Error(`Only @${ALLOWED_DOMAIN} accounts can sign in.`);
  }

  const role = STAFF_EMAILS.includes(email) ? 'staff' : 'student';
  return { email, name: payload.name || email, role };
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
      if (role && user.role !== role) {
        return res.status(403).json({ error: `This action requires a ${role} account.` });
      }
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: 'Session expired or invalid — please sign in again.' });
    }
  };
}

module.exports = { verifyGoogleToken, issueSessionToken, requireAuth, JWT_SECRET };
