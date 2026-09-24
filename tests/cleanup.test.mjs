import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { approximateCoordinates, gigInputError, friendlyError, passwordError, safeNext, setupDestination } from "../src/lib/journey.ts";

// location.ts has extension-less relative imports (./journey, ./geocoding) that
// Node's native ESM+TS loader can't resolve directly, so its exact haversineKm
// formula is duplicated here rather than imported (same formula Browse already
// uses for gig distance, just in kilometers).
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
    useMemo: (callback) => callback(),
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
    "@/lib/services": { SERVICE_TYPES: ["Cleaning", "Other"], SPECIALIZATION_PROMPTS: { Cleaning: "What kind of cleaning?", Handyman: "What kind of handyman work?", Other: "What kind of help?" } },
    "@/lib/journey": { friendlyError, passwordError, safeNext, setupDestination, approximateCoordinates, gigInputError },
    "@/lib/location": { loadJourneyLocation: () => ({ text: "", lat: null, lng: null }), haversineKm },
    "@/lib/tags": {
      loadTagCatalog: async () => ({}),
      gigTagNames: (gig) => (gig.gig_tags ?? []).map((link) => link.tag.name),
      profileTagsForCategory: (profile, serviceType) => (profile.profile_tags ?? []).map((link) => link.tag).filter((tag) => tag.service_type === serviceType),
      MAX_GIG_TAGS: 8,
      MAX_PROFILE_TAGS: 8,
    },
    "@/components/AuthGuard": { default: "guard" },
    "@/components/SelectionChip": { default: "selection-chip" },
    "@/components/StatusBadge": { default: "badge" },
    "@/components/TagChip": { default: "tag-chip" },
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

test("profile chips restore saved and legacy values, toggle independently, and save the same arrays", async () => {
  let saved;
  const client = { from: (table) => table === "profile_tags"
    ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
    : { update: (payload) => {
        saved = payload;
        return { eq: () => ({ select: () => ({ single: async () => ({ error: null }) }) }) };
      } },
    // The unified Save also syncs specializations for whatever ends up selected;
    // this test only cares about the profiles.update payload, so a no-op stub
    // is enough to let those calls succeed harmlessly.
    rpc: async () => ({ data: null, error: null }),
  };
  const original = { ...profile, skills: ["Cleaning", "Legacy skill"] };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
  const chips = (tree) => nodes(tree, (node) => node.type === "selection-chip");
  let tree = app.render({ profile: original });
  assert.deepEqual(chips(tree).filter((node) => node.props.selected).map((node) => node.props.children), ["Cleaning", "Legacy skill", "Other"]);
  chips(tree)[0].props.onClick();
  tree = app.render({ profile: original });
  chips(tree)[1].props.onClick();
  tree = app.render({ profile: original });
  chips(tree)[4].props.onClick();
  tree = app.render({ profile: original });
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), { username: profile.username, skills: ["Legacy skill", "Other"], services: [] });
  const refreshed = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
  assert.deepEqual(chips(refreshed.render({ profile: { ...original, ...saved } })).filter((node) => node.props.selected).map((node) => node.props.children), ["Other", "Legacy skill"]);
});

test("Profile: selecting a skill immediately reveals its specialization prompt with compact chips, and no 'tag' wording appears", async () => {
  const client = { from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) } };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({ Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }] }), MAX_PROFILE_TAGS: 8 } },
  });
  app.render({ profile: { ...profile, skills: [] } }); await flush();
  let tree = app.render({ profile: { ...profile, skills: [] } });
  assert.equal(nodes(tree, (node) => node.props.children === "What kind of cleaning?").length, 0, "no specialization prompt before the skill is selected");
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  chip("Cleaning").props.onClick();
  tree = app.render({ profile: { ...profile, skills: [] } });
  assert.equal(nodes(tree, (node) => node.props.children === "What kind of cleaning?").length, 1, "specialization prompt appears inline immediately, before saving");
  const specializationChip = chip("Deep Cleaning");
  assert.ok(specializationChip, "specialization chip renders under the selected skill");
  assert.equal(specializationChip.props.size, "compact", "specializations use the smaller/secondary chip size for visual hierarchy");

  const allText = nodes(tree, (node) => typeof node.props?.children === "string").map((node) => node.props.children).join(" ");
  assert.doesNotMatch(allText, /\btags?\b/i, "no 'tag' wording is shown to the user");
  assert.doesNotMatch(allText, /profile_tags/i);
});

test("Profile: deselecting a skill hides its specialization chips immediately", async () => {
  const client = { from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) } };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({ Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }] }), MAX_PROFILE_TAGS: 8 } },
  });
  const withSkill = { ...profile, skills: ["Cleaning"] };
  app.render({ profile: withSkill }); await flush();
  let tree = app.render({ profile: withSkill });
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  assert.ok(chip("Deep Cleaning"), "specialization chip present while the skill is selected");
  chip("Cleaning").props.onClick();
  tree = app.render({ profile: withSkill });
  assert.equal(chip("Deep Cleaning"), undefined, "specialization chips disappear once the skill is deselected");
});

