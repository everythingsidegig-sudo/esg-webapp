import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { approximateCoordinates, gigInputError, friendlyError, passwordError, safeNext, setupDestination } from "../src/lib/journey.ts";

// Execute the actual client components with controlled hooks and Supabase responses.
// This is a small unit harness, not a browser or hosted-Auth verification.
const require = createRequire(import.meta.url);
const user = { id: "test-user" };
const profile = { id: user.id, username: "Tester123", skills: ["Cleaning"], services: ["Other"],
  photo_url: null, wom_count: 1, lemon_count: 0, money_made: 0, onboarding_completed_at: "2026-01-01" };
const params = new URLSearchParams();
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function component(path, name, overrides = {}) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(`${source}\nexport { ${name} as TestedComponent };`, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const states = [], effects = [];
  let cursor = 0, queue = [];
  const hooks = {
    Suspense: "suspense",
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useRef(value) { const [ref] = hooks.useState(() => ({ current: value })); return ref; },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = effects[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        queue.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: callback() }; });
      }
    },
  };
  const auth = { user, profile, loading: false, profileLoading: false, profileError: null, refreshProfile: async () => {} };
  const mocks = {
    react: hooks,
    "next/link": { default: "a" },
    "next/navigation": { useSearchParams: () => params, usePathname: () => "/profile", useRouter: () => ({ replace() {} }) },
    "@/lib/auth-context": { useAuth: () => auth },
    "@/lib/supabase/client": { createClient: () => overrides.client },
    "@/lib/services": { SERVICE_TYPES: ["Cleaning", "Other"] },
    "@/lib/journey": { friendlyError, passwordError, safeNext, setupDestination, approximateCoordinates, gigInputError },
    "@/components/AuthGuard": { default: "guard" },
    "@/components/StatusBadge": { default: "badge" },
    ...overrides.mocks,
  };
  const loadedModule = { exports: {} };
  runInNewContext(`(function(require, module, exports) { ${code}\n})`, { URL, URLSearchParams, console, crypto, sessionStorage: overrides.storage,
    ...overrides.globals })( (id) => mocks[id] ?? require(id), loadedModule, loadedModule.exports );
  return { auth, render(props = {}) {
    cursor = 0; queue = [];
    const tree = loadedModule.exports.TestedComponent(props);
    queue.forEach((effect) => effect());
    return tree;
  } };
}

function nodes(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  const children = Array.isArray(tree.props?.children) ? tree.props.children.flat(Infinity) : [tree.props?.children];
  return [...(predicate(tree) ? [tree] : []), ...children.flatMap((child) => nodes(child, predicate))];
}
const button = (tree, label) => nodes(tree, (node) => node.type === "button" && node.props.children === label)[0];

