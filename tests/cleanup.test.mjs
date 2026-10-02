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
    "@/lib/location": { loadJourneyLocation: () => ({ text: "", lat: null, lng: null }), haversineKm, clearGeneralAreaState: () => {} },
    "@/lib/tags": {
      loadTagCatalog: async () => ({}),
      gigTagNames: (gig) => (gig.gig_tags ?? []).map((link) => link.tag.name),
      profileTagsForCategory: (profile, serviceType) => (profile.profile_tags ?? []).map((link) => link.tag).filter((tag) => tag.service_type === serviceType),
      MAX_GIG_TAGS: 8,
      MAX_PROFILE_TAGS: 8,
    },
    "@/components/AuthGuard": { default: "guard" },
    "@/components/SelectionChip": { default: "selection-chip" },
    "@/components/OptionSheet": { default: "option-sheet" },
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
// Profile specializations: removable chips in one place, added via a bottom sheet.
const editSpecializations = (tree) => nodes(tree, (node) => node.type === "button" && node.props["aria-label"] === "Add specializations")[0];
const removeSpecialization = (tree, name) => nodes(tree, (node) => node.type === "button" && node.props["aria-label"] === `Remove ${name}`)[0];
const specializationSheet = (tree) => nodes(tree, (node) => node.type === "option-sheet")[0];
const sheetRow = (tree, label) => nodes(specializationSheet(tree) ?? {}, (node) => node.type === "button" && node.props.role === "checkbox"
  && Array.isArray(node.props.children) && node.props.children[0]?.props?.children === label)[0];

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

test("Profile: selecting a skill immediately reveals the specializations section, whose Add opens a sheet of options, with no 'tag' wording", async () => {
  const client = { from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) } };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({ Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }] }), MAX_PROFILE_TAGS: 8 } },
  });
  app.render({ profile: { ...profile, skills: [] } }); await flush();
  let tree = app.render({ profile: { ...profile, skills: [] } });
  assert.equal(editSpecializations(tree), undefined, "no specializations section before a skill is selected");
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  chip("Cleaning").props.onClick();
  tree = app.render({ profile: { ...profile, skills: [] } });
  assert.ok(editSpecializations(tree), "the specializations section appears immediately, before saving");
  assert.equal(nodes(tree, (node) => node.props.children === "None added yet.").length, 1, "empty state until something is chosen");
  assert.equal(specializationSheet(tree).props.title, "What kind of cleaning?", "selecting the skill opens its options straight away");
  specializationSheet(tree).props.onClose();
  tree = app.render({ profile: { ...profile, skills: [] } });
  assert.equal(specializationSheet(tree), undefined, "closing the sheet leaves the skill selected");
  editSpecializations(tree).props.onClick();
  tree = app.render({ profile: { ...profile, skills: [] } });
  assert.equal(specializationSheet(tree).props.title, "Add specializations", "+ Add reopens options for all selected skills");
  assert.ok(sheetRow(tree, "Deep Cleaning"), "the option appears as a row in the sheet");

  const allText = nodes(tree, (node) => typeof node.props?.children === "string").map((node) => node.props.children).join(" ");
  assert.doesNotMatch(allText, /\btags?\b/i, "no 'tag' wording is shown to the user");
  assert.doesNotMatch(allText, /profile_tags/i);
});

test("Profile: each newly selected skill opens its own options sheet, and every pick lands in the one specializations section", async () => {
  const client = { from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) } };
  const catalog = {
    Cleaning: [{ id: "c1", name: "Deep Cleaning", service_type: "Cleaning" }],
    Other: [{ id: "o1", name: "Errands", service_type: "Other" }],
  };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client, mocks: { "@/lib/tags": { loadTagCatalog: async () => catalog, MAX_PROFILE_TAGS: 8 } },
  });
  const props = { profile: { ...profile, skills: [], services: [] } };
  app.render(props); await flush();
  let tree = app.render(props);
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];

  chip("Cleaning").props.onClick();
  tree = app.render(props);
  assert.equal(specializationSheet(tree).props.title, "What kind of cleaning?");
  assert.deepEqual(nodes(specializationSheet(tree), (node) => node.props.role === "group").map((node) => node.props["aria-label"]), ["Cleaning specializations"], "only that skill's options");
  sheetRow(tree, "Deep Cleaning").props.onClick();
  tree = app.render(props);
  specializationSheet(tree).props.onClose();
  tree = app.render(props);

  chip("Other").props.onClick();
  tree = app.render(props);
  assert.equal(specializationSheet(tree).props.title, "What kind of help?");
  assert.deepEqual(nodes(specializationSheet(tree), (node) => node.props.role === "group").map((node) => node.props["aria-label"]), ["Other specializations"], "the new skill's options, not the previous skill's");
  sheetRow(tree, "Errands").props.onClick();
  tree = app.render(props);
  specializationSheet(tree).props.onClose();
  tree = app.render(props);

  assert.equal(specializationSheet(tree), undefined);
  assert.ok(removeSpecialization(tree, "Deep Cleaning") && removeSpecialization(tree, "Errands"), "picks from both skills appear together in the specializations section");

  chip("Other").props.onClick(); // deselecting must not open a sheet
  tree = app.render(props);
  assert.equal(specializationSheet(tree), undefined, "deselecting a skill does not open anything");
});

