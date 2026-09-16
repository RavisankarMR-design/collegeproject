const jwt = require('jsonwebtoken');

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

// ponytail: self-declared email, not Google-verified — anyone can type any
// @rajalakshmi.edu.in address. Trial skips OAuth for speed; swap in
// verifyGoogleToken (git history) if real identity verification is needed.
function verifyEmail(rawEmail) {
  const email = String(rawEmail || '').toLowerCase().trim();
  if (ADMIN_EMAILS.includes(email)) {
    return { email, name: 'Admin', role: 'admin' };
  }
  if (!EMAIL_RE.test(email)) {
    throw new Error(`Enter a valid @${ALLOWED_DOMAIN} email address.`);
  }

  const role = STAFF_EMAILS.includes(email) ? 'staff' : 'student';
  const name = email.split('@')[0].split('.').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { email, name, role };
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

module.exports = { verifyEmail, issueSessionToken, requireAuth, JWT_SECRET };