test("Profile Save persists skill/service changes and specializations together, clearing a deselected skill's specializations first", async () => {
  const calls = [];
  const client = {
    from(table) {
      if (table === "profile_tags") {
        return { select: () => ({ eq: async () => ({
          data: [
            { tag: { id: "t1", name: "Deep Cleaning", service_type: "Cleaning" } },
            { tag: { id: "t2", name: "Plumbing", service_type: "Handyman" } },
          ],
          error: null,
        }) }) };
      }
      return { update: (payload) => {
        calls.push({ type: "profile-update", payload });
        return { eq: () => ({ select: () => ({ single: async () => ({ error: null }) }) }) };
      } };
    },
    rpc: async (name, payload) => { calls.push({ type: "rpc", name, payload }); return { data: null, error: null }; },
  };
  const withSkills = { ...profile, skills: ["Cleaning", "Handyman"] };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    mocks: { "@/lib/tags": {
      loadTagCatalog: async () => ({
        Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }, { id: "t3", name: "Kitchen", service_type: "Cleaning" }],
        Handyman: [{ id: "t2", name: "Plumbing", service_type: "Handyman" }],
      }),
      MAX_PROFILE_TAGS: 8,
    } },
  });
  app.render({ profile: withSkills }); await flush();
  let tree = app.render({ profile: withSkills });
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  chip("Handyman").props.onClick(); // deselect a skill that had a specialization
  tree = app.render({ profile: withSkills });
  chip("Kitchen").props.onClick(); // add a second specialization to the remaining skill
  tree = app.render({ profile: withSkills });
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });

  const rpcCalls = calls.filter((c) => c.type === "rpc");
  const profileUpdateIndex = calls.findIndex((c) => c.type === "profile-update");
  assert.equal(rpcCalls.length, 2, "one clear call for the deselected skill, one sync call for the remaining skill");
  assert.equal(rpcCalls[0].payload.p_service_type, "Handyman");
  assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls[0].payload.p_tag_ids)), [], "deselected skill's specializations are cleared");
  assert.ok(calls.indexOf(rpcCalls[0]) < profileUpdateIndex, "clearing happens before the skill is actually removed from the database, while it's still valid");
  assert.equal(rpcCalls[1].payload.p_service_type, "Cleaning");
  assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls[1].payload.p_tag_ids)).sort(), ["t1", "t3"], "remaining skill's specializations (existing + newly added) are saved");
  assert.ok(calls.indexOf(rpcCalls[1]) > profileUpdateIndex, "syncing the remaining skill happens after the profile update confirms it");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[profileUpdateIndex].payload)), { username: profile.username, skills: ["Cleaning"], services: profile.services });
});

test("Profile Save reports a distinct message when the profile saves but specialization sync fails afterward", async () => {
  const client = {
    from(table) {
      if (table === "profile_tags") return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      return { update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ error: null }) }) }) }) };
    },
    rpc: async () => ({ data: null, error: new Error("network blip") }),
  };
  const withSkill = { ...profile, skills: ["Cleaning"] };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({ Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }] }), MAX_PROFILE_TAGS: 8 } },
  });
  app.render({ profile: withSkill }); await flush();
  let tree = app.render({ profile: withSkill });
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  tree = app.render({ profile: withSkill });
  assert.equal(nodes(tree, (node) => node.props.role === "alert" && /profile saved/i.test(node.props.children)).length, 1, "distinguishes a partial failure from a full failure");
  assert.equal(nodes(tree, (node) => node.props.role === "status").length, 0, "does not also show a misleading success message");
});

function profileTagsOnlyClient(rpcCalls) {
  return {
    from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) },
    rpc: async (name, payload) => { rpcCalls.push({ name, payload }); return { data: null, error: null }; },
  };
}

test("Profile helper location starts empty and shows no opt-out control until a profile has ever opted in", async () => {
  const client = profileTagsOnlyClient([]);
  const withSkillNoLocation = { ...profile, skills: ["Cleaning"], public_location_text: null, public_lat: null, public_lng: null };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client, mocks: { "@/lib/tags": { loadTagCatalog: async () => ({}), MAX_PROFILE_TAGS: 8 } },
  });
  app.render({ profile: withSkillNoLocation }); await flush();
  const tree = app.render({ profile: withSkillNoLocation });
  const areaInput = nodes(tree, (node) => node.type === "input" && node.props.placeholder === "Neighborhood, ZIP or city")[0];
  assert.equal(areaInput.props.value, "", "helper location is never silently pre-filled for an existing profile that hasn't opted in");
  assert.equal(button(tree, "Opt out"), undefined, "no opt-out control shown when nothing has ever been opted into");
});

