# Plan — Firebase-backed roster sync (not built yet)

Status: **agreed architecture, not implemented.** Blocked on data (no
department DB, no staff/timetable data, no Firebase project yet), not on
code. See "What's actually blocking the build" below.

## The problem this solves

P3 is fully offline/static today — every roster (Trial Class 1, or a pasted
one) lives only in that one phone's `localStorage`. There's no way for a
different staff member, with a different class, to get their own roster
onto their own phone except pasting it by hand or hardcoding another
`roster-classX.js` file per class (doesn't scale past a couple of trial
classes without the maintainer touching it every time).

Also established (2026-09-29 conversation): the real department DB is
**flat** — name, email, roll number per student, department-wide, no
class/section field. So the DB alone can never answer "who's in this
specific class" — that grouping has to be defined and stored separately
(staff/timetable/class-roll-list data), it can't be derived from the DB.

## Agreed direction

**Login is opt-in, local-only stays the default.**

- **No login:** P3 behaves exactly as it does today — paste a roster or use
  Trial Class 1, fully offline, zero Firebase involved. No regression, no
  forced dependency.
- **First-time login (needs internet once):** staff signs in, server hands
  back **every class assigned to them** — their whole timetable's worth,
  not just one — and ALL of it gets cached into `localStorage` in one shot.
  One login, one fetch, done — not repeated per session/day.
- **Every session after that (fully offline, no server call):** the app
  shows the staff's full cached class list, and **auto-highlights/pre-selects
  whichever class matches right now** by checking the cached timetable data
  (day + period) against the phone's own clock. Staff can still tap a
  different class from the list manually — the highlight is a convenience,
  not a lock. Re-login only pulls fresh data if the staff explicitly wants
  to re-sync (e.g. timetable changed mid-term).

## Data model (Firestore)

- **`staff/{email}`** — name, department.
- **`staff/{email}/classes`** — subcollection: which class IDs this staff
  teaches (their timetable assignment).
- **`classes/{classId}`** — className, department, `staffEmails` (array of
  who may read it), its timetable slot(s) (day + period/time), and the
  **full student list embedded in the doc**: `students: [{roll, name,
  email}, ...]`. The roll list and the timetable slot are both pieces the
  flat department DB can't provide — someone (admin, or derived from the
  DigiCampus timetable/class export) has to define this once per
  class/term. (Embedded rather than looked up per student — see "Scale"
  below for why.)
- **`students/{rollNo}`** — name, email, department: the flat department
  DB. No longer read by the app at login (the class docs carry their own
  copy); it's the admin-side source the import script copies from. The
  copied real name/email replaces the current `guessEmail()` heuristic in
  `app.js` with verified data instead of a guessed pattern.

## Login flow