function gigClient(failure) {
  const calls = [];
  return { calls, from(table) {
    let kind = table === "claims" ? "claims" : null;
    const query = {
      select() { return query; },
      eq(field) { if (field === "poster_id") kind = "posted"; return query; },
      or() { kind = "worked"; return query; },
      order() { return query; },
      then(resolve, reject) {
        calls.push(kind);
        return Promise.resolve(kind === failure ? { data: null, error: new Error("failed") }
          : { data: kind === "claims" ? [] : [{ id: `${kind}-gig`, status: "active" }], error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
}

for (const failure of ["claims", "worked", "posted"]) {
  test(`My Gigs isolates ${failure} failure and retries only that section`, async () => {
    const client = gigClient(failure);
    const app = await component("src/app/my-gigs/page.tsx", "MyGigsInner", { client });
    app.render(); await flush();
    let tree = app.render();
    const goodTab = failure === "posted" ? "Gigs Worked" : "Gigs Posted";
    button(tree, goodTab).props.onClick(); tree = app.render();
    assert.equal(nodes(tree, (node) => node.props.role === "alert").length, 0);
    assert.equal(nodes(tree, (node) => node.props.gigs?.length === 1).length, 1);
    button(tree, failure === "posted" ? "Gigs Posted" : "Gigs Worked").props.onClick();
    tree = app.render();
    assert.equal(nodes(tree, (node) => node.props.role === "alert").length, 1);
    client.calls.length = 0;
    button(tree, "Retry").props.onClick(); app.render(); await flush();
    assert.deepEqual(client.calls, failure === "posted" ? ["posted"] : failure === "claims" ? ["claims"] : ["claims", "worked"]);
  });
}

test("AuthGuard retains the same loaded child slot on background refresh failure", async () => {
  const app = await component("src/components/AuthGuard.tsx", "AuthGuardInner");
  const child = { type: "editor", props: { dirty: true } };
  const before = app.render({ children: child });
  app.auth.profileError = "Refresh failed";
  const after = app.render({ children: child });
  assert.equal(before.type, after.type);
  assert.equal(before.props.children[1], child);
  assert.equal(after.props.children[1], child);
  assert.equal(nodes(after, (node) => node.props.role === "alert").length, 1);
  app.auth.profile = null;
  assert.equal(nodes(app.render({ children: child }), (node) => node === child).length, 0);
});

for (const fails of [false, true]) {
  test(`normal profile save ${fails ? "surfaces failure" : "persists only editable fields without setup"}`, async () => {
    const updates = [];
    const client = { from(table) {
      assert.equal(table, "profiles");
      return { update(payload) {
        updates.push(payload);
        return { eq(field, id) {
          assert.equal(field, "id"); assert.equal(id, user.id);
          return { select: () => ({ single: async () => ({ error: fails ? new Error("denied") : null }) }) };
        } };
      } };
    } };
    const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
    let tree = app.render({ profile });
    const input = nodes(tree, (node) => node.type === "input" && node.props.value === profile.username)[0];
    input.props.onChange({ target: { value: "Edited123" } });
    tree = app.render({ profile });
    await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
    tree = app.render({ profile });
    assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ username: "Edited123", skills: ["Cleaning"], services: ["Other"] }]);
    assert.equal(nodes(tree, (node) => node.props.role === "status").length, fails ? 0 : 1);
    assert.equal(nodes(tree, (node) => node.props.role === "alert").length, fails ? 1 : 0);
    app.auth.profileError = "Refresh failed";
    tree = app.render({ profile: { ...profile, username: "Server123" } });
    assert.equal(nodes(tree, (node) => node.type === "input" && node.props.value === "Edited123").length, 1);
  });
}

for (const status of ["active", "draft"]) {
  test(`creation retry retains identity and opens ${status === "draft" ? "My Gigs" : "Gig Detail"}`, async () => {
    const destinations = [], calls = [];
    const request = { p_request_id: "retry-identity", p_title: "Gig", p_amount: 10, p_publish: status !== "draft" };
    const storage = new Map([[`esg:post:${user.id}`, JSON.stringify(request)]]);
    const app = await component("src/app/post/page.tsx", "PostGigForm", {
      client: { rpc: async (name, payload) => { calls.push({ name, payload }); return { data: { id: "created-id", status }, error: null }; } },
      storage: { getItem: (key) => storage.get(key), removeItem: (key) => storage.delete(key) },
      mocks: {
        "@/lib/location": { loadJourneyLocation: () => ({ text: "", lat: null, lng: null }) },
        "next/navigation": { useSearchParams: () => params, useRouter: () => ({ replace: (url) => destinations.push(url) }) },
      },
    });
    const tree = app.render();
    button(tree, "Retry previous request").props.onClick();
    button(tree, "Retry previous request").props.onClick();
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "create_gig");
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)), request);
    assert.deepEqual(destinations, [status === "draft" ? "/my-gigs?created=created-id" : "/gigs/created-id"]);
    assert.equal(storage.size, 0);
  });
}

test("Location is confirmed before either journey choice appears", async () => {
  const destinations = [], locations = [];
  const app = await component("src/app/location/page.tsx", "LocationEntryInner", {
    storage: { setItem: (_key, value) => locations.push(JSON.parse(value)) },
    mocks: {
      "@/lib/location": { LOCATION_KEY: "esg:general-area" },
      "next/navigation": { useRouter: () => ({ push: (url) => destinations.push(url) }) },
    },
  });
  let tree = app.render();
  assert.equal(nodes(tree, (node) => node.props.href === "/need-help").length, 0);
  assert.equal(nodes(tree, (node) => node.props["aria-label"] === "Help & Earn Money").length, 0);
  nodes(tree, (node) => node.type === "input")[0].props.onChange({ target: { value: "Test city" } });
  tree = app.render(); button(tree, "Continue").props.onClick();
  tree = app.render();
  assert.equal(nodes(tree, (node) => node.props.href === "/need-help").length, 1);
  assert.equal(nodes(tree, (node) => node.props["aria-label"] === "Help & Earn Money").length, 1);
  assert.deepEqual(destinations, []);
  assert.equal(locations[0].text, "Test city");
});

test("I Need Help offers Post a Gig and a non-navigating Coming soon helper choice", async () => {
  const app = await component("src/app/need-help/page.tsx", "NeedHelp");
  const tree = app.render();
  const links = nodes(tree, (node) => node.type === "a");
  assert.deepEqual(links.map((link) => link.props.href), ["/post"]);
  assert.equal(nodes(tree, (node) => node.props.children === "Find a Helper").length, 1);
  assert.equal(nodes(tree, (node) => node.props.children === "Coming soon").length, 1);
  assert.equal(nodes(tree, (node) => node.props.href === "/browse").length, 0);
});