test("Profile helper location: saving calls set_helper_location with the entered area", async () => {
  const rpcCalls = [];
  const client = profileTagsOnlyClient(rpcCalls);
  const withSkill = { ...profile, skills: ["Cleaning"], public_location_text: null, public_lat: null, public_lng: null };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client, mocks: { "@/lib/tags": { loadTagCatalog: async () => ({}), MAX_PROFILE_TAGS: 8 } },
  });
  app.render({ profile: withSkill }); await flush();
  let tree = app.render({ profile: withSkill });
  const areaInput = nodes(tree, (node) => node.type === "input" && node.props.placeholder === "Neighborhood, ZIP or city")[0];
  areaInput.props.onChange({ target: { value: "Downtown" } });
  tree = app.render({ profile: withSkill });
  button(tree, "Save location").props.onClick();
  await flush();
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "set_helper_location");
  assert.equal(rpcCalls[0].payload.p_location_text, "Downtown");
  assert.equal(rpcCalls[0].payload.p_lat, null, "manual text entry without geolocation carries no coordinates");
  assert.equal(rpcCalls[0].payload.p_lng, null);
});

test("Profile helper location: opting out calls set_helper_location with all nulls", async () => {
  const rpcCalls = [];
  const client = profileTagsOnlyClient(rpcCalls);
  const withLocation = { ...profile, skills: ["Cleaning"], public_location_text: "Downtown", public_lat: 12.34, public_lng: -56.78 };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client, mocks: { "@/lib/tags": { loadTagCatalog: async () => ({}), MAX_PROFILE_TAGS: 8 } },
  });
  app.render({ profile: withLocation }); await flush();
  const tree = app.render({ profile: withLocation });
  assert.ok(button(tree, "Opt out"), "opt-out control appears once a location is already set");
  button(tree, "Opt out").props.onClick();
  await flush();
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "set_helper_location");
  assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls[0].payload)), { p_location_text: null, p_lat: null, p_lng: null });
});

test("Public profile displays specialization tags grouped by skill", async () => {
  const publicProfile = {
    id: "helper-1", username: "HelperOne", photo_url: null, skills: ["Cleaning", "Handyman"], wom_count: 4,
    profile_tags: [
      { tag: { id: "t1", name: "Deep Cleaning", service_type: "Cleaning" } },
      { tag: { id: "t2", name: "Plumbing", service_type: "Handyman" } },
    ],
  };
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: publicProfile, error: null }) }) }) }),
    rpc: async () => ({ data: [{ gigs_worked_count: 2, wom_count: 4 }], error: null }),
  };
  const app = await component("src/app/profile/[username]/page.tsx", "PublicProfileView", { client });
  app.render({ username: "HelperOne" }); await flush();
  const tree = app.render({ username: "HelperOne" });
  assert.equal(nodes(tree, (node) => node.type === "tag-chip" && node.props.children === "Deep Cleaning").length, 1);
  assert.equal(nodes(tree, (node) => node.type === "tag-chip" && node.props.children === "Plumbing").length, 1);
  assert.equal(nodes(tree, (node) => node.props.children === "Specializations").length, 1);
});

test("Public profile hides Specializations section for a legacy profile with no tags", async () => {
  const legacyProfile = { id: "helper-2", username: "Legacy", photo_url: null, skills: ["Cleaning"], wom_count: 1, profile_tags: [] };
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: legacyProfile, error: null }) }) }) }),
    rpc: async () => ({ data: [{ gigs_worked_count: 0, wom_count: 1 }], error: null }),
  };
  const app = await component("src/app/profile/[username]/page.tsx", "PublicProfileView", { client });
  app.render({ username: "Legacy" }); await flush();
  const tree = app.render({ username: "Legacy" });
  assert.equal(nodes(tree, (node) => node.props.children === "Specializations").length, 0, "no specialization section for a profile with skills but no tags");
  assert.equal(nodes(tree, (node) => node.type === "tag-chip").length, 0);
});

test("Browse chips select one existing category and All Services restores results", async () => {
  const gigs = ["Cleaning", "Other"].map((service_type) => ({ id: service_type, service_type, title: service_type, amount: 10 }));
  const client = { from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: gigs, error: null }) }) }) }) };
  const app = await component("src/app/browse/page.tsx", "BrowseInner", { client });
  app.render(); await flush();
  const chips = (tree) => nodes(tree, (node) => node.type === "selection-chip");
  const results = (tree) => nodes(tree, (node) => node.type === "a").map((node) => node.props.href);
  let tree = app.render();
  assert.equal(results(tree).length, 2);
  chips(tree)[1].props.onClick(); tree = app.render();
  assert.deepEqual(results(tree), ["/gigs/Cleaning"]);
  assert.equal(chips(tree).filter((node) => node.props.selected).length, 1);
  chips(tree)[0].props.onClick(); tree = app.render();
  assert.equal(results(tree).length, 2);
});