test("Profile: deselecting the last skill with specializations hides the section and closes an open sheet", async () => {
  const client = { from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) } };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({ Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }] }), MAX_PROFILE_TAGS: 8 } },
  });
  const withSkill = { ...profile, skills: ["Cleaning"] };
  app.render({ profile: withSkill }); await flush();
  let tree = app.render({ profile: withSkill });
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  assert.ok(editSpecializations(tree), "specializations section present while the skill is selected");
  editSpecializations(tree).props.onClick();
  tree = app.render({ profile: withSkill });
  assert.ok(specializationSheet(tree), "sheet is open");
  chip("Cleaning").props.onClick();
  tree = app.render({ profile: withSkill });
  assert.equal(editSpecializations(tree), undefined, "section disappears once no selected skill has specializations");
  assert.equal(specializationSheet(tree), undefined, "an open sheet for a deselected skill closes");
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
  editSpecializations(tree).props.onClick();
  tree = app.render({ profile: withSkills });
  sheetRow(tree, "Kitchen").props.onClick(); // add a second specialization to the remaining skill
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
  nodes(tree, (node) => node.type === "input" && node.props.required === true)[0].props.onChange({ target: { value: "ChangedName1" } });
  tree = app.render({ profile: withSkill });
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

test("Profile helper location: current-location resolves to a locality, never the raw placeholder, and saves rounded coordinates", async () => {
  const rpcCalls = [];
  const lookups = [];
  const client = profileTagsOnlyClient(rpcCalls);
  const withSkill = { ...profile, skills: ["Cleaning"], public_location_text: null, public_lat: null, public_lng: null };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    globals: { navigator: { geolocation: { getCurrentPosition: (success) => success({ coords: { latitude: 55.789, longitude: 13.114 } }) } } },
    mocks: {
      "@/lib/tags": { loadTagCatalog: async () => ({}), MAX_PROFILE_TAGS: 8 },
      "@/lib/location": { reverseGeocodeGeneralArea: async (lat, lng) => { lookups.push({ lat, lng }); return "Kävlinge, Sweden"; } },
    },
  });
  app.render({ profile: withSkill }); await flush();
  let tree = app.render({ profile: withSkill });
  button(tree, "Use my current location").props.onClick();
  await flush();
  tree = app.render({ profile: withSkill });
  const areaInput = nodes(tree, (node) => node.type === "input" && node.props.placeholder === "Neighborhood, ZIP or city")[0];
  assert.equal(areaInput.props.value, "Kävlinge, Sweden", "the resolved locality fills the field, not a literal placeholder");
  assert.deepEqual(lookups, [{ lat: 55.79, lng: 13.11 }], "coordinates are rounded client-side before reverse geocoding, matching the rest of the app");
  button(tree, "Save location").props.onClick();
  await flush();
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "set_helper_location");
  assert.notEqual(rpcCalls[0].payload.p_location_text, "Current location", "the literal placeholder is never persisted as the area");
  assert.equal(rpcCalls[0].payload.p_location_text, "Kävlinge, Sweden");
  assert.equal(rpcCalls[0].payload.p_lat, 55.79, "coordinates are still passed through to the existing RPC, which rounds them again server-side");
  assert.equal(rpcCalls[0].payload.p_lng, 13.11);
});

test("Profile helper location: geolocation denial shows the required message and manual entry still works", async () => {
  const client = profileTagsOnlyClient([]);
  const withSkill = { ...profile, skills: ["Cleaning"], public_location_text: null, public_lat: null, public_lng: null };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    globals: { navigator: { geolocation: { getCurrentPosition: (_success, failure) => failure() } } },
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({}), MAX_PROFILE_TAGS: 8 } },
  });
  app.render({ profile: withSkill }); await flush();
  let tree = app.render({ profile: withSkill });
  button(tree, "Use my current location").props.onClick();
  tree = app.render({ profile: withSkill });
  assert.equal(nodes(tree, (node) => node.props.children === "We couldn't access your location. Enter your area manually.").length, 1);
  const areaInput = nodes(tree, (node) => node.type === "input" && node.props.placeholder === "Neighborhood, ZIP or city")[0];
  areaInput.props.onChange({ target: { value: "Malmö" } });
  tree = app.render({ profile: withSkill });
  assert.equal(nodes(tree, (node) => node.type === "input" && node.props.placeholder === "Neighborhood, ZIP or city")[0].props.value, "Malmö");
});

