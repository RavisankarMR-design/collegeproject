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

/**
 * Verifies a scanned token against the current window and the previous one
 * (a small grace period so a scan that lands right at a 10s boundary, or that
 * takes a couple of seconds to reach the server, isn't unfairly rejected).
 */
function verifyToken(secret, sessionId, windowIndex, token, windowSeconds) {
  const now = currentWindow(windowSeconds);
  const windowIndexNum = Number(windowIndex);

  if (!Number.isInteger(windowIndexNum)) return { valid: false, reason: 'Malformed QR payload' };
  if (windowIndexNum > now) return { valid: false, reason: 'QR from the future — clock mismatch' };
  if (now - windowIndexNum > 1) return { valid: false, reason: 'QR expired — rescan the current code' };

  const expected = generateToken(secret, sessionId, windowIndexNum);
  if (expected !== token) return { valid: false, reason: 'Token does not match — tampered or forged QR' };

  return { valid: true };
}

module.exports = { currentWindow, generateToken, verifyToken };
