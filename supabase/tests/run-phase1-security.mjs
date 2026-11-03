// Optional isolated PostgreSQL/WASM check. No Docker or hosted database access.
// Supply the path to a separately installed @electric-sql/pglite dist/index.js.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const blockUser = process.argv.includes("--block-user");
const withdrawExitRemove = process.argv.includes("--withdraw-exit-remove") || blockUser;
const feedbackComments = process.argv.includes("--feedback-comments") || withdrawExitRemove;
const keepClaims = process.argv.includes("--keep-claims") || feedbackComments;
const unansweredStart = process.argv.includes("--unanswered-start") || keepClaims;
const delayStart = process.argv.includes("--delay-start") || unansweredStart;
const negotiation = process.argv.includes("--negotiation") || delayStart;
const profileSave = process.argv.includes("--profile-save") || negotiation;
const requests = process.argv.includes("--requests") || profileSave;
// origin/main's migrations 0011-0018 (taxonomy, deletion eligibility, account settings,
// registration rewrite, ...). They were never run by this harness before; --mainline
// replays them on top of 0010 so later migrations are checked against the real baseline.
const mainline = process.argv.includes("--mainline") || requests;
const offers = process.argv.includes("--offers") || mainline;
const deletion = process.argv.includes("--deletion") || offers;
const distance = process.argv.includes("--distance") || deletion;
const helpers = process.argv.includes("--helpers") || distance;
const tags = process.argv.includes("--tags") || helpers;
const phase2c = process.argv.includes("--phase2c") || tags;
const onboarding = process.argv.includes("--onboarding") || phase2c;
const phase2a = process.argv.includes("--phase2a") || onboarding;
const runtimePath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const original = await readFile(new URL("migrations/20240101000001_init.sql", root), "utf8");
const hardened = await readFile(new URL("migrations/20240101000002_security_hardening.sql", root), "utf8");
const originalFunctions = [...original.matchAll(/create function ([a-z_]+)\([\s\S]*?\n\$\$;/g)];
const hardenedFunctions = [...hardened.matchAll(/create or replace function public\.([a-z_]+)\([\s\S]*?\n\$\$;/g)];
if (originalFunctions.length !== 14 || hardenedFunctions.length !== 14) {
  throw new Error("Expected all 14 original SECURITY DEFINER functions to be audited");
}

// Reverse only the intended authorization and name-resolution edits. Everything
// else must match migration history, including deliberately deferred logic.
const normalize = (sql) => sql
  .replaceAll("create or replace function", "create function")
  .replaceAll("public.", "")
  .replaceAll("set search_path = ''", "set search_path = public, pg_temp")
  .replace(/\s*if auth\.uid\(\) is null then\s*raise exception 'Authentication required' using errcode = '42501';\s*end if;\s*/g, "\n")
  .replace(/v_gig\.(poster_id|selected_provider_id) is distinct from auth\.uid\(\)/g, "v_gig.$1 <> auth.uid()")
  .replaceAll("(auth.uid() is distinct from v_gig.poster_id and auth.uid() is distinct from v_gig.selected_provider_id)", "auth.uid() not in (v_gig.poster_id, v_gig.selected_provider_id)")
  .replaceAll("raise exception 'Not authorized' using errcode = '42501';", "raise exception 'Not authorized';")
  .replace(/\s+/g, " ").trim();

for (const prior of originalFunctions) {
  const next = hardenedFunctions.find((entry) => entry[1] === prior[1]);
  if (!next || normalize(prior[0]) !== normalize(next[0])) {
    throw new Error(`Unexpected non-security function change: ${prior[1]}`);
  }
  if (!next[0].includes("set search_path = ''")) {
    throw new Error(`Unsafe search_path: ${prior[1]}`);
  }
  if (!["notify", "sync_public_profile", "handle_new_user", "get_public_stats"].includes(prior[1])
      && !/begin\s+if auth\.uid\(\) is null then/.test(next[0])) {
    throw new Error(`Missing explicit authentication guard: ${prior[1]}`);
  }
}
console.log("PASS: all 14 functions preserve non-security behavior; ten lifecycle RPCs reject NULL identities");
if (phase2a) {
  const integrity = await readFile(new URL("migrations/20240101000003_lifecycle_integrity.sql", root), "utf8");
  const functions = [...integrity.matchAll(/create or replace function public\.([a-z_]+)\([\s\S]*?\n\$\$;/g)];
  const allowed = ["create_claim", "select_provider", "submit_feedback"];
  if (functions.length !== 3 || functions.some((entry) => !allowed.includes(entry[1]))) {
    throw new Error("Phase 2A must replace exactly the three scoped RPCs");
  }
  for (const entry of functions) {
    if (!entry[0].includes("set search_path = ''")
        || !/begin\s+if auth\.uid\(\) is null then/.test(entry[0])
        || !entry[0].includes("from public.gigs where id = p_gig_id for update")) {
      throw new Error(`Phase 1 boundary/parent lock missing: ${entry[1]}`);
    }
  }
  console.log("PASS: Phase 2A scope, explicit authentication, safe search paths and parent row locks");
}
if (onboarding) {
  const journey = await readFile(new URL("migrations/20240101000004_onboarding_post_gig.sql", root), "utf8");
  const functions = [...journey.matchAll(/create function public\.([a-z_]+)\([\s\S]*?\n\$\$;/g)];
  if (functions.length !== 3 || functions.some((entry) => !["ensure_profile", "save_onboarding", "create_gig"].includes(entry[1]))) throw new Error("Unexpected onboarding RPC scope");
  for (const entry of functions) {
    if (!entry[0].includes("security definer set search_path = ''") || !/begin\s+if auth\.uid\(\) is null then/.test(entry[0])) throw new Error(`Unsafe onboarding RPC: ${entry[1]}`);
  }
  console.log("PASS: onboarding RPC scope, explicit authentication and safe search paths");
}
if (phase2c) {
  const hardening = await readFile(new URL("migrations/20240101000005_direct_write_hardening.sql", root), "utf8");
  if (!/create trigger trg_validate_profile_edit\s+before update of username, photo_url, skills, services on public\.profiles/.test(hardening)) {
    throw new Error("Phase 2C must install the profile direct-write validation trigger");
  }
  if (!/revoke update on table public\.gigs from public, anon, authenticated/.test(hardening)) {
    throw new Error("Phase 2C must revoke gigs' client UPDATE grant");
  }
  if (/alter (table|policy)|drop (table|policy)|create (or replace )?function public\./.test(hardening)) {
    throw new Error("Phase 2C must stay scoped to grants/triggers: no RLS or RPC redefinition");
  }
  console.log("PASS: Phase 2C direct-write hardening scope (profiles validation trigger, gigs grant revoke, no RLS/RPC redesign)");
}
if (tags) {
  const gigTags = await readFile(new URL("migrations/20240101000006_gig_tags.sql", root), "utf8");
  if (!/create table public\.tags/.test(gigTags) || !/create table public\.gig_tags/.test(gigTags)) {
    throw new Error("Gig Tags migration must create both the tags catalog and gig_tags junction table");
  }
  if (!/primary key \(gig_id, tag_id\)/.test(gigTags)) {
    throw new Error("gig_tags must have a composite primary key preventing duplicate (gig_id, tag_id) rows");
  }
  if (!/references public\.gigs\(id\) on delete cascade/.test(gigTags)) {
    throw new Error("gig_tags.gig_id must cascade-delete with its gig");
  }
  if (!/drop function public\.create_gig\(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean\);/.test(gigTags)) {
    throw new Error("Gig Tags migration must explicitly drop the pre-tags 12-arg create_gig overload, not just CREATE OR REPLACE it");
  }
  const created = [...gigTags.matchAll(/create function public\.([a-z_]+)\(/g)];
  if (created.length !== 1 || created[0][1] !== "create_gig") {
    throw new Error("Gig Tags migration must only (re)create create_gig, no other RPC");
  }
  if (!/revoke insert, update, delete on table public\.tags, public\.gig_tags from public, anon, authenticated/.test(gigTags)) {
    throw new Error("Gig Tags migration must explicitly revoke client write grants on tags and gig_tags");
  }
  console.log("PASS: Gig Tags migration scope (catalog + junction table, composite PK, cascade delete, create_gig replaced cleanly, write grants revoked)");
}
if (helpers) {
  const profileTags = await readFile(new URL("migrations/20240101000007_profile_tags.sql", root), "utf8");
  if (!/create table public\.profile_tags/.test(profileTags)) {
    throw new Error("Find a Helper migration must create the profile_tags junction table");
  }
  if (!/primary key \(profile_id, tag_id\)/.test(profileTags)) {
    throw new Error("profile_tags must have a composite primary key preventing duplicate (profile_id, tag_id) rows");
  }
  if (!/references public\.profiles\(id\) on delete cascade/.test(profileTags)) {
    throw new Error("profile_tags.profile_id must cascade-delete with its profile");
  }
  const created = [...profileTags.matchAll(/create function public\.([a-z_]+)\(/g)];
  if (created.length !== 1 || created[0][1] !== "set_helper_tags") {
    throw new Error("Find a Helper migration must only create set_helper_tags, no other RPC");
  }
  if (!/revoke insert, update, delete on table public\.profile_tags from public, anon, authenticated/.test(profileTags)) {
    throw new Error("Find a Helper migration must explicitly revoke client write grants on profile_tags");
  }
  if (/alter table public\.profiles|alter table public\.public_profiles|create table public\.tags|create table public\.gig_tags/.test(profileTags)) {
    throw new Error("Find a Helper migration must stay scoped to profile_tags/set_helper_tags: no location columns, no second tag catalog");
  }
  console.log("PASS: Find a Helper migration scope (profile_tags junction table, composite PK, cascade delete, single new RPC, write grants revoked, no location/second-catalog changes)");
}
if (distance) {
  const helperLocation = await readFile(new URL("migrations/20240101000008_helper_location.sql", root), "utf8");
  if (/private_lat|private_lng|private_location_text/.test(helperLocation)) {
    throw new Error("Distance filtering migration must never read, copy, or reference private_lat/private_lng/private_location_text");
  }
  if (!/add column public_location_text text,\s*\n\s*add column public_lat double precision,\s*\n\s*add column public_lng double precision/.test(helperLocation)) {
    throw new Error("Distance filtering migration must add public_location_text/public_lat/public_lng to profiles");
  }
  if ((helperLocation.match(/add column public_location_text text/g) ?? []).length !== 2) {
    throw new Error("Distance filtering migration must add the same three public_* columns to both profiles and public_profiles");
  }
  const created = [...helperLocation.matchAll(/create function public\.([a-z_]+)\(/g)];
  if (created.length !== 1 || created[0][1] !== "set_helper_location") {
    throw new Error("Distance filtering migration must only create set_helper_location, no other RPC");
  }
  if (!/create or replace function public\.sync_public_profile\(\)/.test(helperLocation)) {
    throw new Error("Distance filtering migration must extend sync_public_profile() to mirror the new columns, not introduce a separate sync path");
  }
  if (!/round\(p_lat::numeric, 2\)/.test(helperLocation)) {
    throw new Error("set_helper_location must round coordinates to 2 decimals, matching create_gig()'s public coordinate precision");
  }
  console.log("PASS: distance-filtering migration scope (public_location_text/lat/lng on profiles + public_profiles, sync trigger extended, single new RPC, correct rounding, no private_* reference)");

  const findHelperSource = await readFile(new URL("../src/app/find-helper/page.tsx", root), "utf8");
  const profileSource = await readFile(new URL("../src/app/profile/page.tsx", root), "utf8");
  if (/private_lat|private_lng/.test(findHelperSource) || /private_lat|private_lng/.test(profileSource)) {
    throw new Error("Frontend Find a Helper / helper-location UI must never reference private_lat/private_lng");
  }
  console.log("PASS: frontend Find a Helper and Profile pages never reference private coordinates");
}
if (deletion) {
  const accountDeletion = await readFile(new URL("migrations/20240101000009_account_deletion.sql", root), "utf8");
  const created = [...accountDeletion.matchAll(/create function public\.([a-z_]+)\(/g)];
  if (created.length !== 1 || created[0][1] !== "delete_own_account") {
    throw new Error("Account deletion migration must only create delete_own_account, no other RPC");
  }
  if (!/create function public\.delete_own_account\(\)/.test(accountDeletion)) {
    throw new Error("delete_own_account must take zero parameters: no user_id argument for a client to target another account with");
  }
  if (!/security definer set search_path = ''/.test(accountDeletion) || !/if v_uid is null then raise exception 'Authentication required'/.test(accountDeletion)) {
    throw new Error("delete_own_account must be a safely-scoped SECURITY DEFINER function with an explicit authentication guard");
  }
  for (const table of ["public.gigs where poster_id", "public.claims where provider_id", "public.chat_messages where sender_id",
    "public.gig_completions where user_id", "public.gig_incomplete_choices where user_id", "public.feedback where from_id",
    "public.notifications where recipient_id"]) {
    if (!accountDeletion.includes(table)) {
      throw new Error(`Account deletion migration must check ${table} for marketplace history before allowing a hard delete`);
    }
  }
  const accountDeletionCode = accountDeletion.replace(/--.*$/gm, "");
  if (/wom_count|lemon_count|money_made/.test(accountDeletionCode)) {
    throw new Error("Account deletion must never alter wom_count/lemon_count/money_made -- those are the counterparty's recorded history, not this user's personal data");
  }
  if (/auth\.users/.test(accountDeletionCode)) {
    throw new Error("Account deletion must never touch auth.users from SQL -- that requires the service-role Admin API, run server-side only");
  }
  if (!/revoke execute on function public\.delete_own_account\(\) from public, anon, authenticated/.test(accountDeletion)
      || !/grant execute on function public\.delete_own_account\(\) to authenticated/.test(accountDeletion)) {
    throw new Error("delete_own_account must be grant-scoped to authenticated only");
  }
  console.log("PASS: account-deletion migration scope (single zero-arg RPC, explicit auth guard, checks all marketplace-history tables, never touches auth.users or reputation counters, grant-scoped to authenticated)");
}
if (offers) {
  const sql = await readFile(new URL("migrations/20240101000010_offers_and_private_address.sql", root), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  const created = [...code.matchAll(/create (?:or replace )?function public\.([a-z_]+)\(/g)].map((entry) => entry[1]).sort();
  if (created.join(",") !== "create_claim,create_gig,select_provider,withdraw_claim") {
    throw new Error(`Offers migration must only (re)create create_gig, create_claim, withdraw_claim and select_provider, found: ${created}`);
  }
  for (const entry of code.matchAll(/create (?:or replace )?function public\.[a-z_]+\([\s\S]*?\n\$\$;/g)) {
    if (!entry[0].includes("security definer set search_path = ''") || !/if auth\.uid\(\) is null then\s*raise exception 'Authentication required'/.test(entry[0])) {
      throw new Error("Every offers RPC must be SECURITY DEFINER with an empty search_path and an explicit authentication guard");
    }
  }
  if (!/drop function public\.create_claim\(uuid\);/.test(code) || !/drop function public\.create_gig\(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid\[\]\);/.test(code)) {
    throw new Error("Replaced RPC signatures must be dropped, not left as callable overloads");
  }
  if (!/alter table public\.gig_private_locations enable row level security/.test(code) || !/revoke all on table public\.gig_private_locations from public, anon, authenticated/.test(code)
      || !/grant select on table public\.gig_private_locations to authenticated/.test(code)) {
    throw new Error("The private address table must have RLS on, no anon access, and select-only access for authenticated");
  }
  const policy = code.match(/create policy gig_private_locations_select[\s\S]*?\n\);/)?.[0] ?? "";
  if (!/g\.poster_id = auth\.uid\(\)/.test(policy) || !/g\.selected_provider_id = auth\.uid\(\)/.test(policy) || /\btrue\b/.test(policy)) {
    throw new Error("Private addresses must be readable only by the poster and the selected helper");
  }
  if (!/revoke insert, update, delete on table public\.claims from public, anon, authenticated/.test(code)) {
    throw new Error("Clients must not write claims (offers) directly");
  }
  if (/select_provider\([^)]*p_(amount|price|agreed)/.test(code) || !/agreed_amount = v_claim\.offer_amount/.test(code)) {
    throw new Error("The agreed price must come from the accepted offer, never from a client argument");
  }
  if (/notify\([^;]*address/i.test(code)) {
    throw new Error("Notifications must never include the private address");
  }
  console.log("PASS: offers migration scope (claims evolved with offer amount/message, server-captured agreed price, address behind RLS for poster + accepted helper only, old overloads dropped, no client writes, address never in notifications)");
}
if (requests) {
  const sql = await readFile(new URL("migrations/20240101000019_helper_requests.sql", root), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  const created = [...code.matchAll(/create (?:or replace )?function (?:public|esg_private)\.([a-z_]+)\(/g)].map((entry) => entry[1]).sort();
  const expected = "accept_gig_request,account_unavailable,assert_requestable_helper,cancel_gig,create_claim,create_gig,decline_gig_request,delete_own_account,publish_gig,reassign_gig_request,select_provider,withdraw_claim";
  if (created.join(",") !== expected) {
    throw new Error(`Helper-request migration must only (re)create its own functions, found: ${created}`);
  }
  for (const entry of code.matchAll(/create (?:or replace )?function (?:public|esg_private)\.[a-z_]+\([\s\S]*?\n\$\$;/g)) {
    if (!entry[0].includes("security definer set search_path = ''")) throw new Error("Every request function must be SECURITY DEFINER with an empty search_path");
    if (!/function esg_private\.(?:assert_requestable_helper|account_unavailable)/.test(entry[0]) && !/if (?:auth\.uid\(\)|v_uid) is null then\s*raise exception 'Authentication required'/.test(entry[0])) {
      throw new Error("Every request RPC must start with an explicit authentication guard");
    }
  }
  if (!/drop function public\.create_gig\(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid\[\],text\);/.test(code)) {
    throw new Error("The 14-argument create_gig must be dropped, not left callable");
  }
  if (/requested_helper_id uuid references public\.profiles\(id\)\s+on delete/i.test(code)) {
    throw new Error("requested_helper_id must keep NO ACTION: deleting a helper must never turn a private request public");
  }
  const publicPolicy = code.match(/create policy gigs_select on public\.gigs[\s\S]*?\n\);/)?.[0] ?? "";
  if (!/requested_helper_id is null/.test(publicPolicy) || /\btrue\b/.test(publicPolicy)) {
    throw new Error("Public gig visibility must exclude helper requests");
  }
  if (/p_(amount|price|agreed)/.test(code.match(/create function public\.accept_gig_request\([^)]*\)/)?.[0] ?? "")) {
    throw new Error("accept_gig_request must not take a client-supplied price");
  }
  if (/notify\([^;]*(address_text|private_address|v_address)/i.test(code)) throw new Error("Notifications must never include the private address");
  if (!/requested_helper_id = v_uid/.test(code)) throw new Error("delete_own_account must treat a requested helper as having marketplace history");
  console.log("PASS: helper-request migration scope (private requests hidden from the public, eligibility enforced in SQL, atomic locked RPCs, deletion-safe foreign key, address never in notifications)");
}
if (profileSave) {
  const sql = await readFile(new URL("migrations/20240101000020_profile_column_update_grants.sql", root), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  const grants = [...code.matchAll(/\b(grant|revoke)\b[^;]*;/gi)].map((entry) => entry[0].replace(/\s+/g, " ").trim());
  if (grants.length !== 1 || grants[0] !== "grant update (phone, skills_other_text, services_other_text) on public.profiles to authenticated;") {
    throw new Error(`The profile grant migration must grant UPDATE on exactly phone and the two OTHER text columns to authenticated and nothing else, found: ${grants}`);
  }
  if (/create (?:or replace )?(?:function|policy|trigger|table)|drop |alter /i.test(code)) throw new Error("The profile grant migration must not change functions, policies, triggers or tables");
  console.log("PASS: profile grant migration scope (UPDATE on phone, skills_other_text and services_other_text for authenticated only; no policy, trigger or function change)");
}
if (blockUser) {
  const sql = await readFile(new URL("migrations/20240101000027_block_user.sql", root), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  if (!/create table public\.blocks \(/.test(code) || !/unique \(blocker_id, blocked_id\)/.test(code) || !/check \(blocker_id <> blocked_id\)/.test(code)) {
    throw new Error("The block-user migration must create the blocks table with a (blocker_id, blocked_id) unique constraint and a no-self-block check");
  }
  if (!/alter table public\.blocks enable row level security;/.test(code)) throw new Error("blocks must have row level security enabled");
  if (!/create policy blocks_select_own on public\.blocks for select to authenticated using \(\s*blocker_id = auth\.uid\(\)\s*\);/.test(code)) {
    throw new Error("blocks must only be readable by the blocker (the blocked party is never told who blocked them)");
  }
  if (!/revoke all on table public\.blocks from public, anon, authenticated;/.test(code) || !/grant select on table public\.blocks to authenticated;/.test(code)) {
    throw new Error("blocks must be select-only for authenticated, with no client insert/update/delete grant (writes only through block_user())");
  }
  if (!/create or replace function esg_private\.is_blocked\(p_a uuid, p_b uuid\) returns boolean/.test(code)) throw new Error("The block-user migration must create esg_private.is_blocked(uuid, uuid)");
  if (!/grant execute on function esg_private\.is_blocked\(uuid, uuid\) to authenticated;/.test(code) || /esg_private\.is_blocked\(uuid, uuid\)[^;]*to (anon|public)/i.test(code)) {
    throw new Error("esg_private.is_blocked must stay authenticated-only, matching has_own_claim/is_gig_poster's own convention");
  }
  if (!/create function public\.block_user\(p_blocked_id uuid\) returns void/.test(code)) throw new Error("The block-user migration must create public.block_user(uuid)");
  if (!/security definer set search_path = ''/.test(code.match(/create function public\.block_user\([\s\S]*?\n\$\$;/)?.[0] ?? "")) throw new Error("block_user must be SECURITY DEFINER with an empty search_path");
  if (!/if auth\.uid\(\) is null then\s*raise exception 'Authentication required' using errcode = '42501'/.test(code.match(/create function public\.block_user\([\s\S]*?\n\$\$;/)?.[0] ?? "")) throw new Error("block_user must start with an explicit authentication guard");
  const blockBody = code.match(/create function public\.block_user\([\s\S]*?\n\$\$;/)?.[0] ?? "";
  if (!/status in \('in_progress', 'awaiting_payment', 'disputed'\)/.test(blockBody)) throw new Error("block_user must refuse to block while a gig between the pair is in_progress/awaiting_payment/disputed, rather than forcing the two-sided Incomplete handshake with only one side's input");
  if (/gig_completions|gig_incomplete_choices|submit_payment_amount/.test(blockBody)) throw new Error("block_user must not try to drive the Completion/Incomplete lifecycle itself -- confirmed scope is to refuse the block outright while in progress");
  if (!/revoke execute on function public\.block_user\(uuid\) from public, anon, authenticated;/.test(code) || !/grant execute on function public\.block_user\(uuid\) to authenticated;/.test(code)) {
    throw new Error("block_user must be grant-scoped to authenticated only");
  }
  if (!/drop policy gigs_select on public\.gigs;/.test(code) || !/create policy gigs_select on public\.gigs for select to anon using/.test(code) || !/create policy gigs_select_discovery on public\.gigs for select to authenticated using/.test(code)) {
    throw new Error("The block-user migration must split gigs_select into an anon-only policy and a new authenticated gigs_select_discovery policy carrying the block check");
  }
  if (!/create policy gigs_select on public\.gigs for select to anon using \(\s*status = 'active' and selected_provider_id is null and requested_helper_id is null\s*\);/.test(code)) {
    throw new Error("The anon-facing gigs_select policy must keep its exact prior predicate, unmodified and with no esg_private reference");
  }
  if (!/drop policy public_profiles_select_all on public\.public_profiles;/.test(code) || !/create policy public_profiles_select_all on public\.public_profiles for select to anon using \(true\);/.test(code)
      || !/create policy public_profiles_select_authenticated on public\.public_profiles for select to authenticated using/.test(code)) {
    throw new Error("The block-user migration must split public_profiles_select_all into an anon-only policy and a new authenticated public_profiles_select_authenticated policy carrying the block check");
  }
  const createClaimBody = code.match(/create or replace function public\.create_claim\([\s\S]*?\n\$\$;/)?.[0] ?? "";
  if (!createClaimBody || !/esg_private\.is_blocked\(auth\.uid\(\), v_gig\.poster_id\)/.test(createClaimBody)) {
    throw new Error("create_claim must be recreated with a block check before a new claim can be inserted");
  }
  if (!/select \* into v_claim from public\.claims\s*\n\s*where gig_id = p_gig_id and provider_id = auth\.uid\(\);\s*\n\s*if found then/.test(createClaimBody)) {
    throw new Error("create_claim's existing-claim retry short-circuit must stay ahead of the block check, so a stale (block-closed) claim is still just handed back unchanged");
  }
  console.log("PASS: block-user migration scope (blocks table with blocker-only RLS and no client write grant, is_blocked authenticated-only helper, block_user refuses while a gig is in_progress/awaiting_payment/disputed rather than driving Completion/Incomplete itself, discovery/profile policies split with the block check added only to the authenticated side, create_claim blocks new claims while still returning a stale claim unchanged)");
}
if (withdrawExitRemove) {
  const sql = await readFile(new URL("migrations/20240101000026_withdraw_exit_remove_reasons.sql", root), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  if (!/create type public\.exit_reason as enum \('unable_to_locate_poster', 'safety_concern', 'other'\);/.test(code)) {
    throw new Error("The withdraw/exit/remove migration must create the three-value exit_reason enum");
  }
  const created = [...code.matchAll(/create function public\.([a-z_]+)\(/g)].map((entry) => entry[1]).sort();
  if (created.join(",") !== "exit_gig,remove_helper,withdraw_before_start") {
    throw new Error(`The withdraw/exit/remove migration must create exactly these three functions, found: ${created}`);
  }
  if (!/drop function if exists public\.remove_helper\(uuid\);/.test(code)) {
    throw new Error("The single-argument remove_helper overload must be dropped, not left callable alongside the new one");
  }
  for (const entry of code.matchAll(/create function public\.[a-z_]+\([\s\S]*?\n\$\$;/g)) {
    if (!entry[0].includes("security definer set search_path = ''")) throw new Error("Every withdraw/exit/remove function must be SECURITY DEFINER with an empty search_path");
    if (!/if auth\.uid\(\) is null then\s*raise exception 'Authentication required' using errcode = '42501'/.test(entry[0])) throw new Error("Every withdraw/exit/remove function must start with an explicit authentication guard");
  }
  if (!/select \* into v_gig from public\.gigs where id = p_gig_id for update;/.test(code.match(/create function public\.withdraw_before_start\([\s\S]*?\n\$\$;/)?.[0] ?? "")) {
    throw new Error("withdraw_before_start must lock the parent gig row before changing it");
  }
  if (!/v_gig\.status <> 'in_progress' then/.test(code.match(/create function public\.exit_gig\([\s\S]*?\n\$\$;/)?.[0] ?? "")) {
    throw new Error("exit_gig must only be usable while the gig is in progress");
  }
  if (!/status = 'active',/.test(code.match(/create function public\.exit_gig\([\s\S]*?\n\$\$;/)?.[0] ?? "")) {
    throw new Error("exit_gig must always reopen the gig to active, unlike its reopen-or-cancel siblings");
  }
  if (!/v_reason := nullif\(pg_catalog\.btrim\(p_reason\), ''\);/.test(code.match(/create function public\.remove_helper\([\s\S]*?\n\$\$;/)?.[0] ?? "")) {
    throw new Error("remove_helper must require a non-blank reason");
  }
  if (/\bto\s+(anon|public)\b/i.test(code.replace(/revoke[\s\S]*?;/gi, "")) || /grant (insert|update|delete)\b/i.test(code)) {
    throw new Error("The withdraw/exit/remove migration must grant execute to authenticated only");
  }
  console.log("PASS: withdraw/exit/remove migration scope (exit_reason enum, three SECURITY DEFINER functions with authentication guards, remove_helper's old overload dropped, exit_gig always reopens to active, execute for authenticated only)");
}
if (feedbackComments) {
  const sql = await readFile(new URL("migrations/20240101000025_feedback_comments.sql", root), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  if (!/drop function if exists public\.submit_feedback\(uuid, public\.feedback_type\);/.test(code)) throw new Error("The feedback-comments migration must drop the old two-argument submit_feedback before recreating it");
  if (!/create function public\.submit_feedback\(p_gig_id uuid, p_type public\.feedback_type, p_comment text default null\) returns void/.test(code)) throw new Error("The feedback-comments migration must recreate submit_feedback with an optional p_comment parameter");
  if (!code.includes("security definer set search_path = ''")) throw new Error("submit_feedback must remain SECURITY DEFINER with an empty search_path");
  if (!/if auth\.uid\(\) is null then\s*raise exception 'Authentication required' using errcode = '42501'/.test(code)) throw new Error("submit_feedback must keep its explicit authentication guard");
  if (!/alter table public\.feedback add column comment text;/.test(code)) throw new Error("The feedback-comments migration must add exactly one nullable comment column to feedback");
  if (/\bto\s+(anon|public)\b/i.test(code.replace(/revoke[\s\S]*?;/gi, "")) || /grant (insert|update|delete)\b/i.test(code)) throw new Error("The feedback-comments migration must grant execute to authenticated only");
  if (/drop table|create table|create policy|drop policy/i.test(code)) throw new Error("The feedback-comments migration must not change tables beyond adding the comment column, or touch policies");
  console.log("PASS: feedback-comments migration scope (one nullable feedback.comment column, submit_feedback recreated with optional p_comment, auth guard and SECURITY DEFINER preserved, execute for authenticated only)");
}
if (keepClaims) {
  const sql = await readFile(new URL("migrations/20240101000024_keep_other_claims.sql", root), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  const created = [...code.matchAll(/create function public\.([a-z_]+)\(/g)].map((entry) => entry[1]).sort();
  if (created.join(",") !== "close_pending_claims") throw new Error(`The keep-claims migration must create exactly its trigger function, found: ${created}`);
  const replaced = [...code.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((entry) => entry[1]).sort();
  if (replaced.join(",") !== "remove_helper,select_provider,withdraw_from_gig,withdraw_unanswered") throw new Error(`The keep-claims migration must replace exactly four functions, found: ${replaced}`);
  for (const entry of code.matchAll(/create (?:or replace )?function public\.[a-z_]+\([\s\S]*?\n\$\$;/g)) {
    if (!entry[0].includes("security definer set search_path = ''")) throw new Error("Every keep-claims function must be SECURITY DEFINER with an empty search_path");
  }
  for (const entry of code.matchAll(/create or replace function public\.[a-z_]+\([\s\S]*?\n\$\$;/g)) {
    if (!/if auth\.uid\(\) is null then\s*raise exception 'Authentication required' using errcode = '42501'/.test(entry[0])) throw new Error("Every replaced function must keep its explicit authentication guard");
  }
  if (/\bto\s+(anon|public|authenticated)\b/i.test(code.replace(/revoke[\s\S]*?;/gi, "")) || /grant\b/i.test(code)) throw new Error("The keep-claims migration must not grant anything (replaced functions keep their grants; the trigger function is not callable)");
  if (/alter table|drop |create table|create policy/i.test(code)) throw new Error("The keep-claims migration must not change tables or policies");
  if (!/after update of status on public\.gigs/.test(code)) throw new Error("The keep-claims trigger must fire on status changes only");
  console.log("PASS: keep-claims migration scope (select_provider no longer rejects the others, one status trigger, three helper-leaves functions reopen the gig, no table/policy/grant change)");
}
if (unansweredStart) {
  const sql = await readFile(new URL("migrations/20240101000023_unanswered_start_and_remove_helper.sql", root), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  const created = [...code.matchAll(/create function public\.([a-z_]+)\(/g)].map((entry) => entry[1]).sort();
  if (created.join(",") !== "remove_helper,wait_for_start,withdraw_unanswered") throw new Error(`The unanswered-start migration must create exactly its three functions, found: ${created}`);
  if (/create or replace function/i.test(code)) throw new Error("The unanswered-start migration must not replace any existing function");
  for (const entry of code.matchAll(/create function public\.[a-z_]+\([\s\S]*?\n\$\$;/g)) {
    if (!entry[0].includes("security definer set search_path = ''")) throw new Error("Every unanswered-start function must be SECURITY DEFINER with an empty search_path");
    if (!/if auth\.uid\(\) is null then\s*raise exception 'Authentication required' using errcode = '42501'/.test(entry[0])) throw new Error("Every unanswered-start function must start with an explicit authentication guard");
  }
  if (!/alter table public\.gigs\s+add column start_wait_count smallint not null default 0 check \(start_wait_count between 0 and 2\),\s+add column start_wait_until timestamptz,\s+add column helper_removed_at timestamptz;/.test(code)) throw new Error("The unanswered-start migration must add exactly the three gig columns");
  if (/\bto\s+(anon|public)\b/i.test(code.replace(/revoke[\s\S]*?;/gi, "")) || /grant (insert|update|delete)\b/i.test(code)) throw new Error("The unanswered-start migration must grant execute to authenticated only");
  console.log("PASS: unanswered-start migration scope (three gig columns, three new SECURITY DEFINER functions with authentication guards, execute for authenticated only)");
}
if (delayStart) {
  const sql = await readFile(new URL("migrations/20240101000022_delay_start_and_withdraw.sql", root), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  const created = [...code.matchAll(/create function public\.([a-z_]+)\(/g)].map((entry) => entry[1]).sort();
  if (created.join(",") !== "delay_start,withdraw_from_gig") throw new Error(`The delay-start migration must create exactly its two functions, found: ${created}`);
  if (/create or replace function/i.test(code)) throw new Error("The delay-start migration must not replace any existing function");
  for (const entry of code.matchAll(/create function public\.[a-z_]+\([\s\S]*?\n\$\$;/g)) {
    if (!entry[0].includes("security definer set search_path = ''")) throw new Error("Every delay-start function must be SECURITY DEFINER with an empty search_path");
    if (!/if auth\.uid\(\) is null then\s*raise exception 'Authentication required' using errcode = '42501'/.test(entry[0])) throw new Error("Every delay-start function must start with an explicit authentication guard");
  }
  if (!/alter table public\.gigs\s+add column start_delayed_at timestamptz,\s+add column helper_withdrawn_at timestamptz;/.test(code)) throw new Error("The delay-start migration must add exactly the two nullable gig columns");
  if (/\bto\s+(anon|public)\b/i.test(code.replace(/revoke[\s\S]*?;/gi, "")) || /grant (insert|update|delete)\b/i.test(code)) throw new Error("The delay-start migration must grant execute to authenticated only");
  console.log("PASS: delay-start migration scope (two nullable gig columns, two new SECURITY DEFINER functions with authentication guards, execute for authenticated only)");
}
if (negotiation) {
  const sql = await readFile(new URL("migrations/20240101000021_price_negotiation.sql", root), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  const created = [...code.matchAll(/create function public\.([a-z_]+)\(/g)].map((entry) => entry[1]).sort();
  if (created.join(",") !== "propose_price,respond_price_proposal,withdraw_price_proposal") {
    throw new Error(`The negotiation migration must create exactly its three functions and replace none, found: ${created}`);
  }
  if (/create or replace function/i.test(code)) throw new Error("The negotiation migration must not replace any existing function");
  for (const entry of code.matchAll(/create function public\.[a-z_]+\([\s\S]*?\n\$\$;/g)) {
    if (!entry[0].includes("security definer set search_path = ''")) throw new Error("Every negotiation function must be SECURITY DEFINER with an empty search_path");
    if (!/if auth\.uid\(\) is null then\s*raise exception 'Authentication required' using errcode = '42501'/.test(entry[0])) throw new Error("Every negotiation function must start with an explicit authentication guard");
  }
  if (!/grant select on public\.price_proposals to authenticated;/.test(code) || /grant (insert|update|delete|all)[^;]*price_proposals/i.test(code)) {
    throw new Error("Clients may only read price_proposals");
  }
  if (/\bto\s+(anon|public)\b/i.test(code.replace(/revoke[\s\S]*?;/gi, ""))) throw new Error("The negotiation migration must not grant anything to anon or PUBLIC");
  if (/update public\.gigs set [^;]*\b(amount|price_type|status|selected_provider_id)\b\s*=/i.test(code)) throw new Error("Negotiation may only change gigs.agreed_amount");
  console.log("PASS: price-negotiation migration scope (three new SECURITY DEFINER functions, read-only table for clients, no grants to anon, only gigs.agreed_amount is ever changed)");
}
if (!runtimePath) {
  console.log("Static verification only. Supply a PGlite dist/index.js path for SQL execution.");
  process.exit(0);
}

const { PGlite } = await import(pathToFileURL(runtimePath).href);
let passed = 0;
const db = new PGlite();

try {
  // Minimal Supabase-shaped platform scaffolding, not a replacement Supabase
  // stack. This tests PostgreSQL authorization mechanics, not hosted API/Auth.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create schema storage;
    grant usage on schema public, auth, storage to anon, authenticated;
    alter default privileges in schema public grant select, insert, update, delete
      on tables to anon, authenticated;
    -- Simulate both global PUBLIC execution and Supabase per-schema grants.
    alter default privileges in schema public grant execute
      on functions to anon, authenticated;
    create table auth.users (
      id uuid primary key, aud text, role text, email text,
      raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz,
      banned_until timestamptz
    );
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )::uuid;
    $$;
    create table storage.buckets (id text primary key, name text, public boolean);
    create table storage.objects (
      id uuid primary key default gen_random_uuid(), name text,
      bucket_id text references storage.buckets(id)
    );
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql as $$
      select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1];
    $$;
    create publication supabase_realtime;
  `);
  for (const file of [
    "migrations/20240101000001_init.sql",
    "migrations/20240101000002_security_hardening.sql",
    ...(phase2a ? ["migrations/20240101000003_lifecycle_integrity.sql"] : []),
    ...(onboarding ? ["migrations/20240101000004_onboarding_post_gig.sql"] : []),
    ...(phase2c ? ["migrations/20240101000005_direct_write_hardening.sql"] : []),
    ...(tags ? ["migrations/20240101000006_gig_tags.sql"] : []),
    ...(helpers ? ["migrations/20240101000007_profile_tags.sql"] : []),
    ...(distance ? ["migrations/20240101000008_helper_location.sql"] : []),
    ...(deletion ? ["migrations/20240101000009_account_deletion.sql"] : []),
    ...(offers ? ["migrations/20240101000010_offers_and_private_address.sql"] : []),
    ...(mainline ? [
      "migrations/20240101000011_taxonomy_and_identity.sql",
      "migrations/20240101000012_account_deletion_eligibility.sql",
      "migrations/20240101000013_public_wom_percentage.sql",
      "migrations/20240101000014_account_settings.sql",
      "migrations/20240101000015_registration_rewrite.sql",
      "migrations/20240101000016_fix_delete_account_username_lock.sql",
      "migrations/20240101000017_fix_set_helper_tags_categories.sql",
      "migrations/20240101000018_profile_other_text_validation.sql",
    ] : []),
    ...(requests ? ["migrations/20240101000019_helper_requests.sql"] : []),
    ...(profileSave ? ["migrations/20240101000020_profile_column_update_grants.sql"] : []),
    ...(negotiation ? ["migrations/20240101000021_price_negotiation.sql"] : []),
    ...(delayStart ? ["migrations/20240101000022_delay_start_and_withdraw.sql"] : []),
    ...(unansweredStart ? ["migrations/20240101000023_unanswered_start_and_remove_helper.sql"] : []),
    ...(keepClaims ? ["migrations/20240101000024_keep_other_claims.sql"] : []),
    ...(feedbackComments ? ["migrations/20240101000025_feedback_comments.sql"] : []),
    ...(withdrawExitRemove ? ["migrations/20240101000026_withdraw_exit_remove_reasons.sql"] : []),
    ...(blockUser ? ["migrations/20240101000027_block_user.sql"] : []),
    "tests/phase1_security.sql",
    ...(phase2a ? ["tests/phase2a_integrity.sql"] : []),
    ...(onboarding ? ["tests/onboarding_post_gig.sql"] : []),
    ...(phase2c ? ["tests/direct_write_hardening.sql"] : []),
    ...(tags ? ["tests/gig_tags.sql"] : []),
    ...(helpers ? ["tests/profile_tags.sql"] : []),
    ...(distance ? ["tests/helper_location.sql"] : []),
    ...(deletion ? ["tests/account_deletion.sql"] : []),
    ...(offers ? ["tests/offers_private_address.sql"] : []),
    ...(requests ? ["tests/helper_requests.sql"] : []),
    ...(profileSave ? ["tests/profile_column_grants.sql"] : []),
    ...(negotiation ? ["tests/price_negotiation.sql"] : []),
    ...(delayStart ? ["tests/delay_start.sql"] : []),
    ...(unansweredStart ? ["tests/unanswered_start.sql"] : []),
    ...(keepClaims ? ["tests/keep_claims.sql"] : []),
    ...(withdrawExitRemove ? ["tests/withdraw_exit_remove.sql"] : []),
    ...(blockUser ? ["tests/block_user.sql"] : []),
  ]) {
    const sql = await readFile(new URL(file, root), "utf8");
    await db.exec(sql);
    if (file.startsWith("tests/")) {
      // Every assertion is an unconditional top-level SELECT. Successful SQL
      // execution means every call returned without raising its failure error.
      const assertions = [...sql.matchAll(/^select pg_temp\.(?:assert|expect_denied|phase2_assert|phase2_expect_error|journey_assert|journey_error_any|journey_error|dw_assert|dw_denied|dw_error|gt_assert|gt_denied|gt_error|pt_assert|pt_denied|pt_error|hl_assert|hl_denied|hl_error|ad_assert|ad_error|of_assert|of_error|of_denied|rq_assert|rq_error|rq_denied|po_assert|po_error|po_denied|pn_assert|pn_error|pn_denied|ds_assert|ds_error|ds_denied|us_assert|us_error|us_denied|kc_assert|kc_error|kc_denied|wer_assert|wer_error|wer_denied|bl_assert|bl_error|bl_denied)\(/gm)].length;
      passed += assertions;
      console.log(`PASS: ${file}: ${assertions} assertions`);
    }
    console.log(`Executed ${file}`);
  }
  const cleanup = await db.query("select to_regclass('pg_temp.security_fixture') is null and to_regclass('pg_temp.phase2_fixture') is null and to_regclass('pg_temp.journey_fixture') is null and to_regclass('pg_temp.dw_fixture') is null and to_regclass('pg_temp.gt_fixture') is null and to_regclass('pg_temp.pt_fixture') is null and to_regclass('pg_temp.hl_fixture') is null and to_regclass('pg_temp.ad_fixture') is null and to_regclass('pg_temp.of_fixture') is null and to_regclass('pg_temp.rq_fixture') is null and to_regclass('pg_temp.po_fixture') is null and to_regclass('pg_temp.pn_fixture') is null and to_regclass('pg_temp.ds_fixture') is null and to_regclass('pg_temp.us_fixture') is null and to_regclass('pg_temp.kc_fixture') is null and to_regclass('pg_temp.wer_fixture') is null and to_regclass('pg_temp.bl_fixture') is null as clean");
  if (!cleanup.rows[0].clean) throw new Error("SQL fixtures did not roll back");
  console.log(`PASS: ${passed} security assertions in isolated PostgreSQL/WASM`);
  console.log("Hosted Supabase, PostgREST, Auth, Storage and Realtime integration remain unverified.");
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (error.code) console.error(`SQLSTATE: ${error.code}`);
  if (error.where) console.error(`Context: ${error.where}`);
  if (error.position) console.error(`Position: ${error.position}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