test("Profile helper location: reverse-geocoding failure never falls back to the literal placeholder and permits manual entry", async () => {
  const rpcCalls = [];
  const client = profileTagsOnlyClient(rpcCalls);
  const withSkill = { ...profile, skills: ["Cleaning"], public_location_text: null, public_lat: null, public_lng: null };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    globals: { navigator: { geolocation: { getCurrentPosition: (success) => success({ coords: { latitude: 55.789, longitude: 13.114 } }) } } },
    mocks: {
      "@/lib/tags": { loadTagCatalog: async () => ({}), MAX_PROFILE_TAGS: 8 },
      "@/lib/location": { reverseGeocodeGeneralArea: async () => { throw new Error("offline"); } },
    },
  });
  app.render({ profile: withSkill }); await flush();
  let tree = app.render({ profile: withSkill });
  button(tree, "Use my current location").props.onClick();
  await flush();
  tree = app.render({ profile: withSkill });
  const areaInput = nodes(tree, (node) => node.type === "input" && node.props.placeholder === "Neighborhood, ZIP or city")[0];
  assert.equal(areaInput.props.value, "", "coordinates alone never populate the literal 'Current location' placeholder");
  assert.equal(nodes(tree, (node) => node.props.children === "Couldn't determine your area automatically. Enter it manually.").length, 1);
  areaInput.props.onChange({ target: { value: "Kävlinge" } });
  tree = app.render({ profile: withSkill });
  button(tree, "Save location").props.onClick();
  await flush();
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].payload.p_location_text, "Kävlinge", "the field remains editable and the manual entry is what gets saved");
});

test("Profile: existing profile values prepopulate the edit form", async () => {
  const client = { from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) } };
  const existing = { ...profile, username: "ExistingUser1", skills: ["Cleaning"], services: ["Other"] };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
  app.render({ profile: existing }); await flush();
  const tree = app.render({ profile: existing });
  const usernameInput = nodes(tree, (node) => node.type === "input" && node.props.required === true)[0];
  assert.equal(usernameInput.props.value, "ExistingUser1", "username is prepopulated from the existing profile");
  const chips = nodes(tree, (node) => node.type === "selection-chip");
  assert.deepEqual(chips.filter((node) => node.props.selected).map((node) => node.props.children), ["Cleaning", "Other"],
    "existing skills and services are preselected");
});

test("Profile: primary action is 'Update profile', shows 'Updating…' while saving, and the pending guard blocks a duplicate submit", async () => {
  const calls = [];
  const soloProfile = { ...profile, skills: [], services: [] };
  const client = {
    from: (table) => table === "profile_tags"
      ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
      : { update: (payload) => { calls.push(payload); return { eq: () => ({ select: () => ({ single: async () => ({ error: null }) }) }) }; } },
  };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
  app.render({ profile: soloProfile }); await flush();
  let tree = app.render({ profile: soloProfile });
  assert.ok(button(tree, "Update profile"), "primary action is labeled Update profile, not Save");
  nodes(tree, (node) => node.type === "input" && node.props.required === true)[0].props.onChange({ target: { value: "ChangedName1" } });
  tree = app.render({ profile: soloProfile });
  const submit = () => nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  const first = submit();
  const second = submit(); // fired before the first call's promise settles
  tree = app.render({ profile: soloProfile });
  assert.ok(button(tree, "Updating…"), "shows a distinct loading label while saving");
  assert.equal(nodes(tree, (node) => node.type === "fieldset")[0].props.disabled, true, "the form disables itself while saving");
  await Promise.all([first, second]);
  await flush();
  assert.equal(calls.length, 1, "the pending guard drops the duplicate submission");
  tree = app.render({ profile: soloProfile });
  assert.equal(nodes(tree, (node) => node.props.role === "status" && node.props.children === "Profile updated.").length, 1);
});

test("Profile specializations: every skill's choices appear together as removable chips; the sheet groups options by skill and locks a skill at its limit", async () => {
  const withSkills = { ...profile, skills: ["Cleaning", "Handyman"], services: ["Other"] };
  const client = {
    from: (table) => table === "profile_tags"
      ? { select: () => ({ eq: async () => ({ data: [["t1", "Cleaning"], ["t2", "Cleaning"], ["h1", "Handyman"]].map(([id, service_type]) => ({ tag: { id, service_type } })), error: null }) }) }
      : { update: () => ({}) },
  };
  const catalog = {
    Cleaning: ["Deep Cleaning", "Kitchen", "Windows"].map((name, i) => ({ id: `t${i + 1}`, name, service_type: "Cleaning" })),
    Handyman: [{ id: "h1", name: "Plumbing", service_type: "Handyman" }, { id: "h2", name: "Painting", service_type: "Handyman" }],
  };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    mocks: { "@/lib/tags": { loadTagCatalog: async () => catalog, MAX_PROFILE_TAGS: 2 } },
  });
  app.render({ profile: withSkills }); await flush();
  let tree = app.render({ profile: withSkills });
  for (const name of ["Deep Cleaning", "Kitchen", "Plumbing"]) assert.ok(removeSpecialization(tree, name), `${name} shows as a removable chip in the one section`);
  assert.equal(removeSpecialization(tree, "Windows"), undefined, "unselected options are not chips");

  editSpecializations(tree).props.onClick();
  tree = app.render({ profile: withSkills });
  assert.equal(nodes(specializationSheet(tree), (node) => node.props.role === "group").length, 2, "one group per skill inside a single sheet");
  assert.equal(specializationSheet(tree).props.footer.props.children[0].props.children.join(""), "3 selected");
  assert.equal(sheetRow(tree, "Windows").props.disabled, true, "Cleaning is at its limit of 2, so its unselected option locks");
  assert.equal(sheetRow(tree, "Painting").props.disabled, false, "Handyman is under its own limit");

  removeSpecialization(tree, "Kitchen").props.onClick();
  tree = app.render({ profile: withSkills });
  assert.equal(removeSpecialization(tree, "Kitchen"), undefined, "the x removes the chip");
  assert.equal(sheetRow(tree, "Windows").props.disabled, false, "freeing a slot unlocks the skill's other options");
});

