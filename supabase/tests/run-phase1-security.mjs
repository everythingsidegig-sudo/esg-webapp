// Optional isolated PostgreSQL/WASM check. No Docker or hosted database access.
// Supply the path to a separately installed @electric-sql/pglite dist/index.js.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const distance = process.argv.includes("--distance");
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
      raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz
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
    "tests/phase1_security.sql",
    ...(phase2a ? ["tests/phase2a_integrity.sql"] : []),
    ...(onboarding ? ["tests/onboarding_post_gig.sql"] : []),
    ...(phase2c ? ["tests/direct_write_hardening.sql"] : []),
    ...(tags ? ["tests/gig_tags.sql"] : []),
    ...(helpers ? ["tests/profile_tags.sql"] : []),
    ...(distance ? ["tests/helper_location.sql"] : []),
  ]) {
    const sql = await readFile(new URL(file, root), "utf8");
    await db.exec(sql);
    if (file.startsWith("tests/")) {
      // Every assertion is an unconditional top-level SELECT. Successful SQL
      // execution means every call returned without raising its failure error.
      const assertions = [...sql.matchAll(/^select pg_temp\.(?:assert|expect_denied|phase2_assert|phase2_expect_error|journey_assert|journey_error_any|journey_error|dw_assert|dw_denied|dw_error|gt_assert|gt_denied|gt_error|pt_assert|pt_denied|pt_error|hl_assert|hl_denied|hl_error)\(/gm)].length;
      passed += assertions;
      console.log(`PASS: ${file}: ${assertions} assertions`);
    }
    console.log(`Executed ${file}`);
  }
  const cleanup = await db.query("select to_regclass('pg_temp.security_fixture') is null and to_regclass('pg_temp.phase2_fixture') is null and to_regclass('pg_temp.journey_fixture') is null and to_regclass('pg_temp.dw_fixture') is null and to_regclass('pg_temp.gt_fixture') is null and to_regclass('pg_temp.pt_fixture') is null and to_regclass('pg_temp.hl_fixture') is null as clean");
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
