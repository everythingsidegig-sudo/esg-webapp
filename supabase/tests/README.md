# Phase 1 database security verification

This phase changes authorization only. It leaves `0001_init.sql`, application
code, Docker, and lifecycle correctness unchanged. It does not repair historical
reputation/earnings totals or delete existing data.

## Apply to hosted Supabase

1. Back up the database and test on an isolated Supabase project first.
2. Confirm `0001_init.sql` is already applied. Inspect any deployed schema drift,
   additional permissive policies, role memberships, function grants/owners, and
   column grants before applying `0002_security_hardening.sql`.
3. Run the new migration as `postgres` or a trusted migration role with BYPASSRLS.
   Its preflight rejects unexpected function owners and FORCE RLS on gigs/claims.
   Do not remove these checks without reviewing the deployment's ownership model.
4. Keep `esg_private` out of Supabase's **Data API exposed schemas**. Its helpers
   have authenticated-role EXECUTE/USAGE only because RLS needs them; they accept no arbitrary
   user identity and return only current-caller boolean authorization decisions.
5. Run the rollback-only SQL regression script below. Do not run it on production.

No service-role key is needed by the browser. Do not put database passwords or
service-role keys in public environment variables. This work does not apply any
migration to a hosted database automatically.

## Changes and preserved access

| Area | Phase 1 behavior |
| --- | --- |
| Ten lifecycle RPCs | Explicit NULL-identity rejection; NULL-safe role checks; only authenticated API callers receive EXECUTE |
| `get_public_stats` | Aggregate guest API retained for anon/authenticated |
| `notify`, `sync_public_profile`, `handle_new_user` | Direct client EXECUTE revoked; internal/trigger calls retained |
| All 14 original SECURITY DEFINER functions | Empty fixed search_path and qualified application relation/type/helper references |
| Future function defaults | PUBLIC/anon/authenticated EXECUTE defaults revoked globally and in public/private schemas for the role applying this migration; other creators need their own default-privilege review |
| `profiles` | Owner RLS retained; clients can update only username, photo_url, skills, services |
| `public_profiles` | Existing public reads and trusted synchronization retained |
| `chat_messages` | Existing participant RLS retained; client UPDATE limited to read_at |
| `notifications` | Existing owner RLS retained; client UPDATE limited to read |
| `gigs_select`, `gigs_select_participants` | Separate public-active and authenticated-participant policies; all statuses for poster/selected provider/own claimant |
| `claims_select` | Own claims or claims on gigs owned by the caller |
| Other policies | Existing write policies, private submission reads, disputes, and storage policies retained |

Profile/chat/notification UPDATE permissions remove both table grants and existing
column grants to PUBLIC, anon, and authenticated before granting allowed columns.
Trusted function owners retain counter UPDATE access. Existing service-role/admin
permissions are not removed. Custom roles, inherited privileges, or extra deployed
policies require separate inspection; this migration targets the standard schema.

## SQL regression suite

Use a trusted direct database connection to the isolated test project. Set
`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` securely for your shell,
then run from the repository root:

```powershell
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/phase1_security.sql
```

The script creates random-ID fixtures inside a transaction, sets API roles and JWT
claims, raises an exception on any failed assertion, and rolls back all fixtures.
On failure the transaction must be rolled back/connection closed. It checks:

- Anonymous EXECUTE denials and authenticated role with missing JWT identity.
- Cross-user profile writes, protected columns, and preserved profile edits.
- Immutable chat fields, sender impersonation, and legitimate read receipts.
- Internal helper grants, schema CREATE denial, and trusted notification calls.
- Public/poster/provider/claimant/unrelated SELECT visibility without recursion.
- Unauthorized lifecycle calls, including NULL selected-provider checks.
- Legitimate publish/select/start/complete/payment/feedback/cancel calls, with
  trusted earnings/reputation updates still working.
- Notifications can be marked read but their contents cannot be rewritten.

Business-state failures are not accepted as authorization passes: negative RPC
tests require SQLSTATE 42501. Expected row filtering is checked explicitly.

## Optional isolated PostgreSQL/WASM runner

Run the static scope/authentication comparison without any extra dependency:

```powershell
node supabase/tests/run-phase1-security.mjs
```

The Node runner uses an in-memory PGlite database and minimal Supabase-shaped
platform scaffolding. It executes both migrations and the same SQL suite. It does
not connect to Supabase, start Docker, create a backend, or add app dependencies.

```powershell
$phase1Runtime = Join-Path $env:TEMP 'esg-phase1-pglite'
npm install --prefix $phase1Runtime --no-save --package-lock=false --ignore-scripts --no-audit --no-fund @electric-sql/pglite
node supabase/tests/run-phase1-security.mjs "$phase1Runtime/node_modules/@electric-sql/pglite/dist/index.js"
```

A passing embedded-engine result verifies PostgreSQL authorization mechanics in
the supplied scaffold. It does **not** verify hosted grants, custom policies,
PostgREST schema exposure/cache behavior, real Auth cookies, Storage, or Realtime.

## Explicitly deferred concerns

Duplicate-feedback increments, provider reselection, reclaim behavior, and phase
prerequisites remain unchanged as requested. Also deferred: location precision,
gig/payment field visibility, gig insert/update field validation, upload limits,
and frontend redirect validation. These remain security/product concerns, not
claims that Phase 1 closes every possible attack path.
