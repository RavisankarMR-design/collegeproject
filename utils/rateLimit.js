// ponytail: in-memory per-process limiter — fine for this single-instance
// deploy; swap for a shared store (Redis) if this ever runs multiple instances.
function rateLimit({ windowMs, max }) {
  const hits = new Map(); // key -> [timestamps]

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);

    if (recent.length > max) {
      return res.status(429).json({ error: 'Too many requests — please wait a moment and try again.' });
    }
    next();
  };
}

module.exports = { rateLimit };
