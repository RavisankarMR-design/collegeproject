const express = require('express');
const { verifyEmail, issueSessionToken } = require('../utils/auth');

const router = express.Router();

// Body: { email } — self-declared, checked only for the @rajalakshmi.edu.in
// domain and staff-list membership (see utils/auth.js verifyEmail).
router.post('/login', (req, res) => {
  try {
    const identity = verifyEmail(req.body.email);
    const token = issueSessionToken(identity);
    res.json({ token, ...identity });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

module.exports = router;
