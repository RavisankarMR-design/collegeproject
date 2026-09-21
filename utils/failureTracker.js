// Counts wrong-code / forged-token attempts per account and locks the account
// out after too many. The 4-digit code has only 10,000 values, so without this
// a student who is NOT in the room could keep guessing it with a spoofed GPS
// fix (20 tries/min for a whole class period is ~20% odds). A couple of honest
// typos stay far below the limit.
// ponytail: in-memory, per-process — fine for this single-instance deploy.
function createFailureTracker({ maxFailures, windowMs, lockMs }) {
  const state = new Map(); // key -> { times: number[], lockedUntil: number }

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of state) if (v.lockedUntil < now && v.times.every((t) => now - t >= windowMs)) state.delete(k);
  }, 60_000).unref();

  return {
    // Milliseconds of lockout remaining (0 = not locked).
    lockedFor(key) {
      const v = state.get(key);
      return v && v.lockedUntil > Date.now() ? v.lockedUntil - Date.now() : 0;
    },
    record(key) {
      const now = Date.now();
      const v = state.get(key) || { times: [], lockedUntil: 0 };
      v.times = v.times.filter((t) => now - t < windowMs);
      v.times.push(now);
      if (v.times.length >= maxFailures) { v.lockedUntil = now + lockMs; v.times = []; }
      state.set(key, v);
    },
    clear(key) { state.delete(key); },
  };
}

module.exports = { createFailureTracker };