test("Browse tag filter appears after choosing a category and narrows results", async () => {
  const gigs = [
    { id: "g1", service_type: "Cleaning", title: "Deep clean", amount: 10, gig_tags: [{ tag: { id: "t-deep", name: "Deep Cleaning" } }] },
    { id: "g2", service_type: "Cleaning", title: "Kitchen only", amount: 12, gig_tags: [{ tag: { id: "t-kitchen", name: "Kitchen" } }] },
  ];
  const client = { from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: gigs, error: null }) }) }) }) };
  const app = await component("src/app/browse/page.tsx", "BrowseInner", {
    client,
    mocks: { "@/lib/tags": {
      loadTagCatalog: async () => ({ Cleaning: [{ id: "t-deep", name: "Deep Cleaning", service_type: "Cleaning" }, { id: "t-kitchen", name: "Kitchen", service_type: "Cleaning" }] }),
      gigTagNames: (g) => (g.gig_tags ?? []).map((l) => l.tag.name),
    } },
  });
  app.render(); await flush();
  let tree = app.render();
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  const results = () => nodes(tree, (node) => node.type === "a").map((node) => node.props.href);
  assert.equal(nodes(tree, (node) => node.type === "selection-chip" && node.props.children === "Deep Cleaning").length, 0, "no tag filter before a category is chosen");
  assert.equal(results().length, 2);
  chip("Cleaning").props.onClick();
  tree = app.render();
  assert.ok(chip("Deep Cleaning"), "tag filter appears once a category is selected");
  assert.equal(results().length, 2, "selecting a category alone does not yet narrow by tag");
  chip("Deep Cleaning").props.onClick();
  tree = app.render();
  assert.deepEqual(results(), ["/gigs/g1"], "selecting a tag narrows to matching gigs");
});

function helperClient(profiles) {
  return { from: () => ({ select: () => ({ contains: (_column, value) => ({
    then: (resolve, reject) => Promise.resolve({ data: profiles.filter((p) => p.skills.includes(value[0])), error: null }).then(resolve, reject),
  }) }) }) };
}
const helperTagsMock = { profileTagsForCategory: (profile, category) => (profile.profile_tags ?? []).map((link) => link.tag).filter((tag) => tag.service_type === category) };
// HelperCard is a locally-defined component used via JSX (<HelperCard .../>);
// this harness never auto-invokes custom function components (only host
// elements and pre-mocked string types), so — same workaround already used
// for my-gigs' GigRow/Bucketed — assert on the un-invoked element's own
// props rather than descending into its rendered output.
const helperUsernames = (tree) => nodes(tree, (node) => node.props?.profile?.username).map((node) => node.props.profile.username);

test("Find a Helper requires a category before showing tags or results", async () => {
  const app = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client: helperClient([]),
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({ Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }] }), ...helperTagsMock } },
  });
  app.render(); await flush();
  const tree = app.render();
  assert.equal(nodes(tree, (node) => node.type === "selection-chip" && node.props.children === "Deep Cleaning").length, 0, "no tag filter before a category is chosen");
  assert.equal(helperUsernames(tree).length, 0, "no results before a category is chosen");
  assert.equal(nodes(tree, (node) => node.props.children === "Choose a category to see nearby helpers.").length, 1);
});

test("Find a Helper matches on category alone when no tag filter is selected, including legacy helpers with no tags", async () => {
  const profiles = [
    { id: "a", username: "HelperA", photo_url: null, skills: ["Cleaning"], wom_count: 3, profile_tags: [{ tag: { id: "t1", name: "Deep Cleaning", service_type: "Cleaning" } }] },
    { id: "c", username: "HelperC", photo_url: null, skills: ["Cleaning"], wom_count: 5, profile_tags: [] },
  ];
  const app = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client: helperClient(profiles),
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({ Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }] }), ...helperTagsMock } },
  });
  app.render(); await flush();
  let tree = app.render();
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  chip("Cleaning").props.onClick();
  tree = app.render(); await flush();
  tree = app.render();
  assert.deepEqual(helperUsernames(tree).sort(), ["HelperA", "HelperC"], "every category-matching helper shown, including one with no specialization tags");
  assert.equal(nodes(tree, (node) => node.props.children === "Matching specializations").length, 0, "no partition heading when no tag filter is active");
});

test("Find a Helper partitions matching specializations from legacy fallback helpers, excluding non-matching specialists", async () => {
  const catalog = { Cleaning: [
    { id: "t1", name: "Deep Cleaning", service_type: "Cleaning" },
    { id: "t2", name: "Kitchen", service_type: "Cleaning" },
    { id: "t3", name: "Bathroom", service_type: "Cleaning" },
  ] };
  const profiles = [
    { id: "a", username: "HelperA", photo_url: null, skills: ["Cleaning"], wom_count: 3, profile_tags: [{ tag: catalog.Cleaning[0] }] },
    { id: "b", username: "HelperB", photo_url: null, skills: ["Cleaning"], wom_count: 1, profile_tags: [{ tag: catalog.Cleaning[1] }] },
    { id: "c", username: "HelperC", photo_url: null, skills: ["Cleaning"], wom_count: 5, profile_tags: [] },
    { id: "d", username: "HelperD", photo_url: null, skills: ["Cleaning"], wom_count: 0, profile_tags: [{ tag: catalog.Cleaning[2] }] },
  ];
  const app = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client: helperClient(profiles),
    mocks: { "@/lib/tags": { loadTagCatalog: async () => catalog, ...helperTagsMock } },
  });
  app.render(); await flush();
  let tree = app.render();
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  chip("Cleaning").props.onClick();
  tree = app.render(); await flush();
  tree = app.render();
  chip("Deep Cleaning").props.onClick();
  tree = app.render();
  assert.equal(nodes(tree, (node) => node.props.children === "Matching specializations").length, 1);
  // JSX interpolation ("Other {category} helpers") splits into an array of parts, not one string.
  assert.equal(nodes(tree, (node) => Array.isArray(node.props.children) && node.props.children.join("") === "Other Cleaning helpers").length, 1);
  assert.deepEqual(helperUsernames(tree), ["HelperA", "HelperC"], "matching specialist and legacy fallback shown; non-matching specialist (HelperB, HelperD) excluded entirely");
});

