# Firebase / hosting cost decisions (2026-09-30 conversation)

Supplements `FIREBASE-ROSTER-PLAN.md` (the architecture plan) — this file
captures the cost/hosting questions asked and answered in a later session,
since the authoritative Project 3 code and living docs (`CLAUDE.md`,
`FIREBASE-ROSTER-PLAN.md`) currently live on the `gh-pages` branch, which
this session did not push to (kept to the designated
`claude/attendance-verification-l973wq` branch per instruction). Fold this
into `FIREBASE-ROSTER-PLAN.md` on `gh-pages` next time that branch is
touched, so it isn't split across two branches long-term.

## Requirement restated (confirmed matches the existing plan)

- Each staff has their own class + student list.
- A server is needed to hold this (staff, timetable, classes, rosters).
- On login with staff ID, that staff's own class/roster data is cached to
  the phone.
- No internet needed after that — matches `FIREBASE-ROSTER-PLAN.md`'s
  "login once, cache everything, fully offline after" design exactly. No
  new requirement here beyond what's already planned.
- **Scope boundary, explicit**: all of this (login + server-backed fetch +
  offline cache) must be built into the **same Project 3 website** — no
  separate app, no separate portal, nothing beyond that one site.

## Is Firebase good for a 2-staff trial?

**Yes.** Confirmed as the right fit for the trial stage:
- Matches the data shape (staff → classes → roster) naturally as Firestore
  documents.
- Zero server to stand up or maintain.
- At 2 staff, usage is a rounding error against the free tier.

## Firebase pricing — real numbers (checked live, 2026-09-30)

**Spark (free) plan** — no card required, resets daily/monthly, service
just pauses on hitting a cap rather than billing:
- Firestore: 50,000 reads/day, 20,000 writes/day, 1 GiB storage.
- Authentication (incl. Google sign-in): 50,000 monthly active users free.

**Blaze (pay-as-you-go)** — same free quotas included, then metered for
usage above them:
- Firestore: ~$0.06 / 100K reads, ~$0.18 / 100K writes, ~$0.18/GiB stored
  (US multi-region).
- Auth: ~$0.0055/MAU past 50,000 MAU.
- New Blaze projects get $300 free credit.

**No fixed-cost-forever tier exists** — neither Firebase nor any cloud
provider (AWS/Azure/GCP included) sells "pay once, scale forever for
free." It's always Spark's hard-capped free tier, or Blaze's recurring
metered billing. This is inherent to cloud computing, not a Firebase gap.

**Storage question asked directly: can it go past 100GB?** Yes, no upper
wall on Blaze — ~$0.18/GiB/month means 100GB ≈ $18/month (~₹1,500/month).
**But irrelevant in practice**: staff/timetable/class/roster text data for
an entire college (hundreds of staff, thousands of students) totals tens
of MB at most, not GB — nowhere close to needing this tier of spend.

## Migration to AWS / college server later — the real tradeoff

Asked: after full-college rollout, move to a college server or AWS "which
must be large." Key points given:

1. **Firebase itself scales to full-college size fine** — the read-light,
   cache-once design (server hit once at login, not per scan) means even
   full rollout likely stays near-free or a few $/month on Blaze. Cost is
   **not** a real reason to migrate off Firebase.
2. **Migration is a rewrite, not a size upgrade.** Firestore and Firebase
   Auth are Google's proprietary systems — moving to AWS or a
   college-owned server means a different database (e.g.
   PostgreSQL/MySQL) and a different auth system. Data-access code written
   against Firestore does not carry over as-is. This is normal vendor
   lock-in, true of any cloud platform, not a Firebase-specific flaw — but
   it's a real engineering cost at migration time, so worth deciding
   deliberately rather than assuming it's a simple later step.
3. **Legitimate reasons to still migrate anyway**, if they apply:
   - Data ownership/control — college wants the data on infrastructure it
     directly owns/contracts, not a third party.
   - Data residency — a preference/requirement that student data stay on
     Indian-hosted infrastructure (AWS has a Mumbai region; a college's
     own server obviously does). **Not confirmed as a legal requirement**
     — flagged as a policy question for the college to actually decide,
     not something assumed or asserted here.
4. **Recommendation given**: build the trial on Firebase now (free,
   fast, correct fit). Don't treat "must migrate to AWS at scale" as a
   technical necessity — it isn't one, per point 1. Decide migration based
   on whether the college actually cares about ownership/residency, not
   performance or cost.

## Status

Decisions/answers only — no code changes from this conversation. The
actual Firebase integration (login flow, Firestore schema, caching code)
is still **not built**, per `FIREBASE-ROSTER-PLAN.md`'s existing "blocked
on data, not code" status. This file just records the cost/hosting
questions asked and answered before that build starts.
