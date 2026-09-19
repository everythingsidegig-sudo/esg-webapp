// Optional isolated PostgreSQL/WASM check. No Docker or hosted database access.
// Supply the path to a separately installed @electric-sql/pglite dist/index.js.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const onboarding = process.argv.includes("--onboarding");
const phase2a = process.argv.includes("--phase2a") || onboarding;
const runtimePath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const original = await readFile(new URL("migrations/0001_init.sql", root), "utf8");
const hardened = await readFile(new URL("migrations/0002_security_hardening.sql", root), "utf8");
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
  const integrity = await readFile(new URL("migrations/0003_lifecycle_integrity.sql", root), "utf8");
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
  const journey = await readFile(new URL("migrations/0004_onboarding_post_gig.sql", root), "utf8");
  const functions = [...journey.matchAll(/create function public\.([a-z_]+)\([\s\S]*?\n\$\$;/g)];
  if (functions.length !== 3 || functions.some((entry) => !["ensure_profile", "save_onboarding", "create_gig"].includes(entry[1]))) throw new Error("Unexpected onboarding RPC scope");
  for (const entry of functions) {
    if (!entry[0].includes("security definer set search_path = ''") || !/begin\s+if auth\.uid\(\) is null then/.test(entry[0])) throw new Error(`Unsafe onboarding RPC: ${entry[1]}`);
  }
  console.log("PASS: onboarding RPC scope, explicit authentication and safe search paths");
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
    "migrations/0001_init.sql",
    "migrations/0002_security_hardening.sql",
    ...(phase2a ? ["migrations/0003_lifecycle_integrity.sql"] : []),
    ...(onboarding ? ["migrations/0004_onboarding_post_gig.sql"] : []),
    "tests/phase1_security.sql",
    ...(phase2a ? ["tests/phase2a_integrity.sql"] : []),
    ...(onboarding ? ["tests/onboarding_post_gig.sql"] : []),
  ]) {
    const sql = await readFile(new URL(file, root), "utf8");
    await db.exec(sql);
    if (file.startsWith("tests/")) {
      // Every assertion is an unconditional top-level SELECT. Successful SQL
      // execution means every call returned without raising its failure error.
      const assertions = [...sql.matchAll(/^select pg_temp\.(?:assert|expect_denied|phase2_assert|phase2_expect_error|journey_assert|journey_error)\(/gm)].length;
      passed += assertions;
      console.log(`PASS: ${file}: ${assertions} assertions`);
    }
    console.log(`Executed ${file}`);
  }
  const cleanup = await db.query("select to_regclass('pg_temp.security_fixture') is null and to_regclass('pg_temp.phase2_fixture') is null and to_regclass('pg_temp.journey_fixture') is null as clean");
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