test("Find a Helper clears tag selection and re-queries when the category changes", async () => {
  const cleaningProfiles = [{ id: "a", username: "HelperA", photo_url: null, skills: ["Cleaning"], wom_count: 1, profile_tags: [] }];
  const otherProfiles = [{ id: "b", username: "HelperB", photo_url: null, skills: ["Other"], wom_count: 2, profile_tags: [] }];
  const client = helperClient([...cleaningProfiles, ...otherProfiles]);
  const app = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client,
    mocks: { "@/lib/tags": {
      loadTagCatalog: async () => ({
        Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }],
        Other: [{ id: "t2", name: "Errand", service_type: "Other" }],
      }),
      ...helperTagsMock,
    } },
  });
  app.render(); await flush();
  let tree = app.render();
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  chip("Cleaning").props.onClick();
  tree = app.render(); await flush();
  tree = app.render();
  assert.deepEqual(helperUsernames(tree), ["HelperA"]);

  chip("Other").props.onClick();
  tree = app.render(); await flush();
  tree = app.render();
  assert.equal(nodes(tree, (node) => node.type === "selection-chip" && node.props.children === "Deep Cleaning").length, 0, "previous category's tags are gone");
  assert.deepEqual(helperUsernames(tree), ["HelperB"], "results re-queried for the new category");
});

const originLocationMock = { loadJourneyLocation: () => ({ text: "Origin", lat: 0, lng: 0 }), haversineKm };

test("Find a Helper: Any distance (default) includes helpers with and without a public location", async () => {
  const profiles = [
    { id: "a", username: "NearHelper", photo_url: null, skills: ["Cleaning"], wom_count: 1, public_lat: 0.01, public_lng: 0, profile_tags: [] },
    { id: "b", username: "NoLocationHelper", photo_url: null, skills: ["Cleaning"], wom_count: 2, public_lat: null, public_lng: null, profile_tags: [] },
  ];
  const app = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client: helperClient(profiles),
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({}), ...helperTagsMock }, "@/lib/location": originLocationMock },
  });
  app.render(); await flush();
  let tree = app.render();
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  chip("Cleaning").props.onClick();
  tree = app.render(); await flush();
  tree = app.render();
  assert.deepEqual(helperUsernames(tree).sort(), ["NearHelper", "NoLocationHelper"], "Any distance shows every category match regardless of location, unchanged from before this feature");
});

test("Find a Helper distance filter narrows by 5/10/25 km boundaries, excludes helpers without a public location, and sorts nearest-first", async () => {
  const kmPerDegLat = haversineKm(0, 0, 1, 0);
  const at = (km) => km / kmPerDegLat;
  const profiles = [
    { id: "near", username: "Near4km", photo_url: null, skills: ["Cleaning"], wom_count: 1, public_lat: at(4), public_lng: 0, profile_tags: [] },
    { id: "mid", username: "Mid9km", photo_url: null, skills: ["Cleaning"], wom_count: 1, public_lat: at(9), public_lng: 0, profile_tags: [] },
    { id: "far", username: "Far24km", photo_url: null, skills: ["Cleaning"], wom_count: 1, public_lat: at(24), public_lng: 0, profile_tags: [] },
    { id: "beyond", username: "Beyond26km", photo_url: null, skills: ["Cleaning"], wom_count: 1, public_lat: at(26), public_lng: 0, profile_tags: [] },
    { id: "none", username: "NoLocation", photo_url: null, skills: ["Cleaning"], wom_count: 1, public_lat: null, public_lng: null, profile_tags: [] },
  ];
  const app = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client: helperClient(profiles),
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({}), ...helperTagsMock }, "@/lib/location": originLocationMock },
  });
  app.render(); await flush();
  let tree = app.render();
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  chip("Cleaning").props.onClick();
  tree = app.render(); await flush();
  tree = app.render();
  assert.deepEqual(helperUsernames(tree).sort(), ["Beyond26km", "Far24km", "Mid9km", "Near4km", "NoLocation"], "Any distance still includes everyone");

  const select = () => nodes(tree, (node) => node.type === "select")[0];
  select().props.onChange({ target: { value: "5" } });
  tree = app.render();
  assert.deepEqual(helperUsernames(tree), ["Near4km"], "5 km radius includes only the 4 km helper; excludes the one with no location entirely (not just from the radius)");

  select().props.onChange({ target: { value: "10" } });
  tree = app.render();
  assert.deepEqual(helperUsernames(tree), ["Near4km", "Mid9km"], "10 km radius adds the 9 km helper, nearest-first order");

  select().props.onChange({ target: { value: "25" } });
  tree = app.render();
  assert.deepEqual(helperUsernames(tree), ["Near4km", "Mid9km", "Far24km"], "25 km radius adds the 24 km helper but excludes the 26 km one");
});

