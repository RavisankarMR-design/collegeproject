const crypto = require('crypto');

/**
 * Rotating token logic.
 * The QR code never encodes a fixed secret. Instead it encodes:
 *   sessionId | windowIndex | token
 * where token = HMAC(session.secret, sessionId:windowIndex).
 *
 * windowIndex changes every `windowSeconds` (default 10s), so a photo/screenshot
 * of the QR becomes worthless after that window closes. The secret itself is
 * never sent to any client, so a student device can never forge a future token.
 */

function currentWindow(windowSeconds) {
  return Math.floor(Date.now() / (windowSeconds * 1000));
}

function generateToken(secret, sessionId, windowIndex) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${sessionId}:${windowIndex}`)
    .digest('hex')
    .slice(0, 10);
}

// A human-typeable stand-in for the QR — same rotating token, just
// compressed to 4 digits, for classrooms where the QR can't be displayed
// (broken projector, etc). Deterministic from the same token, so it carries
// the exact same rotation/anti-replay guarantee, just less entropy per digit.
function shortCode(token) {
  return String(parseInt(token.slice(0, 8), 16) % 10000).padStart(4, '0');
}

// Real class use showed 15-20s isn't enough for a first-time Google login
// (consent screen + account picker) to complete before the token expires —
// confirmed live, not hypothetical. 60s covers that; still expires well
// short of "screenshot texted to a friend a few minutes later," and the
// client shows a clear rescan prompt for the (now rarer) case a login runs
// past even this.
const TOKEN_STALE_MS = 60_000;

/**
 * Verifies a scanned token against the current window and a grace period
 * behind it — covering both simple network/clock jitter and a first-time
 * login round-trip that delayed the scan reaching the server.
 */
function verifyToken(secret, sessionId, windowIndex, token, windowSeconds) {
  const now = currentWindow(windowSeconds);
  const windowIndexNum = Number(windowIndex);

  if (!Number.isInteger(windowIndexNum)) return { valid: false, forged: true, reason: 'Malformed QR payload' };
  if (windowIndexNum > now) return { valid: false, forged: true, reason: 'QR from the future — clock mismatch' };
  const maxStaleWindows = Math.max(1, Math.ceil(TOKEN_STALE_MS / (windowSeconds * 1000)));
  if (now - windowIndexNum > maxStaleWindows) return { valid: false, reason: 'QR expired — rescan the current code' };

  const expected = generateToken(secret, sessionId, windowIndexNum);
  if (expected !== token) return { valid: false, forged: true, reason: 'Token does not match — tampered or forged QR' };

  return { valid: true };
}

/**
 * Verifies a manually-typed 4-digit code the same way verifyToken verifies a
 * scanned QR — checks the current window and the previous one (same grace
 * period), deriving the expected short code from the real rotating token
 * rather than trusting anything the client sent except the 4 digits typed.
 */
function verifyShortCode(secret, sessionId, code, windowSeconds) {
  const now = currentWindow(windowSeconds);
  for (const windowIndex of [now, now - 1]) {
    const token = generateToken(secret, sessionId, windowIndex);
    if (shortCode(token) === String(code).trim()) return { valid: true };
  }
  return { valid: false, reason: 'Code expired or incorrect — check the live code and try again' };
}

module.exports = { currentWindow, generateToken, verifyToken, shortCode, verifyShortCode };
