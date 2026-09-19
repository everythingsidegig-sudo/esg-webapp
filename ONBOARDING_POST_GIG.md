# Onboarding to Post a Gig

## Existing flow and scoped changes

The original browser-only Supabase app supported email/password registration,
confirmation links, login, trigger-created private/public profiles, standalone
profile photo and free-text skill edits, guest location entry, direct gig INSERT,
public active-gig browse, and owner activity lists. One account already supported
both posting and providing. There were no API routes or server actions for this
journey and no browser/E2E testing framework.

Problems found: unrestricted sign-in next destination; destination lost during
signup/confirmation; callback potentially exchanging the same PKCE code twice;
callbacks without a session incorrectly claiming confirmation; no onboarding
sequence or saved location; editable profile state initialized before loading;
unchecked profile/photo updates; stuck request states on exceptions; duplicate
creation on ambiguous retries; browser-only gig field validation; query errors
shown as empty lists; exact geolocation coordinates passed through URLs.

The journey now uses registration -> Supabase email link -> callback -> basic
profile -> private address/location -> skills/services -> safe intended page.
Already-onboarded users skip setup after login; posting still requires completed
setup in the database. Signed-out Home offers only Sign In and Create Account.
Authentication and any required setup lead to Location, which reveals the I Need
Help and Help & Earn Money choices only after location confirmation. I Need Help
continues to a Post a Gig / Find a Helper choice;
helper search is visibly marked Coming soon and does not browse work gigs. Routine Profile
editing is separate from the initial onboarding wizard: username/categories save
without location steps, and photo changes save immediately with checked errors.

No Active Gig, claim/selection UI, completion, incomplete, payment, or dispute
behavior was changed. The existing Save as Draft option remains; no new draft
workflow was added. Docker, dependencies and migrations 0001–0003 are unchanged.

## Deployment prerequisites

1. Apply additive migration `supabase/migrations/0004_onboarding_post_gig.sql`
   after 0001–0003 using the trusted migration role, first on an isolated project.
   Deploy the matching client alongside it: old clients use direct INSERT, which
   is intentionally revoked by 0004. Existing profiles require setup once; legacy
   custom skill/service labels are preserved and remain selectable for their owner.
2. Set real NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in
   .env.local. Never expose service-role keys or database passwords to the browser.
3. In Supabase Auth URL configuration, allow the local callback including its
   next query parameter (for local development, `http://localhost:3001/**`).
   Use a restricted allowlist for the deployed origin. Configure Site URL and
   email confirmation/template settings for the actual hosted project.
4. Keep `esg_private` outside exposed Data API schemas as required by Phase 1.
   Existing profile-photos and gig-photos bucket policies are retained.

Supabase SSR's installed client uses PKCE. Automatic URL detection is disabled
so the callback exclusively exchanges codes, once even under Strict Mode. Legacy
implicit token-link callbacks are also supported. PKCE links should be opened in
the browser that initiated registration. Errors, expired/reused links and missing
sessions show recovery links rather than claiming verification succeeded. Resend
uses Supabase auth.resend. If hosted confirmation is disabled, signup's returned
session goes directly to setup. Existing-email signup responses can deliberately
be obfuscated by Supabase; the application avoids falsely promising that a new
account was created and offers sign-in/resend.

## Data and command boundaries

- `ensure_profile()` returns only the authenticated caller's private row and
  repairs a missing private/public counterpart. It does not migrate historical
  counters. New-user trigger creation and public-safe synchronization stay intact.
- `save_onboarding(...)` validates username, location, coordinate pairs, photo URL
  and category arrays, then atomically saves only the caller's profile/setup fields.
  Location/coordinates/completion are owner-only fields on profiles, not on
  public_profiles. Existing counter and column-update protections remain.
- `create_gig(...)` takes no poster identity: auth.uid() is authoritative. It
  validates service, title, description, finite positive two-decimal price, fixed
  price type, future schedule for published gigs, location, coordinate pairs and
  photo URL. Status, provider, timestamps and payment fields use server defaults.
  Direct API-role INSERT is revoked without loosening any RLS policy.
- The client persists a per-account request UUID and exact payload before posting.
  Repeated clicks are blocked immediately. An uncertain result freezes editing
  and retries that request, including after refresh in the same tab. Database
  profile row locks and a unique (poster_id, creation_request_id) index return the
  original gig. The request ID is immutable under ordinary gig edits. A known
  validation failure permits correction. Clearing browser storage or independently
  posting from another tab/device creates a new request, not a global dedupe rule.
- Published creations open their Gig Detail; drafts open My Gigs, which confirms
  the loaded row in Gigs Posted. Posted and Worked lists have independent loading,
  error and retry states. Active gigs remain visible in public Browse under existing
  RLS. Background profile refresh errors retain loaded content and dirty edits.

## Location and blueprint differences

The referenced ESG_Final_POC_UX_Flow_v2.docx was not available in the workspace,
Documents or attachments searched during implementation. Comparison is limited
to the requirements pasted for this phase and the existing README/schema.

The application retains confirmation links rather than adding a six-digit OTP.
Photos remain optional. The existing catalog is shared by posting, browsing and
setup: Yard Work, Moving Help, Cleaning, Handyman, Delivery, Pet Care, Tech Help,
Other. Auto is not in the existing catalog. Fixed pricing remains intentional;
the schema has no payment-method field and no method is collected or implied.
Negotiation and accepted-price snapshots remain outside this phase.