test("Find a Helper combines category, tag, and distance filters together", async () => {
  const catalog = { Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }] };
  const profiles = [
    { id: "a", username: "NearSpecialist", photo_url: null, skills: ["Cleaning"], wom_count: 1, public_lat: 0.01, public_lng: 0, profile_tags: [{ tag: catalog.Cleaning[0] }] },
    { id: "b", username: "FarSpecialist", photo_url: null, skills: ["Cleaning"], wom_count: 1, public_lat: 1, public_lng: 0, profile_tags: [{ tag: catalog.Cleaning[0] }] },
    { id: "c", username: "NearLegacy", photo_url: null, skills: ["Cleaning"], wom_count: 1, public_lat: 0.02, public_lng: 0, profile_tags: [] },
  ];
  const app = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client: helperClient(profiles),
    mocks: { "@/lib/tags": { loadTagCatalog: async () => catalog, ...helperTagsMock }, "@/lib/location": originLocationMock },
  });
  app.render(); await flush();
  let tree = app.render();
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  chip("Cleaning").props.onClick();
  tree = app.render(); await flush();
  tree = app.render();
  chip("Deep Cleaning").props.onClick();
  tree = app.render();
  nodes(tree, (node) => node.type === "select")[0].props.onChange({ target: { value: "10" } });
  tree = app.render();
  assert.deepEqual(helperUsernames(tree), ["NearSpecialist", "NearLegacy"], "within radius: matching specialist first, legacy fallback still included; far specialist (111 km away) and radius-excluded helpers are gone");
});

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
      if (table === "profile_tags") return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
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

test("Post category chips select Cleaning, submit its unchanged value, and restore pending selection", async () => {
  const calls = [], values = new Map();
  const options = {
    client: { rpc: async (name, payload) => { calls.push({ name, payload }); return { data: { id: "created", status: "active" }, error: null }; } },
    storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    mocks: { "@/lib/location": { loadJourneyLocation: () => ({ text: "Test city", lat: null, lng: null }) } },
  };
  const app = await component("src/app/post/page.tsx", "PostGigForm", options);
  const chips = (tree) => nodes(tree, (node) => node.type === "selection-chip");
  let tree = app.render();
  chips(tree)[1].props.onClick(); tree = app.render();
  assert.equal(chips(tree).filter((node) => node.props.selected).length, 1);
  chips(tree)[0].props.onClick(); tree = app.render();
  assert.equal(chips(tree).find((node) => node.props.selected).props.children, "Cleaning");
  assert.equal(nodes(tree, (node) => node.type === "select").length, 0);
  for (const [predicate, value] of [
    [(node) => node.type === "input" && node.props.maxLength === 120, "Test gig"],
    [(node) => node.type === "textarea", "Test description"],
    [(node) => node.props.type === "number", "10"],
    [(node) => node.props.type === "datetime-local", new Date(Date.now() + 86400000).toISOString().slice(0, 16)],
  ]) nodes(tree, predicate)[0].props.onChange({ target: { value } });
  tree = app.render(); button(tree, "Post Gig").props.onClick(); await flush();
  assert.equal(calls[0].name, "create_gig");
  assert.equal(calls[0].payload.p_service_type, "Cleaning");
  values.set(`esg:post:${user.id}`, JSON.stringify(calls[0].payload));
  const restored = await component("src/app/post/page.tsx", "PostGigForm", options);
  tree = restored.render();
  assert.equal(chips(tree).find((node) => node.props.selected).props.children, "Cleaning");
  assert.equal(nodes(tree, (node) => node.type === "fieldset")[0].props.disabled, true);
});

