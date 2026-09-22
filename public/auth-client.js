// Shared by teacher.html, student.html and index.html (the sign-in page) —
// one place for "am I signed in," "attach the token," and "handle an
// expired session," instead of copies drifting apart across pages.
const AUTH_KEY = 'auth';

function getAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const auth = JSON.parse(raw);
    const payload = JSON.parse(atob(auth.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp * 1000 < Date.now()) { localStorage.removeItem(AUTH_KEY); return null; }
    return auth;
  } catch {
    localStorage.removeItem(AUTH_KEY);
    return null;
  }
}

function signOut() {
  localStorage.removeItem(AUTH_KEY);
  location.href = 'index.html';
}

// Redirects to index.html (the sign-in page) if nobody's signed in; returns
// the auth object otherwise. Call at the top of a page that requires sign-in.
function requireSignedIn() {
  const auth = getAuth();
  if (!auth) {
    location.href = 'index.html';
    return null;
  }
  return auth;
}

// fetch() wrapper that attaches the bearer token, sends the caller back to
// index.html on a 401 (expired/invalid session), and — on real mobile data,
// not just a fast campus/office connection — gives up after 20s instead of
// leaving a "Scanning..." spinner stuck forever with no explanation.
async function authFetch(url, options = {}, timeoutMs = 20000) {
  const auth = getAuth();
  const headers = { ...(options.headers || {}) };
  if (auth) headers.Authorization = `Bearer ${auth.token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Network is too slow right now — check your connection and try again.');
    }
    throw new Error('Could not reach the server — check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    localStorage.removeItem(AUTH_KEY);
    location.href = 'index.html';
  }
  return res;
}