test("Profile: Update profile is disabled and inert until something actually changes, and re-disables when changes are reverted", async () => {
  const calls = [];
  const withSkill = { ...profile, skills: ["Cleaning"], services: ["Other"] };
  const client = {
    from: (table) => table === "profile_tags"
      ? { select: () => ({ eq: async () => ({ data: [{ tag: { id: "t1", service_type: "Cleaning" } }], error: null }) }) }
      : { update: (payload) => { calls.push(payload); return { eq: () => ({ select: () => ({ single: async () => ({ error: null }) }) }) }; } },
    rpc: async () => ({ data: null, error: null }),
  };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({ Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }, { id: "t2", name: "Kitchen", service_type: "Cleaning" }] }), MAX_PROFILE_TAGS: 8 } },
  });
  app.render({ profile: withSkill }); await flush();
  let tree = app.render({ profile: withSkill });
  const update = () => button(tree, "Update profile");
  const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
  assert.equal(update().props.disabled, true, "nothing changed yet");
  const hint = () => nodes(tree, (node) => node.type === "p" && /changes/.test(String(node.props.children)))[0].props.children;
  assert.equal(hint(), "No changes yet.");
  assert.equal(nodes(tree, (node) => node.props.id === "username-hint").length, 1, "username rules are shown up front");
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls, [], "submitting an unchanged form (e.g. Enter key) saves nothing");

  const username = () => nodes(tree, (node) => node.type === "input" && node.props.required === true)[0];
  username().props.onChange({ target: { value: "ChangedName1" } });
  tree = app.render({ profile: withSkill });
  assert.equal(update().props.disabled, false, "a username change enables it");
  assert.equal(hint(), "You have unsaved changes.");
  username().props.onChange({ target: { value: withSkill.username } });
  tree = app.render({ profile: withSkill });
  assert.equal(update().props.disabled, true, "reverting the change disables it again");

  editSpecializations(tree).props.onClick();
  tree = app.render({ profile: withSkill });
  sheetRow(tree, "Kitchen").props.onClick();
  tree = app.render({ profile: withSkill });
  assert.equal(update().props.disabled, false, "a specialization change enables it");
  sheetRow(tree, "Kitchen").props.onClick();
  tree = app.render({ profile: withSkill });
  assert.equal(update().props.disabled, true);
  specializationSheet(tree).props.onClose();
  tree = app.render({ profile: withSkill });
  assert.equal(specializationSheet(tree), undefined, "Done/Escape/backdrop all close via onClose");

  chip("Other").props.onClick(); // first "Other" chip belongs to the skills group
  tree = app.render({ profile: withSkill });
  assert.equal(update().props.disabled, false, "a skill change enables it");
});

test("Profile Danger zone: Delete account opens a confirmation dialog, disabled until DELETE is typed exactly", async () => {
  const client = { from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) } };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
  app.render({ profile }); await flush();
  let tree = app.render({ profile });
  assert.equal(nodes(tree, (node) => node.props.role === "dialog").length, 0, "no dialog before Delete account is clicked");
  const trigger = nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account" && node.props.disabled === undefined)[0];
  trigger.props.onClick();
  tree = app.render({ profile });
  assert.equal(nodes(tree, (node) => node.props.role === "dialog").length, 1, "confirmation dialog opens");
  assert.equal(nodes(tree, (node) => node.props.children === "Delete your account?").length, 1);
  assert.equal(nodes(tree, (node) => node.props.children === "This action cannot be undone.").length, 1);
  const confirmButton = () => nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account" && node.props.disabled !== undefined)[0];
  assert.equal(confirmButton().props.disabled, true, "disabled until DELETE is typed");
  const input = nodes(tree, (node) => node.type === "input" && node.props.autoComplete === "off")[0];
  input.props.onChange({ target: { value: "delete" } });
  tree = app.render({ profile });
  assert.equal(confirmButton().props.disabled, true, "must match DELETE exactly (case-sensitive)");
  input.props.onChange({ target: { value: "DELETE" } });
  tree = app.render({ profile });
  assert.equal(confirmButton().props.disabled, false, "enabled once DELETE is typed exactly");
});

test("Profile Danger zone: Cancel closes the dialog without deleting anything", async () => {
  const calls = [];
  const client = {
    from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: (payload) => { calls.push(payload); return {}; } },
    rpc: async (name, payload) => { calls.push({ name, payload }); return { data: null, error: null }; },
  };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
  app.render({ profile }); await flush();
  let tree = app.render({ profile });
  const trigger = nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account" && node.props.disabled === undefined)[0];
  trigger.props.onClick();
  tree = app.render({ profile });
  const input = nodes(tree, (node) => node.type === "input" && node.props.autoComplete === "off")[0];
  input.props.onChange({ target: { value: "DELETE" } });
  tree = app.render({ profile });
  button(tree, "Cancel").props.onClick();
  tree = app.render({ profile });
  assert.equal(nodes(tree, (node) => node.props.role === "dialog").length, 0, "dialog closes");
  assert.equal(calls.length, 0, "no request of any kind was made");
});