1. Staff signs in (Google, restricted to `@rajalakshmi.edu.in` — same
   domain restriction Project 1's `utils/auth.js` already enforces).
2. App reads `staff/{their email}/classes` → gets ALL their assigned class
   IDs, their whole timetable's worth, in one go.
3. For every one of those classes, pulls the class doc from
   `classes/{classId}` — timetable slot plus the embedded student list
   (roll, real name, real email). No per-student lookups.
4. Caches the **entire set** of classes (rosters + timetable slots) into
   `localStorage` in one write — new key alongside the existing
   `ROSTER_KEY`, since now there's a list of rosters to choose from, not
   just one active one.
5. Fully offline from there, every session:
   - App checks the phone's current day/time against each cached class's
     timetable slot and **highlights the matching class** in the list.
   - Staff taps it to load that class as the active roster (reuses the
     existing `saveRoster()` / `ROSTER_KEY` single-active-roster mechanism
     P3 already has, same as picking Trial Class 1 today) — or picks a
     different class from the list manually if the auto-pick is wrong.
   - No server call happens here — this is pure local computation against
     the one-time cached data.
6. Re-login only pulls fresh data if the staff explicitly wants to
   re-sync (e.g. timetable changed mid-term) — not on every session.

## Scale: ~500 staff (stated 2026-10-06)

Target: about 500 staff, each with their own timetable and per-class
student lists. Server holds all of it; a staff member only ever sees their
own. **Hard rule: after the first login everything is cached on the phone
and no internet is needed again.**

- **Store each class with its student list inside it (done above), so one
  fetch returns a whole class.** Plain flow: Firebase holds the data and
  hands each staff member only their own; the phone saves it all at first
  login. (Firebase meters usage in "reads" — one per record fetched; free
  plan is 50,000/day. Embedding keeps a login to ~10 fetches, so usage
  stays far under the free limit. No action needed beyond building it this
  way.)
- **Access rule:** a staff member can read `staff/{their email}` and only
  class docs whose `staffEmails` contains their email
  (`request.auth.token.email in resource.data.staffEmails`). Storing
  `staffEmails` on the class doc avoids a second `get()` per read inside the
  rule. A student account has no staff doc and is in no `staffEmails`, so
  it gets nothing — this is also what finally separates staff from
  students; the current client-side sign-in gate accepts any
  `@rajalakshmi.edu.in` account and can't.
- **Stale data / re-sync:** because of the no-internet-after-first-login
  rule, server-side timetable changes never reach a phone by themselves.
  Needs an explicit "Re-sync (needs internet)" button; nothing automatic.
- **Shared/passed-around phones:** the cache holds real student names and
  emails. **Decision changed 2026-10-08:** the owner wants the cache kept
  permanently after one sign-in, so sign-out only ends the login and keeps
  the classes (the phone lock and staff PIN cover the passed-around case).
  The cache is still discarded if a *different* email signs in.
- **Cache size:** ~10 classes × ~100 students × ~150 bytes ≈ 150 KB —
  fits `localStorage`'s ~5 MB; IndexedDB not needed.
- **Auth detail to verify before building:** Firestore security rules need
  a Firebase Auth token, but P3's gate uses plain Google Identity
  Services. The usual bridge is `signInWithCredential` with the Google ID
  token the gate already receives (so staff aren't prompted twice), but
  that requires the token's OAuth client ID (P1's) to be accepted by the
  Firebase project's Google provider. **Not verified yet — check first.**
  Load the Firebase SDK lazily, only on first login / re-sync, so normal
  sessions stay fully offline.
- **Loading the data:** a one-time admin import script (Firebase Admin SDK,
  run from a trusted machine) that builds `staff/*` and `classes/*` from
  the DigiCampus export (staff list, timetable slots, per-class rosters).
  The export itself is the blocker.

## What's actually blocking the build

Not code — data and one deferred decision:

- No Firebase project exists yet (an account-level step only the project
  owner can do — same category of action as the GitHub org created earlier
  in this session for a cleaner P3 URL).
- No real department DB in hand yet (flat roll/name/email export).
- No real staff→class/timetable assignment data in hand yet.
- **Resolved:** sign-in method — P3 has its own Google Identity Services
  login gate (built 2026-10-02/03, live), using P1's OAuth client ID. See
  the Firebase Auth bridging note under "Scale" for the remaining detail.
- **Deferred, not yet decided:** how rosters/timetable data actually get
  uploaded into Firestore in the first place — a CSV-paste admin tool
  (reusable every term) vs. manual entry directly in Firebase's console
  (fine while still trial-scale).

## What can be built right now, with zero real data

The schema, Firestore security rules (a staff can only read their own
`staff/{email}/classes` and the classes it points to — never another
staff's), and the full login → fetch → cache code path, all built and
tested against placeholder/trial data (same shape as the existing Trial
Class 1 roster). The moment real data exists, swapping it in is a
data-loading job, not a coding job.

## Related, already built (for context)

- `app.js`'s `guessEmail()` — the current stand-in for real email data,
  pattern-guessed from a roster name (`ravisankar.mr.2024.cse@…` for "Ravi
  Sankar M R"). Explicitly marked as a guess in its own code comment —
  `students/{rollNo}` above is what replaces it with real data.
- `roster-class1.js` / the paste-a-roster flow — this is the mechanism
  Firestore data would feed into, unchanged.

## Build status (2026-10-08) — app side done, waiting on the Firebase project

Real data arrived (DigiCampus exports: Faculties + two Zoho Creator course
sheets). Analysis + the combined workbook are described in `CLAUDE.md`. What
that changed in this plan:

- **Dropped the `staff` collection and per-student lookups.** One collection,
  `classes`, one document per class (id = `<courseCode>__<className>`) with
  `staffEmails`, `students: [{roll, name}]`, `component`, `department`,
  `parentGroup`, `timetable: null`. A staff member's whole login is a single
  query: `classes where staffEmails array-contains <email>` (2–3 documents).
- **Real numbers:** 51 class documents, 22 staff (2–3 classes each), 3,354
  student entries, 158 KB total, largest document 6.3 KB.
- **Student names are stored without the date of birth** DigiCampus appends to
  same-named students ("Akshaya S (02/09/2006)"). 63 students share a name
  with someone else, but only 2 such pairs sit in the same class, and the
  roll number is always shown next to the name.
- **Timetable is not in any export**, so classes are picked by tapping; no
  auto-highlight by day/period yet.
- **Built in the app** (`app.js`, `index.html`): after sign-in, a "Your
  classes" list; tapping one loads that roster (only those roll numbers can
  be scanned) and starts the camera; switching class with scans present asks
  first and clears them; list cached for offline permanently (kept across sign-out, replaced only by
  a successful re-sync, wiped only when a different account signs in; the
  app also requests persistent browser storage); "Re-sync" = sign out + in. `FIREBASE_CONFIG`
  in `app.js` is now set to the real project, so every fresh sign-in loads
  the Firebase SDK from Google and fetches that account's classes.
- **The class data file is private and deliberately outside this repo**:
  `../p3-private-data/classes-import.json`. Anything inside this repo is
  world-readable on GitHub Pages, which is exactly why the data lives in
  Firestore and not in the app.

### What was set up (2026-10-08, done in the owner's Firebase console)

- **Firebase project `rec-scan`** (project number 399324732813, free Spark
  plan, no billing, no organisation, Analytics / Gemini / Developer Programme
  all off). Firestore `(default)` database, **Standard edition, production
  mode, location `asia-south1` (Mumbai)** — permanent, can't be changed.
  Web app "REC Scan" registered (its config is in `app.js`).
- **Google sign-in enabled**, with P1's OAuth client ID
  (`194459417743-6idjf0…`) added under "Whitelist client IDs from external
  projects" so Firebase accepts the Google ID token P3's sign-in gate already
  gets. Setting confirmed to persist across a page reload.
- **`firebase/firestore.rules` published** and **tested against the live
  database with 12 checks** (made-up identities carrying the same email
  claims a Google sign-in produces): a staff member reads exactly their own
  classes (full student lists); cannot read another staff's classes (tried
  the near-identical "Bhuvaneswari R"), cannot list all classes, cannot
  write or delete; a student account gets zero classes and cannot ask for a
  staff member's; an unverified email is denied even with a staff address; a
  signed-out visitor is denied; a mixed-case email still matches.
- **51 classes imported** (3,354 student entries, 22 staff) and read back
  from Firestore: identical to the local file. `firebase/import-classes.js`
  was fixed on first real run (it used the old Admin SDK calling style that
  current `firebase-admin` removed).
- The one-time service-account key used for the import was **deleted from
  the PC and revoked in Google Cloud**; the test identities were deleted.
  Re-running an import later needs a fresh key (generate, use, revoke).

- **All 22 staff checked against the live database (2026-10-08, second
  one-time key, also revoked and deleted):** signing in as each staff
  member's email returned exactly their own classes with student lists
  identical to the file; each was refused another staff member's classes and
  a list-everything query; across all 22, the 51 classes were delivered
  exactly once each. Also corrected faculty "Sachin Adith 0" to "Sachin
  Adith" in the database. (A first run showed "student list differs" for many
  staff: a test bug — the client SDK returns each student's fields in a
  different key order; compared order-independently, all 51 matched.)

### Still NOT verified

- **A real Google ID token being accepted by Firebase.** Everything up to
  that step is proven: the Firebase SDK loads in the browser, initializes
  against `rec-scan`, and Firebase itself rejects a fake token
  (`auth/invalid-credential`). With a real staff sign-in the class list
  should appear; if instead it shows an `auth/...` error mentioning the
  audience, the client-ID allowlist isn't being honored and the fallback is
  to switch the gate to Firebase's own Google sign-in.
- Not tested on a real phone: the class picker, class switching, offline use
  after first sign-in, and that saved data survives sign-out and phone
  restarts.

### Warning: P1's Google Cloud project now has Firebase attached

While setting up, Firebase was added by mistake to the Google Cloud project
"My First Project" (`project-d87abfba-7819-4e5c-810…`), which owns **P1's
Google login client**. Firebase said this can't be undone and that deleting
the Firebase project deletes the Google Cloud project too. Nothing was
deleted or broken. **Never delete "My First Project" or its Firebase
project** — it would take P1's login with it. P3's real data lives in the
separate `rec-scan` project.