test("Post Gig tag chips load for the category, toggle, clear on category change, and submit selected ids", async () => {
  const calls = [];
  const tagsByCategory = {
    Cleaning: [{ id: "t-deep", name: "Deep Cleaning", service_type: "Cleaning" }, { id: "t-kitchen", name: "Kitchen", service_type: "Cleaning" }],
    Other: [{ id: "t-errand", name: "Errand", service_type: "Other" }],
  };
  const values = new Map();
  const app = await component("src/app/post/page.tsx", "PostGigForm", {
    client: { rpc: async (name, payload) => { calls.push({ name, payload }); return { data: { id: "created", status: "active" }, error: null }; } },
    storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    mocks: {
      "@/lib/location": { loadJourneyLocation: () => ({ text: "Test city", lat: null, lng: null }) },
      "@/lib/tags": { loadTagCatalog: async () => tagsByCategory, gigTagNames: () => [], MAX_GIG_TAGS: 8 },
    },
  });
  app.render(); await flush();
  let tree = app.render();
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  assert.ok(chip("Deep Cleaning"), "tag chips render for the default (first) category");
  chip("Deep Cleaning").props.onClick();
  tree = app.render();
  assert.equal(chip("Deep Cleaning").props.selected, true);

  chip("Other").props.onClick();
  tree = app.render();
  assert.equal(nodes(tree, (node) => node.type === "selection-chip" && node.props.children === "Deep Cleaning").length, 0, "changing category clears incompatible tags from view");
  assert.ok(chip("Errand"), "tag set swaps to the new category");
  chip("Errand").props.onClick();
  tree = app.render();
  assert.equal(chip("Errand").props.selected, true);

  for (const [predicate, value] of [
    [(node) => node.type === "input" && node.props.maxLength === 120, "Test gig"],
    [(node) => node.type === "textarea", "Test description"],
    [(node) => node.props.type === "number", "10"],
    [(node) => node.props.type === "datetime-local", new Date(Date.now() + 86400000).toISOString().slice(0, 16)],
  ]) nodes(tree, predicate)[0].props.onChange({ target: { value } });
  tree = app.render(); button(tree, "Post Gig").props.onClick(); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload.p_tag_ids)), ["t-errand"], "only the tag selected under the final category is submitted");
});

test("Post Gig tag selection is capped at MAX_GIG_TAGS", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, name: `Tag ${i}`, service_type: "Cleaning" }));
  const app = await component("src/app/post/page.tsx", "PostGigForm", {
    mocks: {
      "@/lib/location": { loadJourneyLocation: () => ({ text: "", lat: null, lng: null }) },
      "@/lib/tags": { loadTagCatalog: async () => ({ Cleaning: many }), gigTagNames: () => [], MAX_GIG_TAGS: 8 },
    },
  });
  app.render(); await flush();
  let tree = app.render();
  const tagChips = () => nodes(tree, (node) => node.type === "selection-chip" && typeof node.props.children === "string" && node.props.children.startsWith("Tag "));
  for (let i = 0; i < many.length; i++) {
    tagChips()[i].props.onClick();
    tree = app.render();
  }
  assert.equal(tagChips().filter((c) => c.props.selected).length, 8);
});

test("Post category arrow keys move selection and focus with wrapping", async () => {
  const app = await component("src/app/post/page.tsx", "PostGigForm", {
    mocks: { "@/lib/location": { loadJourneyLocation: () => ({ text: "", lat: null, lng: null }) } },
  });
  const chips = () => nodes(app.render(), (node) => node.type === "selection-chip");
  let focused, prevented = false;
  chips()[0].props.onKeyDown({ key: "ArrowLeft", preventDefault() { prevented = true; },
    currentTarget: { parentElement: { querySelectorAll: () => [0, 1].map((index) => ({ focus() { focused = index; } })) } } });
  assert.equal(prevented, true);
  assert.equal(focused, 1);
  assert.deepEqual(chips().map((node) => [node.props.selected, node.props.tabIndex]), [[false, -1], [true, 0]]);
});

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

test("I Need Help offers Post a Gig and Find a Helper as real links", async () => {
  const app = await component("src/app/need-help/page.tsx", "NeedHelp");
  const tree = app.render();
  const links = nodes(tree, (node) => node.type === "a");
  assert.deepEqual(links.map((link) => link.props.href), ["/post", "/find-helper"]);
  assert.equal(nodes(tree, (node) => node.props.children === "Find a Helper").length, 1);
  assert.equal(nodes(tree, (node) => node.props.children === "Coming soon").length, 0);
  assert.equal(nodes(tree, (node) => node.props["aria-disabled"] === "true").length, 0);
});

test("Help & Earn Money passes rounded current coordinates to Browse", async () => {
  const destinations = [], locations = [], lookups = [];
  const app = await component("src/app/location/page.tsx", "LocationEntryInner", {
    storage: { setItem: (_key, value) => locations.push(JSON.parse(value)) },
    globals: { navigator: { geolocation: { getCurrentPosition: (success) => success({ coords: { latitude: 12.345, longitude: -45.678 } }) } } },
    mocks: {
      "@/lib/location": { LOCATION_KEY: "esg:general-area", reverseGeocodeGeneralArea: async (lat, lng) => { lookups.push({ lat, lng }); return "Kävlinge, Sweden"; } },
      "next/navigation": { useSearchParams: () => new URLSearchParams({ journey: "earn_money" }), useRouter: () => ({ push: (url) => destinations.push(url) }) },
    },
  });
  let tree = app.render();
  button(tree, "📍 Use My Location").props.onClick();
  tree = app.render();
  assert.equal(button(tree, "Finding your location…").props.disabled, true);
  await flush();
  tree = app.render(); button(tree, "Continue").props.onClick();
  tree = app.render(); nodes(tree, (node) => node.props["aria-label"] === "Help & Earn Money")[0].props.onClick();
  assert.deepEqual(destinations, ["/browse?lat=12.35&lng=-45.68"]);
  assert.deepEqual(lookups, [{ lat: 12.35, lng: -45.68 }]);
  assert.deepEqual(locations, [{ text: "Kävlinge, Sweden", lat: 12.35, lng: -45.68 }]);
});