test("Profile Danger zone: successful deletion signs out, clears ESG session state, and redirects home", async () => {
  const client = {
    from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) },
    auth: { signOut: async () => ({ error: null }) },
  };
  const destinations = [];
  const cleared = [];
  let fetchCalls = 0;
  let requestedUrl, requestedMethod;
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    globals: { fetch: async (url, init) => { fetchCalls++; requestedUrl = url; requestedMethod = init?.method; return { ok: true, json: async () => ({ ok: true }) }; } },
    mocks: {
      "next/navigation": { useRouter: () => ({ replace: (url) => destinations.push(url) }) },
      "@/lib/location": { reverseGeocodeGeneralArea: async () => null, clearGeneralAreaState: () => cleared.push("cleared") },
    },
  });
  app.render({ profile }); await flush();
  let tree = app.render({ profile });
  const trigger = nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account" && node.props.disabled === undefined)[0];
  trigger.props.onClick();
  tree = app.render({ profile });
  const input = nodes(tree, (node) => node.type === "input" && node.props.autoComplete === "off")[0];
  input.props.onChange({ target: { value: "DELETE" } });
  tree = app.render({ profile });
  const confirmButton = nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account" && node.props.disabled !== undefined)[0];
  confirmButton.props.onClick();
  await flush();
  assert.equal(fetchCalls, 1);
  assert.equal(requestedUrl, "/api/account/delete");
  assert.equal(requestedMethod, "POST");
  assert.deepEqual(destinations, ["/"], "redirects home after successful deletion");
  assert.deepEqual(cleared, ["cleared"], "ESG-specific session state (general area, geocode cache) is cleared");
});

test("Profile Danger zone: backend failure shows the server's error, keeps the dialog open, and does not sign out or redirect", async () => {
  const client = { from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) },
    auth: { signOut: async () => { throw new Error("should not be called"); } } };
  const destinations = [];
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    globals: { fetch: async () => ({ ok: false, json: async () => ({ error: "Couldn't finish deleting your account. Please try again." }) }) },
    mocks: { "next/navigation": { useRouter: () => ({ replace: (url) => destinations.push(url) }) } },
  });
  app.render({ profile }); await flush();
  let tree = app.render({ profile });
  const trigger = nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account" && node.props.disabled === undefined)[0];
  trigger.props.onClick();
  tree = app.render({ profile });
  const input = nodes(tree, (node) => node.type === "input" && node.props.autoComplete === "off")[0];
  input.props.onChange({ target: { value: "DELETE" } });
  tree = app.render({ profile });
  const confirmButton = nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account" && node.props.disabled !== undefined)[0];
  confirmButton.props.onClick();
  await flush();
  tree = app.render({ profile });
  assert.equal(nodes(tree, (node) => node.props.role === "dialog").length, 1, "dialog stays open after a failure");
  assert.equal(nodes(tree, (node) => node.props.role === "alert" && node.props.children === "Couldn't finish deleting your account. Please try again.").length, 1);
  assert.deepEqual(destinations, [], "no redirect on failure");
});

test("Profile Danger zone: shows a 'Deleting…' loading state, disables Cancel while in flight, and a duplicate click issues only one request", async () => {
  const client = { from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) },
    auth: { signOut: async () => ({ error: null }) } };
  let fetchCalls = 0;
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    globals: { fetch: async () => { fetchCalls++; return { ok: true, json: async () => ({ ok: true }) }; } },
    mocks: { "next/navigation": { useRouter: () => ({ replace() {} }) }, "@/lib/location": { clearGeneralAreaState: () => {} } },
  });
  app.render({ profile }); await flush();
  let tree = app.render({ profile });
  const trigger = nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account" && node.props.disabled === undefined)[0];
  trigger.props.onClick();
  tree = app.render({ profile });
  const input = nodes(tree, (node) => node.type === "input" && node.props.autoComplete === "off")[0];
  input.props.onChange({ target: { value: "DELETE" } });
  tree = app.render({ profile });
  const confirmButton = () => nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account" && node.props.disabled !== undefined)[0];
  confirmButton().props.onClick();
  confirmButton().props.onClick(); // duplicate click before the first request settles
  tree = app.render({ profile });
  assert.ok(nodes(tree, (node) => node.type === "button" && node.props.children === "Deleting…")[0], "shows a distinct loading label while deleting");
  assert.equal(button(tree, "Cancel").props.disabled, true, "Cancel is disabled while deleting");
  await flush();
  assert.equal(fetchCalls, 1, "the pending guard drops the duplicate submission");
});

