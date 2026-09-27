import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercises src/app/api/account/delete/route.ts directly: transpiles the real
// source and runs it in a sandbox with the two Supabase client factories
// mocked, the same technique tests/cleanup.test.mjs uses for React
// components. This is a unit test of the route's own logic (identity
// derivation, which branch it takes, error handling) -- not a replacement
// for hitting a real Next.js server or hosted Supabase project.
const require = createRequire(import.meta.url);
const routeUrl = new URL("../src/app/api/account/delete/route.ts", import.meta.url);

async function loadRoute(overrides = {}) {
  const source = await readFile(routeUrl, "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mocks = {
    "@/lib/supabase/server": { createClient: async () => overrides.serverClient },
    "@/lib/supabase/admin": { createAdminClient: overrides.createAdminClient ?? (() => { throw new Error("createAdminClient should not have been called"); }) },
  };
  const loadedModule = { exports: {} };
  runInNewContext(`(function(require, module, exports) { ${code}\n})`, { URL, console, process: { env: {} } })(
    (id) => mocks[id] ?? require(id), loadedModule, loadedModule.exports
  );
  return loadedModule.exports.POST;
}

function noopAdmin() {
  return { storage: { from: () => ({ list: async () => ({ data: [] }), remove: async () => ({ error: null }) }) },
    auth: { admin: { deleteUser: async () => ({ error: null }), updateUserById: async () => ({ error: null }) } } };
}

test("account delete route: never reads a client-supplied id -- identity comes only from the session", async () => {
  const source = await readFile(routeUrl, "utf8");
  assert.doesNotMatch(source, /req\.(json|body)|request\.(json|body)|params\./, "the handler never reads a request body/params for an id");
  assert.match(source, /getUser\(\)/, "the acted-on identity comes only from the authenticated session");
  assert.match(source, /export async function POST\(\)/, "the handler takes no request argument, so there is nothing for a client to supply an id through");
});

test("account delete route: unauthenticated request is rejected before touching the RPC or admin API", async () => {
  let rpcCalled = false;
  const serverClient = {
    auth: { getUser: async () => ({ data: { user: null }, error: null }), signOut: async () => ({ error: null }) },
    rpc: async () => { rpcCalled = true; return { data: null, error: null }; },
  };
  const POST = await loadRoute({ serverClient });
  const response = await POST();
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.match(body.error, /authentication/i);
  assert.equal(rpcCalled, false, "no deletion RPC runs for an unauthenticated caller");
});

test("account delete route: no-history account is hard-deleted via the Admin API using only the session's own user id, then the session is invalidated globally", async () => {
  const calls = [];
  const serverClient = {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
      signOut: async (opts) => { calls.push({ type: "signOut", opts }); return { error: null }; },
    },
    rpc: async (name) => { calls.push({ type: "rpc", name }); return { data: false, error: null }; },
  };
  const admin = noopAdmin();
  admin.auth.admin.deleteUser = async (id) => { calls.push({ type: "deleteUser", id }); return { error: null }; };
  admin.auth.admin.updateUserById = async (...args) => { calls.push({ type: "updateUserById", args }); return { error: null }; };
  const POST = await loadRoute({ serverClient, createAdminClient: () => admin });
  const response = await POST();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.deepEqual(calls.filter((c) => c.type === "deleteUser"), [{ type: "deleteUser", id: "user-1" }]);
  assert.equal(calls.some((c) => c.type === "updateUserById"), false, "a clean account is hard-deleted, never locked");
  assert.ok(calls.some((c) => c.type === "signOut" && c.opts?.scope === "global"), "the session is invalidated globally after successful deletion");
});

test("account delete route: account with marketplace history is anonymized and permanently locked, never hard-deleted", async () => {
  const calls = [];
  const serverClient = {
    auth: { getUser: async () => ({ data: { user: { id: "user-2" } }, error: null }), signOut: async () => ({ error: null }) },
    rpc: async () => ({ data: true, error: null }),
  };
  const admin = noopAdmin();
  admin.auth.admin.deleteUser = async (id) => { calls.push({ type: "deleteUser", id }); return { error: null }; };
  admin.auth.admin.updateUserById = async (id, attrs) => { calls.push({ type: "updateUserById", id, attrs }); return { error: null }; };
  const POST = await loadRoute({ serverClient, createAdminClient: () => admin });
  const response = await POST();
  assert.equal(response.status, 200);
  assert.equal(calls.some((c) => c.type === "deleteUser"), false, "an account with history is never hard-deleted");
  const lock = calls.find((c) => c.type === "updateUserById");
  assert.ok(lock, "the account is locked via updateUserById instead");
  assert.equal(lock.id, "user-2");
  assert.match(lock.attrs.email, /^deleted\+user-2@/, "the email is scrambled so the old credentials can never find the account again");
  assert.ok(lock.attrs.ban_duration, "a ban is applied so the account can never sign in again");
});

test("account delete route: a failed deletion RPC leaves the account untouched, never reaches the admin API, and reports an error", async () => {
  let adminConstructed = false;
  const serverClient = {
    auth: { getUser: async () => ({ data: { user: { id: "user-3" } }, error: null }), signOut: async () => ({ error: null }) },
    rpc: async () => ({ data: null, error: new Error("db unavailable") }),
  };
  const POST = await loadRoute({ serverClient, createAdminClient: () => { adminConstructed = true; return noopAdmin(); } });
  const response = await POST();
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /try again/i);
  assert.equal(adminConstructed, false, "the service-role client is never touched when the RPC itself fails");
});

test("account delete route: an Admin API failure reports an error and does not sign the caller out", async () => {
  let signedOut = false;
  const serverClient = {
    auth: { getUser: async () => ({ data: { user: { id: "user-4" } }, error: null }), signOut: async () => { signedOut = true; return { error: null }; } },
    rpc: async () => ({ data: false, error: null }),
  };
  const admin = noopAdmin();
  admin.auth.admin.deleteUser = async () => ({ error: new Error("admin api down") });
  const POST = await loadRoute({ serverClient, createAdminClient: () => admin });
  const response = await POST();
  assert.equal(response.status, 500);
  assert.equal(signedOut, false, "the session is left intact when the destructive step fails, so the account remains usable");
});