test("Help & Earn Money passes rounded current coordinates to Browse", async () => {
  const destinations = [], locations = [];
  const app = await component("src/app/location/page.tsx", "LocationEntryInner", {
    storage: { setItem: (_key, value) => locations.push(JSON.parse(value)) },
    globals: { navigator: { geolocation: { getCurrentPosition: (success) => success({ coords: { latitude: 12.345, longitude: -45.678 } }) } } },
    mocks: {
      "@/lib/location": { LOCATION_KEY: "esg:general-area" },
      "next/navigation": { useSearchParams: () => new URLSearchParams({ journey: "earn_money" }), useRouter: () => ({ push: (url) => destinations.push(url) }) },
    },
  });
  let tree = app.render();
  button(tree, "📍 Use My Location").props.onClick();
  tree = app.render(); button(tree, "Continue").props.onClick();
  tree = app.render(); nodes(tree, (node) => node.props["aria-label"] === "Help & Earn Money")[0].props.onClick();
  assert.deepEqual(destinations, ["/browse?lat=12.35&lng=-45.68"]);
  assert.deepEqual(locations, [{ text: "Current location", lat: 12.35, lng: -45.68 }]);
});

test("logged-out Home contains only authentication entry links", async () => {
  const app = await component("src/app/page.tsx", "Home");
  app.auth.user = null; app.auth.profile = null;
  const tree = app.render();
  assert.deepEqual(nodes(tree, (node) => node.type === "a").map((node) => node.props.href), ["/auth/sign-in", "/auth/sign-up"]);
  assert.equal(nodes(tree, (node) => node.props.children === "I Need Help").length, 0);
  assert.equal(nodes(tree, (node) => node.props.children === "Help & Earn Money").length, 0);
  assert.equal(nodes(tree, (node) => String(node.props.children).includes("guest")).length, 0);
});

for (const completed of [false, true]) {
  test(`authenticated Home routes ${completed ? "completed" : "incomplete"} profile toward Location`, async () => {
    const destinations = [];
    const app = await component("src/app/page.tsx", "Home", {
      mocks: { "next/navigation": { useRouter: () => ({ replace: (url) => destinations.push(url) }) } },
    });
    app.auth.profile = { ...profile, onboarding_completed_at: completed ? "2026-01-01" : null };
    app.render();
    assert.deepEqual(destinations, [completed ? "/location" : "/onboarding?next=%2Flocation"]);
  });
}

test("Sign In exposes the password-recovery route", async () => {
  const app = await component("src/app/auth/sign-in/page.tsx", "SignInInner", { client: { auth: {} } });
  const tree = app.render();
  assert.equal(nodes(tree, (node) => node.props.href === "/auth/forgot-password").length, 1);
});

test("forgot-password requests a recovery link without exposing account existence", async () => {
  const requests = [];
  const app = await component("src/app/auth/forgot-password/page.tsx", "ForgotPassword", {
    client: { auth: { resetPasswordForEmail: async (email, options) => { requests.push({ email, options }); return { error: null }; } } },
    globals: { window: { location: { origin: "http://localhost:3001" } } },
  });
  let tree = app.render();
  nodes(tree, (node) => node.props.id === "recovery-email")[0].props.onChange({ target: { value: "person@example.com" } });
  tree = app.render();
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  tree = app.render();
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ email: "person@example.com", options: { redirectTo: "http://localhost:3001/auth/reset-password" } }]);
  assert.equal(nodes(tree, (node) => String(node.props.children).includes("If an ESG account uses that email")).length, 1);
});

test("reset-password exchanges the recovery code before updating the password", async () => {
  const calls = [], destinations = [];
  const app = await component("src/app/auth/reset-password/page.tsx", "ResetPassword", {
    client: { auth: {
      exchangeCodeForSession: async (code) => { calls.push(["exchange", code]); return { error: null }; },
      getSession: async () => ({ data: { session: { user: { id: "test-user" } } }, error: null }),
      updateUser: async ({ password }) => { calls.push(["update", password]); return { error: null }; },
    } },
    globals: { window: {
      location: { href: "http://localhost:3001/auth/reset-password?code=recovery-code" },
      history: { replaceState: (_state, _title, url) => calls.push(["clean", url]) },
    } },
    mocks: { "next/navigation": { useRouter: () => ({ replace: (url) => destinations.push(url) }) } },
  });
  app.render(); await flush();
  let tree = app.render();
  const inputs = nodes(tree, (node) => node.type === "input");
  inputs[0].props.onChange({ target: { value: "Replacement1!" } });
  inputs[1].props.onChange({ target: { value: "Replacement1!" } });
  tree = app.render();
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls, [["exchange", "recovery-code"], ["clean", "/auth/reset-password"], ["update", "Replacement1!"]]);
  assert.deepEqual(destinations, ["/"]);
});