async function onboardingLocationStep(reverseGeocodeGeneralArea) {
  const lookups = [];
  const app = await component("src/components/ProfileSetup.tsx", "ProfileSetup", {
    client: {},
    globals: { navigator: { geolocation: { getCurrentPosition: (success) => success({ coords: { latitude: 55.789, longitude: 13.114 } }) } } },
    mocks: { "@/lib/location": { reverseGeocodeGeneralArea: async (lat, lng) => { lookups.push({ lat, lng }); return reverseGeocodeGeneralArea(); } } },
  });
  const props = { profile: { ...profile, private_location_text: null, private_lat: null, private_lng: null } };
  let tree = app.render(props);
  button(tree, "Continue").props.onClick();
  tree = app.render(props);
  return { app, props, lookups, tree };
}

test("Onboarding 'Use my current location' resolves to a locality, never the raw placeholder, and looks up only rounded coordinates", async () => {
  const { app, props, lookups, tree: initial } = await onboardingLocationStep(async () => "Kävlinge, Sweden");
  button(initial, "Use my current location").props.onClick();
  await flush();
  const tree = app.render(props);
  const area = nodes(tree, (node) => node.type === "input" && node.props.maxLength === 200)[0];
  assert.equal(area.props.value, "Kävlinge, Sweden");
  assert.deepEqual(lookups, [{ lat: 55.79, lng: 13.11 }], "the label lookup receives rounded coordinates, not the exact private ones");
});

