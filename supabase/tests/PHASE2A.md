# Phase 2A lifecycle integrity

Apply `0003_lifecycle_integrity.sql` after migrations 0001 and 0002 using a
trusted migration role. This migration changes only three RPCs and adds a
partial unique index. It does not repair historical rows or reputation totals.
No hosted migration has been applied by this implementation.

## Command semantics

| Command | First call | Retry |
| --- | --- | --- |
| `create_claim` | A non-poster can create a pending claim only on an active gig with no selected provider. One notification is emitted. | Returns the existing composite claim unchanged, including pending, selected, rejected or withdrawn claims, even after the gig advances. No new notification or reactivation. |
| `select_provider` | Only the poster can select a pending claim belonging to an active gig with no selected provider or existing selected claim. The claim and provider pointer update atomically. | Both identical and different retries fail with SQLSTATE P0001, `Provider already selected`. No second notification. |
| `submit_feedback` | Existing participant and completed/incomplete requirements remain. A new feedback row increments its recipient's WOM or Lemon once; skip increments neither. | The first row wins. Identical, opposite, and skip retries succeed without modifying the row or counters. |

RPC argument/return types are unchanged. No frontend change is necessary: the
existing selection error handler displays database error messages. Selection
does not advance gig status or alter existing timestamps; other claims stay
pending. The controlled selection error is intentionally different from the
successful no-op behavior of claim and feedback retries.

All three RPCs retain explicit NULL identity rejection, NULL-safe authorization,
empty fixed search paths, qualified references, and authenticated-only EXECUTE.
Phase 1 private helpers and all other RPCs/policies are unchanged.

## Transactions and existing data

Every command locks the parent gig with SELECT FOR UPDATE before reading or
writing children. Calls on the same gig serialize; at default READ COMMITTED,
the waiting command sees the committed winner before applying its checks.
Claims and feedback also retain their existing unique keys and use INSERT ON
CONFLICT DO NOTHING. Notifications/counters execute only for a successful insert.
Feedback insertion and counter updates are in the same transaction. Counter
updates use `counter = counter + 1`, preserving concurrent increments from
different gigs. At stricter isolation, callers may receive serialization errors
and should retry the whole transaction.

`claims_one_selected_per_gig` prevents two selected claims even outside the RPC
path. Trusted writers still must preserve consistency with the gig's provider
pointer. This migration does not repair historical pointer inconsistencies.

Before deployment, inspect historical duplicate selected claims:

```sql
select gig_id, count(*) from public.claims
where state = 'selected' group by gig_id having count(*) > 1;
```

The migration aborts atomically when duplicates exist; review which provider
is authoritative rather than automatically choosing one. The regular unique
index creation temporarily blocks writes to claims; schedule accordingly.
Test deployment on an isolated Supabase project before production.

## Repeatable verification

Static scope/security checks (no extra dependency):

```powershell
node supabase/tests/run-phase1-security.mjs --phase2a
```

With the separately installed PGlite runtime described in README.md:

```powershell
$phase2Runtime = Join-Path $env:TEMP 'esg-phase1-pglite'
node supabase/tests/run-phase1-security.mjs "$phase2Runtime/node_modules/@electric-sql/pglite/dist/index.js" --phase2a
```

This runs all three migrations, then 96 Phase 1 assertions and 64 Phase 2A
assertions in an isolated in-memory PostgreSQL/WASM engine. Both SQL suites
roll back all fixtures. Phase 2A covers claim state preservation and notification
counts, both selection contender orders, the selected-claim unique constraint,
feedback immutability and counters, and authorization/ACL regressions.

For an already-migrated isolated Supabase test database, use a trusted direct
connection and securely configured PG environment variables:

```powershell
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/phase1_security.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/phase2a_integrity.sql
```

Do not run fixture suites on production. No database credentials are stored in
these files. The WASM scaffold does not verify deployed grants/schema drift,
PostgREST, real Auth, Storage, Realtime, or multiple simultaneous connections.

## Pending native two-session contention verification

Use only a disposable database with all three migrations applied. Create
committed test-only users/gigs/claims with known IDs, then use two direct database
connections. In each transaction set role authenticated and JWT identity using
both request.jwt.claim.sub and request.jwt.claims. Do not reuse production IDs.

1. Selection: in session A, begin and select claimant A without committing.
   In session B, begin and select claimant B as the same poster. Verify B blocks.
   Commit A; B must fail with `Provider already selected`. Roll back B. Check
   exactly one selected claim, the provider pointer matches A, and one selected
   notification. Repeat with B winning, and with both selecting the same claim.
2. Claims: on a fresh active gig, session A creates a claim without committing.
   Session B repeats as the same provider. Commit A; B must return the same row.
   Commit B; check one claim and one claim_received notification. Also race a
   new claimant against selection: after selection commits first, claiming fails.
3. Feedback: on a fresh resolved gig, session A submits WOM without committing.
   Session B submits identical WOM, then repeat on a fresh gig with Lemon in B.
   Commit A; B succeeds without changes. Commit B; check one immutable WOM row,
   exactly one WOM increment and no Lemon increment. Repeat with Lemon winning.
4. Repeat each scenario with A rolling back: B should proceed as the first
   successful command. Remove only the disposable test fixtures afterwards.

These true contention cases have not been executed here. Executed tests cover
retries, both sequential winner orders, and enforcement of the unique invariant;
locking behavior is additionally inspected statically.

Phase 2B remains separate: completion/incomplete prerequisites, payment
semantics, accepted-price snapshots, and any newly designed workflows. Historical
counter reconciliation is also outside this migration.
