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
- **`classes/{classId}`** — className, department, the list of roll numbers
  in that class, and its timetable slot(s) (day + period/time). The roll
  list and the timetable slot are both pieces the flat department DB can't
  provide — someone (admin, or derived from a real timetable export) has
  to define this once per class/term.
- **`students/{rollNo}`** — name, email, department. This *is* the flat
  department DB, used purely as a lookup table — replaces the current
  `guessEmail()` heuristic in `app.js` with real verified data instead of a
  guessed pattern.

## Login flow

1. Staff signs in (Google, restricted to `@rajalakshmi.edu.in` — same
   domain restriction Project 1's `utils/auth.js` already enforces).
2. App reads `staff/{their email}/classes` → gets ALL their assigned class
   IDs, their whole timetable's worth, in one go.
3. For every one of those classes, pulls its roll-number list + timetable
   slot from `classes/{classId}`, then resolves each roll number to a real
   name + email via `students/{rollNo}`.
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

## What's actually blocking the build

Not code — data and two deferred decisions:

- No Firebase project exists yet (an account-level step only the project
  owner can do — same category of action as the GitHub org created earlier
  in this session for a cleaner P3 URL).
- No real department DB in hand yet (flat roll/name/email export).
- No real staff→class/timetable assignment data in hand yet.
- **Deferred, not yet decided:** sign-in method — reuse P1's existing
  Google Sign-In identity (one system, same account everywhere) vs. a
  separate login just for P3 (keeps P3 fully standalone, matching its
  "independent project" instruction, but a second login for staff).
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