test("Onboarding 'Use my current location': reverse-geocoding failure leaves the field empty for manual entry with a non-blocking message", async () => {
  const { app, props, tree: initial } = await onboardingLocationStep(async () => { throw new Error("offline"); });
  button(initial, "Use my current location").props.onClick();
  await flush();
  const tree = app.render(props);
  const area = nodes(tree, (node) => node.type === "input" && node.props.maxLength === 200)[0];
  assert.equal(area.props.value, "", "never falls back to the literal 'Current location'");
  assert.equal(nodes(tree, (node) => node.props.role === "status" && node.props.children === "Couldn't determine your area automatically. Enter it manually.").length, 1);
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

test("I Need Help offers Post a Gig and Find a Helper as real links, reachable with no session at all", async () => {
  const app = await component("src/app/need-help/page.tsx", "NeedHelp");
  app.auth.user = null; app.auth.profile = null;
  const tree = app.render();
  const links = nodes(tree, (node) => node.type === "a");
  assert.deepEqual(links.map((link) => link.props.href), ["/post", "/find-helper"]);
  assert.equal(nodes(tree, (node) => node.props.children === "Find a Helper").length, 1);
  assert.equal(nodes(tree, (node) => node.props.children === "Coming soon").length, 0);
  assert.equal(nodes(tree, (node) => node.props["aria-disabled"] === "true").length, 0);
});

test("Find a Helper and the public helper profile require no authentication -- no AuthGuard, no useAuth dependency", async () => {
  const findHelperSource = await readFile(new URL("../src/app/find-helper/page.tsx", import.meta.url), "utf8");
  const publicProfileSource = await readFile(new URL("../src/app/profile/[username]/page.tsx", import.meta.url), "utf8");
  for (const source of [findHelperSource, publicProfileSource]) {
    assert.doesNotMatch(source, /AuthGuard|useAuth/, "helper browsing and public profiles have no session/auth-guard dependency to gate them");
  }
});

test("Post a Gig, reached from I Need Help, requires authentication: unauthenticated visitors are sent to Sign In preserving next=/post", async () => {
  const destinations = [];
  const app = await component("src/components/AuthGuard.tsx", "AuthGuardInner", {
    mocks: { "next/navigation": {
      usePathname: () => "/post",
      useSearchParams: () => new URLSearchParams(),
      useRouter: () => ({ replace: (url) => destinations.push(url) }),
    } },
  });
  app.auth.user = null; app.auth.profile = null;
  app.render({ children: { type: "post-gig-form" } });
  assert.deepEqual(destinations, ["/auth/sign-in?next=%2Fpost"]);
});

test("Post a Gig: an authenticated but not-yet-onboarded visitor is routed through onboarding, preserving next=/post", async () => {
  const destinations = [];
  const app = await component("src/components/AuthGuard.tsx", "AuthGuardInner", {
    mocks: { "next/navigation": {
      usePathname: () => "/post",
      useSearchParams: () => new URLSearchParams(),
      useRouter: () => ({ replace: (url) => destinations.push(url) }),
    } },
  });
  app.auth.profile = { ...profile, onboarding_completed_at: null };
  app.render({ children: { type: "post-gig-form" } });
  assert.deepEqual(destinations, ["/onboarding?next=%2Fpost"], "onboarding preserves /post as the destination to return to, not a generic profile/home page");
});

test("Sign In with next=/post sends an already-authenticated user straight to Post a Gig, completing the round trip", async () => {
  const destinations = [];
  const app = await component("src/app/auth/sign-in/page.tsx", "SignInInner", {
    client: { auth: {} },
    mocks: { "next/navigation": {
      useSearchParams: () => new URLSearchParams({ next: "/post" }),
      useRouter: () => ({ replace: (url) => destinations.push(url) }),
    } },
  });
  app.render();
  assert.deepEqual(destinations, ["/post"]);
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

test("landing page: I Need Help and Help & Make Money are public links for every visitor, with no sign-in or onboarding detour", async () => {
  for (const state of [
    { user: null, profile: null },
    { user, profile: { ...profile, onboarding_completed_at: "2026-01-01" } },
    { user, profile: { ...profile, onboarding_completed_at: null } },
  ]) {
    const app = await component("src/app/page.tsx", "Home");
    app.auth.user = state.user; app.auth.profile = state.profile;
    const tree = app.render();
    assert.equal(nodes(tree, (node) => node.props.children === "I Need Help").length, 1);
    assert.equal(nodes(tree, (node) => node.props.children === "Help & Make Money" || (Array.isArray(node.props.children) && node.props.children.join("") === "Help & Make Money")).length, 1);
    const links = nodes(tree, (node) => node.type === "a").map((node) => node.props.href);
    assert.deepEqual(links.sort(), ["/browse", "/need-help"]);
    assert.equal(nodes(tree, (node) => node.props.children === "Sign In" || node.props.children === "Register" || node.props.children === "Create Account").length, 0);
  }
});

test("Browse is public but opening a gig requires authentication, preserving the gig as next", async () => {
  const browseSource = await readFile(new URL("../src/app/browse/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(browseSource, /AuthGuard|useAuth/, "browsing the gig list needs no session");
  const gigSource = await readFile(new URL("../src/app/gigs/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(gigSource, /<AuthGuard><GigDetails id=\{id\} \/><\/AuthGuard>/, "gig details are wrapped in AuthGuard");

  const gigPath = "/gigs/12345678-1234-1234-1234-123456789012";
  const destinations = [];
  const app = await component("src/components/AuthGuard.tsx", "AuthGuardInner", {
    mocks: { "next/navigation": {
      usePathname: () => gigPath,
      useSearchParams: () => new URLSearchParams(),
      useRouter: () => ({ replace: (url) => destinations.push(url) }),
    } },
  });
  app.auth.user = null; app.auth.profile = null;
  app.render({ children: { type: "gig-details" } });
  assert.deepEqual(destinations, [`/auth/sign-in?next=${encodeURIComponent(gigPath)}`]);
  assert.equal(safeNext(gigPath), gigPath, "the gig destination survives sign-in/registration via the existing next whitelist");
});

test("header shows a single Sign In action for unauthenticated users", async () => {
  const app = await component("src/components/Nav.tsx", "Nav", {
    client: { auth: { signOut: async () => ({ error: null }) } },
    mocks: {
      "@/components/NotificationsBell": { default: "notifications-bell" },
      "next/navigation": { usePathname: () => "/", useRouter: () => ({ replace() {} }) },
    },
  });
  app.auth.user = null; app.auth.profile = null;
  const tree = app.render();
  assert.deepEqual(nodes(tree, (node) => node.props.href === "/auth/sign-in").map((node) => node.props.children), ["Sign In"]);
  assert.equal(nodes(tree, (node) => node.props.children === "Log out").length, 0, "no authenticated-only actions leak into the logged-out header");
});

test("Sign In exposes the password-recovery route", async () => {
  const app = await component("src/app/auth/sign-in/page.tsx", "SignInInner", { client: { auth: {} } });
  app.auth.user = null;
  const tree = app.render();
  assert.equal(nodes(tree, (node) => node.props.href === "/auth/forgot-password").length, 1);
});

test("Sign In password field toggles between masked and visible via the Show/Hide control", async () => {
  const app = await component("src/app/auth/sign-in/page.tsx", "SignInInner", { client: { auth: {} } });
  app.auth.user = null;
  let tree = app.render();
  const passwordInput = () => nodes(tree, (node) => node.props.id === "signin-password")[0];
  assert.equal(passwordInput().props.type, "password", "password is masked by default");
  const toggle = () => nodes(tree, (node) => node.type === "button" && (node.props["aria-label"] === "Show password" || node.props["aria-label"] === "Hide password"))[0];
  assert.equal(toggle().props["aria-label"], "Show password");
  toggle().props.onClick();
  tree = app.render();
  assert.equal(passwordInput().props.type, "text", "clicking Show reveals the password");
  assert.equal(toggle().props["aria-label"], "Hide password");
  toggle().props.onClick();
  tree = app.render();
  assert.equal(passwordInput().props.type, "password", "clicking Hide masks it again");
});

test("Sign In shows 'New user? Register' and Register opens the existing signup flow, preserving next", async () => {
  const app = await component("src/app/auth/sign-in/page.tsx", "SignInInner", {
    client: { auth: {} },
    mocks: { "next/navigation": { useSearchParams: () => new URLSearchParams({ next: "/need-help" }), useRouter: () => ({ replace() {} }) } },
  });
  app.auth.user = null;
  const tree = app.render();
  assert.equal(nodes(tree, (node) => Array.isArray(node.props.children) && node.props.children.includes("New user?")).length, 1);
  const register = nodes(tree, (node) => node.props.children === "Register")[0];
  assert.ok(register, "Register link is present");
  assert.equal(register.props.href, "/auth/sign-up?next=%2Fneed-help", "Register reuses the existing signup flow and carries the selected journey through");
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

test("forgot-password requests a recovery link without exposing account existence, disabling submit while pending", async () => {
  const requests = [];
  let resolveRequest;
  const app = await component("src/app/auth/forgot-password/page.tsx", "ForgotPassword", {
    client: { auth: { resetPasswordForEmail: async (email, options) => {
      requests.push({ email, options });
      return new Promise((resolve) => { resolveRequest = () => resolve({ error: null }); });
    } } },
    globals: { window: { location: { origin: "http://localhost:3001" } } },
  });
  let tree = app.render();
  nodes(tree, (node) => node.props.id === "recovery-email")[0].props.onChange({ target: { value: "person@example.com" } });
  tree = app.render();
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  const submission = nodes(tree, (node) => node.type === "form")[0].props.onSubmit(event);
  assert.equal(button(app.render(), "Sending…").props.disabled, true, "submit is disabled while the request is pending");
  resolveRequest();
  await submission;
  tree = app.render();
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ email: "person@example.com", options: { redirectTo: "http://localhost:3001/auth/reset-password" } }]);
  assert.equal(nodes(tree, (node) => String(node.props.children).includes("If an ESG account uses that email")).length, 1);
  assert.equal(event.defaultPrevented, true);
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

test("signup callback exchanges a fresh code then redirects to onboarding with the requested destination", async () => {
  const calls = [], destinations = [];
  const app = await component("src/app/auth/callback/page.tsx", "CallbackInner", {
    client: { auth: {
      exchangeCodeForSession: async () => { calls.push("exchange"); return { error: null }; },
      getSession: async () => { calls.push("session"); return { data: { session: { user } }, error: null }; },
    } },
    globals: { window: {
      location: { href: "http://localhost:3001/auth/callback?next=%2Fprofile&code=fresh-test-code" },
      history: { replaceState: (_state, _title, url) => calls.push(url) },
    } },
    mocks: { "next/navigation": {
      useSearchParams: () => new URLSearchParams("next=%2Fprofile"),
      useRouter: () => ({ replace: (url) => destinations.push(url) }),
    } },
  });
  app.render(); await flush();
  assert.deepEqual(calls, ["exchange", "session", "/auth/callback?next=%2Fprofile"]);
  assert.deepEqual(destinations, ["/onboarding?next=%2Fprofile"]);
});

for (const flow of [
  { path: "callback", component: "CallbackInner", label: "signup" },
  { path: "reset-password", component: "ResetPassword", label: "recovery" },
]) {
  test(`${flow.label} provider errors are reported before URL cleanup and never attempt a PKCE exchange`, async () => {
    const app = await component(`src/app/auth/${flow.path}/page.tsx`, flow.component, {
      client: { auth: {
        exchangeCodeForSession: async () => { throw new Error("Exchange must not run"); },
        getSession: async () => { throw new Error("Session lookup must not run"); },
      } },
      globals: { window: {
        location: { href: `http://localhost:3001/auth/${flow.path}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` },
        history: { replaceState() {} },
      } },
    });
    app.render(); await flush();
    // If the code had wrongly attempted an exchange, the "must not run" mocks
    // above would surface as a *different* alert message than this one.
    assert.equal(nodes(app.render(), (node) => node.props.role === "alert" && /invalid or expired/i.test(String(node.props.children))).length, 1);
  });

  test(`${flow.label} PKCE exchange errors stop session lookup and navigation`, async () => {
    const destinations = [];
    const app = await component(`src/app/auth/${flow.path}/page.tsx`, flow.component, {
      client: { auth: {
        exchangeCodeForSession: async () => ({ error: { code: "bad_code_verifier", status: 400 } }),
        getSession: async () => { throw new Error("Session lookup must not run"); },
      } },
      globals: { window: {
        location: { href: `http://localhost:3001/auth/${flow.path}?code=fresh-failing-test-code` },
        history: { replaceState() {} },
      } },
      mocks: { "next/navigation": { useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: (url) => destinations.push(url) }) } },
    });
    app.render(); await flush();
    assert.deepEqual(destinations, [], "no navigation happens after an exchange failure");
    // If session lookup had wrongly run, the "must not run" mock above would
    // surface as a *different* alert message than this one.
    assert.equal(nodes(app.render(), (node) => node.props.role === "alert" && /expired/i.test(String(node.props.children))).length, 1);
  });

  test(`${flow.label} recognizes a hash error_code even without a plain error key, and never attempts a PKCE exchange`, async () => {
    const calls = [];
    const app = await component(`src/app/auth/${flow.path}/page.tsx`, flow.component, {
      client: { auth: {
        exchangeCodeForSession: async () => { throw new Error("Exchange must not run"); },
        getSession: async () => { throw new Error("Session lookup must not run"); },
      } },
      globals: { window: {
        location: { href: `http://localhost:3001/auth/${flow.path}#error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` },
        history: { replaceState: () => calls.push("clean") },
      } },
    });
    app.render(); await flush();
    assert.deepEqual(calls, ["clean"]);
    assert.equal(nodes(app.render(), (node) => node.props.role === "alert").length, 1);
  });
}