Manual onboarding address/general area is saved privately. There is no geocoder
or maps provider; manual locations do not generate coordinates. Public gigs ask
separately for a general area and never prefill the saved private street address.
Current-location collection has a timeout and manual fallback. New journey and
gig coordinates are rounded to two decimal places before public use, including
server enforcement on creation. Do not include street addresses in public gig
text/photos. This does not retroactively scrub historical gigs or redesign existing
pre-selection edit permissions/location privacy. New approximate coordinates are
not a guarantee of anonymity, particularly in sparsely populated areas.

## Verification commands and boundaries

Final results: Phase 1 **96/96**, Phase 2A **64/64**, new journey SQL
**75/75** (235 database assertions total), and client rules **59/59**. Zero
failed assertions/tests. Static checks, TypeScript and production build passed.
Lint passed with the three existing img-element warnings. Node emits an advisory
module-type warning when loading TypeScript tests; package module settings were
left unchanged. There are no other existing test scripts in package.json.

```powershell
node --test tests/journey.test.mjs
node supabase/tests/run-phase1-security.mjs --onboarding
$journeyRuntime = Join-Path $env:TEMP 'esg-phase1-pglite'
node supabase/tests/run-phase1-security.mjs "$journeyRuntime/node_modules/@electric-sql/pglite/dist/index.js" --onboarding
npm run lint
node node_modules/next/dist/bin/next typegen
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm run build
```

Node tests use built-in type stripping (Node 22.18+ or Node 24) without adding a
framework/dependency. See supabase/tests/README.md for optional external PGlite
installation. SQL tests roll back fixtures and must only run on an isolated test
database. For a migrated isolated hosted project, use a trusted direct connection:

```powershell
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/phase1_security.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/phase2a_integrity.sql
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/onboarding_post_gig.sql
```

Executed verification includes static RPC/authentication/search-path checks,
isolated PostgreSQL/WASM assertions, Node client rules, TypeScript, lint and build.
Guest navigation was manually checked in the browser at http://localhost:3001:
signed-out header, general-area entry, I Need Help options, protected posting
redirect, registration destination retention, expired-link recovery UI, and
discarding an external next destination. The expiry check supplied a callback
error parameter; it did not verify actual hosted link expiration.
No hosted migration or real account/email/authenticated browser journey has been
executed; environment values were placeholders. True multiple-session contention
also remains unverified. Unit tests verify rules, not React interaction behavior.

## Hosted acceptance checklist still required

- Register with a disposable email; receive and open its actual confirmation
  link in the initiating browser; test expiry/reuse and resend.
- Test invalid credentials/unverified login, immediate-session signup if enabled,
  logout and session restoration on refresh.
- Complete all setup steps with manual area and geolocation; verify private
  address/coordinates are inaccessible to anon and unrelated users.
- Save/reload/logout/login; verify existing skills/services/photo persist and
  saved inputs are not replaced by an early empty state.
- Post with/without an image; check exactly one active gig, correct owner/defaults,
  no claims, activity success/list and public Browse visibility.
- Retry an ambiguous request, refresh its form and repeat; verify one original
  gig. Exercise two-session contention in the disposable database.
- Inspect actual grants, JWT/RLS and PostgREST exposure/schema cache; test Storage
  policies and upload failures. Failed/abandoned uploads can leave unused objects;
  automatic orphan cleanup is not introduced by this phase.

Stop after creation. Phase 2B completion/payment semantics, accepted prices,
direct helper search and broader historical location/privacy issues remain separate.

## File inventory

Created:

- `src/lib/journey.ts`: safe destinations, validation and actionable errors.
- `src/lib/services.ts`: shared existing POC catalog.
- `src/lib/location.ts`: general-area session storage.
- `src/components/ProfileSetup.tsx`: loaded-profile three-step editor.
- `src/app/onboarding/page.tsx`: setup and intended-destination continuation.
- `src/app/need-help/page.tsx`: Post a Gig choice and non-navigating Find a Helper preview.
- `supabase/migrations/0004_onboarding_post_gig.sql`: private setup fields,
  authenticated RPCs, authoritative creation and immutable retry keys.
- `supabase/tests/onboarding_post_gig.sql`: 75 rollback-only assertions.
- `tests/journey.test.mjs`: 58 built-in Node tests after removal of the intermediate route.
- `tests/cleanup.test.mjs`: isolated client-component regressions for the cleanup.
- `ONBOARDING_POST_GIG.md`: this implementation/verification handoff.

Modified:

- `src/lib/auth-context.tsx`: profile/session loading, errors and stale-result guards.
- `src/lib/supabase/client.ts`: single callback ownership and bounded network requests.
- `src/lib/database.types.ts`: additive field/RPC shapes.
- `src/components/AuthGuard.tsx`: loaded profile and setup requirement for posting.
- `src/components/Nav.tsx`: loading/signed-in controls and reliable logout.
- `src/app/auth/sign-in/page.tsx`: sanitized destinations and robust request/error states.
- `src/app/auth/sign-up/page.tsx`: retained destination, validation, confirmation/resend.
- `src/app/auth/callback/page.tsx`: one-time link exchange and honest recovery states.
- `src/app/profile/page.tsx`: standalone profile editing, retained private stats/photo.
- `src/app/location/page.tsx`: bounded geolocation, rounded coordinates and journey storage.
- `src/app/page.tsx`: original journey cards and stable signed-out messaging.
- `src/app/post/page.tsx`: validated RPC creation and persisted safe retries.
- `src/app/my-gigs/page.tsx`: loading/error handling and confirmed creation success.
- `src/app/browse/page.tsx`: shared catalog and distinguish query failures from empty results.
- `supabase/tests/run-phase1-security.mjs`: optional --onboarding scope/migration/suite checks.
- `README.md`: apply all additive migrations and link to this handoff.

Build/type generation also refreshes ignored Next.js generated output. No source
outside the journey, migration history, Docker files or package files was edited.
No commit was created.
