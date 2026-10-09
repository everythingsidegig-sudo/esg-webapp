import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/app/api/auth/sign-in/route.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup(options = {}) {
  const calls = [];
  const query = {
    select: () => query,
    eq: (key, value) => { calls.push(["lookup", key, value]); return query; },
    maybeSingle: async () => ({
      data: options.missing ? null : { id: "user-1" },
      error: options.lookupError ? { message: "private diagnostic" } : null,
    }),
  };
  const admin = {
    from: (table) => { assert.equal(table, "profiles"); return query; },
    auth: { admin: { getUserById: async (id) => {
      assert.equal(id, "user-1");
      return { data: { user: { email: "private@example.com" } }, error: null };
    } } },
  };
  const mocks = {
    "@/lib/supabase/admin": { createAdminClient: () => {
      if (options.noConfig) throw new Error("secret configuration detail");
      return admin;
    } },
    "@supabase/supabase-js": { createClient: (url, key, config) => {
      assert.equal(key, "public-anon-key");
      assert.equal(config.auth.persistSession, false);
      return { auth: { signInWithPassword: async (credentials) => {
        calls.push(["password", credentials.email, credentials.password]);
        return {
          data: { user: { id: options.wrongUser ? "user-2" : "user-1" },
            session: options.noSession ? null : { access_token: "access", refresh_token: "refresh" } },
          error: options.authError ?? null,
        };
      } } };
    } },
  };
  const loaded = { exports: {} };
  runInNewContext("(function(require, module, exports) {" + code + "\n})", {
    Response, URL, process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon-key" } },
  })((id) => { assert.ok(mocks[id]); return mocks[id]; }, loaded, loaded.exports);
  return { POST: loaded.exports.POST, calls };
}

function request(body = { username: "Tester01", password: "Password123!" }, headers = {}) {
  return new Request("https://esg.example/api/auth/sign-in", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://esg.example", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("username sign-in resolves exact username privately and requires a valid password", async () => {
  const { POST, calls } = setup();
  const response = await POST(request({ username: " Tester01 ", password: " Password123! " }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { access_token: "access", refresh_token: "refresh" });
  assert.deepEqual(calls, [["lookup", "username", "Tester01"], ["password", "private@example.com", " Password123! "]]);
});

test("unknown username and incorrect password have identical public errors", async () => {
  const unknown = await setup({ missing: true }).POST(request());
  const wrong = await setup({ authError: { code: "invalid_credentials" } }).POST(request());
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await unknown.json(), await wrong.json());
});

test("never returns a session for a different user or a missing session", async () => {
  for (const options of [{ wrongUser: true }, { noSession: true }]) {
    const response = await setup(options).POST(request());
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { code: "invalid_credentials" });
  }
});

test("preserves rate limiting and email verification failures without leaking private data", async () => {
  for (const [error, status, code] of [
    [{ status: 429 }, 429, "over_request_rate_limit"],
    [{ code: "email_not_confirmed" }, 401, "email_not_confirmed"],
    [{ code: "user_banned" }, 401, "invalid_credentials"],
  ]) {
    const response = await setup({ authError: error }).POST(request());
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { code });
  }
});

test("configuration and database failures fail closed with a safe error", async () => {
  for (const options of [{ noConfig: true }, { lookupError: true }]) {
    const response = await setup(options).POST(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "username_signin_unavailable" });
  }
});

test("rejects malformed, oversized, and cross-origin requests before lookup", async () => {
  for (const req of [
    request("not json"), request(null), request({ username: {}, password: "test" }),
    request({ username: "%", password: "test" }), request("x".repeat(17000)),
    request(undefined, { Origin: "https://other.example" }),
    request(undefined, { "Content-Type": "text/plain" }),
  ]) {
    const { POST, calls } = setup();
    const response = await POST(req);
    assert.ok(response.status >= 400);
    assert.equal(calls.length, 0);
  }
});
