const express = require('express');
const { verifyEmail, verifyGoogleIdToken, issueSessionToken, GOOGLE_CLIENT_ID, SignInError } = require('../utils/auth');
const { rateLimit } = require('../utils/rateLimit');

const router = express.Router();

// Per IP, but generous: a whole class signs in at once from one campus WiFi IP.
// Google verifies the token itself, so there's no password to brute-force here.
const loginLimiter = rateLimit({ windowMs: 60_000, max: 300 });

// Public — no secret in it, just tells login.html whether Google sign-in is
// configured yet, and which client id to initialize it with.
router.get('/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

// Body: { credential } — a Google ID token from Sign In With Google,
// verified against Google's own keys (see utils/auth.js verifyGoogleIdToken)
// so the email in it can't be typed or forged. Falls back to { email }
// (self-declared, unverified) only when GOOGLE_CLIENT_ID isn't configured —
// dev-only; production refuses to boot without it (see server.js).
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const identity = GOOGLE_CLIENT_ID
      ? await verifyGoogleIdToken(req.body.credential)
      : verifyEmail(req.body.email);
    const token = issueSessionToken(identity);
    res.json({ token, ...identity });
  } catch (err) {
    if (err instanceof SignInError) {
      return res.status(401).json({ error: err.message });
    }
    if (GOOGLE_CLIENT_ID) console.error('Google sign-in verification failed:', err);
    res.status(401).json({ error: GOOGLE_CLIENT_ID ? 'Google sign-in failed — please try again.' : err.message });
  }
});

module.exports = router;
