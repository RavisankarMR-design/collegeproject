const express = require('express');
const { verifyGoogleToken, issueSessionToken } = require('../utils/auth');

const router = express.Router();

// Public config the login page needs — the Client ID is not a secret (it's
// embedded in every Google sign-in button on the public internet), safe to
// serve plainly instead of hardcoding it into the HTML.
router.get('/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
});

// Body: { credential } — the ID token Google Identity Services hands back
// after a successful sign-in. Verified here server-side; the client never
// gets to just assert its own email/name/role.
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing credential' });

    const identity = await verifyGoogleToken(credential);
    const token = issueSessionToken(identity);
    res.json({ token, ...identity });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

module.exports = router;