test("reverse-geocoding failure keeps coordinates and the Current location fallback", async () => {
  const locations = [];
  const app = await component("src/app/location/page.tsx", "LocationEntryInner", {
    storage: { setItem: (_key, value) => locations.push(JSON.parse(value)) },
    globals: { navigator: { geolocation: { getCurrentPosition: (success) => success({ coords: { latitude: 55.789, longitude: 13.114 } }) } } },
    mocks: {
      "@/lib/location": { LOCATION_KEY: "esg:general-area", reverseGeocodeGeneralArea: async () => { throw new Error("offline"); } },
      "next/navigation": { useRouter: () => ({ push() {} }) },
    },
  });
  let tree = app.render();
  button(tree, "📍 Use My Location").props.onClick();
  await flush();
  tree = app.render();
  assert.equal(nodes(tree, (node) => node.type === "input")[0].props.value, "Current location");
  button(tree, "Continue").props.onClick();
  assert.deepEqual(locations, [{ text: "Current location", lat: 55.79, lng: 13.11 }]);
});

test("geolocation denial preserves manual location entry", async () => {
  const locations = [];
  const app = await component("src/app/location/page.tsx", "LocationEntryInner", {
    storage: { setItem: (_key, value) => locations.push(JSON.parse(value)) },
    globals: { navigator: { geolocation: { getCurrentPosition: (_success, failure) => failure() } } },
    mocks: {
      "@/lib/location": { LOCATION_KEY: "esg:general-area", reverseGeocodeGeneralArea: async () => null },
      "next/navigation": { useRouter: () => ({ push() {} }) },
    },
  });
  let tree = app.render();
  button(tree, "📍 Use My Location").props.onClick();
  tree = app.render();
  assert.equal(nodes(tree, (node) => node.props.children === "Location permission denied. Enter a location manually below.").length, 1);
  nodes(tree, (node) => node.type === "input")[0].props.onChange({ target: { value: "Lund, Sweden" } });
  tree = app.render(); button(tree, "Continue").props.onClick();
  assert.deepEqual(locations, [{ text: "Lund, Sweden" }]);
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
  app.auth.user = null;
  const tree = app.render();
  assert.equal(nodes(tree, (node) => node.props.href === "/auth/forgot-password").length, 1);
});

test("logged-out protected journey redirects to Sign In with a safe next", async () => {
  const destinations = [];
  const app = await component("src/components/AuthGuard.tsx", "AuthGuardInner", {
    mocks: { "next/navigation": {
      usePathname: () => "/location",
      useSearchParams: () => new URLSearchParams(),
      useRouter: () => ({ replace: (url) => destinations.push(url) }),
    } },
  });
  app.auth.user = null; app.auth.profile = null;
  app.render({ children: { type: "location" } });
  assert.deepEqual(destinations, ["/auth/sign-in?next=%2Flocation"]);
});

test("authenticated Sign In uses validated next and never renders the form", async () => {
  const destinations = [];
  const app = await component("src/app/auth/sign-in/page.tsx", "SignInInner", {
    client: { auth: {} },
    mocks: { "next/navigation": {
      useSearchParams: () => new URLSearchParams({ next: "/location" }),
      useRouter: () => ({ replace: (url) => destinations.push(url) }),
    } },
  });
  const tree = app.render();
  assert.deepEqual(destinations, ["/location"]);
  assert.equal(nodes(tree, (node) => node.type === "form").length, 0);
});

test("authenticated Sign Up defaults to Location", async () => {
  const destinations = [];
  const app = await component("src/app/auth/sign-up/page.tsx", "SignUpInner", {
    client: {},
    mocks: { "next/navigation": {
      useSearchParams: () => new URLSearchParams(),
      useRouter: () => ({ replace: (url) => destinations.push(url) }),
    } },
  });
  const tree = app.render();
  assert.deepEqual(destinations, ["/location"]);
  assert.equal(nodes(tree, (node) => node.type === "form").length, 0);
});

test("auth-entry pages wait for session restoration before deciding", async () => {
  const destinations = [];
  const app = await component("src/app/auth/sign-in/page.tsx", "SignInInner", {
    client: { auth: {} },
    mocks: { "next/navigation": {
      useSearchParams: () => new URLSearchParams({ next: "/location" }),
      useRouter: () => ({ replace: (url) => destinations.push(url) }),
    } },
  });
  app.auth.loading = true; app.auth.user = null;
  let tree = app.render();
  assert.equal(nodes(tree, (node) => node.type === "form").length, 0);
  assert.deepEqual(destinations, []);
  app.auth.loading = false; app.auth.user = user;
  tree = app.render();
  assert.equal(nodes(tree, (node) => node.type === "form").length, 0);
  assert.deepEqual(destinations, ["/location"]);
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
