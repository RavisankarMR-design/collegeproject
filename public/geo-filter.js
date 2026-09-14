// Shared by student.html (scanning) and teacher.html (capturing the
// classroom center) — both need the same noise-reduced GPS fix, not just
// the student's. A laptop's "GPS" is usually pure WiFi/IP-based
// geolocation with no real chip at all, often noisier than a phone's,
// so the teacher's one-shot reading used to be an unaddressed source of
// error even after the student side was fixed.

// "Take one reading and keep it" throws away information — each new GPS
// fix says something about where you are even if it's noisy. A Kalman
// filter fuses every sample into a running estimate instead: each fix is
// weighted by its own reported accuracy (a confident fix pulls the
// estimate hard, a noisy one barely moves it), and uncertainty grows
// between fixes based on how much movement is plausible.
function haversineApprox(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class KalmanLocationFilter {
  // processNoise: meters/sec of plausible movement, i.e. how fast our
  // confidence should erode between fixes. A slow walk, not a car.
  constructor(processNoise = 3) {
    this.variance = -1;
    this.processNoise = processNoise;
  }
  process(lat, lng, accuracy, timestampMs) {
    const acc = Math.max(accuracy, 1); // a reported 0m accuracy is not real
    if (this.variance < 0) {
      this.timestamp = timestampMs;
      this.lat = lat;
      this.lng = lng;
      this.variance = acc * acc;
    } else {
      const dtSeconds = Math.max(0, (timestampMs - this.timestamp) / 1000);

      // A jump wildly bigger than what either reading's own claimed
      // accuracy could plausibly explain (a stray multipath reflection,
      // not real movement or ordinary noise) is discarded outright — a
      // Kalman filter otherwise still lets one bad sample drag the
      // estimate a long way before it recovers. Gated on the readings'
      // own uncertainty rather than an assumed speed, since a flat speed
      // threshold is fragile: how far apart two noisy-but-valid fixes
      // land depends on the device's polling interval, not just how fast
      // someone could move.
      if (dtSeconds > 0) {
        const jumpMeters = haversineApprox(this.lat, this.lng, lat, lng);
        const priorAccuracy = Math.sqrt(this.variance);
        const plausibleAllowance = 3 * (priorAccuracy + acc) + this.processNoise * dtSeconds;
        if (jumpMeters > plausibleAllowance) {
          return { lat: this.lat, lng: this.lng, accuracy: Math.sqrt(this.variance) };
        }
      }

      this.timestamp = timestampMs;
      this.variance += dtSeconds * this.processNoise * this.processNoise; // uncertainty grows with time since last fix
      const gain = this.variance / (this.variance + acc * acc);
      this.lat += gain * (lat - this.lat);
      this.lng += gain * (lng - this.lng);
      this.variance = (1 - gain) * this.variance;
    }
    return { lat: this.lat, lng: this.lng, accuracy: Math.sqrt(this.variance) };
  }
}

// Samples for a few seconds, running every fix through the filter above,
// instead of a single getCurrentPosition() call — which on many devices
// returns the first fix, commonly the least accurate one (cached/
// network-based, before a real GPS chip — if there even is one — has
// warmed up).
function getFilteredPosition(onProgress) {
  return new Promise((resolve, reject) => {
    const GOOD_ENOUGH_METERS = 12;
    const TIMEOUT_MS = 8000;
    // A PositionError before any fix has arrived is usually POSITION_UNAVAILABLE
    // — the GPS provider is momentarily busy, e.g. because the previous scan
    // only just released it — not a real failure. Restarting the watch a
    // couple of times fixes this transparently instead of failing outright
    // and forcing the student to notice and tap Scan again themselves.
    const MAX_RESTART_ATTEMPTS = 2;
    const RESTART_DELAY_MS = 500;

    const filter = new KalmanLocationFilter();
    let latest = null;
    let gotAnyFix = false;
    let watchId = null;
    let restarts = 0;

    function startWatch() {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          gotAnyFix = true;
          latest = filter.process(
            pos.coords.latitude,
            pos.coords.longitude,
            pos.coords.accuracy,
            pos.timestamp || Date.now()
          );
          if (onProgress) onProgress(latest.accuracy);
          if (latest.accuracy <= GOOD_ENOUGH_METERS) finish();
        },
        (err) => {
          if (gotAnyFix) { finish(); return; }
          if (restarts < MAX_RESTART_ATTEMPTS) {
            restarts++;
            navigator.geolocation.clearWatch(watchId);
            setTimeout(startWatch, RESTART_DELAY_MS);
          } else {
            cleanup();
            reject(err);
          }
        },
        { enableHighAccuracy: true, maximumAge: 0 }
      );
    }
    startWatch();

    const timer = setTimeout(finish, TIMEOUT_MS);
    function cleanup() { clearTimeout(timer); if (watchId != null) navigator.geolocation.clearWatch(watchId); }
    function finish() {
      cleanup();
      if (latest) resolve(latest);
      else reject(new Error('Still could not get a GPS fix. Check that location/GPS is turned on, then try again.'));
    }
  });
}
