// Shared by teacher.html and student.html (and read by login.html) — one
// place for "am I signed in," "attach the token," and "handle an expired
// session," instead of copies drifting apart across pages.
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
  location.href = 'login.html';
}

// Redirects to login.html if nobody's signed in; returns the auth object
// otherwise. Call at the top of a page that requires sign-in.
function requireSignedIn() {
  const auth = getAuth();
  if (!auth) {
    location.href = 'login.html';
    return null;
  }
  return auth;
}

// fetch() wrapper that attaches the bearer token and sends the caller back
// to login.html on a 401 (expired/invalid session) instead of failing silently.
async function authFetch(url, options = {}) {
  const auth = getAuth();
  const headers = { ...(options.headers || {}) };
  if (auth) headers.Authorization = `Bearer ${auth.token}`;

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem(AUTH_KEY);
    location.href = 'login.html';
  }
  return res;
}
