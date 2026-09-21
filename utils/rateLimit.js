const { clientIp } = require('./ip');

// ponytail: in-memory per-process limiter — fine for this single-instance
// deploy; swap for a shared store (Redis) if this ever runs multiple instances.
//
// `key` picks who is being limited. Default is the client IP, which is wrong
// for anything a whole class does at once from one campus WiFi (all students
// share one public IP) — those routes pass a per-user key instead.
function rateLimit({ windowMs, max, key = clientIp }) {
  const hits = new Map(); // key -> [timestamps]

  // Without this, every distinct key stays in the map forever.
  setInterval(() => {
    const now = Date.now();
    for (const [k, times] of hits) {
      if (times.every((t) => now - t >= windowMs)) hits.delete(k);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const recent = (hits.get(k) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(k, recent);

    if (recent.length > max) {
      return res.status(429).json({ error: 'Too many requests — please wait a moment and try again.' });
    }
    next();
  };
}

module.exports = { rateLimit };
