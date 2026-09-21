// Behind Render the socket peer is Cloudflare's edge, so req.ip is an edge
// address shared by unrelated users (and rotates per connection). Cloudflare
// sets CF-Connecting-IP to the real client and overwrites any client-supplied
// value; Render's origin is only reachable through it. We only trust the
// header when CF-Ray (also CF-set) is present, otherwise fall back to req.ip
// (local dev / direct connections).
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  return cf && req.headers['cf-ray'] ? String(cf) : req.ip;
}

module.exports = { clientIp };
