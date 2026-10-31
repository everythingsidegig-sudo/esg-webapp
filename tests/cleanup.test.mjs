import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as myGigsLib from "../src/lib/my-gigs.ts";
import * as moneyLib from "../src/lib/money.ts";
import * as journeyLib from "../src/lib/journey.ts";
import * as areaSearchLib from "../src/lib/area-search.ts";
import * as zipLocationLib from "../src/lib/zip-location.ts";
import * as helperRequestLib from "../src/lib/helper-request.ts";
import * as profileSaveLib from "../src/lib/profile-save.ts";
import * as negotiationLib from "../src/lib/negotiation.ts";
import * as repostLib from "../src/lib/repost.ts";
import * as startFlowLib from "../src/lib/start-flow.ts";
import { safeNext } from "../src/lib/journey.ts";

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
    useCallback: (callback) => callback,
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
    // The whole real module: pages import new helpers from it as they are added.
    "@/lib/journey": journeyLib,
    "@/lib/location": { loadJourneyLocation: () => ({ text: "", lat: null, lng: null }), haversineKm, clearGeneralAreaState: () => {}, rememberAreaForAuth: () => false },
    "@/lib/tags": {
      loadTagCatalog: async () => ({}),
      gigTagNames: (gig) => (gig.gig_tags ?? []).map((link) => link.tag.name),
      withProfileTags: async (_supabase, rows) => rows,
      profileTagsForCategory: (profile, serviceType) => (profile.profile_tags ?? []).map((link) => link.tag).filter((tag) => tag.service_type === serviceType),
      MAX_GIG_TAGS: 8,
      MAX_PROFILE_TAGS: 8,
    },
    "@/components/AuthGuard": { default: "guard" },
    "@/components/SelectionChip": { default: "selection-chip" },
    "@/components/OptionSheet": { default: "option-sheet" },
    "@/components/CategoryList": { CategoryList: "category-list" },
    "@/lib/my-gigs": myGigsLib,
    "@/lib/money": moneyLib,
    // Pure helpers the location screens import (area search, ZIP lookup) -- the real modules, no network at import time.
    "@/lib/area-search": areaSearchLib,
    "@/lib/zip-location": zipLocationLib,
    "@/lib/helper-request": helperRequestLib,
    "@/lib/profile-save": profileSaveLib,
    "@/lib/negotiation": negotiationLib,
    "@/lib/repost": repostLib,
    "@/lib/start-flow": startFlowLib,
    "@/lib/area-lookup": { resolveAreaQuery: async () => ({ kind: "none" }) },
    "@/components/AreaPicker": { default: "area-picker" },
    "@/components/MapPicker": { default: "map-picker" },
    "@/components/RadiusSlider": { default: "radius-slider" },
    "@/components/HelperSignInPrompt": { default: "helper-signin-prompt" },
    "@/components/LogoutButton": { default: "logout-button" },
    "@/components/MessagesLink": { default: "messages-link" },
    "@/components/StatusBadge": { default: "badge" },
    "@/components/TagChip": { default: "tag-chip" },
    ...overrides.mocks,
  };
  const loadedModule = { exports: {} };
  runInNewContext(`(function(require, module, exports) { ${code}\n})`, { URL, URLSearchParams, console, crypto,
    // The journey location moved from sessionStorage to localStorage so it survives a new
    // sign-in; a test's single `storage` mock backs both, same as a real page only ever
    // reading/writing whichever one it actually calls.
    sessionStorage: overrides.storage, localStorage: overrides.storage,
    // Timers are inert unless a test supplies its own: debounced lookups never fire on their own.
    AbortController, setTimeout: () => 0, clearTimeout() {},
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
const textOf = (node) => [node?.props?.children].flat(Infinity)
  .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : child?.props ? textOf(child) : "")).join("");
const button = (tree, label) => nodes(tree, (node) => node.type === "button" && node.props.children === label)[0];
// Profile skills/services: the real category checkboxes/ALL/OTHER live inside
// CategoryList, which is opaque to this harness (like SelectionChip/OptionSheet) --
// tests drive it via its props directly, computing the toggled array themselves
// the way the real checkbox's onChange would.
const categoryList = (tree, title) => nodes(tree, (node) => node.type === "category-list" && node.props.title === title)[0];
const skillsList = (tree) => categoryList(tree, "Skills I can use to make money");
const servicesList = (tree) => categoryList(tree, "Services I might need");
function toggleCategory(list, item) {
  const current = list.props.selected;
  list.props.setSelected(current.includes(item) ? current.filter((c) => c !== item) : [...current, item]);
}
// Profile specializations: removable chips in one place, added via a bottom sheet.
const editSpecializations = (tree) => nodes(tree, (node) => node.type === "button" && node.props["aria-label"] === "Add specializations")[0];
const removeSpecialization = (tree, name) => nodes(tree, (node) => node.type === "button" && node.props["aria-label"] === `Remove ${name}`)[0];
const specializationSheet = (tree) => nodes(tree, (node) => node.type === "option-sheet")[0];
const sheetRow = (tree, label) => nodes(specializationSheet(tree) ?? {}, (node) => node.type === "button" && node.props.role === "checkbox"
  && Array.isArray(node.props.children) && node.props.children[0]?.props?.children === label)[0];

test("profile skills/services selections pass through to CategoryList, toggle independently, preserve a legacy value, and save the same arrays", async () => {
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
  // "Legacy skill" stands in for a stored value outside the master list
  // (e.g. pre-rename data) -- CategoryList only ever renders the official
  // categories, but the raw array must still pass through untouched.
  const original = { ...profile, skills: ["Cleaning", "Legacy skill"] };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
  let tree = app.render({ profile: original });
  assert.deepEqual(skillsList(tree).props.selected, ["Cleaning", "Legacy skill"]);
  assert.deepEqual(servicesList(tree).props.selected, ["Other"]);

  toggleCategory(skillsList(tree), "Cleaning"); // deselect
  tree = app.render({ profile: original });
  assert.deepEqual(skillsList(tree).props.selected, ["Legacy skill"], "deselecting one skill leaves the legacy value untouched");

  toggleCategory(skillsList(tree), "Handyman"); // select a different skill
  tree = app.render({ profile: original });
  assert.deepEqual(skillsList(tree).props.selected, ["Legacy skill", "Handyman"]);

  toggleCategory(servicesList(tree), "Other"); // deselect, independently of skills
  tree = app.render({ profile: original });
  assert.deepEqual(servicesList(tree).props.selected, []);

  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), {
    skills: ["Legacy skill", "Handyman"], services: [],   // no OTHER text columns: neither changed
  });
  const refreshed = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
  const refreshedTree = refreshed.render({ profile: { ...original, ...saved } });
  assert.deepEqual(skillsList(refreshedTree).props.selected, ["Legacy skill", "Handyman"], "a legacy value survives the save round-trip");
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
  toggleCategory(skillsList(tree), "Cleaning");
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

  toggleCategory(skillsList(tree), "Cleaning");
  tree = app.render(props);
  assert.equal(specializationSheet(tree).props.title, "What kind of cleaning?");
  assert.deepEqual(nodes(specializationSheet(tree), (node) => node.props.role === "group").map((node) => node.props["aria-label"]), ["Cleaning specializations"], "only that skill's options");
  sheetRow(tree, "Deep Cleaning").props.onClick();
  tree = app.render(props);
  specializationSheet(tree).props.onClose();
  tree = app.render(props);

  toggleCategory(skillsList(tree), "Other");
  tree = app.render(props);
  assert.equal(specializationSheet(tree).props.title, "What kind of help?");
  assert.deepEqual(nodes(specializationSheet(tree), (node) => node.props.role === "group").map((node) => node.props["aria-label"]), ["Other specializations"], "the new skill's options, not the previous skill's");
  sheetRow(tree, "Errands").props.onClick();
  tree = app.render(props);
  specializationSheet(tree).props.onClose();
  tree = app.render(props);

  assert.equal(specializationSheet(tree), undefined);
  assert.ok(removeSpecialization(tree, "Deep Cleaning") && removeSpecialization(tree, "Errands"), "picks from both skills appear together in the specializations section");

  toggleCategory(skillsList(tree), "Other"); // deselecting must not open a sheet
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
  assert.ok(editSpecializations(tree), "specializations section present while the skill is selected");
  editSpecializations(tree).props.onClick();
  tree = app.render({ profile: withSkill });
  assert.ok(specializationSheet(tree), "sheet is open");
  toggleCategory(skillsList(tree), "Cleaning");
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
  const withSkills = { ...profile, skills: ["Cleaning", "Handyman"], services: [] };
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
  toggleCategory(skillsList(tree), "Handyman"); // deselect a skill that had a specialization
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
  assert.deepEqual(JSON.parse(JSON.stringify(calls[profileUpdateIndex].payload)), {
    skills: ["Cleaning"], services: [],   // no OTHER text columns: neither changed
  });
});

test("Profile Save reports a distinct message when the profile saves but specialization sync fails afterward", async () => {
  const client = {
    from(table) {
      if (table === "profile_tags") return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      return { update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ error: null }) }) }) }) };
    },
    rpc: async () => ({ data: null, error: new Error("network blip") }),
  };
  const withSkill = { ...profile, skills: ["Cleaning"], services: [] };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({ Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }] }), MAX_PROFILE_TAGS: 8 } },
  });
  app.render({ profile: withSkill }); await flush();
  let tree = app.render({ profile: withSkill });
  toggleCategory(skillsList(tree), "Other");
  tree = app.render({ profile: withSkill });
  skillsList(tree).props.setOtherText("Something else");
  tree = app.render({ profile: withSkill });
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  tree = app.render({ profile: withSkill });
  assert.equal(nodes(tree, (node) => node.props.role === "alert" && /profile saved/i.test(node.props.children)).length, 1, "distinguishes a partial failure from a full failure");
  assert.equal(nodes(tree, (node) => node.props.role === "status").length, 0, "does not also show a misleading success message");
});

// ESG-SVC-001 v1.0 §5: OTHER's "please specify" text is mandatory exactly
// while OTHER is selected, for Skills and Services independently -- and this
// must be enforced before anything is sent, same as Registration.
test("Profile Save blocks selecting OTHER without specifying it, for skills and services independently", async () => {
  const calls = [];
  const client = {
    from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
      : { update: (payload) => { calls.push(payload); return { eq: () => ({ select: () => ({ single: async () => ({ error: null }) }) }) }; } },
    rpc: async () => ({ data: null, error: null }),
  };
  const soloProfile = { ...profile, skills: [], services: [] };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
  app.render({ profile: soloProfile }); await flush();
  let tree = app.render({ profile: soloProfile });
  const submit = () => nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });

  toggleCategory(skillsList(tree), "Other");
  tree = app.render({ profile: soloProfile });
  await submit();
  tree = app.render({ profile: soloProfile });
  assert.deepEqual(calls, [], "never saves while OTHER is selected with no text");
  assert.equal(nodes(tree, (node) => node.props.role === "alert" && /Skills I can use to make money/.test(node.props.children)).length, 1);

  skillsList(tree).props.setOtherText("Juggling");
  toggleCategory(servicesList(tree), "Other");
  tree = app.render({ profile: soloProfile });
  await submit();
  tree = app.render({ profile: soloProfile });
  assert.deepEqual(calls, [], "skills now has text, but services' OTHER still has none");
  assert.equal(nodes(tree, (node) => node.props.role === "alert" && /Services I might need/.test(node.props.children)).length, 1);

  servicesList(tree).props.setOtherText("Piano tuning");
  tree = app.render({ profile: soloProfile });
  await submit();
  assert.equal(calls.length, 1, "both OTHER texts specified: the save proceeds");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    skills: ["Other"], services: ["Other"], skills_other_text: "Juggling", services_other_text: "Piano tuning",
  });
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
  const heading = nodes(tree, (node) => node.type === "h1")[0];
  assert.equal(textOf(heading), "@ExistingUser1", "username is shown read-only from the existing profile, not as an editable field");
  assert.deepEqual(skillsList(tree).props.selected, ["Cleaning"], "existing skills are preselected");
  assert.deepEqual(servicesList(tree).props.selected, ["Other"], "existing services are preselected");
});

test("Profile: primary action is 'Update profile', shows 'Updating…' while saving, and the pending guard blocks a duplicate submit", async () => {
  const calls = [];
  const soloProfile = { ...profile, skills: [], services: [] };
  const client = {
    from: (table) => table === "profile_tags"
      ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
      : { update: (payload) => { calls.push(payload); return { eq: () => ({ select: () => ({ single: async () => ({ error: null }) }) }) }; } },
    rpc: async () => ({ data: null, error: null }),
  };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
  app.render({ profile: soloProfile }); await flush();
  let tree = app.render({ profile: soloProfile });
  assert.ok(button(tree, "Update profile"), "primary action is labeled Update profile, not Save");
  toggleCategory(skillsList(tree), "Other");
  tree = app.render({ profile: soloProfile });
  skillsList(tree).props.setOtherText("Something else");
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
  assert.equal(update().props.disabled, true, "nothing changed yet");
  const hint = () => nodes(tree, (node) => node.type === "p" && /changes/.test(String(node.props.children)))[0].props.children;
  assert.equal(hint(), "No changes yet.");
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls, [], "submitting an unchanged form (e.g. Enter key) saves nothing");

  toggleCategory(skillsList(tree), "Other");
  tree = app.render({ profile: withSkill });
  assert.equal(update().props.disabled, false, "a skill change enables it");
  assert.equal(hint(), "You have unsaved changes.");
  toggleCategory(skillsList(tree), "Other");
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

  toggleCategory(skillsList(tree), "Other");
  tree = app.render({ profile: withSkill });
  assert.equal(update().props.disabled, false, "a skill change enables it");
});

// ESG-AUTH-004 v1.0: Delete account -> eligibility pre-check -> Outstanding
// Gigs popup (blocked) or Warning screen (eligible) -> Final Confirmation
// with password re-authentication (not an arbitrary typed word) -> delete.
const eligibleClient = (overrides = {}) => ({
  from: (table) => table === "profile_tags" ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) } : { update: () => ({}) },
  rpc: async () => ({ data: [{ eligible: true, active_gigs_count: 0, open_disputes_count: 0 }], error: null }),
  ...overrides,
});

async function openToConfirmStage(app) {
  app.render({ profile }); await flush();
  let tree = app.render({ profile });
  const trigger = nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account")[0];
  trigger.props.onClick();
  await flush();
  tree = app.render({ profile });
  button(tree, "Continue to Delete").props.onClick();
  tree = app.render({ profile });
  return tree;
}

test("Profile Danger zone: a blocked account sees the Outstanding Gigs popup with counts, and View Gigs/Cancel never call delete", async () => {
  const calls = [];
  const client = eligibleClient({
    rpc: async () => ({ data: [{ eligible: false, active_gigs_count: 2, open_disputes_count: 1 }], error: null }),
  });
  const destinations = [];
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client, globals: { fetch: async () => { calls.push("fetch"); return { ok: true, json: async () => ({ ok: true }) }; } },
    mocks: { "next/navigation": { useRouter: () => ({ replace: (url) => destinations.push(url), push: (url) => destinations.push(url) }) } },
  });
  app.render({ profile }); await flush();
  let tree = app.render({ profile });
  nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account")[0].props.onClick();
  await flush();
  tree = app.render({ profile });
  assert.equal(nodes(tree, (node) => node.props.children === "You have Gigs that need attention").length, 1);
  assert.ok(nodes(tree, (node) => node.type === "li" && textOf(node) === "Active or in-progress Gigs: 2").length, "shows the active-gigs count");
  assert.ok(nodes(tree, (node) => node.type === "li" && textOf(node) === "Open Disputes: 1").length, "shows the open-disputes count");
  assert.equal(nodes(tree, (node) => node.type === "button" && node.props.children === "Continue to Delete").length, 0, "no path to Warning/Confirm while blocked");
  button(tree, "View Gigs").props.onClick();
  assert.deepEqual(destinations, ["/my-gigs"]);
  assert.deepEqual(calls, [], "never calls the delete endpoint while blocked");
});

test("Profile Danger zone: an eligible account proceeds through the Warning screen to Final Confirmation", async () => {
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client: eligibleClient() });
  app.render({ profile }); await flush();
  let tree = app.render({ profile });
  assert.equal(nodes(tree, (node) => node.props.role === "dialog").length, 0, "no dialog before Delete account is clicked");
  nodes(tree, (node) => node.type === "button" && node.props.children === "Delete account")[0].props.onClick();
  await flush();
  tree = app.render({ profile });
  assert.equal(nodes(tree, (node) => node.props.children === "Delete Account").length, 1, "Warning screen title");
  assert.match(String(nodes(tree, (node) => node.type === "p" && /permanently remove/.test(String(node.props.children)))[0]?.props.children), /permanently remove your access/);
  button(tree, "Continue to Delete").props.onClick();
  tree = app.render({ profile });
  assert.equal(nodes(tree, (node) => node.props.children === "Permanently Delete Account?").length, 1, "Final Confirmation title");
  const confirmButton = () => nodes(tree, (node) => node.type === "button" && node.props.children === "Delete My Account")[0];
  assert.equal(confirmButton().props.disabled, true, "disabled until a password is entered");
  nodes(tree, (node) => node.type === "input" && node.props.type === "password")[0].props.onChange({ target: { value: "CurrentPass1!" } });
  tree = app.render({ profile });
  assert.equal(confirmButton().props.disabled, false, "enabled once a password is entered");
});

test("Profile Danger zone: Cancel/Keep My Account closes the dialog without deleting anything", async () => {
  const calls = [];
  const client = eligibleClient({ auth: { signInWithPassword: async () => { calls.push("reauth"); return { error: null }; } } });
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    globals: { fetch: async () => { calls.push("fetch"); return { ok: true, json: async () => ({ ok: true }) }; } },
  });
  let tree = await openToConfirmStage(app);
  nodes(tree, (node) => node.type === "input" && node.props.type === "password")[0].props.onChange({ target: { value: "CurrentPass1!" } });
  tree = app.render({ profile });
  button(tree, "Keep My Account").props.onClick();
  tree = app.render({ profile });
  assert.equal(nodes(tree, (node) => node.props.role === "dialog").length, 0, "dialog closes");
  assert.deepEqual(calls, [], "no request of any kind was made");
});

test("Profile Danger zone: successful deletion re-authenticates, signs out, clears ESG session state, and redirects home with the deleted-account flag", async () => {
  const client = eligibleClient({
    auth: {
      signInWithPassword: async (args) => ({ _args: args, error: null }),
      signOut: async () => ({ error: null }),
    },
  });
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
  app.auth.user = { ...user, email: "person@example.com" };
  let tree = await openToConfirmStage(app);
  nodes(tree, (node) => node.type === "input" && node.props.type === "password")[0].props.onChange({ target: { value: "CurrentPass1!" } });
  tree = app.render({ profile });
  button(tree, "Delete My Account").props.onClick();
  await flush();
  assert.equal(fetchCalls, 1);
  assert.equal(requestedUrl, "/api/account/delete");
  assert.equal(requestedMethod, "POST");
  assert.deepEqual(destinations, ["/?accountDeleted=1"], "redirects home with the confirmation flag after successful deletion");
  assert.deepEqual(cleared, ["cleared"], "ESG-specific session state (general area, geocode cache) is cleared");
});

test("Profile Danger zone: a failed re-authentication never calls the delete endpoint", async () => {
  const calls = [];
  const client = eligibleClient({ auth: { signInWithPassword: async () => ({ error: { code: "invalid_credentials" } }) } });
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client, globals: { fetch: async () => { calls.push("fetch"); return { ok: true, json: async () => ({ ok: true }) }; } },
  });
  app.auth.user = { ...user, email: "person@example.com" };
  let tree = await openToConfirmStage(app);
  nodes(tree, (node) => node.type === "input" && node.props.type === "password")[0].props.onChange({ target: { value: "WrongPass1!" } });
  tree = app.render({ profile });
  button(tree, "Delete My Account").props.onClick();
  await flush();
  tree = app.render({ profile });
  assert.deepEqual(calls, [], "the delete endpoint is never reached");
  assert.equal(String(nodes(tree, (node) => node.props.role === "alert")[0].props.children), "We couldn't verify your account. Please check your details and try again.");
});

test("Profile Danger zone: backend failure shows the server's error, keeps the dialog open, and does not sign out or redirect", async () => {
  const client = eligibleClient({ auth: { signInWithPassword: async () => ({ error: null }), signOut: async () => { throw new Error("should not be called"); } } });
  const destinations = [];
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    globals: { fetch: async () => ({ ok: false, json: async () => ({ error: "Couldn't finish deleting your account. Please try again." }) }) },
    mocks: { "next/navigation": { useRouter: () => ({ replace: (url) => destinations.push(url) }) } },
  });
  app.auth.user = { ...user, email: "person@example.com" };
  let tree = await openToConfirmStage(app);
  nodes(tree, (node) => node.type === "input" && node.props.type === "password")[0].props.onChange({ target: { value: "CurrentPass1!" } });
  tree = app.render({ profile });
  button(tree, "Delete My Account").props.onClick();
  await flush();
  tree = app.render({ profile });
  assert.equal(nodes(tree, (node) => node.props.role === "dialog").length, 1, "dialog stays open after a failure");
  assert.equal(nodes(tree, (node) => node.props.role === "alert" && node.props.children === "Couldn't finish deleting your account. Please try again.").length, 1);
  assert.deepEqual(destinations, [], "no redirect on failure");
});

test("Profile Danger zone: a network failure shows a friendly message, not the browser's raw error", async () => {
  const client = eligibleClient({ auth: { signInWithPassword: async () => ({ error: null }), signOut: async () => ({ error: null }) } });
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    globals: { fetch: async () => { throw new TypeError("Failed to fetch"); } },
    mocks: { "next/navigation": { useRouter: () => ({ replace() {} }) } },
  });
  app.auth.user = { ...user, email: "person@example.com" };
  let tree = await openToConfirmStage(app);
  nodes(tree, (node) => node.type === "input" && node.props.type === "password")[0].props.onChange({ target: { value: "CurrentPass1!" } });
  tree = app.render({ profile });
  button(tree, "Delete My Account").props.onClick();
  await flush();
  tree = app.render({ profile });
  assert.equal(nodes(tree, (node) => node.props.role === "alert" && node.props.children === "Couldn't delete your account. Check your connection and try again.").length, 1);
});

test("Profile Danger zone: shows a 'Deleting…' loading state, disables Keep My Account while in flight, and a duplicate click issues only one request", async () => {
  const client = eligibleClient({ auth: { signInWithPassword: async () => ({ error: null }), signOut: async () => ({ error: null }) } });
  let fetchCalls = 0;
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", {
    client,
    globals: { fetch: async () => { fetchCalls++; return { ok: true, json: async () => ({ ok: true }) }; } },
    mocks: { "next/navigation": { useRouter: () => ({ replace() {} }) }, "@/lib/location": { clearGeneralAreaState: () => {} } },
  });
  app.auth.user = { ...user, email: "person@example.com" };
  let tree = await openToConfirmStage(app);
  nodes(tree, (node) => node.type === "input" && node.props.type === "password")[0].props.onChange({ target: { value: "CurrentPass1!" } });
  tree = app.render({ profile });
  const confirmButton = () => nodes(tree, (node) => node.type === "button" && node.props.children === "Delete My Account")[0];
  const first = confirmButton().props.onClick();
  confirmButton().props.onClick(); // duplicate click before the first request settles
  tree = app.render({ profile });
  assert.ok(nodes(tree, (node) => node.type === "button" && node.props.children === "Deleting…")[0], "shows a distinct loading label while deleting");
  assert.equal(button(tree, "Keep My Account").props.disabled, true, "Keep My Account is disabled while deleting");
  await first; await flush();
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

async function onboardingSkillsStep({ rpc, finished = [] }) {
  const catalog = {
    Cleaning: [{ id: "c1", name: "Deep Cleaning", service_type: "Cleaning" }, { id: "c2", name: "Kitchen", service_type: "Cleaning" }],
    Other: [{ id: "o1", name: "Errands", service_type: "Other" }],
  };
  const app = await component("src/components/ProfileSetup.tsx", "ProfileSetup", {
    client: { rpc },
    mocks: { "@/lib/tags": { loadTagCatalog: async () => catalog, MAX_PROFILE_TAGS: 8 } },
  });
  const props = { profile: { ...profile, skills: [], services: [], private_location_text: "Somewhere", private_lat: null, private_lng: null }, onFinish: () => finished.push("done") };
  app.render(props); await flush();
  let tree = app.render(props);
  button(tree, "Continue").props.onClick(); tree = app.render(props);
  button(tree, "Continue").props.onClick(); tree = app.render(props);
  return { app, props, tree };
}
const skillCheckbox = (tree, name) => nodes(tree, (node) => node.type === "label" && Array.isArray(node.props.children) && node.props.children[2] === name)[0].props.children[0];

test("Onboarding skills step: choosing a skill opens its specializations, picks show as chips, and are saved after the profile", async () => {
  const calls = [], finished = [];
  const rpc = async (name, payload) => { calls.push([name, JSON.parse(JSON.stringify(payload))]); return { data: { id: "p" }, error: null }; };
  const { app, props, tree: initial } = await onboardingSkillsStep({ rpc, finished });
  assert.equal(nodes(initial, (node) => node.props["aria-label"] === "Add specializations").length, 0, "no section until a skill with options is chosen");
  skillCheckbox(initial, "Cleaning").props.onChange();
  let tree = app.render(props);
  assert.equal(specializationSheet(tree).props.title, "What kind of cleaning?", "selecting a skill opens its options");
  sheetRow(tree, "Kitchen").props.onClick();
  tree = app.render(props);
  specializationSheet(tree).props.onClose();
  tree = app.render(props);
  assert.ok(removeSpecialization(tree, "Kitchen"), "the pick appears as a chip");
  skillCheckbox(tree, "Other").props.onChange(); // chosen but nothing picked
  tree = app.render(props);
  specializationSheet(tree).props.onClose();
  tree = app.render(props);

  button(tree, "Save profile & continue").props.onClick(); await flush();
  assert.deepEqual(calls.map(([name]) => name), ["save_onboarding", "set_helper_tags"], "profile first, then only skills that have picks");
  assert.deepEqual(calls[1][1], { p_service_type: "Cleaning", p_tag_ids: ["c2"] });
  assert.deepEqual(finished, ["done"]);
});

test("Onboarding: if specializations fail to save after the profile saved, the user stays and can retry", async () => {
  const calls = [], finished = [];
  let failTags = true;
  const rpc = async (name) => { calls.push(name); return name === "set_helper_tags" && failTags ? { data: null, error: { code: "XX000" } } : { data: { id: "p" }, error: null }; };
  const { app, props, tree: initial } = await onboardingSkillsStep({ rpc, finished });
  skillCheckbox(initial, "Cleaning").props.onChange();
  let tree = app.render(props);
  sheetRow(tree, "Deep Cleaning").props.onClick();
  tree = app.render(props);
  specializationSheet(tree).props.onClose();
  tree = app.render(props);
  button(tree, "Save profile & continue").props.onClick(); await flush();
  tree = app.render(props);
  assert.equal(nodes(tree, (node) => node.props.role === "alert" && /profile saved, but some specializations/.test(String(node.props.children))).length, 1);
  assert.deepEqual(finished, [], "does not leave onboarding with the picks silently lost");
  failTags = false;
  button(tree, "Save profile & continue").props.onClick(); await flush();
  assert.deepEqual(finished, ["done"]);
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

test("Settings: shows username read-only, lets email/phone be edited independently, and updates the password", async () => {
  const updates = []; const profileUpdates = [];
  const client = {
    from: () => ({ update: (payload) => { profileUpdates.push(payload); return { eq: () => ({ select: () => ({ single: async () => ({ error: null }) }) }) }; } }),
    auth: { updateUser: async (args) => { updates.push(args); return { error: null }; } },
  };
  const app = await component("src/app/settings/page.tsx", "SettingsInner", { client });
  app.auth.user = { ...user, email: "current@example.com" };
  app.auth.profile = { ...profile, phone: null };
  let tree = app.render();
  assert.match(textOf(nodes(tree, (node) => String(node.props.children).includes("cannot be changed"))[0]), /@Tester123/, "username is shown read-only");
  assert.ok(nodes(tree, (node) => node.props.children === "current@example.com").length, "current email is shown");

  // Edit email: invalid format never reaches Supabase.
  nodes(tree, (node) => node.type === "button" && node.props.children === "Edit")[0].props.onClick();
  tree = app.render();
  const emailInput = nodes(tree, (node) => node.type === "input" && node.props.type === "email")[0];
  emailInput.props.onChange({ target: { value: "not-an-email" } });
  tree = app.render();
  button(tree, "Save").props.onClick(); await flush();
  tree = app.render();
  assert.deepEqual(updates, [], "an invalid email never reaches Supabase");
  assert.equal(String(nodes(tree, (node) => node.props.role === "alert")[0].props.children), "Enter a valid email address.");

  emailInput.props.onChange({ target: { value: " new@example.com " } });
  tree = app.render();
  button(tree, "Save").props.onClick(); await flush();
  tree = app.render();
  assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ email: "new@example.com" }], "the email is trimmed before Supabase's own secure-email-change flow runs");
  assert.match(String(nodes(tree, (node) => node.props.role === "status")[0].props.children), /Check your new email/);

  // Edit phone: non-10-digit input is rejected; a formatted 10-digit number is stripped before saving.
  // Email's own "Edit" button is back (its section closed after saving), so take the last match (phone's).
  const editButtons = nodes(tree, (node) => node.type === "button" && node.props.children === "Edit");
  editButtons[editButtons.length - 1].props.onClick();
  tree = app.render();
  const phoneInput = nodes(tree, (node) => node.type === "input" && node.props.type === "tel")[0];
  phoneInput.props.onChange({ target: { value: "555-123" } });
  tree = app.render();
  button(tree, "Save").props.onClick(); await flush();
  tree = app.render();
  assert.deepEqual(profileUpdates, [], "an incomplete phone number never reaches Supabase");
  phoneInput.props.onChange({ target: { value: "(555) 123-4567" } });
  tree = app.render();
  button(tree, "Save").props.onClick(); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(profileUpdates)), [{ phone: "5551234567" }], "formatting characters are stripped before saving");

  // Change password: mismatch is caught client-side; a match calls updateUser.
  tree = app.render();
  const [newPw, confirmPw] = nodes(tree, (node) => node.type === "input" && node.props.type === "password");
  newPw.props.onChange({ target: { value: "NewPassword1!" } });
  confirmPw.props.onChange({ target: { value: "Different1!" } });
  tree = app.render();
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  tree = app.render();
  assert.equal(String(nodes(tree, (node) => node.props.role === "alert")[0].props.children), "Passwords don't match.");
  confirmPw.props.onChange({ target: { value: "NewPassword1!" } });
  tree = app.render();
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(updates[updates.length - 1])), { password: "NewPassword1!" });
});

test("Public profile shows the pre-computed WOM% (never the raw lemon_count, which stays private) and falls back to '—' when it's null", async () => {
  const withPercentage = { id: "helper-1", username: "HelperOne", photo_url: null, skills: [], wom_count: 4, profile_tags: [] };
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: withPercentage, error: null }) }) }) }),
    rpc: async () => ({ data: [{ gigs_worked_count: 2, wom_count: 4, wom_percentage: 80 }], error: null }),
  };
  const app = await component("src/app/profile/[username]/page.tsx", "PublicProfileView", { client });
  app.render({ username: "HelperOne" }); await flush();
  let tree = app.render({ username: "HelperOne" });
  assert.equal(nodes(tree, (node) => node.props.children === "80%").length, 1, "shows the server-computed percentage");
  assert.equal(nodes(tree, (node) => String(node.props.children).includes("lemon")).length, 0, "lemon_count is never requested or rendered here");

  const noSignal = { ...withPercentage, wom_count: 0 };
  const clientNull = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: noSignal, error: null }) }) }) }),
    rpc: async () => ({ data: [{ gigs_worked_count: 0, wom_count: 0, wom_percentage: null }], error: null }),
  };
  const app2 = await component("src/app/profile/[username]/page.tsx", "PublicProfileView", { client: clientNull });
  app2.render({ username: "HelperOne" }); await flush();
  tree = app2.render({ username: "HelperOne" });
  assert.equal(nodes(tree, (node) => node.props.children === "—").length, 1, "no WOM/Lemon signal yet falls back to an em dash, not 0%/NaN");
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

// public_profiles.skills is JSONB. Mirrors how postgrest-js serializes .contains() and how
// PostgREST then treats it, so a wrong argument shape fails here as it does against the
// real project: an array becomes the PostgreSQL-array literal cs.{Yard Work}, which a jsonb
// column rejects with 22P02 (HTTP 400); a JSON string becomes cs.["Yard Work"], which works.
function skillsContains(profiles, filters, column, value) {
  const serialized = typeof value === "string" ? `cs.${value}` : Array.isArray(value) ? `cs.{${value.join(",")}}` : `cs.${JSON.stringify(value)}`;
  filters.push(`${column}=${serialized}`);
  const body = serialized.slice(3);
  if (column !== "skills" || !body.startsWith("[")) return { data: null, error: { code: "22P02", message: "invalid input syntax for type json" } };
  const wanted = JSON.parse(body);
  return { data: profiles.filter((p) => wanted.every((skill) => p.skills.includes(skill))), error: null };
}
function helperClient(profiles, filters = []) {
  return { from: () => ({ select: () => ({ contains: (column, value) => ({
    then: (resolve, reject) => Promise.resolve(skillsContains(profiles, filters, column, value)).then(resolve, reject),
  }) }) }) };
}
const helperTagsMock = { withProfileTags: async (_supabase, rows) => rows, profileTagsForCategory: (profile, category) => (profile.profile_tags ?? []).map((link) => link.tag).filter((tag) => tag.service_type === category) };
// Specializations are chosen in the same bottom sheet as on the profile page: "+ Add", then tick a row.
const addSpecializations = (tree) => nodes(tree, (node) => node.type === "button" && node.props["aria-label"] === "Add specializations")[0];
const specializationRow = (tree, name) => nodes(tree, (node) => node.type === "option-sheet")
  .flatMap((sheet) => nodes(sheet, (node) => node.type === "button" && node.props.role === "checkbox" && textOf(node.props.children[0]) === name))[0];
function pickSpecialization(app, name) {
  addSpecializations(app.render()).props.onClick();
  specializationRow(app.render(), name).props.onClick();
  return app.render();
}
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
  tree = pickSpecialization(app, "Deep Cleaning");
  assert.equal(nodes(tree, (node) => node.props.children === "Matching specializations").length, 1);
  // JSX interpolation ("Other {category} helpers") splits into an array of parts, not one string.
  assert.equal(nodes(tree, (node) => Array.isArray(node.props.children) && node.props.children.join("") === "Other Cleaning helpers").length, 1);
  assert.deepEqual(helperUsernames(tree), ["HelperA", "HelperC"], "matching specialist and legacy fallback shown; non-matching specialist (HelperB, HelperD) excluded entirely");
});

test("Find a Helper specializations use the profile pattern: chips plus a + Add bottom sheet, removable", async () => {
  const catalog = { Cleaning: [{ id: "t1", name: "Deep Cleaning", service_type: "Cleaning" }, { id: "t2", name: "Kitchen", service_type: "Cleaning" }] };
  const profiles = [{ id: "a", username: "HelperA", photo_url: null, skills: ["Cleaning"], wom_count: 1, profile_tags: [{ tag: catalog.Cleaning[0] }] },
    { id: "b", username: "HelperB", photo_url: null, skills: ["Cleaning"], wom_count: 1, profile_tags: [{ tag: catalog.Cleaning[1] }] }];
  const app = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client: helperClient(profiles),
    mocks: { "@/lib/tags": { loadTagCatalog: async () => catalog, ...helperTagsMock } },
  });
  app.render(); await flush();
  let tree = app.render();
  nodes(tree, (node) => node.type === "selection-chip" && node.props.children === "Cleaning")[0].props.onClick();
  tree = app.render(); await flush(); tree = app.render();
  assert.equal(nodes(tree, (node) => node.type === "selection-chip" && ["Deep Cleaning", "Kitchen"].includes(node.props.children)).length, 0, "options are not an inline wall of selection chips");
  assert.equal(nodes(tree, (node) => node.props.children === "Specializations (optional)").length, 1);
  assert.equal(nodes(tree, (node) => node.props.children === "Any specialization.").length, 1, "nothing chosen means any specialization");
  assert.equal(nodes(tree, (node) => node.type === "option-sheet").length, 0, "sheet is closed until + Add");
  addSpecializations(tree).props.onClick();
  tree = app.render();
  assert.equal(nodes(tree, (node) => node.type === "option-sheet").length, 1);
  assert.ok(specializationRow(tree, "Deep Cleaning") && specializationRow(tree, "Kitchen"), "every option for the category is listed in the sheet");
  specializationRow(tree, "Kitchen").props.onClick();
  tree = app.render();
  assert.equal(specializationRow(tree, "Kitchen").props["aria-checked"], true);
  assert.deepEqual(helperUsernames(tree), ["HelperB"]);
  const remove = nodes(tree, (node) => node.type === "button" && node.props["aria-label"] === "Remove Kitchen")[0];
  assert.ok(remove, "the chosen specialization shows as a removable chip");
  remove.props.onClick();
  tree = app.render();
  assert.deepEqual(helperUsernames(tree).sort(), ["HelperA", "HelperB"], "removing the chip clears the filter");
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

// The distance control is now "Any distance" (checkbox) plus a RadiusSlider (mocked as a
// "radius-slider" node) shown only while that checkbox is unchecked. Passing km === null
// checks "Any distance"; any other km unchecks it (uncovering the slider) and sets its value.
function setDistance(app, tree, km) {
  const checkbox = nodes(tree, (node) => node.type === "input" && node.props.type === "checkbox")[0];
  if (km === null) {
    if (checkbox.props.checked) return app.render();
    checkbox.props.onChange({ target: { checked: true } });
    return app.render();
  }
  if (checkbox.props.checked) { checkbox.props.onChange({ target: { checked: false } }); tree = app.render(); }
  nodes(tree, (node) => node.type === "radius-slider")[0].props.onChange(km);
  return app.render();
}

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

  tree = setDistance(app, tree, 5);
  assert.deepEqual(helperUsernames(tree), ["Near4km"], "5 km radius includes only the 4 km helper; excludes the one with no location entirely (not just from the radius)");

  tree = setDistance(app, tree, 10);
  assert.deepEqual(helperUsernames(tree), ["Near4km", "Mid9km"], "10 km radius adds the 9 km helper, nearest-first order");

  tree = setDistance(app, tree, 25);
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
  tree = pickSpecialization(app, "Deep Cleaning");
  tree = setDistance(app, tree, 10);
  assert.deepEqual(helperUsernames(tree), ["NearSpecialist", "NearLegacy"], "within radius: matching specialist first, legacy fallback still included; far specialist (111 km away) and radius-excluded helpers are gone");
});

// ---------------------------------------------------------------------------
// Navigation, My Gigs, Messages, notifications and the gig hub
// ---------------------------------------------------------------------------
const sectionLabels = (tree) => nodes(tree, (node) => node.type === "section").map((node) => node.props["aria-label"]);
const sectionNamed = (tree, label) => nodes(tree, (node) => node.type === "section" && node.props["aria-label"] === label)[0];

// Minimal chainable Supabase fake: `resolve(query, single)` decides each result.
function fakeDb(resolve) {
  return {
    from(table) {
      const query = { table, eq: {}, in: {}, or: null };
      const api = {
        select() { return api; }, order() { return api; }, limit() { return api; }, not() { return api; }, is() { return api; }, neq() { return api; },
        eq(field, value) { query.eq[field] = value; return api; },
        in(field, value) { query.in[field] = value; return api; },
        or(value) { query.or = value; return api; },
        maybeSingle() { return Promise.resolve(resolve(query, true)); },
        then(ok, bad) { return Promise.resolve(resolve(query, false)).then(ok, bad); },
      };
      return api;
    },
    rpc: async () => ({ error: null }),
    channel() { const channel = { on() { return channel; }, subscribe() { return channel; } }; return channel; },
    removeChannel() {},
  };
}

const myGig = (id, fields = {}) => ({ id, title: id, poster_id: user.id, selected_provider_id: null, status: "active", amount: 50, location_text: "Kävlinge", scheduled_at: "2026-10-30T12:00:00Z", gig_tags: [], ...fields });
function myGigsDb({ fail, calls = [], empty = false } = {}) {
  const data = empty ? { posted: [], helping: [], myClaims: [], pending: [], profiles: [] } : {
    posted: [myGig("g-open"), myGig("g-acc", { selected_provider_id: "h1", agreed_amount: 45 }), myGig("g-prog", { status: "in_progress", selected_provider_id: "h1" }),
      myGig("g-done", { status: "completed", selected_provider_id: "h1" }), myGig("g-draft", { status: "draft" }), myGig("g-cancel", { status: "cancelled" })],
    helping: [myGig("h-pending", { poster_id: "c1" }), myGig("h-acc", { poster_id: "c1", selected_provider_id: user.id, agreed_amount: 40 }),
      myGig("h-prog", { poster_id: "c1", status: "in_progress", selected_provider_id: user.id }), myGig("h-done", { poster_id: "c1", status: "completed", selected_provider_id: user.id }),
      myGig("h-lost", { poster_id: "c1", selected_provider_id: "someone" }), myGig("h-cancelled", { poster_id: "c1", status: "cancelled" })],
    myClaims: [{ gig_id: "h-pending", state: "pending", offer_amount: 40 }, { gig_id: "h-acc", state: "selected", offer_amount: 40 }, { gig_id: "h-lost", state: "rejected" }, { gig_id: "h-cancelled", state: "rejected" }],
    pending: [{ gig_id: "g-open" }, { gig_id: "g-open" }],
    profiles: [{ id: "h1", username: "helper1" }, { id: "c1", username: "customer1" }],
  };
  return fakeDb((query) => {
    let label, rows;
    if (query.table === "gigs" && query.eq.poster_id) { label = "gigs-posted"; rows = data.posted; }
    else if (query.table === "gigs" && query.or) { label = "gigs-helping"; rows = data.helping; }
    else if (query.table === "claims" && query.eq.provider_id) { label = "claims-helping"; rows = data.myClaims; }
    else if (query.table === "claims") { label = "claims-pending"; rows = data.pending; }
    else if (query.table === "public_profiles") { label = "profiles"; rows = data.profiles.filter((profile) => query.in.id.includes(profile.id)); }
    calls.push(label);
    return label === fail ? { data: null, error: new Error("failed") } : { data: rows, error: null };
  });
}
async function openMyGigs(options = {}, mocks = {}) {
  const app = await component("src/app/my-gigs/page.tsx", "MyGigsInner", { client: myGigsDb(options), mocks });
  app.render(); await flush();
  return { app, tree: app.render() };
}

test("bottom navigation is exactly Home | Explore | My Gigs | Profile; header has Messages and Notifications, no username", async () => {
  const app = await component("src/components/Nav.tsx", "Nav", { mocks: { "@/components/NotificationsBell": { default: "notifications-bell" } } });
  const tree = app.render();
  const header = nodes(tree, (node) => node.type === "header")[0];
  assert.equal(nodes(header, (node) => node.type === "messages-link").length, 1, "Messages icon in the header");
  assert.equal(nodes(header, (node) => node.type === "notifications-bell").length, 1, "Notifications icon in the header");
  assert.equal(nodes(header, (node) => node.type === "a" && node.props.href === "/profile").length, 0, "no username link: Profile is already in the bottom bar");
  const nav = nodes(tree, (node) => node.type === "nav")[0];
  const links = nodes(nav, (node) => node.type === "a");
  assert.deepEqual(links.map((link) => textOf(link.props.children[1])), ["Home", "Explore", "My Gigs", "Profile"]);
  assert.deepEqual(links.map((link) => link.props.href), ["/location", "/browse", "/my-gigs", "/profile"]);
  assert.equal(nodes(nav, (node) => node.props.href === "/messages").length, 0, "Messages is not a bottom tab");
});

test("My Gigs tabs are 'I Need Help' and 'I'm Helping'", async () => {
  const { tree } = await openMyGigs();
  const tabs = nodes(tree, (node) => node.props.role === "tab");
  assert.deepEqual(tabs.map(textOf), ["I Need Help", "I'm Helping"]);
  assert.deepEqual(tabs.map((tab) => tab.props["aria-selected"]), [true, false]);
});

test("My Gigs / I Need Help groups posted gigs by the existing statuses, with proposal counts and the selected helper", async () => {
  const { tree } = await openMyGigs();
  assert.deepEqual(sectionLabels(tree), ["Open", "Accepted", "In progress", "Completed", "Drafts", "Cancelled"]);
  const open = sectionNamed(tree, "Open");
  const openLinks = nodes(open, (node) => node.type === "a");
  assert.ok(openLinks.some((link) => link.props.href === "/gigs/g-open#proposals" && textOf(link) === "2 proposals"), "proposal count leads to that gig's proposals");
  assert.ok(openLinks.some((link) => link.props.href === "/gigs/g-open" && textOf(link) === "View gig"));
  assert.match(textOf(open), /Oct 30 · Kävlinge · Budget 50 CAD/);
  assert.doesNotMatch(textOf(open), /Helper:/, "no helper before one is selected");
  assert.match(textOf(sectionNamed(tree, "Accepted")), /Helper: @helper1 · Agreed price: 45 CAD/, "budget stays visible, agreed price is shown once someone is accepted");
  assert.match(textOf(sectionNamed(tree, "In progress")), /Helper: @helper1/);
  assert.deepEqual(nodes(sectionNamed(tree, "Accepted"), (node) => node.type === "badge").map((node) => node.props.status), ["active"], "the real gig status is shown");
  assert.deepEqual(nodes(sectionNamed(tree, "In progress"), (node) => node.type === "badge").map((node) => node.props.status), ["in_progress"]);
});

test("My Gigs / I'm Helping maps the existing claim and gig lifecycle to sections and badges", async () => {
  const { app, tree: first } = await openMyGigs();
  nodes(first, (node) => node.props.role === "tab")[1].props.onClick();
  const tree = app.render();
  assert.deepEqual(sectionLabels(tree), ["Proposals", "Accepted", "In progress", "Completed", "Not selected or closed"]);
  assert.match(textOf(sectionNamed(tree, "Proposals")), /Proposal pending/);
  assert.match(textOf(sectionNamed(tree, "Proposals")), /Customer: @customer1/);
  assert.match(textOf(sectionNamed(tree, "Proposals")), /Your offer: 40 CAD/);
  assert.match(textOf(sectionNamed(tree, "Accepted")), /Accepted/);
  assert.match(textOf(sectionNamed(tree, "Accepted")), /Agreed price: 40 CAD/);
  assert.match(textOf(sectionNamed(tree, "In progress")), /In progress/);
  assert.match(textOf(sectionNamed(tree, "Completed")), /Completed/);
  const closed = textOf(sectionNamed(tree, "Not selected or closed"));
  assert.match(closed, /Not selected/);
  assert.match(closed, /Gig cancelled/);
  assert.ok(nodes(sectionNamed(tree, "Proposals"), (node) => node.type === "a" && node.props.href === "/gigs/h-pending").length >= 1);
});

test("My Gigs opens on I'm Helping when linked with ?tab=helping", async () => {
  const { tree } = await openMyGigs({}, { "next/navigation": { useSearchParams: () => new URLSearchParams("tab=helping") } });
  assert.deepEqual(nodes(tree, (node) => node.props.role === "tab").map((tab) => tab.props["aria-selected"]), [false, true]);
  assert.equal(sectionLabels(tree)[0], "Proposals");
});

test("My Gigs empty states point to Post a gig and Explore", async () => {
  const { app, tree: first } = await openMyGigs({ empty: true });
  assert.ok(nodes(first, (node) => node.type === "a" && node.props.href === "/post"));
  nodes(first, (node) => node.props.role === "tab")[1].props.onClick();
  assert.ok(nodes(app.render(), (node) => node.type === "a" && node.props.href === "/browse"));
});

for (const [fail, failingTab] of [["gigs-posted", 0], ["claims-pending", 0], ["claims-helping", 1], ["gigs-helping", 1]]) {
  test(`My Gigs isolates a ${fail} failure to its tab and retries only that tab`, async () => {
    const calls = [];
    const { app, tree: first } = await openMyGigs({ fail, calls });
    const select = (index) => { nodes(app.render(), (node) => node.props.role === "tab")[index].props.onClick(); return app.render(); };
    let tree = select(failingTab ? 0 : 1);
    assert.equal(nodes(tree, (node) => node.props.role === "alert").length, 0, "the other tab is unaffected");
    assert.ok(sectionLabels(tree).length > 0);
    tree = select(failingTab);
    assert.equal(nodes(tree, (node) => node.props.role === "alert").length, 1);
    calls.length = 0;
    button(tree, "Retry").props.onClick(); app.render(); await flush();
    const other = failingTab ? ["gigs-posted", "claims-pending"] : ["claims-helping", "gigs-helping"];
    assert.ok(calls.length > 0);
    assert.ok(calls.every((label) => !other.includes(label)), "retry only reloads the failed tab's data");
    void first;
  });
}

test("Messages inbox lists gig conversations newest first with the other person, preview and unread count", async () => {
  const now = Date.now();
  const message = (id, gig_id, sender_id, body, ageSeconds, read_at = null) => ({ id, gig_id, sender_id, body, created_at: new Date(now - ageSeconds * 1000).toISOString(), read_at });
  const client = fakeDb((query) => {
    if (query.table === "gigs") return { data: [
      { id: "g1", title: "Yard Cleaning", poster_id: user.id, selected_provider_id: "h1" },
      { id: "g2", title: "Dog Walking", poster_id: "c2", selected_provider_id: user.id },
      { id: "g3", title: "No messages yet", poster_id: user.id, selected_provider_id: "h3" },
    ], error: null };
    if (query.table === "chat_messages") return { data: [
      message("m1", "g2", "c2", "Are you free tomorrow?", 30), message("m2", "g2", "c2", "Hello", 300),
      message("m3", "g1", user.id, "Yes, Thursday at 2 works.", 120),
    ], error: null };
    return { data: [{ id: "h1", username: "helper1" }, { id: "c2", username: "customer2" }], error: null };
  });
  const app = await component("src/app/messages/page.tsx", "MessagesInner", { client, mocks: { "@/lib/my-gigs": myGigsLib } });
  app.render(); await flush();
  const tree = app.render();
  const rows = nodes(tree, (node) => node.type === "li");
  assert.equal(rows.length, 2, "only gigs that actually have messages");
  const [newest, older] = rows.map((row) => nodes(row, (node) => node.type === "a")[0]);
  assert.equal(newest.props.href, "/gigs/g2#messages");
  assert.equal(older.props.href, "/gigs/g1#messages");
  assert.match(textOf(newest), /Dog Walking/); assert.match(textOf(newest), /@customer2/); assert.match(textOf(newest), /Are you free tomorrow\?/);
  assert.equal(nodes(newest, (node) => node.props.role === "img")[0].props["aria-label"], "2 unread", "unread has an accessible name");
  assert.match(textOf(older), /You: Yes, Thursday at 2 works\./);
  assert.match(textOf(older), /@helper1/);
  assert.equal(nodes(older, (node) => node.props.role === "img").length, 0);
});

test("Messages inbox explains when there are no conversations", async () => {
  const app = await component("src/app/messages/page.tsx", "MessagesInner", { client: fakeDb(() => ({ data: [], error: null })), mocks: { "@/lib/my-gigs": myGigsLib } });
  app.render(); await flush();
  assert.equal(nodes(app.render(), (node) => /No conversations yet/.test(textOf(node)) && node.type === "p").length, 1);
});

test("Messages header link carries an accessible unread count and opens the inbox", async () => {
  for (const [count, label] of [[3, "Messages, 3 unread"], [0, "Messages"]]) {
    const listeners = [];
    const client = { ...fakeDb(() => ({ count, error: null })), };
    const app = await component("src/components/MessagesLink.tsx", "MessagesLink", {
      client, globals: { window: { addEventListener: (name) => listeners.push(name), removeEventListener() {} } },
      mocks: { "next/navigation": { usePathname: () => "/browse" } },
    });
    app.render(); await flush();
    const link = nodes(app.render(), (node) => node.type === "a")[0];
    assert.equal(link.props.href, "/messages");
    assert.equal(link.props["aria-label"], label);
    assert.deepEqual(listeners, ["esg:messages-read"], "badge refreshes when a conversation is opened");
  }
});

test("Notifications: accessible unread count, and each one opens its gig (new proposals land on the proposals list)", async () => {
  const items = [
    { id: "n1", gig_id: "g1", type: "claim_received", message: "New proposal", read: false },
    { id: "n2", gig_id: "g2", type: "selected", message: "You were selected", read: false },
    { id: "n3", gig_id: "g3", type: "resolved", message: "Resolved", read: true },
  ];
  const pushed = [], updates = [];
  const query = { select() { return query; }, eq() { return query; }, order() { return query; }, limit() { return Promise.resolve({ data: items }); },
    update(payload) { updates.push(payload); return { eq: async () => ({ error: null }) }; } };
  const client = { from: () => query, channel() { const c = { on() { return c; }, subscribe() { return c; } }; return c; }, removeChannel() {} };
  const app = await component("src/components/NotificationsBell.tsx", "NotificationsBell", { client, mocks: { "next/navigation": { useRouter: () => ({ push: (url) => pushed.push(url) }) } } });
  app.render(); await flush();
  let tree = app.render();
  const bell = () => nodes(tree, (node) => node.type === "button" && /^Notifications/.test(node.props["aria-label"] ?? ""))[0];
  assert.equal(bell().props["aria-label"], "Notifications, 2 unread");
  bell().props.onClick(); tree = app.render();
  const open = (label) => nodes(tree, (node) => node.type === "button" && node.props.children === label)[0];
  await open("New proposal").props.onClick();
  await open("You were selected").props.onClick();
  assert.deepEqual(pushed, ["/gigs/g1#proposals", "/gigs/g2"]);
  assert.equal(updates.length, 2, "unread notifications are marked read when opened");
});

test("Chat opening marks the other party's messages read and tells the header badge to refresh", async () => {
  const updates = [], events = [];
  const rows = [{ id: "m1", gig_id: "g1", sender_id: "other", body: "Hi", created_at: "2026-10-01T10:00:00Z", read_at: null }];
  const query = { select() { return query; }, eq() { return query; }, order() { return { then: (ok) => Promise.resolve({ data: rows }).then(ok) }; },
    update(payload) { updates.push(payload); const chain = { eq() { return chain; }, neq() { return chain; }, is() { return Promise.resolve({ error: null }); } }; return chain; } };
  const noProposals = { select() { return noProposals; }, eq() { return noProposals; }, order() { return { then: (ok) => Promise.resolve({ data: [] }).then(ok) }; } };
  const client = { from: (table) => (table === "price_proposals" ? noProposals : query), channel() { const c = { on() { return c; }, subscribe() { return c; } }; return c; }, removeChannel() {} };
  const app = await component("src/components/ChatPanel.tsx", "ChatPanel", {
    client, globals: { Event: class { constructor(type) { this.type = type; } }, window: { dispatchEvent: (event) => events.push(event.type) } },
  });
  app.render({ gigId: "g1", currentUserId: user.id, readOnly: false }); await flush();
  assert.equal(updates.length, 1);
  assert.ok(typeof updates[0].read_at === "string");
  assert.deepEqual(events, ["esg:messages-read"]);
});

// Gig hub ------------------------------------------------------------------
function gigHubDb({ gig, claims = [], myClaim = null, address = null, addressQueries = [] }) {
  return fakeDb((query, single) => {
    if (query.table === "gigs") return { data: gig, error: null };
    if (query.table === "gig_private_locations") { addressQueries.push(query.eq.gig_id); return { data: address ? { address_text: address } : null, error: null }; }
    if (query.table === "public_profiles") return { data: [{ id: "poster-1", username: "customer1" }, { id: "helper-1", username: "helper1" }].filter((row) => query.in.id.includes(row.id)), error: null };
    if (query.table === "claims" && query.eq.provider_id) return { data: myClaim, error: null };
    if (query.table === "claims") return { data: claims, error: null };
    return { data: single ? null : [], error: null };
  });
}
async function openGig(fields, db = {}, asUser = user.id) {
  const gig = { id: "gig-1", poster_id: "poster-1", selected_provider_id: null, status: "active", title: "Yard Cleaning", description: "Rake leaves", service_type: "Yard Work",
    photo_url: null, amount: 50, location_text: "Kävlinge", scheduled_at: null, start_requested_at: null, incomplete_choice_phase: false, amount_paid: null, amount_received: null, gig_tags: [], ...fields };
  const rpcs = [];
  const client = gigHubDb({ gig, ...db });
  client.rpc = async (name, args) => { rpcs.push([name, args]); return { error: null }; };
  const app = await component("src/app/gigs/[id]/page.tsx", "GigDetails", {
    client, globals: { window: { confirm: () => true, location: { hash: "" } }, document: { getElementById: () => null } },
    mocks: { "@/components/ChatPanel": { default: "chat-panel" } },
  });
  app.auth.user = { id: asUser };
  app.render({ id: "gig-1" }); await flush();
  return { app, rpcs, tree: app.render({ id: "gig-1" }), props: { id: "gig-1" } };
}

test("Gig hub (owner, open): proposals live on the gig, with Accept offer, Cancel and a back link to My Gigs", async () => {
  const claims = [{ id: "c1", gig_id: "gig-1", provider_id: "helper-1", state: "pending", profile: undefined }];
  const { app, rpcs, tree, props } = await openGig({ poster_id: user.id }, { claims });
  assert.ok(nodes(tree, (node) => node.type === "a" && node.props.href === "/my-gigs" && /My Gigs/.test(textOf(node))));
  const proposals = nodes(tree, (node) => node.props.id === "proposals")[0];
  assert.ok(proposals, "proposals anchor exists for notification/My Gigs deep links");
  assert.match(textOf(proposals), /Your budget: 50 CAD · 1 proposal/);
  await nodes(proposals, (node) => node.type === "button" && textOf(node) === "Accept offer")[0].props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(rpcs[0])), ["select_provider", { p_gig_id: "gig-1", p_claim_id: "c1" }], "uses the existing lifecycle RPC");
  await nodes(tree, (node) => node.type === "button" && textOf(node) === "Cancel gig")[0].props.onClick();
  assert.equal(rpcs[1][0], "cancel_gig");
  void app; void props;
});

test("Gig hub (owner, draft): offers Publish via the existing RPC", async () => {
  const { rpcs, tree } = await openGig({ poster_id: user.id, status: "draft" });
  await nodes(tree, (node) => node.type === "button" && textOf(node) === "Publish gig")[0].props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(rpcs[0])), ["publish_gig", { p_gig_id: "gig-1" }]);
});

test("Gig hub (owner, helper selected): shows the helper and the gig's messages section", async () => {
  const { tree } = await openGig({ poster_id: user.id, selected_provider_id: "helper-1" });
  assert.match(textOf(nodes(tree, (node) => node.type === "p" && /You posted this gig/.test(textOf(node)))[0]), /Helper: @helper1/);
  const messages = nodes(tree, (node) => node.props.id === "messages")[0];
  assert.ok(messages && nodes(messages, (node) => node.type === "chat-panel").length === 1, "existing gig-scoped chat is the Messages section");
});

test("Gig hub (helper): back link goes to I'm Helping and proposal state is explained", async () => {
  const pending = await openGig({}, { myClaim: { id: "mine", gig_id: "gig-1", provider_id: user.id, state: "pending" } });
  assert.ok(nodes(pending.tree, (node) => node.type === "a" && node.props.href === "/my-gigs?tab=helping"));
  assert.ok(nodes(pending.tree, (node) => /Offer sent/.test(textOf(node))).length > 0);

  const accepted = await openGig({ selected_provider_id: user.id }, { myClaim: { id: "mine", gig_id: "gig-1", provider_id: user.id, state: "selected" } });
  assert.ok(nodes(accepted.tree, (node) => /Your offer was accepted/.test(textOf(node))).length > 0);
  assert.ok(nodes(accepted.tree, (node) => node.type === "button" && textOf(node) === "START").length === 1, "existing lifecycle action");
  assert.ok(nodes(accepted.tree, (node) => node.props.id === "messages").length === 1);

  const rejected = await openGig({ selected_provider_id: "other-helper" }, { myClaim: { id: "mine", gig_id: "gig-1", provider_id: user.id, state: "rejected" } });
  assert.ok(nodes(rejected.tree, (node) => /Not selected/.test(textOf(node))).length > 0);
});

test("Gig hub (helper, no offer yet): the offer form defaults to the budget and sends amount and message through create_claim", async () => {
  const { app, rpcs, tree, props } = await openGig({ amount: 50 });
  const form = nodes(tree, (node) => node.type === "form" && node.props["aria-label"] === "Make an offer")[0];
  assert.ok(form, "Make an offer form");
  const amountInput = nodes(form, (node) => node.type === "input")[0];
  assert.equal(amountInput.props.value, "50", "defaults to the posted budget");
  assert.match(textOf(form), /budget is 50 CAD/);
  await form.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(rpcs[0])), ["create_claim", { p_gig_id: "gig-1", p_offer_amount: 50, p_message: null }]);

  nodes(form, (node) => node.type === "input")[0].props.onChange({ target: { value: "42.5" } });
  nodes(form, (node) => node.type === "textarea")[0].props.onChange({ target: { value: "  I can come Saturday  " } });
  const edited = nodes(app.render(props), (node) => node.type === "form" && node.props["aria-label"] === "Make an offer")[0];
  await edited.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(rpcs[1])), ["create_claim", { p_gig_id: "gig-1", p_offer_amount: 42.5, p_message: "I can come Saturday" }]);
});

test("Gig hub (helper): an invalid offer amount is rejected in the UI without calling the server", async () => {
  const { app, rpcs, tree, props } = await openGig({ amount: 50 });
  nodes(tree, (node) => node.type === "input")[0].props.onChange({ target: { value: "-5" } });
  const form = nodes(app.render(props), (node) => node.type === "form")[0];
  await form.props.onSubmit({ preventDefault() {} });
  assert.equal(rpcs.length, 0);
  assert.match(textOf(nodes(app.render(props), (node) => node.props.role === "alert")[0]), /positive offer/);
});

test("Gig hub (helper, pending offer): shows the offer, can withdraw it, and cannot send a second one", async () => {
  const { rpcs, tree } = await openGig({}, { myClaim: { id: "mine", gig_id: "gig-1", provider_id: user.id, state: "pending", offer_amount: 42, message: "Saturday works" } });
  assert.equal(nodes(tree, (node) => node.type === "form").length, 0, "no second offer form");
  assert.match(textOf(nodes(tree, (node) => /Offer sent/.test(textOf(node)))[0]), /42 CAD/);
  await nodes(tree, (node) => node.type === "button" && textOf(node) === "Withdraw offer")[0].props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(rpcs[0])), ["withdraw_claim", { p_gig_id: "gig-1" }]);
});

test("Gig hub (helper, withdrawn offer): offers stay closed because the server never reopens a withdrawn offer", async () => {
  const { tree } = await openGig({}, { myClaim: { id: "mine", gig_id: "gig-1", provider_id: user.id, state: "withdrawn", offer_amount: 42 } });
  assert.equal(nodes(tree, (node) => node.type === "form").length, 0);
  assert.ok(nodes(tree, (node) => /You withdrew your offer/.test(textOf(node))).length > 0);
});

test("Gig hub (owner, open): each proposal shows username, reputation, offer, message, View profile and Accept offer", async () => {
  const profile = { id: "helper-1", username: "helper1", wom_count: 3 };
  const claims = [{ id: "c1", gig_id: "gig-1", provider_id: "helper-1", state: "pending", offer_amount: 40, message: "Bringing my own rake", created_at: "2026-10-01T10:00:00Z" }];
  const client = gigHubDb({ gig: { id: "gig-1", poster_id: user.id, selected_provider_id: null, status: "active", title: "t", description: "d", service_type: "Yard Work", photo_url: null, amount: 50, location_text: "Kävlinge", scheduled_at: null, gig_tags: [] }, claims });
  const baseFrom = client.from;
  client.from = (table) => { const api = baseFrom(table); if (table === "public_profiles") { const then = api.then; api.then = (ok, bad) => then.call(api, (r) => ok({ ...r, data: [profile] }), bad); } return api; };
  client.rpc = async () => ({ error: null });
  const app = await component("src/app/gigs/[id]/page.tsx", "GigDetails", { client, globals: { window: { confirm: () => true, location: { hash: "" } }, document: { getElementById: () => null } }, mocks: { "@/components/ChatPanel": { default: "chat-panel" } } });
  app.render({ id: "gig-1" }); await flush();
  const text = textOf(nodes(app.render({ id: "gig-1" }), (node) => node.props.id === "proposals")[0]);
  assert.match(text, /@helper1 · 3 WOM/);
  assert.match(text, /40 CAD/);
  assert.match(text, /Bringing my own rake/);
  assert.match(text, /View profile/);
  assert.match(text, /Accept offer/);
});

test("Gig hub (accepted): poster and accepted helper both see agreed price, private address and a Message button", async () => {
  for (const [asUser, fields, other] of [[user.id, { poster_id: user.id, selected_provider_id: "helper-1" }, "Message helper"], [user.id, { selected_provider_id: user.id }, "Message poster"]]) {
    const addressQueries = [];
    const { tree } = await openGig({ amount: 50, agreed_amount: 40, ...fields }, { address: "Storgatan 1, 2tr", addressQueries }, asUser);
    assert.match(textOf(nodes(tree, (node) => node.props["aria-label"] === "Private address")[0]), /Storgatan 1, 2tr/);
    assert.match(textOf(tree), /Agreed 40 CAD/);
    assert.match(textOf(tree), /budget 50 CAD/);
    assert.ok(nodes(tree, (node) => node.type === "a" && node.props.href === "#messages" && textOf(node) === other).length === 1);
    assert.deepEqual(addressQueries, ["gig-1"]);
  }
});

test("Gig hub: the private address is never requested or rendered for helpers who are not the accepted one", async () => {
  const addressQueries = [];
  const open = await openGig({ amount: 50 }, { address: "Secret 9", addressQueries });
  const rejected = await openGig({ selected_provider_id: "other-helper" }, { address: "Secret 9", addressQueries, myClaim: { id: "mine", gig_id: "gig-1", provider_id: user.id, state: "rejected", offer_amount: 40 } });
  const pending = await openGig({}, { address: "Secret 9", addressQueries, myClaim: { id: "mine", gig_id: "gig-1", provider_id: user.id, state: "pending", offer_amount: 40 } });
  assert.deepEqual(addressQueries, [], "no query against gig_private_locations for non-participants");
  for (const { tree } of [open, rejected, pending]) {
    assert.equal(nodes(tree, (node) => node.props["aria-label"] === "Private address").length, 0);
    assert.doesNotMatch(JSON.stringify(tree), /Secret 9/);
  }
});

test("Gig hub: a visitor who neither posted nor proposed gets no back link, and a gig is capped to a readable width", async () => {
  const { tree } = await openGig({});
  assert.equal(nodes(tree, (node) => node.type === "a" && /My Gigs/.test(textOf(node))).length, 0);
  assert.match(tree.props.className, /max-w-2xl/);
});


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
    }, rpc: async () => ({ data: null, error: null }) };
    const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
    app.render({ profile }); await flush();
    let tree = app.render({ profile });
    // The test harness's default "@/lib/services" mock only offers Cleaning/Other.
    const chip = (label) => nodes(tree, (node) => node.type === "selection-chip" && node.props.children === label)[0];
    chip("Other").props.onClick(); // the first "Other" chip belongs to the skills group
    tree = app.render({ profile });
    await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
    tree = app.render({ profile });
    assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ skills: ["Cleaning", "Other"], services: ["Other"] }]);
    assert.equal(nodes(tree, (node) => node.props.role === "status").length, fails ? 0 : 1);
    assert.equal(nodes(tree, (node) => node.props.role === "alert").length, fails ? 1 : 0);
    app.auth.profileError = "Refresh failed";
    tree = app.render({ profile: { ...profile, username: "Server123" } });
    assert.ok(chip("Other"), "unrelated background refresh failure does not blow away the unsaved skill selection");
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

async function postGigLocation({ geolocation, reverse, initialText = "" }) {
  const calls = [], lookups = [];
  const app = await component("src/app/post/page.tsx", "PostGigForm", {
    client: { rpc: async (name, payload) => { calls.push({ name, payload }); return { data: { id: "created", status: "active" }, error: null }; } },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    globals: { navigator: { geolocation } },
    mocks: {
      "@/lib/location": { loadJourneyLocation: () => ({ text: initialText, lat: null, lng: null }), reverseGeocodeGeneralArea: async (lat, lng) => { lookups.push({ lat, lng }); return reverse(); } },
      "@/lib/tags": { loadTagCatalog: async () => ({}), gigTagNames: () => [], MAX_GIG_TAGS: 8 },
    },
  });
  app.render(); await flush();
  return { app, calls, lookups, tree: app.render() };
}
const locationInput = (tree) => nodes(tree, (node) => node.type === "input" && node.props.maxLength === 200)[0];
const locateButton = (tree) => nodes(tree, (node) => node.type === "button" && /Use my current location/.test(String(node.props.children)))[0];

test("Post Gig offers 'Use my current location', filling a locality and submitting only rounded coordinates", async () => {
  const { app, calls, lookups, tree: first } = await postGigLocation({
    geolocation: { getCurrentPosition: (success) => success({ coords: { latitude: 55.789, longitude: 13.114 } }) },
    reverse: async () => "Kävlinge, Sweden",
  });
  assert.ok(locateButton(first), "the option exists on the Post a Gig form");
  locateButton(first).props.onClick(); await flush();
  let tree = app.render();
  // A successful lookup collapses the picker to a summary; reopen it to check the filled value.
  button(tree, "Update location").props.onClick();
  tree = app.render();
  assert.equal(locationInput(tree).props.value, "Kävlinge, Sweden");
  assert.deepEqual(lookups, [{ lat: 55.79, lng: 13.11 }], "only rounded coordinates leave the browser");
  for (const [predicate, value] of [
    [(node) => node.type === "input" && node.props.maxLength === 120, "Test gig"],
    [(node) => node.type === "textarea", "Test description"],
    [(node) => node.props.type === "number", "10"],
    [(node) => node.props.type === "datetime-local", new Date(Date.now() + 86400000).toISOString().slice(0, 16)],
  ]) nodes(tree, predicate)[0].props.onChange({ target: { value } });
  tree = app.render(); button(tree, "Post Gig").props.onClick(); await flush();
  const payload = JSON.parse(JSON.stringify(calls[0].payload));
  assert.equal(payload.p_location_text, "Kävlinge, Sweden");
  assert.deepEqual([payload.p_lat, payload.p_lng], [55.79, 13.11]);
});

test("Post Gig 'Use my current location': denial and lookup failure never write the literal placeholder", async () => {
  const denied = await postGigLocation({ geolocation: { getCurrentPosition: (_ok, fail) => fail() }, reverse: async () => null });
  locateButton(denied.tree).props.onClick();
  let tree = denied.app.render();
  assert.equal(nodes(tree, (node) => node.props.role === "status" && node.props.children === "We couldn't access your location. Enter your area manually.").length, 1);
  assert.equal(locationInput(tree).props.value, "");

  const offline = await postGigLocation({
    geolocation: { getCurrentPosition: (success) => success({ coords: { latitude: 55.789, longitude: 13.114 } }) },
    reverse: async () => { throw new Error("offline"); }, initialText: "Existing area",
  });
  // Existing text means the picker opens collapsed; reopen it to reach "Use my current location".
  button(offline.tree, "Update location").props.onClick();
  const offlineExpanded = offline.app.render();
  locateButton(offlineExpanded).props.onClick(); await flush();
  tree = offline.app.render();
  assert.equal(nodes(tree, (node) => node.props.role === "status" && node.props.children === "Couldn't determine your area automatically. Enter it manually.").length, 1);
  assert.equal(locationInput(tree).props.value, "Existing area", "a failed lookup leaves what was there, never 'Current location'");
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
      "@/lib/location": { LOCATION_KEY: "esg:general-area", loadJourneyLocation: () => ({ text: "", lat: null, lng: null }) },
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
      "@/lib/location": { LOCATION_KEY: "esg:general-area", loadJourneyLocation: () => ({ text: "", lat: null, lng: null }), reverseGeocodeGeneralArea: async (lat, lng) => { lookups.push({ lat, lng }); return "Kävlinge, Sweden"; } },
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
  // Browse now reads the saved area itself (sessionStorage/localStorage), the same way Find a
  // Helper does, instead of needing it repeated in the URL.
  assert.deepEqual(destinations, ["/browse"]);
  assert.deepEqual(lookups, [{ lat: 12.35, lng: -45.68 }]);
  assert.deepEqual(locations, [{ text: "Kävlinge, Sweden", lat: 12.35, lng: -45.68 }]);
});

test("reverse-geocoding failure keeps coordinates and the Current location fallback", async () => {
  const locations = [];
  const app = await component("src/app/location/page.tsx", "LocationEntryInner", {
    storage: { setItem: (_key, value) => locations.push(JSON.parse(value)) },
    globals: { navigator: { geolocation: { getCurrentPosition: (success) => success({ coords: { latitude: 55.789, longitude: 13.114 } }) } } },
    mocks: {
      "@/lib/location": { LOCATION_KEY: "esg:general-area", loadJourneyLocation: () => ({ text: "", lat: null, lng: null }), reverseGeocodeGeneralArea: async () => { throw new Error("offline"); } },
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
      "@/lib/location": { LOCATION_KEY: "esg:general-area", loadJourneyLocation: () => ({ text: "", lat: null, lng: null }), reverseGeocodeGeneralArea: async () => null },
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
    const app = await component("src/app/page.tsx", "HomeInner");
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

// ESG-AUTH-002 v0.5 §4: email-link registration, BR-REG-002 checked via
// email_registered() before anything is sent -- no password is collected here
// at all anymore (that moved to /auth/register, after email verification).
async function signUpApp(emailRegistered, { signInWithOtp = async () => ({ error: null }) } = {}) {
  const app = await component("src/app/auth/sign-up/page.tsx", "SignUpInner", {
    client: { rpc: async () => ({ data: emailRegistered, error: null }), auth: { signInWithOtp } },
    globals: { window: { location: { origin: "http://localhost:3001" } } },
  });
  app.auth.user = null; app.auth.profile = null;
  let tree = app.render();
  nodes(tree, (node) => node.props.id === "signup-email")[0].props.onChange({ target: { value: "person@example.com" } });
  tree = app.render();
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  return app.render();
}
const existsAlert = (tree) => nodes(tree, (node) => node.props.role === "alert" && node.props.children === "This email is already registered.");

test("Sign Up tells the user when the email is already registered, offering Sign In / Use Another Email, and never sends a link", async () => {
  const sent = [];
  const tree = await signUpApp(true, { signInWithOtp: async (args) => { sent.push(args); return { error: null }; } });
  assert.equal(existsAlert(tree).length, 1);
  assert.equal(nodes(tree, (node) => node.props.children === "Check Your Email").length, 0, "does not claim a link was sent");
  assert.deepEqual(sent, [], "never calls signInWithOtp for an already-registered email");
  assert.ok(nodes(tree, (node) => node.type === "a" && node.props.href === "/auth/sign-in").length, "offers Sign In");
  assert.ok(nodes(tree, (node) => node.type === "button" && node.props.children === "Use Another Email").length);
});

test("Sign Up for a genuinely new email sends a verification link (no password collected) and shows Check Your Email", async () => {
  const sent = [];
  const tree = await signUpApp(false, { signInWithOtp: async (args) => { sent.push(args); return { error: null }; } });
  assert.equal(existsAlert(tree).length, 0);
  assert.equal(nodes(tree, (node) => node.props.children === "Check Your Email").length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
    email: "person@example.com",
    options: { emailRedirectTo: "http://localhost:3001/auth/callback?flow=register", shouldCreateUser: true },
  }]);
  assert.equal(nodes(tree, (node) => node.type === "input" && node.props.type === "password").length, 0, "no password field exists on this screen");
});

test("authenticated Sign Up resumes registration (incomplete profile) or goes Home (already finished)", async () => {
  for (const [onboarding_completed_at, expected] of [[null, "/auth/register"], ["2026-01-01", "/"]]) {
    const destinations = [];
    const app = await component("src/app/auth/sign-up/page.tsx", "SignUpInner", {
      client: {},
      mocks: { "next/navigation": { useRouter: () => ({ replace: (url) => destinations.push(url) }) } },
    });
    app.auth.profile = { ...profile, onboarding_completed_at };
    const tree = app.render();
    assert.deepEqual(destinations, [expected]);
    assert.equal(nodes(tree, (node) => node.type === "form").length, 0);
  }
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

// ESG-AUTH-003 v1.0: email -> code (no reset link, no PKCE) -> new password.
// This Supabase project sends an 8-digit code (its OTP length isn't exposed
// as a dashboard setting); see forgot-password/page.tsx's top comment.
async function forgotPasswordPage({ client, destinations = [] }) {
  return component("src/app/auth/forgot-password/page.tsx", "ForgotPassword", {
    client,
    mocks: { "next/navigation": { useRouter: () => ({ replace: (url) => destinations.push(url) }) } },
  });
}

test("forgot-password validates email format client-side before sending anything", async () => {
  const sent = [];
  const app = await forgotPasswordPage({ client: { auth: { resetPasswordForEmail: async (email) => { sent.push(email); return { error: null }; } } } });
  let tree = app.render();
  nodes(tree, (node) => node.props.id === "recovery-email")[0].props.onChange({ target: { value: "not-an-email" } });
  tree = app.render();
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  tree = app.render();
  assert.deepEqual(sent, [], "an invalid email never reaches Supabase");
  assert.equal(String(nodes(tree, (node) => node.props.role === "alert")[0].props.children), "Enter a valid email address.");
});

test("forgot-password sends a recovery code without exposing account existence, disabling submit while pending, then shows the code step", async () => {
  const requests = [];
  let resolveRequest;
  const app = await forgotPasswordPage({
    client: { auth: { resetPasswordForEmail: async (email) => {
      requests.push(email);
      return new Promise((resolve) => { resolveRequest = () => resolve({ error: null }); });
    } } },
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
  assert.deepEqual(requests, ["person@example.com"]);
  assert.equal(nodes(tree, (node) => String(node.props.children).includes("If an ESG account exists for this email")).length, 1);
  assert.ok(nodes(tree, (node) => node.props.id === "recovery-code").length, "moves to the code-entry step");
  assert.equal(event.defaultPrevented, true);
});

async function codeStep(client, destinations = []) {
  const app = await forgotPasswordPage({ client, destinations });
  let tree = app.render();
  nodes(tree, (node) => node.props.id === "recovery-email")[0].props.onChange({ target: { value: "person@example.com" } });
  tree = app.render();
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  return { app, destinations };
}

test("forgot-password code step requires exactly 8 digits before calling Supabase", async () => {
  const verifies = [];
  const { app } = await codeStep({ auth: {
    resetPasswordForEmail: async () => ({ error: null }),
    verifyOtp: async (args) => { verifies.push(args); return { error: null }; },
  } });
  let tree = app.render();
  nodes(tree, (node) => node.props.id === "recovery-code")[0].props.onChange({ target: { value: "123" } });
  tree = app.render();
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  tree = app.render();
  assert.deepEqual(verifies, []);
  assert.equal(String(nodes(tree, (node) => node.props.role === "alert")[0].props.children), "Enter the 8-digit verification code.");
});

test("forgot-password verifies the code via email+token (no token_hash, no PKCE) and redirects to reset-password", async () => {
  const verifies = [];
  const { app, destinations } = await codeStep({ auth: {
    resetPasswordForEmail: async () => ({ error: null }),
    verifyOtp: async (args) => { verifies.push(args); return { error: null }; },
  } });
  let tree = app.render();
  nodes(tree, (node) => node.props.id === "recovery-code")[0].props.onChange({ target: { value: "12345678" } });
  tree = app.render();
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(verifies)), [{ email: "person@example.com", token: "12345678", type: "recovery" }]);
  assert.deepEqual(destinations, ["/auth/reset-password"]);
});

test("forgot-password: an invalid or expired code shows an error and stays on the code step", async () => {
  const { app, destinations } = await codeStep({ auth: {
    resetPasswordForEmail: async () => ({ error: null }),
    verifyOtp: async () => ({ error: { code: "otp_expired", message: "Token has expired or is invalid" } }),
  } });
  let tree = app.render();
  nodes(tree, (node) => node.props.id === "recovery-code")[0].props.onChange({ target: { value: "00000000" } });
  tree = app.render();
  await nodes(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  tree = app.render();
  assert.deepEqual(destinations, [], "a failed verification does not navigate away");
  assert.equal(String(nodes(tree, (node) => node.props.role === "alert")[0].props.children), "Verification code expired.");
  assert.ok(nodes(tree, (node) => node.props.id === "recovery-code").length, "still on the code step for another attempt");
});

test("forgot-password: resend code re-sends and updates the notice", async () => {
  const requests = [];
  const { app } = await codeStep({ auth: { resetPasswordForEmail: async (email) => { requests.push(email); return { error: null }; } } });
  let tree = app.render();
  nodes(tree, (node) => node.type === "button" && node.props.children === "Resend code")[0].props.onClick();
  await flush();
  tree = app.render();
  assert.deepEqual(requests, ["person@example.com", "person@example.com"]);
  assert.equal(nodes(tree, (node) => String(node.props.children).includes("we've sent a new verification code")).length, 1);
});

async function recoveryPage({ client, destinations = [] }) {
  return component("src/app/auth/reset-password/page.tsx", "ResetPassword", {
    client,
    mocks: { "next/navigation": { useRouter: () => ({ replace: (url) => destinations.push(url) }) } },
  });
}
const recoveryForm = (tree) => nodes(tree, (node) => node.type === "form")[0];
const recoveryAlert = (tree) => nodes(tree, (node) => node.props.role === "alert")[0];

test("reset-password shows the password form once an existing recovery session is confirmed", async () => {
  const app = await recoveryPage({ client: { auth: { getSession: async () => ({ data: { session: { user: { id: "u" } } }, error: null }) } } });
  let tree = app.render();
  assert.equal(recoveryForm(tree), undefined, "no form before the session check resolves");
  await flush();
  tree = app.render();
  assert.ok(recoveryForm(tree), "form appears once a recovery session is confirmed");
});

test("reset-password: no session asks to request another code, never showing the form", async () => {
  const app = await recoveryPage({ client: { auth: { getSession: async () => ({ data: { session: null }, error: null }) } } });
  app.render(); await flush();
  const tree = app.render();
  assert.equal(recoveryForm(tree), undefined);
  assert.match(String(recoveryAlert(tree).props.children), /Verify your email code again/);
});

async function submitNewPassword(updateUser, { password = "Replacement1!", confirm = password } = {}) {
  const updates = []; const signOuts = [];
  const app = await recoveryPage({
    client: { auth: {
      getSession: async () => ({ data: { session: { user: { id: "u" } } }, error: null }),
      updateUser: async (args) => { updates.push(args.password); return updateUser(); },
      signOut: async () => { signOuts.push(true); },
    } },
  });
  app.render(); await flush();
  let tree = app.render();
  const inputs = nodes(tree, (node) => node.type === "input");
  inputs[0].props.onChange({ target: { value: password } });
  inputs[1].props.onChange({ target: { value: confirm } });
  tree = app.render();
  await recoveryForm(tree).props.onSubmit({ preventDefault() {} });
  tree = app.render();
  return { tree, updates, signOuts, alert: recoveryAlert(tree) ? String(recoveryAlert(tree).props.children) : null };
}

test("reset-password: a same-as-current password shows a specific message, not the generic one", async () => {
  for (const error of [
    { code: "same_password", status: 422, message: "New password should be different from the old password." },
    { status: 422, message: "New password should be different from the old password." },
  ]) {
    const { alert, updates } = await submitNewPassword(async () => ({ error }));
    assert.equal(alert, "Your new password must be different from your current password.");
    assert.equal(updates.length, 1);
  }
});

test("reset-password: other known password errors map to concise messages", async () => {
  const cases = [
    [{ code: "weak_password" }, /stronger password/],
    [{ code: "over_request_rate_limit" }, /Too many requests/],
    [{ code: "session_expired" }, /reset session has expired/],
  ];
  for (const [error, expected] of cases) {
    const { alert } = await submitNewPassword(async () => ({ error }));
    assert.match(alert, expected);
  }
});

test("reset-password: unknown errors use the generic fallback and never echo raw provider details", async () => {
  const { alert } = await submitNewPassword(async () => ({ error: { code: "unexpected_failure", status: 500, message: "internal detail user_id=abc123 token=SECRET stack at db.js:1" } }));
  assert.equal(alert, "Couldn't update your password. Please try again.");
  const thrown = await submitNewPassword(async () => { throw new Error("network exploded SECRET"); });
  assert.equal(thrown.alert, "Couldn't update your password. Please try again.");
});

test("reset-password: a password mismatch is still caught client-side, without calling Supabase", async () => {
  const { alert, updates } = await submitNewPassword(async () => ({ error: null }), { password: "Replacement1!", confirm: "Different1!" });
  assert.equal(alert, "Passwords don't match.");
  assert.deepEqual(updates, []);
  const weak = await submitNewPassword(async () => ({ error: null }), { password: "short" });
  assert.match(weak.alert, /at least 10 characters/);
  assert.deepEqual(weak.updates, []);
});

test("reset-password: a successful update signs out (BR-AUTH3-008: no auto sign-in) and shows the Sign In link, no error", async () => {
  const { tree, signOuts } = await submitNewPassword(async () => ({ error: null }));
  assert.equal(signOuts.length, 1, "the recovery session is signed out after a successful reset");
  assert.ok(nodes(tree, (node) => node.props.children === "Your password was successfully reset.").length, 1);
  assert.ok(nodes(tree, (node) => node.type === "a" && node.props.href === "/auth/sign-in").length, 1);
  assert.equal(recoveryAlert(tree), undefined);
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

test("Post Gig sends the optional private address separately from the public location, and null when blank", async () => {
  for (const [typed, expected] of [["  Storgatan 1, 2tr  ", "Storgatan 1, 2tr"], ["   ", null]]) {
    const calls = [], values = new Map();
    const app = await component("src/app/post/page.tsx", "PostGigForm", {
      client: { rpc: async (name, payload) => { calls.push({ name, payload }); return { data: { id: "created", status: "active" }, error: null }; } },
      storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
      mocks: { "@/lib/location": { loadJourneyLocation: () => ({ text: "Kävlinge", lat: null, lng: null }) } },
    });
    let tree = app.render();
    for (const [predicate, value] of [
      [(node) => node.type === "input" && node.props.maxLength === 120, "Test gig"],
      [(node) => node.type === "textarea", "Test description"],
      [(node) => node.props.type === "number", "10"],
      [(node) => node.props.type === "datetime-local", new Date(Date.now() + 86400000).toISOString().slice(0, 16)],
      [(node) => node.type === "input" && node.props.maxLength === 300, typed],
    ]) nodes(tree, predicate)[0].props.onChange({ target: { value } });
    tree = app.render(); button(tree, "Post Gig").props.onClick(); await flush();
    assert.equal(calls[0].payload.p_private_address, expected);
    assert.equal(calls[0].payload.p_location_text, "Kävlinge", "public location text is independent of the private address");
    assert.doesNotMatch(textOf(tree), /undefined/);
  }
});

test("money: amounts are shown in the single app currency and offers are validated like the server", () => {
  assert.equal(moneyLib.formatMoney(50), "50 CAD");
  assert.equal(moneyLib.formatMoney("1234.5"), "1,234.5 CAD");
  assert.equal(moneyLib.formatMoney(null), "");
  for (const bad of ["", "0", "-1", "1.234", "abc", "NaN", "Infinity", "1e3", "99999999999"]) assert.notEqual(moneyLib.offerError(bad), null, `rejects ${bad}`);
  for (const good of ["0.01", "50", "42.5", "9999999999.99"]) assert.equal(moneyLib.offerError(good), null, `accepts ${good}`);
});

test("withProfileTags attaches tags per profile in the embed shape, in batches, and surfaces query errors", async () => {
  const source = await readFile(new URL("../src/lib/tags.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  runInNewContext(`(function(require, module, exports) { ${code}
})`, {})((id) => ({}), loaded, loaded.exports);
  const { withProfileTags } = loaded.exports;
  const queries = [];
  const links = [{ profile_id: "p1", tag: { id: "t1", name: "Deep Cleaning", service_type: "Cleaning" } }, { profile_id: "p1", tag: { id: "t2", name: "Kitchen", service_type: "Cleaning" } }];
  const client = (error) => ({ from: (table) => ({ select: (columns) => ({ in: async (column, ids) => {
    queries.push({ table, columns, column, count: ids.length });
    return error ? { data: null, error } : { data: links.filter((link) => ids.includes(link.profile_id)), error: null };
  } }) }) });
  const profiles = [{ id: "p1", username: "A" }, { id: "p2", username: "B" }];
  const result = JSON.parse(JSON.stringify(await withProfileTags(client(null), profiles)));
  assert.deepEqual(result.map((row) => [row.username, row.profile_tags.map((link) => link.tag.name)]), [["A", ["Deep Cleaning", "Kitchen"]], ["B", []]]);
  assert.deepEqual(queries[0], { table: "profile_tags", columns: "profile_id, tag:tags(id,name,service_type)", column: "profile_id", count: 2 }, "queries profile_tags directly, never an embed on public_profiles");
  queries.length = 0;
  await withProfileTags(client(null), Array.from({ length: 250 }, (_, i) => ({ id: `x${i}` })));
  assert.deepEqual(queries.map((query) => query.count), [100, 100, 50]);
  assert.deepEqual(await withProfileTags(client(null), []), []);
  await assert.rejects(() => withProfileTags(client(new Error("boom")), profiles), /boom/);
});

test("Find a Helper and public profiles never embed profile_tags in a public_profiles query (no such relationship exists)", async () => {
  for (const path of ["../src/app/find-helper/page.tsx", "../src/app/profile/[username]/page.tsx"]) {
    assert.doesNotMatch(await readFile(new URL(path, import.meta.url), "utf8"), /select\("\*, profile_tags/, path);
  }
});

// Regression: hosted public_profiles has no relationship to profile_tags, so helpers
// are loaded in two requests. These tests run the real withProfileTags() against a
// client that answers each table the way PostgREST does -- public_profiles rows carry
// no profile_tags field, and a helper with no tags simply has no profile_tags rows.
async function yardWorkHelperPage(profiles, tagLinks = [], filters = []) {
  const source = await readFile(new URL("../src/lib/tags.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  runInNewContext(`(function(require, module, exports) { ${code}\n})`, {})(() => ({}), loaded, loaded.exports);
  const queries = [];
  const client = { from: (table) => ({ select: (columns) => {
    queries.push({ table, columns });
    if (table === "public_profiles") return { contains: (column, value) => ({
      then: (resolve, reject) => Promise.resolve(skillsContains(profiles, filters, column, value)).then(resolve, reject),
    }) };
    return { in: async (_column, ids) => ({ data: tagLinks.filter((link) => ids.includes(link.profile_id)), error: null }) };
  } }) };
  const app = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client,
    mocks: {
      "@/lib/services": { SERVICE_TYPES: ["Yard Work", "Cleaning"], SPECIALIZATION_PROMPTS: { "Yard Work": "What kind of yard work?" } },
      "@/lib/tags": { ...loaded.exports, loadTagCatalog: async () => ({}) },
      "@/lib/location": originLocationMock,
    },
  });
  app.render(); await flush();
  let tree = app.render();
  nodes(tree, (node) => node.type === "selection-chip" && node.props.children === "Yard Work")[0].props.onClick();
  tree = app.render(); await flush();
  return { app, queries, tree: app.render() };
}
const noTagsNoLocationHelper = { id: "b", username: "AccountB", photo_url: null, skills: ["Yard Work"], wom_count: 0, public_location_text: null, public_lat: null, public_lng: null };

test("Find a Helper: a Yard Work helper with no profile_tags and no public location appears for the category with Any distance", async () => {
  const other = { id: "c", username: "CleaningOnly", photo_url: null, skills: ["Cleaning"], wom_count: 0, public_lat: null, public_lng: null };
  const { tree, queries } = await yardWorkHelperPage([noTagsNoLocationHelper, other]);
  assert.equal(nodes(tree, (node) => node.props.role === "alert").length, 0, "no load error");
  assert.equal(nodes(tree, (node) => /Couldn't load helpers/.test(textOf(node))).length, 0);
  assert.deepEqual(helperUsernames(tree), ["AccountB"], "found by category skill alone; other categories excluded");
  assert.equal(nodes(tree, (node) => node.props.children === "Matching specializations").length, 0, "no specialization filter is applied unless one is selected");
  assert.deepEqual(queries.map((query) => query.table), ["public_profiles", "profile_tags"]);
  assert.equal(queries[0].columns, "*", "public_profiles is queried without embedding profile_tags");
});

test("Find a Helper filters the JSONB skills column with a JSON containment value, never a PostgreSQL array literal", async () => {
  const filters = [];
  const { tree } = await yardWorkHelperPage([noTagsNoLocationHelper], [], filters);
  assert.deepEqual(filters, ["skills=cs.[\"Yard Work\"]"], "exact PostgREST filter sent for category Yard Work");
  assert.doesNotMatch(filters[0], /cs.{/, "must not be the array form cs.{Yard Work}");
  assert.deepEqual(helperUsernames(tree), ["AccountB"], "the helper is returned, not a load error");
  assert.equal(nodes(tree, (node) => node.props.role === "alert").length, 0);
  // The harness rejects the array form exactly as the hosted jsonb column does.
  assert.equal(skillsContains([], [], "skills", ["Yard Work"]).error.code, "22P02");
  assert.equal(skillsContains([], [], "skills", JSON.stringify(["Yard Work"])).error, null);
});

test("Find a Helper: a helper without public coordinates shows for Any distance and is excluded for 5, 10 and 25 km", async () => {
  const located = { id: "a", username: "NearHelper", photo_url: null, skills: ["Yard Work"], wom_count: 1, public_lat: 0.01, public_lng: 0 };
  const { app, tree: first } = await yardWorkHelperPage([noTagsNoLocationHelper, located]);
  assert.deepEqual(helperUsernames(first).sort(), ["AccountB", "NearHelper"], "Any distance (default) includes the helper with no coordinates");
  let tree = first;
  for (const radius of [5, 10, 25]) {
    tree = setDistance(app, tree, radius);
    assert.deepEqual(helperUsernames(tree), ["NearHelper"], `${radius} km excludes the helper with no public coordinates`);
  }
  tree = setDistance(app, tree, null);
  assert.deepEqual(helperUsernames(tree).sort(), ["AccountB", "NearHelper"], "back to Any distance, the helper returns");
});

// ---------------------------------------------------------------------------
// Signed-out "I Need Help -> Find a Helper": search is public, a helper's profile is not.
// ---------------------------------------------------------------------------
const helperSkillsProfile = (id, username, extra = {}) => ({ id, username, photo_url: null, skills: ["Cleaning", "Other"], wom_count: 2, profile_tags: [], ...extra });

async function openFindHelper({ profiles = [helperSkillsProfile("a", "HelperOne")], user: signedInUser = null, authLoading = false, globals = {}, mocks = {} } = {}) {
  const filters = [];
  const app = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client: helperClient(profiles, filters),
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({}), ...helperTagsMock }, "@/lib/location": originLocationMock, ...mocks },
    globals,
  });
  app.auth.user = signedInUser;
  app.auth.loading = authLoading;
  app.render(); await flush();
  let tree = app.render();
  nodes(tree, (node) => node.type === "selection-chip" && node.props.children === "Cleaning")[0].props.onClick();
  tree = app.render(); await flush();
  return { app, filters, tree: app.render() };
}
const helperCards = (tree) => nodes(tree, (node) => node.props?.profile?.username);
// HelperCard is a local component the harness never invokes: call it to get its rendered link.
const renderCard = (card) => card.type(card.props);

test("Find a Helper and its search stay public: no AuthGuard anywhere; only the profile route is gated, on the server", async () => {
  const findHelperSource = await readFile(new URL("../src/app/find-helper/page.tsx", import.meta.url), "utf8");
  const profileSource = await readFile(new URL("../src/app/profile/[username]/page.tsx", import.meta.url), "utf8");
  const proxySource = await readFile(new URL("../src/proxy.ts", import.meta.url), "utf8");
  assert.doesNotMatch(findHelperSource, /AuthGuard/, "searching must never require an account");
  assert.doesNotMatch(profileSource, /AuthGuard/, "the profile route is protected by src/proxy.ts, not by the page-level redirect guard");
  assert.match(proxySource, /matcher: \["\/profile\/:username"\]/, "the server-side guard covers exactly the helper-profile route (not the visitor's own /profile)");
  assert.match(proxySource, /supabase\.auth\.getUser\(\)/, "the session is verified with Supabase Auth, not just read from a cookie");
});

test("Find a Helper (signed out): the list is visible and clicking a helper opens the sign-in prompt instead of the profile", async () => {
  const { app, tree } = await openFindHelper({ user: null });
  const cards = helperCards(tree);
  assert.deepEqual(cards.map((card) => card.props.profile.username), ["HelperOne"], "the signed-out visitor sees the matching helper");
  assert.equal(cards[0].props.gated, true);
  const link = renderCard(cards[0]);
  assert.equal(link.props.href, "/profile/HelperOne?from=find-helper&category=Cleaning", "the link still targets the protected route and carries the search context");
  let prevented = false;
  link.props.onClick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true, "the click does not navigate to the profile");
  const after = app.render();
  const sheet = nodes(after, (node) => node.type === "option-sheet")[0];
  assert.ok(sheet, "a sign-in prompt sheet opens");
  assert.match(sheet.props.title, /Sign in to view @HelperOne/);
  const prompt = nodes(sheet, (node) => node.type === "helper-signin-prompt")[0];
  assert.equal(prompt.props.username, "HelperOne");
  assert.equal(prompt.props.destination, "/profile/HelperOne?from=find-helper&category=Cleaning");
  prompt.props.onContinueBrowsing();
  const closed = app.render();
  assert.equal(nodes(closed, (node) => node.type === "option-sheet").length, 0, "Continue browsing closes the prompt");
  assert.deepEqual(helperCards(closed).map((card) => card.props.profile.username), ["HelperOne"], "and the list is still there");
});

test("Find a Helper (signed in, or auth still loading): cards are ordinary links; the server decides while loading", async () => {
  for (const options of [{ user: { id: "u1" } }, { user: null, authLoading: true }]) {
    const { app, tree } = await openFindHelper(options);
    const card = helperCards(tree)[0];
    assert.equal(card.props.gated, false);
    let prevented = false;
    renderCard(card).props.onClick({ preventDefault() { prevented = true; } });
    assert.equal(prevented, false, "the click is not intercepted");
    assert.equal(nodes(app.render(), (node) => node.type === "option-sheet").length, 0);
  }
});

test("Find a Helper shows the distance whenever both positions are known, only a radius filters, and every skill is listed", async () => {
  const kmPerDegLat = haversineKm(0, 0, 1, 0);
  const profiles = [
    helperSkillsProfile("n", "NearHelper", { public_lat: 4 / kmPerDegLat, public_lng: 0, skills: ["Cleaning", "Handyman", "Pet Care"] }),
    helperSkillsProfile("x", "NoLocation"),
  ];
  const { app, tree } = await openFindHelper({ profiles });
  const byName = Object.fromEntries(helperCards(tree).map((card) => [card.props.profile.username, card.props.distanceKm]));
  assert.ok(Math.abs(byName.NearHelper - 4) < 0.05, "distance is shown with Any distance");
  assert.equal(byName.NoLocation, undefined, "a helper without a public position has no distance but is still listed");
  assert.match(textOf(renderCard(helperCards(tree)[0])), /Offers:\s*Cleaning · Handyman · Pet Care/, "the requested service and every other one");
  const crowded = helperCards(tree)[0];
  const crowdedText = textOf(crowded.type({ ...crowded.props, profile: { ...crowded.props.profile, skills: ["A", "B", "Cleaning", "C", "D", "E", "F", "B"] } }));
  assert.match(crowdedText, /Offers:\s*Cleaning · A · B · C · D · E · F\b/, "all of them, the searched one first, none dropped or repeated");
  assert.doesNotMatch(crowdedText, /more/, "no skill is hidden behind a +N more");
  const afterRadius = setDistance(app, tree, 5);
  assert.deepEqual(helperCards(afterRadius).map((card) => card.props.profile.username), ["NearHelper"], "a radius filters");
  // No position at all: a radius cannot apply, and the visitor is told how to add one.
  const noPosition = await openFindHelper({ profiles, mocks: { "@/lib/location": { loadJourneyLocation: () => ({ text: "", lat: null, lng: null }), haversineKm } } });
  const hinted = setDistance(noPosition.app, noPosition.tree, 5);
  assert.match(textOf(nodes(hinted, (node) => node.props.role === "status")[0]), /Add a ZIP code or use your location/);
  assert.equal(helperCards(hinted).length, 2, "nothing is hidden by a radius that cannot be measured");
});

test("Find a Helper reads the saved area only after hydration, so the server HTML and the first client render agree", async () => {
  const app = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client: helperClient([], []),
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({}), ...helperTagsMock },
      "@/lib/location": { loadJourneyLocation: () => ({ text: "Stockholm, Sweden", lat: 59.33, lng: 18.07 }), haversineKm } },
  });
  app.auth.user = null;
  const picker = (tree) => nodes(tree, (node) => node.type === "area-picker")[0];
  assert.equal(picker(app.render()).props.area.text, "", "first render: nothing from browser storage (the server cannot see it)");
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(picker(app.render()).props.area)), { text: "Stockholm, Sweden", lat: 59.33, lng: 18.07 }, "then the saved area appears");
});

test("Find a Helper restores a search from ?category=, ignores unknown values, and keeps the category in the address", async () => {
  const history = [];
  const withQuery = (search) => ({ window: { location: { search }, history: { replaceState: (...args) => history.push(args[2]) } } });
  const restored = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client: helperClient([helperSkillsProfile("a", "HelperOne")]), globals: withQuery("?category=Cleaning"),
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({}), ...helperTagsMock }, "@/lib/location": originLocationMock },
  });
  restored.auth.user = null;
  restored.render(); await flush(); restored.render(); await flush();
  const tree = restored.render();
  assert.equal(nodes(tree, (node) => node.type === "selection-chip" && node.props.children === "Cleaning")[0].props.selected, true);
  assert.deepEqual(helperCards(tree).map((card) => card.props.profile.username), ["HelperOne"]);
  assert.deepEqual(history, ["/find-helper?category=Cleaning"]);

  const ignored = await component("src/app/find-helper/page.tsx", "FindHelper", {
    client: helperClient([]), globals: withQuery("?category=%3Cscript%3E"),
    mocks: { "@/lib/tags": { loadTagCatalog: async () => ({}), ...helperTagsMock }, "@/lib/location": originLocationMock },
  });
  ignored.render(); await flush();
  assert.ok(nodes(ignored.render(), (node) => node.props.children === "Choose a category to see nearby helpers."), "an unknown category is ignored");
});

test("Find a Helper has a search area control that needs no account", async () => {
  const { tree } = await openFindHelper({ user: null });
  const picker = nodes(tree, (node) => node.type === "area-picker")[0];
  assert.ok(picker, "ZIP / current-location search is on the page itself");
  assert.deepEqual(JSON.parse(JSON.stringify(picker.props.area)), { text: "Origin", lat: 0, lng: 0 });
});

// ---- AreaPicker (ZIP/postal code, neighborhood search, current location, map pin) ----
async function openAreaPicker({ geolocation, lookup, reverse, storage = new Map(), area = { text: "", lat: null, lng: null } } = {}) {
  const chosen = [];
  const store = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const app = await component("src/components/AreaPicker.tsx", "AreaPicker", {
    storage: store,
    globals: { setTimeout: (fn) => { Promise.resolve().then(fn); return 1; }, clearTimeout() {}, AbortController, navigator: { geolocation } },
    mocks: {
      "@/lib/area-lookup": { resolveAreaQuery: lookup ?? (async () => { throw new Error("no lookup expected"); }) },
      "@/lib/location": { LOCATION_KEY: "esg:general-area", reverseGeocodeGeneralArea: reverse ?? (async () => null) },
    },
  });
  const props = { area, onChange: (next) => chosen.push(JSON.parse(JSON.stringify(next))) };
  app.render(props); await flush();
  const type = async (value) => { nodes(app.render(props), (node) => node.type === "input")[0].props.onChange({ target: { value } }); app.render(props); await flush(); await flush(); };
  return { app, props, chosen, storage, type };
}

test("AreaPicker: a ZIP code sets the area, stores only the rounded journey location, and shows no account requirement", async () => {
  const { chosen, storage, type } = await openAreaPicker({ lookup: async () => ({ kind: "single", area: { label: "Minneapolis, MN 55401", areaLabel: "Minneapolis, MN 55401", lat: 44.98, lng: -93.27 } }) });
  await type("55401");
  assert.deepEqual(chosen, [{ text: "Minneapolis, MN 55401", lat: 44.98, lng: -93.27 }]);
  assert.deepEqual(JSON.parse(storage.get("esg:general-area")), { text: "Minneapolis, MN 55401", lat: 44.98, lng: -93.27 }, "same record /location writes, nothing else");
});

test("AreaPicker: a postcode that cannot be found says so and keeps manual entry and current location available", async () => {
  const { app, props, chosen, type } = await openAreaPicker({ lookup: async () => ({ kind: "none" }) });
  await type("00000");
  const tree = app.render(props);
  assert.equal(chosen.length, 0);
  assert.match(textOf(nodes(tree, (node) => node.props.role === "alert")[0]), /No place found for that postcode/);
  assert.ok(nodes(tree, (node) => node.type === "button" && /Use my location/.test(textOf(node))).length === 1);
});

test("AreaPicker: a geocoding failure is reported as a failure, not as 'nothing found', and nothing is saved", async () => {
  const { app, props, chosen, storage, type } = await openAreaPicker({ lookup: async () => { throw new Error("offline"); } });
  await type("Södermalm");
  const tree = app.render(props);
  assert.equal(chosen.length, 0);
  assert.equal(storage.size, 0);
  assert.match(textOf(nodes(tree, (node) => node.props.role === "alert")[0]), /Couldn't search for that place right now/);
  assert.equal(nodes(tree, (node) => node.type === "input").length, 1, "manual entry is still there");
});

test("AreaPicker: a neighborhood, city or ambiguous postcode lists areas (never street addresses) and picking one sets the area", async () => {
  const matches = [
    { label: "Kävlinge Torg 1, Kävlinge, Skåne, Sweden", areaLabel: "Kävlinge, Skåne, Sweden", lat: 55.79, lng: 13.12 },
    { label: "Kävlinge, Texas", areaLabel: "Kävlinge, TX 24431", lat: 30.1, lng: -97.2 },
  ];
  const { app, props, chosen, type } = await openAreaPicker({ lookup: async () => ({ kind: "choices", choices: matches }) });
  await type("244 31");
  const list = nodes(app.render(props), (node) => node.type === "ul")[0];
  const options = nodes(list, (node) => node.type === "button");
  assert.equal(textOf(options[0]), "Kävlinge, Skåne, Sweden", "the area label is shown, not the street address");
  assert.equal(chosen.length, 0, "several matches: nothing is chosen for the visitor");
  options[0].props.onClick();
  assert.deepEqual(chosen, [{ text: "Kävlinge, Skåne, Sweden", lat: 55.79, lng: 13.12 }]);
});

test("AreaPicker: the map follows the chosen area, and moving the pin re-labels the area with the pinned (rounded) point", async () => {
  const area = { text: "Stockholm, Sweden", lat: 59.33, lng: 18.07 };
  const { app, props, chosen, storage } = await openAreaPicker({ area, reverse: async (lat, lng) => { assert.deepEqual([lat, lng], [59.31, 18.06]); return "Södermalm, Stockholm, Sweden"; } });
  // An area is already set, so the picker opens collapsed to a summary; "Update location" reopens it.
  let tree = app.render(props);
  button(tree, "Update location").props.onClick();
  tree = app.render(props);
  const map = nodes(tree, (node) => node.type === "map-picker")[0];
  assert.deepEqual([map.props.lat, map.props.lng], [59.33, 18.07], "the pin sits where the entered area is");
  map.props.onPick({ lat: 59.31, lng: 18.06 });
  assert.deepEqual(chosen[0], { text: "Pinned location", lat: 59.31, lng: 18.06 }, "text never describes the old place while the pin has moved");
  await flush(); await flush();
  assert.deepEqual(chosen.at(-1), { text: "Södermalm, Stockholm, Sweden", lat: 59.31, lng: 18.06 }, "entered location and pin coordinates agree");
  assert.deepEqual(JSON.parse(storage.get("esg:general-area")), chosen.at(-1));
  // No coordinates (a place without a position): no map to show, even expanded.
  const bare = await openAreaPicker({ area: { text: "Somewhere", lat: null, lng: null } });
  const bareTree = bare.app.render(bare.props);
  button(bareTree, "Update location").props.onClick();
  assert.equal(nodes(bare.app.render(bare.props), (node) => node.type === "map-picker").length, 0);
});

test("AreaPicker: the moved pin is saved at once, even while its place name is still being looked up", async () => {
  const area = { text: "Stockholm, Sweden", lat: 59.33, lng: 18.07 };
  const { app, props, storage } = await openAreaPicker({ area, reverse: () => new Promise(() => {}) });
  let tree = app.render(props);
  button(tree, "Update location").props.onClick();
  tree = app.render(props);
  nodes(tree, (node) => node.type === "map-picker")[0].props.onPick({ lat: 59.4, lng: 18.1 });
  assert.deepEqual(JSON.parse(storage.get("esg:general-area")), { text: "Pinned location", lat: 59.4, lng: 18.1 }, "leaving the page now keeps the pin, not the old place");
});

test("AreaPicker: if the pin's place name cannot be looked up, the pin stays and the text says 'Pinned location'", async () => {
  const area = { text: "Stockholm, Sweden", lat: 59.33, lng: 18.07 };
  const { app, props, chosen } = await openAreaPicker({ area, reverse: async () => { throw new Error("offline"); } });
  let tree = app.render(props);
  button(tree, "Update location").props.onClick();
  tree = app.render(props);
  nodes(tree, (node) => node.type === "map-picker")[0].props.onPick({ lat: 59.4, lng: 18.1 });
  await flush(); await flush();
  assert.deepEqual(chosen.at(-1), { text: "Pinned location", lat: 59.4, lng: 18.1 });
});

test("AreaPicker: current location rounds coordinates, labels the area, stores only text and rounded lat/lng; denial falls back to manual entry", async () => {
  const granted = await openAreaPicker({
    geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 59.329323, longitude: 18.068581 } }) },
    reverse: async (lat, lng) => { assert.deepEqual([lat, lng], [59.33, 18.07]); return "Stockholm, Sweden"; },
  });
  nodes(granted.app.render(granted.props), (node) => node.type === "button" && /Use my location/.test(textOf(node)))[0].props.onClick();
  await flush(); await flush();
  assert.deepEqual(granted.chosen, [{ text: "Stockholm, Sweden", lat: 59.33, lng: 18.07 }]);
  assert.deepEqual(JSON.parse(granted.storage.get("esg:general-area")), { text: "Stockholm, Sweden", lat: 59.33, lng: 18.07 });

  const denied = await openAreaPicker({ geolocation: { getCurrentPosition: (_ok, fail) => fail(new Error("denied")) } });
  nodes(denied.app.render(denied.props), (node) => node.type === "button" && /Use my location/.test(textOf(node)))[0].props.onClick();
  await flush();
  assert.equal(denied.chosen.length, 0);
  assert.match(textOf(nodes(denied.app.render(denied.props), (node) => node.props.role === "alert")[0]), /couldn't access your location/);
  assert.ok(nodes(denied.app.render(denied.props), (node) => node.type === "input").length === 1, "manual entry is still there");

  const unsupported = await openAreaPicker({ geolocation: undefined });
  nodes(unsupported.app.render(unsupported.props), (node) => node.type === "button" && /Use my location/.test(textOf(node)))[0].props.onClick();
  assert.match(textOf(nodes(unsupported.app.render(unsupported.props), (node) => node.props.role === "alert")[0]), /isn't available in this browser/);
});

// ---- postcode and area resolution (the real modules, network faked) ----
async function loadLib(path, mocks = {}, globals = {}) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  runInNewContext(`(function(require, module, exports) { ${code}\n})`, { URL, URLSearchParams, console, AbortSignal, ...globals })((id) => mocks[id] ?? require(id), loaded, loaded.exports);
  return loaded.exports;
}

test("Postcode parsing: US ZIPs and Swedish postcodes (spaced, unspaced, SE- prefixed) are recognised; five digits are ambiguous; junk is not a postcode", () => {
  const { swedishPostcode, postcodeCandidates, parsePostcodeLocation } = zipLocationLib;
  assert.equal(swedishPostcode("244 31"), "24431");
  assert.equal(swedishPostcode("SE-244 31"), "24431");
  assert.equal(swedishPostcode("24431"), "24431");
  assert.equal(swedishPostcode("2443"), null);
  assert.equal(swedishPostcode("244 311"), null);
  assert.deepEqual(postcodeCandidates("94086"), [{ country: "us", code: "94086" }, { country: "se", code: "94086" }]);
  assert.deepEqual(postcodeCandidates("111 22"), [{ country: "se", code: "11122" }]);
  assert.deepEqual(postcodeCandidates("Södermalm"), []);
  assert.deepEqual(postcodeCandidates("12345; DROP TABLE"), []);
  const place = { "place name": "Kävlinge", state: "Skåne", latitude: "55.7922", longitude: "13.1166" };
  assert.deepEqual(parsePostcodeLocation({ places: [place] }, "24431", "se"), { lat: 55.79, lng: 13.12, label: "244 31 Kävlinge, Skåne, Sweden" }, "rounded to a general area");
  assert.throws(() => parsePostcodeLocation({ places: [{ ...place, latitude: "" }] }, "24431", "se"), /Invalid/);
  assert.throws(() => parsePostcodeLocation({ places: [{ ...place, latitude: "123" }] }, "24431", "se"), /Invalid/);
  assert.throws(() => parsePostcodeLocation({ places: [] }, "24431", "se"), /Invalid/);
});

test("resolveAreaQuery: one postcode match selects itself, an ambiguous five-digit code offers both, anything else is an area search, failures propagate", async () => {
  const swedish = { label: "244 31 Kävlinge, Skåne, Sweden", lat: 55.79, lng: 13.12 };
  const american = { label: "Kävlinge, TX 24431", lat: 30.1, lng: -97.2 };
  const calls = [];
  const searches = [];
  const make = async (lookups, search) => loadLib("src/lib/area-lookup.ts", {
    "@/lib/zip-location": { postcodeCandidates: zipLocationLib.postcodeCandidates, isPostcodeNotFound: zipLocationLib.isPostcodeNotFound, lookupPostcode: async (country, code) => { calls.push(`${country}:${code}`); return lookups[country](); } },
    "@/lib/area-search": { searchAreas: async (query) => { searches.push(query); return search(); } },
  });
  const signal = new AbortController().signal;
  const unique = await make({ se: async () => swedish }, async () => []);
  const single = await unique.resolveAreaQuery("244 31", signal);
  assert.equal(single.kind, "single");
  assert.deepEqual([single.area.lat, single.area.lng], [55.79, 13.12]);
  assert.deepEqual(calls, ["se:24431"]);
  assert.equal(searches.length, 0, "a postcode that resolved is not searched again");

  calls.length = 0;
  const both = await make({ us: async () => american, se: async () => swedish }, async () => []);
  const ambiguous = await both.resolveAreaQuery("24431", signal);
  assert.equal(ambiguous.kind, "choices");
  assert.deepEqual([...ambiguous.choices.map((c) => c.areaLabel)], [american.label, swedish.label]);
  assert.deepEqual(calls.sort(), ["se:24431", "us:24431"]);

  const onlyOne = await make({ us: async () => { throw new Error("404"); }, se: async () => swedish }, async () => []);
  assert.equal((await onlyOne.resolveAreaQuery("24431", signal)).kind, "single", "the code that does not exist is ignored");

  const neighborhood = await make({}, async () => [{ label: "x", areaLabel: "Södermalm, Stockholm", lat: 59.31, lng: 18.07 }]);
  assert.equal((await neighborhood.resolveAreaQuery("Södermalm", signal)).kind, "choices");
  assert.deepEqual(searches.at(-1), "Södermalm");

  const missing = () => Object.assign(new Error("Postcode not found"), { name: "PostcodeNotFoundError" });
  searches.length = 0;
  const nothing = await make({ us: async () => { throw missing(); }, se: async () => { throw missing(); } }, async () => [{ label: "Pedro do Rio", areaLabel: "Pedro do Rio, Brazil", lat: -22.4, lng: -43.1 }]);
  assert.equal((await nothing.resolveAreaQuery("00000", signal)).kind, "none", "a bare five-digit code that is neither a ZIP nor a postcode is not a place");
  assert.equal(searches.length, 0, "and is not fuzzy-matched against unrelated towns");
  assert.equal((await nothing.resolveAreaQuery("111 22", signal)).kind, "choices", "a spaced code the postcode service lacks still falls back to the area search");
  assert.deepEqual([...searches], ["111 22"]);
  const offline = await make({ us: async () => { throw new TypeError("fetch failed"); }, se: async () => { throw missing(); } }, async () => []);
  await assert.rejects(() => offline.resolveAreaQuery("24431", signal), /fetch failed/, "an unreachable postcode service is a failure, not 'not found'");

  const down = await make({}, async () => { throw new Error("network"); });
  await assert.rejects(() => down.resolveAreaQuery("Södermalm", signal), /network/, "a service failure is not reported as 'no such place'");
});

test("Postcode lookup uses the right endpoint per country and rejects a code that does not belong to that country", async () => {
  const urls = [];
  const lib = await loadLib("src/lib/zip-location.ts", {}, { AbortSignal, fetch: async (url) => { urls.push(url); return { ok: true, json: async () => ({ places: [{ "place name": "Kävlinge", state: "Skåne", latitude: "55.79", longitude: "13.12" }] }) }; } });
  const place = await lib.lookupPostcode("se", "24431", new AbortController().signal);
  assert.deepEqual(urls, ["https://api.zippopotam.us/se/24431"]);
  assert.equal(place.label, "244 31 Kävlinge, Skåne, Sweden");
  await assert.rejects(() => lib.lookupPostcode("se", "../../etc", new AbortController().signal), /Invalid postcode/);
  await assert.rejects(() => lib.lookupPostcode("us", "244 31", new AbortController().signal), /Invalid postcode/, "a Swedish code is not looked up as a US ZIP");
  assert.equal(urls.length, 1, "invalid input never reaches the network");
  const status = async (code) => (await loadLib("src/lib/zip-location.ts", {}, { AbortSignal, fetch: async () => ({ ok: code < 400, status: code, json: async () => ({}) }) }))
    .lookupPostcode("se", "24431", new AbortController().signal).then(() => null, (error) => error);
  assert.equal((await status(404)).name, "PostcodeNotFoundError", "404: the service answered, the code does not exist");
  assert.equal(lib.isPostcodeNotFound(await status(404)), true);
  const broken = await status(503);
  assert.equal(broken.message, "Postcode lookup failed", "5xx: the lookup failed, which is not the same as not found");
  assert.equal(lib.isPostcodeNotFound(broken), false);
});

test("The searched area survives the trip through sign-in or registration (short-lived, validated, rounded, one-shot)", async () => {
  const lib = await loadLib("src/lib/location.ts", { "./journey": journeyLib, "./geocoding": { generalAreaLabel: () => null } });
  const mapStore = () => { const m = new Map(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
  const local = mapStore();
  const session = mapStore();
  session.m.set("esg:general-area", JSON.stringify({ text: "Stockholm, Sweden", lat: 59.329323, lng: 18.068581, address: "Storgatan 1" }));
  assert.equal(lib.rememberAreaForAuth(local, session, 1000), true);
  const saved = JSON.parse(local.m.get("esg:post-auth-area"));
  assert.deepEqual(saved, { text: "Stockholm, Sweden", lat: 59.33, lng: 18.07, expires: 1000 + 30 * 60 * 1000 }, "rounded; nothing else is carried");

  const fresh = mapStore();                  // the verification link opens a new tab: empty sessionStorage
  assert.deepEqual(JSON.parse(JSON.stringify(lib.restoreAreaAfterAuth(local, fresh, 2000))), { text: "Stockholm, Sweden", lat: 59.33, lng: 18.07 });
  assert.deepEqual(JSON.parse(fresh.m.get("esg:general-area")), { text: "Stockholm, Sweden", lat: 59.33, lng: 18.07 }, "restored for the rest of the visit");
  assert.equal(local.m.size, 0, "one-shot");

  local.m.set("esg:post-auth-area", JSON.stringify({ ...saved }));
  assert.deepEqual(JSON.parse(JSON.stringify(lib.restoreAreaAfterAuth(local, mapStore(), saved.expires + 1))), { text: "", lat: null, lng: null }, "expired");
  local.m.set("esg:post-auth-area", JSON.stringify({ text: "x".repeat(201), lat: 1, lng: 1, expires: 9e15 }));
  assert.deepEqual(JSON.parse(JSON.stringify(lib.restoreAreaAfterAuth(local, mapStore(), 0))), { text: "", lat: null, lng: null }, "oversized");
  local.m.set("esg:post-auth-area", "{not json");
  assert.deepEqual(JSON.parse(JSON.stringify(lib.restoreAreaAfterAuth(local, mapStore(), 0))), { text: "", lat: null, lng: null }, "corrupt");
  assert.equal(lib.rememberAreaForAuth(mapStore(), mapStore(), 0), false, "nothing to remember");
});


// ---- the prompt itself ----
test("The helper sign-in prompt offers Log in, Create account and Continue browsing with the right destinations", async () => {
  const storage = new Map();
  const local = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const destination = "/profile/HelperOne?from=find-helper&category=Yard%20Work";
  let areasKept = 0;
  const app = await component("src/components/HelperSignInPrompt.tsx", "HelperSignInPrompt", {
    mocks: {
      "@/lib/journey": { ...journeyLib, rememberAuthDestination: (value) => journeyLib.rememberAuthDestination(value, local) },
      "@/lib/location": { rememberAreaForAuth: () => { areasKept++; return true; } },
    },
  });
  const tree = app.render({ username: "HelperOne", destination });
  const links = nodes(tree, (node) => node.type === "a");
  const login = links.find((node) => textOf(node) === "Log in");
  const create = links.find((node) => textOf(node) === "Create account");
  const browse = links.find((node) => textOf(node) === "Continue browsing");
  assert.equal(login.props.href, `/auth/sign-in?next=${encodeURIComponent(destination)}`);
  assert.equal(safeNext(decodeURIComponent(login.props.href.split("next=")[1])), destination, "the destination survives encoding and passes the same validation sign-in applies");
  assert.equal(create.props.href, "/auth/sign-up");
  assert.equal(browse.props.href, "/find-helper");
  assert.equal(storage.size, 0, "nothing is remembered until the visitor picks Create account");
  assert.equal(areasKept, 0);
  create.props.onClick();
  assert.equal(JSON.parse(storage.get("esg:post-auth-destination")).path, destination);
  assert.equal(areasKept, 1, "the searched area is kept for the return from registration");
  login.props.onClick();
  assert.equal(areasKept, 2, "and for the return from Log in");
  // Inside the list, Continue browsing is a button that closes the sheet.
  let closed = 0;
  const inList = nodes(app.render({ username: "HelperOne", destination, onContinueBrowsing: () => { closed++; } }), (node) => node.type === "button" && textOf(node) === "Continue browsing")[0];
  inList.props.onClick();
  assert.equal(closed, 1);
});

// ---- the profile route itself ----
test("A helper profile page shows the sign-in prompt, and fetches nothing, when no one is signed in", async () => {
  const touched = [];
  const client = { from: (table) => { touched.push(table); throw new Error("must not query"); }, rpc: async () => { touched.push("rpc"); throw new Error("must not call"); } };
  const app = await component("src/app/profile/[username]/page.tsx", "PublicProfileView", {
    client, mocks: { "next/navigation": { useSearchParams: () => new URLSearchParams("from=find-helper&category=Yard%20Work") } },
  });
  app.auth.user = null;
  app.render({ username: "HelperOne" }); await flush();
  const tree = app.render({ username: "HelperOne" });
  const prompt = nodes(tree, (node) => node.type === "helper-signin-prompt")[0];
  assert.ok(prompt, "the prompt replaces the profile");
  assert.equal(prompt.props.destination, "/profile/HelperOne?from=find-helper&category=Yard%20Work");
  assert.equal(prompt.props.browseHref, "/find-helper", "an unknown category (this test's service list) falls back to the plain list");
  assert.deepEqual(touched, [], "no profile, tag or stats data is requested for a signed-out visitor");
  assert.equal(nodes(tree, (node) => node.type === "tag-chip").length, 0);
});

test("A signed-in visitor still gets the helper profile, with a way back to the same search", async () => {
  const profile = { id: "helper-1", username: "HelperOne", photo_url: null, skills: ["Cleaning"], wom_count: 3, profile_tags: [] };
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) }),
    rpc: async () => ({ data: [{ gigs_worked_count: 1, wom_count: 3 }], error: null }),
  };
  const app = await component("src/app/profile/[username]/page.tsx", "PublicProfileView", {
    client, mocks: { "next/navigation": { useSearchParams: () => new URLSearchParams("from=find-helper&category=Cleaning") } },
  });
  app.render({ username: "HelperOne" }); await flush();
  const tree = app.render({ username: "HelperOne" });
  assert.equal(nodes(tree, (node) => node.type === "helper-signin-prompt").length, 0);
  assert.ok(nodes(tree, (node) => node.type === "div" && textOf(node) === "@HelperOne").length > 0, "the profile itself is shown");
  const back = nodes(tree, (node) => node.type === "a" && /Back to Find a Helper/.test(textOf(node)))[0];
  assert.equal(back.props.href, "/find-helper?category=Cleaning", "Back returns to the same category");
});

// ---- sign in / register carry the destination ----
async function openSignIn(next) {
  const storage = new Map();
  const local = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const app = await component("src/app/auth/sign-in/page.tsx", "SignInInner", {
    client: { auth: {} },
    mocks: {
      "next/navigation": { useSearchParams: () => new URLSearchParams({ next }), useRouter: () => ({ replace() {} }) },
      "@/lib/journey": { ...journeyLib, rememberAuthDestination: (value) => journeyLib.rememberAuthDestination(value, local) },
    },
  });
  app.auth.user = null;
  return { tree: app.render(), storage };
}

test("Sign In reached from a helper profile says so, offers Continue browsing, and Register remembers only that profile", async () => {
  const destination = "/profile/HelperOne?from=find-helper&category=Yard%20Work";
  const { tree, storage } = await openSignIn(destination);
  const notice = nodes(tree, (node) => node.props.role === "status")[0];
  assert.match(textOf(notice), /Sign in to view @HelperOne's profile/);
  assert.equal(nodes(notice, (node) => node.type === "a" && textOf(node) === "Continue browsing")[0].props.href, "/find-helper?category=Yard%20Work");
  const register = nodes(tree, (node) => node.type === "a" && node.props.children === "Register")[0];
  assert.equal(register.props.href, `/auth/sign-up?next=${encodeURIComponent(destination)}`);
  register.props.onClick();
  assert.equal(JSON.parse(storage.get("esg:post-auth-destination")).path, destination);
});

test("Sign In never treats other or external destinations as a helper journey", async () => {
  for (const next of ["/post", "/need-help", "https://evil.invalid/profile/HelperOne", "//evil.invalid/profile/HelperOne", "/profile/Helper/One", "/profile"]) {
    const { tree, storage } = await openSignIn(next);
    assert.equal(nodes(tree, (node) => node.props.role === "status").length, 0, `no helper notice for ${next}`);
    nodes(tree, (node) => node.type === "a" && node.props.children === "Register")[0].props.onClick();
    assert.equal(storage.size, 0, `nothing remembered for ${next}`);
  }
});

async function registrationEnds({ remembered }) {
  const storage = new Map();
  if (remembered !== undefined) storage.set("esg:post-auth-destination", typeof remembered === "string" ? remembered : JSON.stringify(remembered));
  const local = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const destinations = [];
  const app = await component("src/app/auth/register/page.tsx", "RegisterInner", {
    client: {},
    mocks: {
      // A new router object on every render makes the effect run again, as it can in the browser.
      "next/navigation": { useRouter: () => ({ replace: (to) => destinations.push(to) }) },
      "@/components/CategoryList": { CategoryList: "category-list" },
      "@/lib/journey": { ...journeyLib, takeAuthDestination: () => journeyLib.takeAuthDestination(local) },
    },
  });
  app.auth.profile = { ...profile, onboarding_completed_at: "2026-01-01" };
  app.render(); app.render(); await flush();   // the effect may run more than once
  return { destinations, storage };
}

test("Registration ends at Home, unless the visitor chose Create account from a helper profile: then it lands there, once", async () => {
  const destination = "/profile/HelperOne?from=find-helper&category=Cleaning";
  const now = Date.now();
  const remembered = { path: destination, expires: now + 60_000 };
  const kept = await registrationEnds({ remembered });
  assert.ok(kept.destinations.length >= 2, "the redirect effect did run more than once");
  assert.deepEqual([...new Set(kept.destinations)], [destination], "always the helper profile, even when the effect runs again");
  assert.equal(kept.storage.has("esg:post-auth-destination"), false, "forgotten once used");
  for (const [label, value] of [
    ["nothing remembered", undefined],
    ["expired", { path: destination, expires: now - 1 }],
    ["external destination", { path: "https://evil.invalid/profile/x", expires: now + 60_000 }],
    ["a protected non-helper page", { path: "/my-gigs", expires: now + 60_000 }],
    ["corrupted value", "not json"],
  ]) {
    assert.deepEqual([...new Set((await registrationEnds({ remembered: value })).destinations)], ["/"], `Home when ${label}`);
  }
});

// ---- the server-side route guard (src/proxy.ts) ----
async function runProxy({ pathAndQuery = "/profile/HelperOne?from=find-helper&category=Yard%20Work", user = null, error = null, throws = false } = {}) {
  const source = await readFile(new URL("../src/proxy.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  class NextResponse {
    constructor(body, init) { this.kind = "body"; this.body = body; this.status = init?.status; this.headers = new Map(Object.entries(init?.headers ?? {})); }
    static next() { const r = new NextResponse(); r.kind = "next"; r.cookies = { set() {} }; return r; }
    static redirect(url) { const r = new NextResponse(); r.kind = "redirect"; r.url = String(url); r.cookies = { set() {} }; return r; }
  }
  const loaded = { exports: {} };
  const mocks = {
    "next/server": { NextResponse },
    "@supabase/ssr": { createServerClient: () => ({ auth: { getUser: async () => { if (throws) throw new Error("network"); return { data: { user }, error }; } } }) },
  };
  runInNewContext(`(function(require, module, exports, process) { ${code}\n})`, { URL })((id) => mocks[id], loaded, loaded.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon" } });
  const url = new URL(`http://localhost:3001${pathAndQuery}`);
  const request = { url: url.href, nextUrl: url, cookies: { getAll: () => [], set() {} } };
  return { response: await loaded.exports.proxy(request), config: loaded.exports.config };
}

test("Direct navigation to a helper profile while signed out is redirected on the server to Sign In, keeping the profile as the destination", async () => {
  const { response, config } = await runProxy({ error: { name: "AuthSessionMissingError", status: 400 } });
  assert.equal(response.kind, "redirect");
  const target = new URL(response.url);
  assert.equal(target.pathname, "/auth/sign-in");
  assert.equal(target.searchParams.get("reason"), "helper-profile");
  const next = target.searchParams.get("next");
  assert.equal(next, "/profile/HelperOne?from=find-helper&category=Yard%20Work");
  assert.equal(safeNext(next), next, "the destination passes the validation the sign-in page applies");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(JSON.parse(JSON.stringify(config)), { matcher: ["/profile/:username"] });
  for (const status of [401, 403]) {
    assert.equal((await runProxy({ error: { name: "AuthApiError", status } })).response.kind, "redirect", `an invalid or expired session (${status}) is signed out`);
  }
});

test("The route guard lets a verified session through and fails closed (503, no redirect loop) if auth cannot be checked", async () => {
  assert.equal((await runProxy({ user: { id: "u1" } })).response.kind, "next", "a signed-in visitor gets the profile");
  for (const options of [{ error: { name: "AuthRetryableFetchError", status: 0 } }, { error: { name: "AuthApiError", status: 500 } }, { throws: true }]) {
    const { response } = await runProxy(options);
    assert.equal(response.status, 503);
    assert.notEqual(response.kind, "redirect");
    assert.notEqual(response.kind, "next", "never serves the page when the session could not be verified");
  }
});

test("Hostile profile paths cannot turn the sign-in redirect into an open redirect", async () => {
  for (const pathAndQuery of ["/profile/evil.com", "/profile/%2F%2Fevil.com", "/profile/a%5Cb"]) {
    const { response } = await runProxy({ pathAndQuery, error: { name: "AuthSessionMissingError", status: 400 } });
    const next = new URL(response.url).searchParams.get("next");
    assert.equal(safeNext(next), "/", `sign-in discards ${pathAndQuery}: it falls back to Home`);
    assert.equal(new URL(response.url).origin, "http://localhost:3001", "the redirect itself always stays on this site");
  }
});

// ===========================================================================
// Helper requests: Post a Gig on a helper's profile -> private request -> accept / decline
// ===========================================================================
test("helper-request helpers: only plain usernames are accepted, the link is built safely, and the stage follows the gig and the helper's claim", () => {
  const { requestUsername, postRequestHref, requestableCategories, requestStage, priceLabel } = helperRequestLib;
  assert.equal(requestUsername("HelperOne"), "HelperOne");
  for (const bad of [null, undefined, "", "a b", "../x", "<script>", "a".repeat(41), "x?y=1", "a/b"]) assert.equal(requestUsername(bad), null, String(bad));
  assert.equal(postRequestHref("HelperOne"), "/post?helper=HelperOne");
  assert.equal(postRequestHref("HelperOne", "Yard Work"), "/post?helper=HelperOne&category=Yard+Work");
  assert.equal(postRequestHref("../evil"), "/post", "an unusable username never builds a helper link");
  assert.deepEqual(requestableCategories(["Handyman", "Cleaning", "Made Up"], ["Cleaning", "Handyman", "Other"]), ["Cleaning", "Handyman"], "only what the helper offers, in the app's order; nothing invented");
  assert.deepEqual(requestableCategories(null, ["Cleaning"]), []);
  assert.equal(priceLabel("fixed"), "Fixed price");
  assert.equal(priceLabel("negotiable"), "Negotiable");
  const gig = (fields) => ({ status: "active", selected_provider_id: null, requested_helper_id: "h", ...fields });
  assert.equal(requestStage({ ...gig(), requested_helper_id: null }, null), null, "a public gig is not a request");
  assert.equal(requestStage(gig({ status: "draft" }), null), "draft");
  assert.equal(requestStage(gig(), null), "waiting");
  assert.equal(requestStage(gig(), "pending"), "countered");
  assert.equal(requestStage(gig(), "withdrawn"), "declined");
  assert.equal(requestStage(gig({ selected_provider_id: "h", status: "in_progress" }), "selected"), "accepted");
  assert.equal(requestStage(gig({ status: "cancelled" }), null), "closed");
  assert.equal(requestStage(gig({ status: "completed" }), null), "closed");
});

// ---- the profile's Post a Gig button ----
async function openProfile({ viewer = user, profileFields = {}, search = "from=find-helper&category=Cleaning" } = {}) {
  const profile = { id: "helper-1", username: "HelperOne", photo_url: null, skills: ["Cleaning", "Handyman", "Pet Care"], wom_count: 3, profile_tags: [], ...profileFields };
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) }),
    rpc: async () => ({ data: [{ gigs_worked_count: 1, wom_percentage: 100 }], error: null }),
  };
  const app = await component("src/app/profile/[username]/page.tsx", "PublicProfileView", {
    client, mocks: { "next/navigation": { useSearchParams: () => new URLSearchParams(search) } },
  });
  app.auth.user = viewer;
  app.render({ username: "HelperOne" }); await flush();
  return app.render({ username: "HelperOne" });
}

test("Another member's profile has a clearly visible Post a Gig action, targeting that helper and the searched service", async () => {
  const tree = await openProfile();
  const post = nodes(tree, (node) => node.type === "a" && textOf(node) === "Post a Gig");
  assert.equal(post.length, 1);
  assert.equal(post[0].props.href, "/post?helper=HelperOne&category=Cleaning", "names the helper (private request) and the service searched for");
  assert.equal(post[0].props["aria-label"], "Post a Gig for @HelperOne");
  assert.match(post[0].props.className, /bg-emerald-600/, "a primary, filled action");
  assert.match(post[0].props.className, /min-h-11/, "a touch-sized target");
  // Top-right: the same row as the name, after it.
  const row = nodes(tree, (node) => node.type === "div" && Array.isArray(node.props.children) && node.props.children.includes?.(post[0]))[0];
  assert.ok(row, "the action sits in the profile's header row");
  assert.equal(row.props.children.at(-1), post[0], "last in the row, so it sits at the right");
});

test("Post a Gig is not shown on your own profile, and a category the helper does not offer is not carried into the link", async () => {
  const own = await openProfile({ viewer: { id: "helper-1" } });
  assert.equal(nodes(own, (node) => /Post a Gig/.test(textOf(node))).length, 0);
  const other = await openProfile({ search: "from=find-helper&category=Gardening" });
  assert.equal(nodes(other, (node) => node.type === "a" && textOf(node) === "Post a Gig")[0].props.href, "/post?helper=HelperOne");
});

// ---- the existing form, addressed to one helper ----
async function openRequestForm({ search = "helper=HelperOne&category=Cleaning", helper = { id: "helper-1", username: "HelperOne", skills: ["Cleaning", "Handyman", "Other"] }, lookupError = null,
    rpc, stored = new Map(), asUser = user } = {}) {
  const calls = [], destinations = [];
  const client = {
    from: (table) => {
      const api = { select: () => api, eq: () => api, maybeSingle: async () => ({ data: table === "public_profiles" ? helper : null, error: lookupError }) };
      return api;
    },
    rpc: rpc ?? (async (name, payload) => { calls.push({ name, payload }); return { data: { id: "created", status: payload.p_publish ? "active" : "draft" }, error: null }; }),
  };
  const app = await component("src/app/post/page.tsx", "PostGigForm", {
    client,
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
    globals: { crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" } },
    mocks: {
      "next/navigation": { useSearchParams: () => new URLSearchParams(search), useRouter: () => ({ replace: (url) => destinations.push(url) }) },
      "@/lib/location": { loadJourneyLocation: () => ({ text: "Kävlinge", lat: 55.79, lng: 13.12 }), reverseGeocodeGeneralArea: async () => null },
    },
  });
  app.auth.user = asUser;
  app.render(); await flush();
  const fill = (tree, price) => {
    for (const [predicate, value] of [
      [(node) => node.type === "input" && node.props.maxLength === 120, "Rake the yard"],
      [(node) => node.type === "textarea", "Leaves and twigs"],
      [(node) => node.props.type === "number", price ?? "40"],
      [(node) => node.props.type === "datetime-local", new Date(Date.now() + 86400000).toISOString().slice(0, 16)],
    ]) nodes(tree, predicate)[0].props.onChange({ target: { value } });
  };
  return { app, calls, destinations, stored, fill };
}
const radios = (tree) => nodes(tree, (node) => node.type === "selection-chip" && node.props.role === "radio");

test("Post a Gig for a helper: the existing form, addressed to that helper, private, with only what they offer", async () => {
  const { app } = await openRequestForm();
  const tree = app.render();
  assert.match(textOf(nodes(tree, (node) => node.type === "h1")[0]), /Post a Gig for @HelperOne/);
  const note = nodes(tree, (node) => node.props.role === "note")[0];
  assert.match(textOf(note), /Private request.*Only @HelperOne will see it.*isn't posted publicly/);
  assert.ok(nodes(note, (node) => node.type === "a" && node.props.href === "/post"), "a way to post a public gig instead");
  assert.deepEqual(radios(tree).map(textOf).slice(0, 2), ["Cleaning", "Other"], "the helper's services that exist here (Handyman is not a category in this build)");
  assert.equal(radios(tree).find((node) => node.props.selected).props.children, "Cleaning", "starts on the searched service");
  assert.ok(nodes(tree, (node) => node.type === "input" && node.props.maxLength === 120).length === 1, "the same title / description / budget / date / area form");
  assert.ok(button(tree, "Send request"), "Send request is at the bottom of the form");
  assert.ok(button(tree, "Save as Draft"));
  assert.equal(button(tree, "Post Gig"), undefined, "not worded as a public posting");
});

test("Post a Gig for a helper: Fixed or Negotiable pricing is selectable, validated, and submitted with the helper id", async () => {
  const { app, calls, destinations, stored, fill } = await openRequestForm();
  let tree = app.render();
  const pricing = radios(tree).filter((node) => ["Fixed", "Negotiable"].includes(textOf(node)));
  assert.deepEqual(pricing.map(textOf), ["Fixed", "Negotiable"]);
  assert.equal(pricing[0].props.selected, true, "Fixed by default");
  pricing[1].props.onClick(); tree = app.render();
  assert.equal(radios(tree).find((node) => textOf(node) === "Negotiable").props.selected, true);
  assert.match(textOf(tree), /may accept, decline, or counteroffer/);

  // Validation reuses the public form's rules, before anything is sent.
  fill(tree, "-5");
  tree = app.render(); button(tree, "Send request").props.onClick(); await flush();
  assert.equal(calls.length, 0);
  assert.match(textOf(nodes(app.render(), (node) => node.props.role === "alert")[0]), /positive amount/);

  fill(app.render(), "40");
  button(app.render(), "Send request").props.onClick(); await flush();
  assert.equal(calls.length, 1);
  const { name, payload } = calls[0];
  assert.equal(name, "create_gig");
  assert.equal(payload.p_requested_helper_id, "helper-1", "the helper id reaches the database call");
  assert.equal(payload.p_price_type, "negotiable");
  assert.equal(payload.p_publish, true);
  assert.equal(payload.p_amount, 40);
  assert.equal(payload.p_service_type, "Cleaning");
  assert.deepEqual(destinations, ["/gigs/created"], "lands on the request itself");
  assert.equal(stored.size, 0, "the retry record is cleared once the request is saved");
});

test("Post a Gig for a helper: Fixed pricing is sent as fixed, and Save as Draft keeps the helper but does not publish", async () => {
  const sent = await openRequestForm();
  sent.fill(sent.app.render());
  button(sent.app.render(), "Send request").props.onClick(); await flush();
  assert.equal(sent.calls[0].payload.p_price_type, "fixed");
  const draft = await openRequestForm();
  draft.fill(draft.app.render());
  button(draft.app.render(), "Save as Draft").props.onClick(); await flush();
  assert.equal(draft.calls[0].payload.p_requested_helper_id, "helper-1");
  assert.equal(draft.calls[0].payload.p_publish, false);
  assert.deepEqual(draft.destinations, ["/my-gigs?created=created"]);
});

test("Post a Gig for a helper: a double click sends one request, shows Sending…, and an ambiguous failure retries the same request", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const { app, fill, stored } = await openRequestForm({ rpc: async (name, payload) => { calls.push(payload); await gate; return { data: null, error: { code: "08006", message: "network" } }; } });
  fill(app.render());
  const send = button(app.render(), "Send request");
  send.props.onClick(); send.props.onClick();
  await flush();
  assert.equal(calls.length, 1, "the second click is ignored");
  assert.ok(button(app.render(), "Sending…").props.disabled, "loading state, button disabled");
  release(); await flush(); await flush();
  const tree = app.render();
  assert.match(textOf(nodes(tree, (node) => node.props.role === "alert")[0]), /couldn't confirm whether your request was saved/);
  assert.ok(button(tree, "Retry previous request"), "retry reuses the saved request");
  assert.equal(JSON.parse(stored.get(`esg:post:${user.id}`)).p_requested_helper_id, "helper-1");
  assert.equal(JSON.parse(stored.get(`esg:post:${user.id}`)).p_request_id, "11111111-1111-4111-8111-111111111111");
});

test("Post a Gig for a helper: a retried request stays addressed to its original helper, even if the link changes", async () => {
  const stored = new Map([[`esg:post:${user.id}`, JSON.stringify({ p_request_id: "r1", p_service_type: "Cleaning", p_title: "t", p_description: "d", p_amount: 40, p_price_type: "negotiable",
    p_scheduled_at: null, p_location_text: "x", p_lat: null, p_lng: null, p_photo_url: null, p_publish: true, p_tag_ids: [], p_requested_helper_id: "helper-1" })]]);
  const { app, calls } = await openRequestForm({ search: "", stored });
  const tree = app.render();
  assert.match(textOf(nodes(tree, (node) => node.type === "h1")[0]), /for @HelperOne/, "the helper is looked up from the saved request");
  assert.equal(radios(tree).find((node) => textOf(node) === "Negotiable").props.selected, true);
  button(tree, "Retry previous request").props.onClick(); await flush();
  assert.equal(calls[0].payload.p_request_id, "r1");
  assert.equal(calls[0].payload.p_requested_helper_id, "helper-1");
});

test("Post a Gig for a helper: database refusals (not offered, unavailable) are shown as-is and nothing is left pending", async () => {
  const { app, fill, stored } = await openRequestForm({ rpc: async () => ({ data: null, error: { code: "22023", message: "That helper doesn't offer this category." } }) });
  fill(app.render());
  button(app.render(), "Send request").props.onClick(); await flush();
  assert.match(textOf(nodes(app.render(), (node) => node.props.role === "alert")[0]), /That helper doesn't offer this category/);
  assert.equal(stored.size, 0, "a validation refusal cannot have committed, so the form is editable again");
  assert.ok(button(app.render(), "Send request"));
});

test("Post a Gig for a helper: bad links and ineligible helpers stop with a clear message and no form", async () => {
  const cases = [
    [{ search: "helper=../evil" }, /That helper link isn't valid/],
    [{ helper: null }, /couldn't be found/],
    [{ lookupError: new Error("offline") }, /Couldn't load that helper/],
    [{ helper: { id: user.id, username: "Tester123", skills: ["Cleaning"] }, search: "helper=Tester123" }, /can't send a request to yourself/],
    [{ helper: { id: "helper-1", username: "HelperOne", skills: ["Skydiving"] } }, /hasn't listed a service you can request/],
  ];
  for (const [options, message] of cases) {
    const { app } = await openRequestForm(options);
    const tree = app.render();
    assert.match(textOf(nodes(tree, (node) => node.props.role === "alert")[0]), message);
    assert.equal(nodes(tree, (node) => node.type === "input").length, 0, "no form to submit");
    assert.ok(nodes(tree, (node) => node.type === "a" && node.props.href === "/post"), "public gig posting is still one click away");
  }
});

test("Post a Gig without a helper is unchanged: public, fixed price, no helper id, Post Gig", async () => {
  const { app, calls, fill } = await openRequestForm({ search: "" });
  let tree = app.render();
  assert.match(textOf(nodes(tree, (node) => node.type === "h1")[0]), /^Post a Gig$/);
  assert.equal(nodes(tree, (node) => node.props.role === "note").length, 0);
  assert.equal(radios(tree).filter((node) => ["Fixed", "Negotiable"].includes(textOf(node))).length, 0, "no pricing choice on a public gig");
  assert.match(textOf(tree), /Pricing: Fixed/);
  fill(tree);
  button(app.render(), "Post Gig").props.onClick(); await flush();
  assert.equal(calls[0].payload.p_price_type, "fixed");
  assert.equal("p_requested_helper_id" in calls[0].payload, false, "never sent for a public gig");
});

// ---- the requested helper's and the poster's gig page ----
async function openRequest({ asUser = "helper-1", gig = {}, claims = {}, pending = [], rpcError = null, confirm = true } = {}) {
  const fields = { id: "gig-1", poster_id: "poster-1", requested_helper_id: "helper-1", selected_provider_id: null, status: "active", price_type: "fixed", title: "Rake the yard",
    description: "Leaves", service_type: "Cleaning", photo_url: null, amount: 40, agreed_amount: null, location_text: "Kävlinge", scheduled_at: null, start_requested_at: null,
    incomplete_choice_phase: false, amount_paid: null, amount_received: null, gig_tags: [], ...gig };
  const people = [{ id: "poster-1", username: "customer1" }, { id: "helper-1", username: "helper1" }];
  const client = fakeDb((query, single) => {
    if (query.table === "gigs") return { data: fields, error: null };
    if (query.table === "public_profiles") return { data: people.filter((row) => (query.in.id ?? []).includes(row.id)), error: null };
    if (query.table === "claims" && query.eq.provider_id) return { data: claims[query.eq.provider_id] ?? null, error: null };
    if (query.table === "claims") return { data: pending, error: null };
    return { data: single ? null : [], error: null };
  });
  const rpcs = [];
  client.rpc = async (name, args) => { rpcs.push([name, JSON.parse(JSON.stringify(args))]); return { error: rpcError }; };
  const confirms = [];
  const app = await component("src/app/gigs/[id]/page.tsx", "GigDetails", {
    client, globals: { window: { confirm: (message) => { confirms.push(message); return confirm; }, location: { hash: "" } }, document: { getElementById: () => null } },
    mocks: { "@/components/ChatPanel": { default: "chat-panel" } },
  });
  app.auth.user = { id: asUser };
  app.render({ id: "gig-1" }); await flush();
  return { app, rpcs, confirms, tree: app.render({ id: "gig-1" }), again: () => app.render({ id: "gig-1" }) };
}
const buttonText = (tree, label) => nodes(tree, (node) => node.type === "button" && textOf(node) === label)[0];

test("The requested helper sees the request with Accept and Decline (fixed price: no counteroffer), and Accept uses accept_gig_request", async () => {
  const { tree, rpcs, confirms } = await openRequest();
  const panel = nodes(tree, (node) => node.props["aria-label"] === "Request for you")[0];
  assert.ok(panel, "the panel the notification links to (#request)");
  assert.equal(panel.props.id, "request");
  assert.match(textOf(panel), /@customer1 sent you a request/);
  assert.match(textOf(panel), /Fixed price: 40 CAD/);
  assert.equal(nodes(tree, (node) => node.type === "form").length, 0, "a fixed-price request has no counteroffer");
  assert.match(textOf(tree), /Private request/);
  await buttonText(panel, "Accept").props.onClick();
  assert.deepEqual(rpcs, [["accept_gig_request", { p_gig_id: "gig-1" }]]);
  assert.deepEqual(confirms, [], "accepting needs no extra dialog");
});

test("Decline asks first, then uses decline_gig_request; cancelling the dialog sends nothing", async () => {
  const declined = await openRequest();
  await buttonText(declined.tree, "Decline").props.onClick();
  assert.deepEqual(declined.rpcs, [["decline_gig_request", { p_gig_id: "gig-1" }]]);
  assert.equal(declined.confirms.length, 1);
  const kept = await openRequest({ confirm: false });
  await buttonText(kept.tree, "Decline").props.onClick();
  assert.deepEqual(kept.rpcs, []);
});

test("A negotiable request also offers a counteroffer through the existing offer RPC", async () => {
  const { tree, rpcs, app } = await openRequest({ gig: { price_type: "negotiable" } });
  const form = nodes(tree, (node) => node.type === "form" && node.props["aria-label"] === "Counteroffer")[0];
  assert.ok(form, "counteroffer form");
  assert.match(textOf(nodes(tree, (node) => node.props["aria-label"] === "Request for you")[0]), /Negotiable: 40 CAD.*counteroffer/);
  nodes(form, (node) => node.type === "input")[0].props.onChange({ target: { value: "55" } });
  await nodes(app.render({ id: "gig-1" }), (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(rpcs, [["create_claim", { p_gig_id: "gig-1", p_offer_amount: 55, p_message: null }]]);
  assert.match(textOf(form), /Send counteroffer/);
});

test("After a counteroffer the helper can still accept the posted price or decline; after declining the request is closed to them", async () => {
  const countered = await openRequest({ gig: { price_type: "negotiable" }, claims: { "helper-1": { id: "c", state: "pending", offer_amount: 55, provider_id: "helper-1" } } });
  assert.ok(nodes(countered.tree, (node) => node.props["aria-label"] === "Request for you").length === 1);
  assert.ok(buttonText(countered.tree, "Accept") && buttonText(countered.tree, "Decline"));
  assert.equal(nodes(countered.tree, (node) => node.type === "form").length, 0, "one counteroffer at a time");
  const declined = await openRequest({ claims: { "helper-1": { id: "c", state: "withdrawn", provider_id: "helper-1" } } });
  assert.equal(nodes(declined.tree, (node) => node.props["aria-label"] === "Request for you").length, 0);
  assert.ok(nodes(declined.tree, (node) => /You declined this request/.test(textOf(node))).length > 0);
  assert.equal(nodes(declined.tree, (node) => node.type === "form").length, 0);
});

test("Requests that are no longer open say so (cancelled, closed) and a refused action shows the server's reason", async () => {
  const cancelled = await openRequest({ gig: { status: "cancelled" } });
  assert.match(textOf(cancelled.tree), /This request was cancelled/);
  assert.equal(nodes(cancelled.tree, (node) => node.props["aria-label"] === "Request for you").length, 0);
  const disputed = await openRequest({ gig: { status: "disputed" } });
  assert.match(textOf(disputed.tree), /This request is no longer open/);
  assert.equal(buttonText(disputed.tree, "Accept"), undefined);
  const stale = await openRequest({ rpcError: { code: "P0001", message: "This request is no longer open." } });
  await buttonText(stale.tree, "Accept").props.onClick();
  assert.match(textOf(nodes(stale.again(), (node) => node.props.role === "alert")[0]), /This request is no longer open/);
});

test("Nobody but the requested helper gets Accept / Decline or an offer on a private request", async () => {
  for (const asUser of ["stranger", "poster-1"]) {
    const { tree } = await openRequest({ asUser });
    assert.equal(nodes(tree, (node) => node.props["aria-label"] === "Request for you").length, 0, asUser);
    assert.equal(buttonText(tree, "Accept"), undefined);
    assert.equal(buttonText(tree, "Decline"), undefined);
    assert.equal(nodes(tree, (node) => node.type === "form").length, 0, "no offer form");
  }
  const publicGig = await openRequest({ asUser: "stranger", gig: { requested_helper_id: null } });
  assert.equal(nodes(publicGig.tree, (node) => node.type === "form" && node.props["aria-label"] === "Make an offer").length, 1, "public gigs still take offers");
  assert.doesNotMatch(textOf(publicGig.tree), /Private request/);
});

test("The poster sees who the request went to, that it is private, and can post it publicly (one confirmed RPC)", async () => {
  const { tree, rpcs, confirms } = await openRequest({ asUser: "poster-1" });
  const panel = nodes(tree, (node) => node.props["aria-label"] === "Private request")[0];
  assert.match(textOf(panel), /Private request to @helper1/);
  assert.match(textOf(panel), /Waiting for @helper1 to respond.*accept or decline your price/);
  assert.match(textOf(tree), /Sent privately to @helper1. No one else can see it/);
  await buttonText(panel, "Post publicly instead").props.onClick();
  assert.deepEqual(rpcs, [["reassign_gig_request", { p_gig_id: "gig-1", p_new_helper_id: null }]]);
  assert.match(confirms[0], /Anyone nearby will be able to see it/, "the public step is never silent");
  const declined = await openRequest({ asUser: "poster-1", claims: { "helper-1": { state: "withdrawn" } } });
  assert.match(textOf(nodes(declined.tree, (node) => node.props["aria-label"] === "Private request")[0]), /@helper1 declined. Your request is still private/);
  const negotiable = await openRequest({ asUser: "poster-1", gig: { price_type: "negotiable" } });
  assert.match(textOf(negotiable.tree), /accept, decline or counteroffer/);
  assert.match(textOf(negotiable.tree), /Negotiable/);
  assert.match(textOf(negotiable.tree), /No counteroffer yet/);
});

test("A counteroffer reaches the poster as an ordinary proposal they can accept with the existing RPC", async () => {
  const pending = [{ id: "c1", gig_id: "gig-1", provider_id: "helper-1", state: "pending", offer_amount: 55, message: null, created_at: "2026-10-01T10:00:00Z" }];
  const { tree, rpcs } = await openRequest({ asUser: "poster-1", gig: { price_type: "negotiable" }, claims: { "helper-1": { state: "pending" } }, pending });
  assert.match(textOf(nodes(tree, (node) => node.props["aria-label"] === "Private request")[0]), /counteroffer below/);
  await buttonText(nodes(tree, (node) => node.props.id === "proposals")[0], "Accept offer").props.onClick();
  assert.deepEqual(rpcs, [["select_provider", { p_gig_id: "gig-1", p_claim_id: "c1" }]]);
});

test("A draft request is sent from the gig page with the existing publish RPC", async () => {
  const { tree, rpcs } = await openRequest({ asUser: "poster-1", gig: { status: "draft" } });
  assert.match(textOf(tree), /This request is a draft/);
  assert.equal(buttonText(tree, "Publish gig"), undefined, "worded as sending, not publishing");
  await buttonText(tree, "Send request").props.onClick();
  assert.deepEqual(rpcs, [["publish_gig", { p_gig_id: "gig-1" }]]);
});

test("After the helper accepts, the ordinary gig lifecycle continues: START, chat, address, completion and payment all use the existing sections", async () => {
  const accepted = { poster_id: "poster-1", requested_helper_id: "helper-1", selected_provider_id: "helper-1", agreed_amount: 40 };
  const asHelper = await openRequest({ gig: accepted, claims: { "helper-1": { state: "selected" } } });
  assert.match(textOf(asHelper.tree), /You accepted this request. Press START/);
  assert.ok(buttonText(asHelper.tree, "START"));
  assert.ok(nodes(asHelper.tree, (node) => node.type === "chat-panel").length === 1, "the existing gig chat");
  assert.equal(nodes(asHelper.tree, (node) => node.props["aria-label"] === "Request for you").length, 0, "no longer a pending request");
  await buttonText(asHelper.tree, "START").props.onClick();
  assert.deepEqual(asHelper.rpcs, [["request_start", { p_gig_id: "gig-1" }]]);

  const asPoster = await openRequest({ asUser: "poster-1", gig: { ...accepted, start_requested_at: "2026-10-02T10:00:00Z" } });
  await buttonText(asPoster.tree, "ACCEPT START — LET'S GO").props.onClick();
  assert.deepEqual(asPoster.rpcs, [["approve_start", { p_gig_id: "gig-1" }]]);

  const inProgress = await openRequest({ asUser: "poster-1", gig: { ...accepted, status: "in_progress" } });
  await buttonText(inProgress.tree, "COMPLETE").props.onClick();
  assert.equal(inProgress.rpcs[0][0], "submit_completion");
  const paying = await openRequest({ gig: { ...accepted, status: "awaiting_payment" } });
  assert.match(textOf(paying.tree), /Enter Amount Received/);
  const done = await openRequest({ asUser: "poster-1", gig: { ...accepted, status: "completed" } });
  assert.ok(buttonText(done.tree, "Skip"), "feedback step");
  assert.equal(nodes(done.tree, (node) => node.props["aria-label"] === "Private request").length, 0, "the poster's request panel disappears once a helper is assigned");
});

// ---- My Gigs and notifications ----
test("My Gigs (helper side) lists an unanswered request addressed to the helper under 'Requests for you', before proposals", () => {
  const { helperSection, helperBadge, HELPER_SECTIONS } = myGigsLib;
  const request = { status: "active", selected_provider_id: null, requested_helper_id: "me" };
  assert.equal(HELPER_SECTIONS[0].key, "requests");
  assert.equal(helperSection(request, null, "me"), "requests");
  assert.deepEqual({ ...helperBadge("requests", request, null) }, { label: "New request", tone: "pending" });
  assert.equal(helperSection(request, "pending", "me"), "proposals", "a counteroffer is an ordinary proposal");
  assert.equal(helperSection(request, "withdrawn", "me"), "closed");
  assert.equal(helperBadge("closed", request, "withdrawn").label, "Declined");
  assert.equal(helperBadge("closed", { ...request, requested_helper_id: null }, "withdrawn").label, "Withdrawn", "public gigs keep their wording");
  assert.equal(helperSection({ ...request, requested_helper_id: "someone-else" }, null, "me"), "closed", "a request for another helper is never listed");
  assert.equal(helperSection({ status: "active", selected_provider_id: null }, null, "me"), "closed", "public gigs without a claim are unchanged");
  assert.equal(helperSection({ ...request, selected_provider_id: "me", status: "in_progress" }, "selected", "me"), "in_progress", "after accepting, the normal sections");
});

test("My Gigs fetches gigs addressed to the helper (no claim needed) and marks the poster's private requests", async () => {
  const queries = [];
  const request = myGig("g-req", { poster_id: "c1", requested_helper_id: user.id, price_type: "negotiable" });
  const mine = myGig("g-mine", { requested_helper_id: "h1" });
  const client = fakeDb((query) => {
    queries.push(query);
    if (query.table === "gigs" && query.eq.poster_id) return { data: [mine], error: null };
    if (query.table === "gigs" && query.or) return { data: [request], error: null };
    if (query.table === "public_profiles") return { data: [{ id: "h1", username: "helper1" }, { id: "c1", username: "customer1" }].filter((row) => query.in.id.includes(row.id)), error: null };
    return { data: [], error: null };
  });
  const app = await component("src/app/my-gigs/page.tsx", "MyGigsInner", { client });
  app.render(); await flush();
  const posted = app.render();
  assert.match(textOf(sectionNamed(posted, "Open")), /Private request to @helper1/);
  assert.match(queries.find((query) => query.or).or, new RegExp(`requested_helper_id\\.eq\\.${user.id}`));
  nodes(posted, (node) => node.props.role === "tab")[1].props.onClick();
  const helping = app.render();
  assert.deepEqual(sectionLabels(helping), ["Requests for you"]);
  const text = textOf(sectionNamed(helping, "Requests for you"));
  assert.match(text, /Request from @customer1/);
  assert.match(text, /Offered: 50 CAD · Negotiable/);
  assert.match(text, /New request/);
});

test("A request notification opens the request panel; other notifications still open their gig or proposals", async () => {
  const bell = await loadLib("src/components/NotificationsBell.tsx", {
    react: {}, "next/navigation": {}, "@/lib/supabase/client": {}, "@/lib/auth-context": {}, "react/jsx-runtime": { jsx() {}, jsxs() {} },
  });
  assert.equal(bell.notificationHref({ gig_id: "g1", type: "gig_request" }), "/gigs/g1#request");
  assert.equal(bell.notificationHref({ gig_id: "g1", type: "claim_received" }), "/gigs/g1#proposals");
  for (const type of ["request_accepted", "request_declined", "request_withdrawn", "selected"]) assert.equal(bell.notificationHref({ gig_id: "g1", type }), "/gigs/g1");
});


// ---- /location: postcode, neighborhood, map pin ----
async function openLocationPage({ lookup, reverse, geolocation } = {}) {
  const locations = [];
  const app = await component("src/app/location/page.tsx", "LocationEntryInner", {
    storage: { setItem: (_key, value) => locations.push(JSON.parse(value)) },
    globals: { setTimeout: (fn) => { Promise.resolve().then(fn); return 1; }, clearTimeout() {}, navigator: { geolocation } },
    mocks: {
      "@/lib/area-lookup": { resolveAreaQuery: lookup ?? (async () => ({ kind: "none" })) },
      "@/lib/location": { LOCATION_KEY: "esg:general-area", loadJourneyLocation: () => ({ text: "", lat: null, lng: null }), reverseGeocodeGeneralArea: reverse ?? (async () => null) },
      "next/navigation": { useRouter: () => ({ push() {} }) },
    },
  });
  app.render();
  const type = async (value) => { nodes(app.render(), (node) => node.type === "input")[0].props.onChange({ target: { value } }); app.render(); await flush(); await flush(); return app.render(); };
  const mapOf = (tree) => nodes(tree, (node) => node.type === "map-picker")[0];
  return { app, locations, type, mapOf };
}
const singleArea = (areaLabel, lat, lng) => async () => ({ kind: "single", area: { label: areaLabel, areaLabel, lat, lng } });

test("/location: a Swedish postcode resolves to a place and a map pin, and Continue saves exactly that place", async () => {
  const { locations, type, mapOf } = await openLocationPage({ lookup: singleArea("244 31 Kävlinge, Skåne, Sweden", 55.79, 13.12) });
  const tree = await type("244 31");
  assert.deepEqual([mapOf(tree).props.lat, mapOf(tree).props.lng], [55.79, 13.12], "the map appears with the pin on the postcode");
  assert.match(textOf(nodes(tree, (node) => node.props.role === "status").at(-1)), /244 31 Kävlinge, Skåne, Sweden — approximate area/);
  button(tree, "Continue").props.onClick();
  assert.deepEqual(locations, [{ text: "244 31 Kävlinge, Skåne, Sweden", lat: 55.79, lng: 13.12 }]);
});

test("/location: Continue waits for a postcode to resolve, and a postcode that does not exist says so", async () => {
  const slow = await openLocationPage({ lookup: () => new Promise(() => {}) });
  let tree = await slow.type("24431");
  assert.equal(button(tree, "Continue").props.disabled, true, "no Continue while the postcode is still being looked up");
  const none = await openLocationPage({ lookup: async () => ({ kind: "none" }) });
  tree = await none.type("00000");
  assert.match(textOf(nodes(tree, (node) => node.props.role === "alert")[0]), /Couldn't find that postcode/);
  assert.equal(none.mapOf(tree), undefined, "no map for a place that was not found");
  assert.equal(none.locations.length, 0);
});

test("/location: an unavailable geocoder is reported, never saved as a place, and neighborhoods can still be entered by hand", async () => {
  const down = await openLocationPage({ lookup: async () => { throw new Error("offline"); } });
  let tree = await down.type("24431");
  assert.match(textOf(nodes(tree, (node) => node.props.role === "alert")[0]), /Couldn't look up that postcode right now/);
  assert.equal(down.locations.length, 0);
  const hand = await openLocationPage({ lookup: async () => { throw new Error("offline"); } });
  tree = await hand.type("Södermalm");
  assert.match(textOf(nodes(tree, (node) => node.props.role === "alert")[0]), /You can still continue with what you typed/);
  button(tree, "Continue").props.onClick();
  assert.deepEqual(hand.locations, [{ text: "Södermalm" }], "typed text alone is enough; no invented coordinates");
});

test("/location: an ambiguous postcode or a neighborhood search offers choices, and picking one drops the pin there", async () => {
  const choices = [
    { label: "Crimora, VA 24431", areaLabel: "Crimora, VA 24431", lat: 38.15, lng: -78.87 },
    { label: "244 31 Kävlinge", areaLabel: "244 31 Kävlinge, Skåne, Sweden", lat: 55.79, lng: 13.12 },
  ];
  const { locations, type, app, mapOf } = await openLocationPage({ lookup: async () => ({ kind: "choices", choices }) });
  let tree = await type("24431");
  const list = nodes(tree, (node) => node.props["aria-label"] === "Matching areas")[0];
  assert.deepEqual(nodes(list, (node) => node.type === "button").map(textOf), ["Crimora, VA 24431", "244 31 Kävlinge, Skåne, Sweden"]);
  assert.equal(button(tree, "Continue").props.disabled, true, "an ambiguous postcode must be chosen first");
  assert.equal(mapOf(tree), undefined);
  nodes(list, (node) => node.type === "button")[1].props.onClick();
  tree = app.render();
  assert.deepEqual([mapOf(tree).props.lat, mapOf(tree).props.lng], [55.79, 13.12]);
  assert.equal(nodes(tree, (node) => node.props["aria-label"] === "Matching areas").length, 0, "the list closes once chosen");
  button(tree, "Continue").props.onClick();
  assert.deepEqual(locations, [{ text: "244 31 Kävlinge, Skåne, Sweden", lat: 55.79, lng: 13.12 }]);
});

test("/location: moving the pin changes the saved coordinates and label together (rounded), and a failed label lookup keeps the pin", async () => {
  const labelled = await openLocationPage({ lookup: singleArea("Stockholm, Sweden", 59.33, 18.07), reverse: async (lat, lng) => { assert.deepEqual([lat, lng], [59.31, 18.06]); return "Södermalm, Stockholm"; } });
  let tree = await labelled.type("Stockholm");
  labelled.mapOf(tree).props.onPick({ lat: 59.31, lng: 18.06 });
  tree = labelled.app.render();
  assert.match(textOf(nodes(tree, (node) => node.props.role === "status").at(-1)), /Pinned location — approximate area/, "the text never describes the old place while the pin is elsewhere");
  await flush(); await flush();
  tree = labelled.app.render();
  assert.deepEqual([labelled.mapOf(tree).props.lat, labelled.mapOf(tree).props.lng], [59.31, 18.06]);
  assert.match(textOf(nodes(tree, (node) => node.props.role === "status").at(-1)), /Södermalm, Stockholm — approximate area/);
  button(tree, "Continue").props.onClick();
  assert.deepEqual(labelled.locations, [{ text: "Södermalm, Stockholm", lat: 59.31, lng: 18.06 }]);

  const offline = await openLocationPage({ lookup: singleArea("Stockholm, Sweden", 59.33, 18.07), reverse: async () => { throw new Error("offline"); } });
  tree = await offline.type("Stockholm");
  offline.mapOf(tree).props.onPick({ lat: 59.4, lng: 18.1 });
  await flush(); await flush();
  tree = offline.app.render();
  button(tree, "Continue").props.onClick();
  assert.deepEqual(offline.locations, [{ text: "Pinned location", lat: 59.4, lng: 18.1 }]);
});

test("/location: current location shows the pin without re-searching its own label, and a denial leaves manual entry working", async () => {
  const searches = [];
  const granted = await openLocationPage({
    lookup: async (text) => { searches.push(text); return { kind: "none" }; },
    geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 59.329323, longitude: 18.068581 } }) },
    reverse: async () => "Stockholm, Sweden",
  });
  button(granted.app.render(), "📍 Use My Location").props.onClick();
  await flush(); await flush();
  granted.app.render(); await flush(); await flush();
  let tree = granted.app.render();
  assert.deepEqual([granted.mapOf(tree).props.lat, granted.mapOf(tree).props.lng], [59.33, 18.07], "rounded coordinates on the map");
  assert.equal(nodes(tree, (node) => node.type === "input")[0].props.value, "Stockholm, Sweden");
  assert.deepEqual(searches, [], "the label the page wrote itself is not searched again");
  const denied = await openLocationPage({ geolocation: { getCurrentPosition: (_ok, fail) => fail() } });
  button(denied.app.render(), "📍 Use My Location").props.onClick();
  tree = denied.app.render();
  assert.match(textOf(nodes(tree, (node) => node.props.role === "alert")[0]), /Location permission denied/);
  tree = await denied.type("Lund");
  button(tree, "Continue").props.onClick();
  assert.deepEqual(denied.locations, [{ text: "Lund" }]);
});

// ===========================================================================
// Profile save: the OTHER text columns are sent only when they change (migration 0020 grants them)
// ===========================================================================
test("profileUpdate: an ordinary save names only skills and services; the OTHER text columns are sent exactly when they change", () => {
  const { profileUpdate, otherTextsChanged, otherTextFor } = profileSaveLib;
  const draft = (fields) => ({ skills: ["Cleaning"], services: ["Handyman"], skillsOtherText: "", servicesOtherText: "", ...fields });
  const none = { skills_other_text: null, services_other_text: null };
  const keys = (update) => Object.keys(update).sort().join(",");

  assert.equal(keys(profileUpdate(draft(), none)), "services,skills", "ordinary profile: nothing else is written");
  assert.equal(keys(profileUpdate(draft({ skills: ["Cleaning", "Errands"] }), none)), "services,skills", "skills changed, text untouched");

  // OTHER skills / services, newly chosen with their text.
  const withSkill = profileUpdate(draft({ skills: ["Cleaning", "Other"], skillsOtherText: "  Piano tuning  " }), none);
  assert.deepEqual({ ...withSkill }, { skills: ["Cleaning", "Other"], services: ["Handyman"], skills_other_text: "Piano tuning" }, "trimmed, and only the changed side is sent");
  const withService = profileUpdate(draft({ services: ["Other"], servicesOtherText: "Dog walking" }), none);
  assert.deepEqual({ ...withService }, { skills: ["Cleaning"], services: ["Other"], services_other_text: "Dog walking" });

  // Existing values are preserved by omission, never overwritten with a blank.
  const saved = { skills_other_text: "Piano tuning", services_other_text: "Dog walking" };
  const kept = profileUpdate(draft({ skills: ["Cleaning", "Other"], services: ["Handyman", "Other"], skillsOtherText: "Piano tuning", servicesOtherText: "Dog walking" }), saved);
  assert.equal(keys(kept), "services,skills", "both stored texts unchanged: neither column is in the payload");
  const keptOneSide = profileUpdate(draft({ skills: ["Cleaning", "Other"], services: ["Handyman", "Other"], skillsOtherText: "Piano and organ tuning", servicesOtherText: "Dog walking" }), saved);
  assert.equal(keptOneSide.skills_other_text, "Piano and organ tuning", "an edit to one text is never dropped");
  assert.equal("services_other_text" in keptOneSide, false, "and the other stored text is left alone");

  // Unticking OTHER clears its text (the database requires text exactly while OTHER is selected).
  const cleared = profileUpdate(draft({ skills: ["Cleaning"], skillsOtherText: "Piano tuning" }), saved);
  assert.equal(cleared.skills_other_text, null);
  assert.equal("services_other_text" in cleared, true, "the services side is also reconciled: OTHER is not selected there");

  // A draft left over from an unticked OTHER is not a change; empty and missing are the same.
  assert.deepEqual({ ...otherTextsChanged(draft({ skillsOtherText: "left over" }), none) }, { skills: false, services: false });
  assert.deepEqual({ ...otherTextsChanged(draft({ services: ["Other"] }), none) }, { skills: false, services: false }, "OTHER selected with no stored or typed text: unchanged");
  assert.equal(otherTextFor(["Other"], "   "), null);
  assert.equal(otherTextFor(["Cleaning"], "text"), null);
});

async function openProfileForSave({ profileFields = {}, updateResult = { error: null } } = {}) {
  const updates = [];
  const client = {
    from: (table) => table === "profile_tags"
      ? { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
      : { update: (payload) => { updates.push(JSON.parse(JSON.stringify(payload))); return { eq: () => ({ select: () => ({ single: async () => updateResult }) }) }; } },
    rpc: async () => ({ data: null, error: null }),
  };
  const app = await component("src/app/profile/page.tsx", "ProfileEditor", { client });
  const props = { profile: { ...profile, skills: ["Cleaning"], services: ["Other"], skills_other_text: null, services_other_text: "Dog walking", ...profileFields } };
  app.render(props); await flush();
  const submit = async () => { await nodes(app.render(props), (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} }); return app.render(props); };
  return { app, props, updates, submit };
}

test("Profile Save: an ordinary skills change does not write, and so cannot overwrite, the OTHER text columns", async () => {
  const { app, props, updates, submit } = await openProfileForSave();
  toggleCategory(skillsList(app.render(props)), "Handyman");
  await submit();
  assert.deepEqual(updates, [{ skills: ["Cleaning", "Handyman"], services: ["Other"] }], "the stored OTHER service text is preserved by omission");
});

test("Profile Save: choosing OTHER and typing the text saves exactly that text, trimmed, for skills and for services", async () => {
  const skill = await openProfileForSave({ profileFields: { services: ["Handyman"], services_other_text: null } });
  toggleCategory(skillsList(skill.app.render(skill.props)), "Other");
  skillsList(skill.app.render(skill.props)).props.setOtherText("  Piano tuning ");
  const skillTree = await skill.submit();
  assert.deepEqual(skill.updates, [{ skills: ["Cleaning", "Other"], services: ["Handyman"], skills_other_text: "Piano tuning" }]);
  assert.equal(nodes(skillTree, (node) => node.props.role === "alert").length, 0);

  const service = await openProfileForSave();
  servicesList(service.app.render(service.props)).props.setOtherText("Dog and cat walking");
  await service.submit();
  assert.deepEqual(service.updates, [{ skills: ["Cleaning"], services: ["Other"], services_other_text: "Dog and cat walking" }], "an edit to the text alone is saved, not discarded");
});

test("Profile Save: unticking OTHER clears its stored text, and leftover typed text is not an unsaved change", async () => {
  const { app, props, updates, submit } = await openProfileForSave();
  const hint = () => textOf(nodes(app.render(props), (node) => node.type === "p" && /unsaved changes|No changes yet/.test(textOf(node)))[0]);
  assert.equal(hint(), "No changes yet.");
  toggleCategory(servicesList(app.render(props)), "Other");
  assert.equal(hint(), "You have unsaved changes.");
  await submit();
  assert.deepEqual(updates, [{ skills: ["Cleaning"], services: [], services_other_text: null }], "the stored text is cleared with the selection");
  // Typing text while OTHER is not selected must not enable the button.
  const idle = await openProfileForSave({ profileFields: { services: ["Handyman"], services_other_text: null } });
  servicesList(idle.app.render(idle.props)).props.setOtherText("typed but OTHER is not selected");
  assert.equal(button(idle.app.render(idle.props), "Update profile").props.disabled, true);
});

test("Profile Save: OTHER without its text is still refused in the page, before anything is sent", async () => {
  const { app, props, updates, submit } = await openProfileForSave({ profileFields: { services: ["Handyman"], services_other_text: null } });
  toggleCategory(skillsList(app.render(props)), "Other");
  const tree = await submit();
  assert.deepEqual(updates, []);
  assert.match(textOf(nodes(tree, (node) => node.props.role === "alert")[0]), /Specify your OTHER skill/);
});

test("Profile Save: a permission refusal is explained as a permission problem, not as 'sign in again'", async () => {
  const denied = await openProfileForSave({ updateResult: { error: { code: "42501", message: "permission denied for table profiles" } } });
  toggleCategory(skillsList(denied.app.render(denied.props)), "Handyman");
  const tree = await denied.submit();
  const alert = textOf(nodes(tree, (node) => node.props.role === "alert")[0]);
  assert.match(alert, /don't have permission/);
  assert.doesNotMatch(alert, /sign in/i);
  assert.equal(nodes(tree, (node) => node.props.role === "status").length, 0, "no success message");
  assert.match(textOf(nodes(tree, (node) => node.type === "p" && /unsaved changes/.test(textOf(node)))[0]), /unsaved changes/, "still unsaved");
});

test("friendlyError: 42501 is a permission message unless our own function says authentication is required; other mappings are unchanged", () => {
  const { friendlyError, rpcActionError } = journeyLib;
  assert.match(friendlyError({ code: "42501", message: "permission denied for table profiles" }), /don't have permission/);
  assert.match(friendlyError({ code: "42501", message: "new row violates row-level security policy for table \"profiles\"" }), /don't have permission/);
  assert.match(friendlyError({ code: "42501", message: "Not authorized" }), /don't have permission/);
  assert.match(friendlyError({ code: "42501" }), /don't have permission/, "no message: still a permission problem");
  assert.doesNotMatch(friendlyError({ code: "42501", message: "permission denied for table profiles" }), /sign in/i);
  assert.match(friendlyError({ code: "42501", message: "Authentication required" }), /sign in again/, "a genuine missing session still asks to sign in");
  assert.match(friendlyError({ code: "42501", message: "authentication required." }), /sign in again/);
  assert.match(friendlyError({ code: "email_not_confirmed" }), /Verify your email/);
  assert.match(friendlyError({ code: "invalid_credentials" }), /isn't right/);
  assert.match(friendlyError({ code: "22023", message: "Pick a future date/time before posting." }), /future date/);
  assert.equal(friendlyError({ code: "XX000" }, "fallback"), "fallback");
  assert.match(rpcActionError({ code: "42501", message: "Not authorized" }), /sign in again/, "lifecycle RPC errors keep their existing wording (unchanged here)");
});

// ---- Gig page: full-width link buttons must center their text ----
// .touch-link is `display: inline-flex` and sits outside Tailwind's layers, so it beats `block` and
// makes `text-center` a no-op: the label hugged the left edge of its box. Link-styled buttons that
// fill their row use an explicit flex centering instead.
test("Gig page: the Message helper link and the proposal's View profile link center their text and keep a touch-size target", async () => {
  const accepted = await openGig({ poster_id: user.id, selected_provider_id: "helper-1" });
  const message = nodes(accepted.tree, (node) => node.type === "a" && node.props.href === "#messages")[0];
  assert.ok(message, "the Message link is there");
  for (const cls of [message.props.className]) {
    assert.match(cls, /\bflex\b/);
    assert.match(cls, /\bjustify-center\b/);
    assert.match(cls, /\bitems-center\b/);
    assert.match(cls, /\bmin-h-11\b/, "44px touch target");
    assert.match(cls, /\bpx-4\b/, "horizontal padding so the label never touches the border");
    assert.doesNotMatch(cls, /\btouch-link\b/, "touch-link (inline-flex) overrides block and text-center");
  }
  const claims = [{ id: "c1", gig_id: "gig-1", provider_id: "helper-1", state: "pending", offer_amount: 40, created_at: "2026-10-01T10:00:00Z" }];
  const open = await openGig({ poster_id: user.id }, { claims });
  const profileLink = nodes(open.tree, (node) => node.type === "a" && /View profile/.test(textOf(node)));
  assert.ok(profileLink.length > 0, "the proposal shows a View profile link");
  for (const link of profileLink) {
    assert.match(link.props.className, /\bjustify-center\b/);
    assert.doesNotMatch(link.props.className, /\btouch-link\b/);
  }
});

// ---- Chat panel presentation ----
async function openChat({ rows = [], readOnly = false, proposals = [], negotiation, rpcError = null, onPriceChanged, proposalsError = null } = {}) {
  const inserts = [], rpcs = [], current = { proposals: proposals.map((proposal) => ({ ...proposal })) };
  const table = (data, error = null) => {
    const query = {
      select() { return query; }, eq() { return query; },
      order() { return { then: (ok) => Promise.resolve(error ? { data: null, error } : { data: data() }).then(ok) }; },
      update() { const chain = { eq() { return chain; }, neq() { return chain; }, is() { return Promise.resolve({ error: null }); } }; return chain; },
      insert: async (payload) => { inserts.push(JSON.parse(JSON.stringify(payload))); return { error: null }; },
    };
    return query;
  };
  const messages = table(() => rows), proposalTable = table(() => current.proposals, proposalsError);
  const client = {
    from: (name) => (name === "price_proposals" ? proposalTable : messages),
    rpc: async (name, args) => { rpcs.push([name, JSON.parse(JSON.stringify(args))]); return { data: null, error: rpcError }; },
    channel() { const c = { on() { return c; }, subscribe() { return c; } }; return c; }, removeChannel() {},
  };
  const app = await component("src/components/ChatPanel.tsx", "ChatPanel", {
    client, globals: { Event: class { constructor(type) { this.type = type; } }, window: { dispatchEvent() {} } },
  });
  const props = { gigId: "g1", currentUserId: "me", readOnly, negotiation, otherName: "@helper1", onPriceChanged };
  app.render(props); await flush();
  return { app, props, inserts, rpcs, current, tree: app.render(props) };
}
const chatBubbles = (tree) => nodes(tree, (node) => node.type === "div" && typeof node.props.className === "string" && /\brounded-2xl\b/.test(node.props.className) && /\bpx-3\.5\b/.test(node.props.className));
const chatStamps = (tree) => nodes(tree, (node) => node.type === "p" && /text-\[11px\]/.test(node.props.className ?? "")).map(textOf);

test("Chat: bubbles are grouped per sender, dated, timed, and only your last read message says Seen", async () => {
  const at = (daysAgo, hh, mm) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
  const rows = [
    { id: "1", sender_id: "them", body: "I accept", created_at: at(1, 9, 0), read_at: at(1, 9, 1) },
    { id: "2", sender_id: "them", body: "Hello", created_at: at(0, 10, 0), read_at: at(0, 10, 1) },
    { id: "3", sender_id: "me", body: "Good", created_at: at(0, 10, 1), read_at: at(0, 10, 2) },
    { id: "4", sender_id: "me", body: "See you Saturday", created_at: at(0, 10, 2), read_at: at(0, 10, 3) },
  ];
  const { tree } = await openChat({ rows });
  const log = nodes(tree, (node) => node.props.role === "log")[0];
  assert.ok(log, "the conversation is an accessible live log");
  const chips = nodes(log, (node) => node.type === "span" && /rounded-full/.test(node.props.className ?? "")).map(textOf);
  assert.deepEqual(chips, ["Yesterday", "Today"], "a date chip starts each day");
  assert.equal(chatBubbles(tree).length, 4);
  const mine = chatBubbles(tree).filter((node) => /bg-emerald-600/.test(node.props.className));
  assert.equal(mine.length, 2);
  assert.doesNotMatch(mine[0].props.className, /rounded-br-md/, "inside a group only the last bubble gets the corner tail");
  assert.match(mine[1].props.className, /rounded-br-md/);
  const stamps = chatStamps(tree);
  assert.equal(stamps.length, 3, "one time stamp per group: yesterday's message, today's 'Hello', your two messages");
  assert.ok(stamps.every((text) => /\d{1,2}:\d{2}/.test(text)));
  assert.equal(stamps.filter((text) => /Seen/.test(text)).length, 1, "Seen appears once");
  assert.match(stamps.at(-1), /Seen/, "on the last message you sent");
  assert.match(chatBubbles(tree)[0].props.className, /bg-white/, "their messages are white with a border");
  assert.doesNotMatch(JSON.stringify(tree), /touch-link/);
});

test("Chat: an unread message of yours is not marked Seen, and an empty chat invites the first message", async () => {
  const unread = await openChat({ rows: [{ id: "1", sender_id: "me", body: "Hi", created_at: new Date().toISOString(), read_at: null }] });
  assert.equal(chatStamps(unread.tree).filter((text) => /Seen/.test(text)).length, 0);
  const empty = await openChat();
  assert.match(textOf(empty.tree), /No messages yet/);
  assert.match(textOf(empty.tree), /Say hello/);
});

test("Chat: the composer is a form; Send is disabled until there is text, Enter or the button sends the trimmed text once", async () => {
  const { app, props, inserts, tree } = await openChat();
  const form = () => nodes(app.render(props), (node) => node.type === "form")[0];
  const sendButton = () => nodes(form(), (node) => node.type === "button")[0];
  assert.equal(sendButton().props["aria-label"], "Send message");
  assert.equal(sendButton().props.disabled, true, "nothing to send yet");
  assert.equal(nodes(tree, (node) => node.type === "input")[0].props["aria-label"], "Message");
  nodes(form(), (node) => node.type === "input")[0].props.onChange({ target: { value: "   " } });
  assert.equal(sendButton().props.disabled, true, "whitespace is not a message");
  nodes(form(), (node) => node.type === "input")[0].props.onChange({ target: { value: "  On my way  " } });
  assert.equal(sendButton().props.disabled, false);
  let prevented = false;
  await form().props.onSubmit({ preventDefault() { prevented = true; } });
  await flush();
  assert.equal(prevented, true, "the page never reloads");
  assert.deepEqual(inserts, [{ gig_id: "g1", sender_id: "me", body: "On my way" }]);
  assert.equal(nodes(form(), (node) => node.type === "input")[0].props.value, "", "the box clears after a successful send");
});

test("Chat: a closed gig shows the read-only notice instead of a composer", async () => {
  const { tree } = await openChat({ readOnly: true });
  assert.equal(nodes(tree, (node) => node.type === "form").length, 0);
  assert.match(textOf(tree), /read-only/);
});

test("Chat: Seen is shown once, on your most recent message, even if earlier messages of yours were read too", async () => {
  const at = (hh, mm) => { const d = new Date(); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
  const { tree } = await openChat({ rows: [
    { id: "1", sender_id: "me", body: "First", created_at: at(9, 0), read_at: at(9, 1) },
    { id: "2", sender_id: "them", body: "Reply", created_at: at(9, 2), read_at: at(9, 2) },
    { id: "3", sender_id: "me", body: "Second", created_at: at(9, 3), read_at: at(9, 4) },
  ] });
  const stamps = chatStamps(tree);
  assert.equal(stamps.length, 3);
  assert.equal(stamps.filter((text) => /Seen/.test(text)).length, 1);
  assert.match(stamps.at(-1), /Seen/);
});

// ===========================================================================
// Price negotiation in the chat (migration 0021): up to three rounds, propose / counter / accept / decline
// ===========================================================================
test("negotiation helpers: rounds, who may propose, amount checks, error wording and card status", () => {
  const { negotiationView, proposalAmountError, negotiationActionError, proposalStatus, MAX_PRICE_ROUNDS } = negotiationLib;
  const p = (fields) => ({ id: "p" + Math.random(), gig_id: "g", proposer_id: "them", round: 1, from_amount: 100, amount: 120, state: "declined", created_at: "2026-10-01T10:00:00Z", responded_at: "2026-10-01T10:01:00Z", ...fields });
  assert.equal(MAX_PRICE_ROUNDS, 3);
  const none = negotiationView([], "me", true);
  assert.deepEqual({ ...none }, { used: 0, remaining: 3, nextRound: 1, pending: null, agreed: false, pendingFromOther: false, pendingFromMe: false, canPropose: true });
  assert.equal(negotiationView([], "me", false).canPropose, false, "not before the helper is chosen, nor after start");
  const theirs = p({ state: "pending", responded_at: null });
  const owed = negotiationView([theirs], "me", true);
  assert.equal(owed.pendingFromOther, true);
  assert.equal(owed.canPropose, true, "you can counter their proposal");
  const mine = negotiationView([p({ proposer_id: "me", state: "pending", responded_at: null })], "me", true);
  assert.equal(mine.pendingFromMe, true);
  assert.equal(mine.canPropose, false, "you wait for their answer");
  const used = negotiationView([p({ round: 1 }), p({ round: 2 }), p({ round: 3 })], "me", true);
  assert.deepEqual([used.used, used.remaining, used.canPropose], [3, 0, false], "three rounds is the limit, whatever happened to them");
  assert.equal(negotiationView([p({ state: "withdrawn" }), p({ round: 2 })], "me", true).remaining, 1, "a withdrawn proposal still counts as a round");
  const agreed = negotiationView([p({ state: "accepted" })], "me", true);
  assert.deepEqual([agreed.agreed, agreed.canPropose], [true, false], "an accepted price ends the negotiation");

  assert.equal(proposalAmountError("120", 100), null);
  assert.equal(proposalAmountError(" 99.5 ", 100), null);
  for (const bad of ["", "abc", "-5", "0", "100.123", "1e3", "10000000000"]) assert.match(proposalAmountError(bad, 100), /positive price/, bad);
  assert.equal(proposalAmountError("100", 100), "That is already the agreed price.");
  assert.equal(proposalAmountError("100.00", 100), "That is already the agreed price.");

  assert.equal(negotiationActionError({ code: "P0001", message: "You already have a proposal waiting for a reply. Withdraw it first." }), "You already have a proposal waiting for a reply. Withdraw it first.");
  assert.equal(negotiationActionError({ code: "22023", message: "That is already the agreed price." }), "That is already the agreed price.");
  assert.match(negotiationActionError({ code: "42501", message: "Not authorized" }), /can't change the price/);
  assert.equal(negotiationActionError({ code: "XX000", message: "relation \"price_proposals\" does not exist" }), "Couldn't send that. Please try again.", "internal details are never shown");
  assert.equal(negotiationActionError(null), "Couldn't send that. Please try again.");

  assert.equal(proposalStatus(theirs, "me", true), "answer");
  assert.equal(proposalStatus(mine.pending, "me", true), "waiting");
  assert.equal(proposalStatus(theirs, "me", false), "closed");
  for (const state of ["accepted", "declined", "withdrawn"]) assert.equal(proposalStatus(p({ state }), "me", true), state);
});

const nowIso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
const prop = (fields = {}) => ({ id: "pp" + (fields.round ?? 1), gig_id: "g1", proposer_id: "them", round: 1, from_amount: 100, amount: 120, state: "pending", created_at: nowIso(5), responded_at: null, ...fields });
const open = { open: true, agreedAmount: 100 };
const buttonLabelled = (tree, pattern) => nodes(tree, (node) => node.type === "button" && pattern.test(String(node.props["aria-label"] ?? textOf(node))))[0];
const proposeButton = (tree) => nodes(tree, (node) => node.type === "button" && /(Propose a new price|Counter with another price)/.test(textOf(node)))[0];
const proposalCards = (tree) => nodes(tree, (node) => node.type === "section" && /^Price proposal/.test(node.props["aria-label"] ?? ""));

test("Chat negotiation: a proposal appears as a card in the conversation, in time order, and the recipient can Accept or Decline", async () => {
  const rows = [
    { id: "m1", sender_id: "them", body: "Could we do a bit more?", created_at: nowIso(10), read_at: null },
    { id: "m2", sender_id: "me", body: "Maybe", created_at: nowIso(2), read_at: null },
  ];
  const { app, props, rpcs, tree } = await openChat({ rows, proposals: [prop({ created_at: nowIso(5) })], negotiation: open });
  const log = nodes(tree, (node) => node.props.role === "log")[0];
  const order = nodes(log, (node) => (node.type === "section" && /^Price proposal/.test(node.props["aria-label"] ?? "")) || (node.type === "div" && /rounded-2xl/.test(node.props.className ?? "") && /px-3\.5/.test(node.props.className ?? "")))
    .map((node) => (node.type === "section" ? "proposal" : textOf(node)));
  assert.deepEqual(order, ["Could we do a bit more?", "proposal", "Maybe"], "the card sits between the messages around it, by time");
  const card = proposalCards(tree)[0];
  assert.match(textOf(card), /Price proposal · Round 1 of 3/);
  assert.match(textOf(card), /120 CAD/);
  assert.match(textOf(card), /100 CAD/, "the price it started from is shown, struck through");
  assert.match(textOf(card), /@helper1 proposed this/, "named after the other person");

  buttonLabelled(card, /^Accept/).props.onClick();
  await flush(); await flush();
  assert.deepEqual(rpcs, [["respond_price_proposal", { p_proposal_id: "pp1", p_accept: true }]]);
  buttonLabelled(app.render(props), /^Decline/).props.onClick();
  await flush(); await flush();
  assert.deepEqual(rpcs.at(-1), ["respond_price_proposal", { p_proposal_id: "pp1", p_accept: false }]);
});

test("Chat negotiation: your own proposal says it is waiting and can be withdrawn, but cannot be accepted by you", async () => {
  const { tree, rpcs } = await openChat({ proposals: [prop({ proposer_id: "me" })], negotiation: open });
  const card = proposalCards(tree)[0];
  assert.match(textOf(card), /You proposed this/);
  assert.match(textOf(card), /Waiting for a reply/);
  assert.equal(buttonLabelled(card, /^(Accept|Decline)/), undefined, "no Accept/Decline on your own proposal");
  nodes(card, (node) => node.type === "button" && textOf(node) === "Withdraw")[0].props.onClick();
  await flush(); await flush();
  assert.deepEqual(rpcs, [["withdraw_price_proposal", { p_proposal_id: "pp1" }]]);
  assert.equal(proposeButton(tree), undefined, "you cannot stack a second proposal while yours waits");
});

test("Chat negotiation: answered proposals show their outcome, and a late one says the price can no longer change", async () => {
  const states = [["accepted", /Accepted\. The agreed price is 120 CAD/], ["declined", /Declined/], ["withdrawn", /Withdrawn/]];
  for (const [state, pattern] of states) {
    const { tree } = await openChat({ proposals: [prop({ state, responded_at: nowIso(1) })], negotiation: open });
    const card = proposalCards(tree)[0];
    assert.match(textOf(card), pattern, state);
    assert.equal(buttonLabelled(card, /^(Accept|Decline|Withdraw)/), undefined, "no actions on an answered proposal");
  }
  const late = await openChat({ proposals: [prop()], negotiation: { open: false, agreedAmount: 100 } });
  assert.match(textOf(proposalCards(late.tree)[0]), /can no longer be changed/);
  assert.equal(buttonLabelled(proposalCards(late.tree)[0], /^(Accept|Decline)/), undefined, "once start was requested the pending proposal cannot be answered");
  const accepted = proposalCards((await openChat({ proposals: [prop({ state: "accepted", responded_at: nowIso(1) })], negotiation: open })).tree)[0];
  assert.match(accepted.props.className, /border-emerald-300/, "an accepted price is highlighted");
});

test("Chat negotiation: Propose a new price opens a small form, checks the amount, and sends it through propose_price", async () => {
  let changed = 0;
  const { app, props, rpcs, tree } = await openChat({ negotiation: open, onPriceChanged: () => { changed++; } });
  assert.match(textOf(proposeButton(tree)), /Propose a new price/);
  assert.match(textOf(proposeButton(tree)), /3 of 3 left/);
  proposeButton(tree).props.onClick();
  let form = nodes(app.render(props), (node) => node.type === "form" && node.props["aria-label"] === "Propose a new price")[0];
  assert.ok(form, "the form opens above the message box");
  assert.match(textOf(form), /now 100 CAD/);
  assert.match(textOf(form), /round 1 of 3/);
  const type = (value) => nodes(form, (node) => node.type === "input")[0].props.onChange({ target: { value } });
  // Nothing is sent for an unusable amount, and the reason is shown.
  for (const [bad, message] of [["abc", /positive price/], ["100", /already the agreed price/], ["12.345", /positive price/]]) {
    type(bad);
    form = nodes(app.render(props), (node) => node.type === "form" && node.props["aria-label"] === "Propose a new price")[0];
    form.props.onSubmit({ preventDefault() {} });
    await flush(); await flush();
    assert.match(textOf(nodes(app.render(props), (node) => node.props.role === "alert")[0]), message);
  }
  assert.deepEqual(rpcs, [], "no request for invalid amounts");
  type("120.50");
  form = nodes(app.render(props), (node) => node.type === "form" && node.props["aria-label"] === "Propose a new price")[0];
  form.props.onSubmit({ preventDefault() {} });
  await flush(); await flush();
  assert.deepEqual(rpcs, [["propose_price", { p_gig_id: "g1", p_amount: 120.5 }]]);
  assert.equal(changed, 1, "the gig page is told to refresh");
  assert.equal(nodes(app.render(props), (node) => node.type === "form" && node.props["aria-label"] === "Propose a new price").length, 0, "the form closes after a successful proposal");
});

test("Chat negotiation: a refusal from the server is explained in words, and Cancel closes the form", async () => {
  const { app, props, tree } = await openChat({ negotiation: open, rpcError: { code: "P0001", message: "The price has already been proposed three times." } });
  proposeButton(tree).props.onClick();
  let form = nodes(app.render(props), (node) => node.type === "form" && node.props["aria-label"] === "Propose a new price")[0];
  nodes(form, (node) => node.type === "input")[0].props.onChange({ target: { value: "130" } });
  form = nodes(app.render(props), (node) => node.type === "form" && node.props["aria-label"] === "Propose a new price")[0];
  form.props.onSubmit({ preventDefault() {} });
  await flush(); await flush();
  assert.match(textOf(nodes(app.render(props), (node) => node.props.role === "alert")[0]), /proposed three times/);
  const cancel = nodes(app.render(props), (node) => node.type === "button" && textOf(node) === "Cancel")[0];
  cancel.props.onClick();
  assert.equal(nodes(app.render(props), (node) => node.type === "form" && node.props["aria-label"] === "Propose a new price").length, 0);
});

test("Chat negotiation: the propose control is hidden when the price cannot change, and says why when the rounds are used up", async () => {
  const closed = await openChat({ negotiation: { open: false, agreedAmount: 100 } });
  assert.equal(proposeButton(closed.tree), undefined, "after start (or before a helper is chosen) there is no price control");
  const none = await openChat({});
  assert.equal(proposeButton(none.tree), undefined, "no negotiation prop: plain chat");
  const readOnly = await openChat({ readOnly: true, negotiation: open });
  assert.equal(proposeButton(readOnly.tree), undefined, "a finished conversation is read-only");
  const done = (n, state = "declined") => Array.from({ length: n }, (_, i) => prop({ id: `d${i}`, round: i + 1, state, proposer_id: i % 2 ? "me" : "them", responded_at: nowIso(1) }));
  const exhausted = await openChat({ negotiation: open, proposals: done(3) });
  assert.equal(proposeButton(exhausted.tree), undefined);
  assert.match(textOf(exhausted.tree), /All three price proposals have been used/);
  const agreed = await openChat({ negotiation: open, proposals: [prop({ state: "accepted", responded_at: nowIso(1) })] });
  assert.equal(proposeButton(agreed.tree), undefined);
  assert.match(textOf(agreed.tree), /A new price was agreed/);
  const two = await openChat({ negotiation: open, proposals: done(2) });
  assert.match(textOf(proposeButton(two.tree)), /1 of 3 left/, "the button counts what is left");
  const counter = await openChat({ negotiation: open, proposals: [prop({ round: 1 })] });
  assert.match(textOf(proposeButton(counter.tree)), /Counter with another price/, "while an answer is owed, proposing is a counter");
});

test("Gig page: the chat is told when the price can be negotiated (helper chosen, start not yet requested) and who the other person is", async () => {
  const chat = (tree) => nodes(tree, (node) => node.type === "chat-panel")[0];
  const selected = await openGig({ poster_id: user.id, selected_provider_id: "helper-1", agreed_amount: 55, amount: 50 });
  assert.deepEqual({ ...chat(selected.tree).props.negotiation }, { open: true, agreedAmount: 55 }, "negotiate from the agreed price, not the original budget");
  assert.equal(chat(selected.tree).props.otherName, "@helper1");
  assert.equal(typeof chat(selected.tree).props.onPriceChanged, "function", "the page reloads the gig when a price is accepted");
  const asHelper = await openGig({ selected_provider_id: user.id, agreed_amount: 50 });
  assert.equal(chat(asHelper.tree).props.otherName, "@customer1");
  assert.equal(chat(asHelper.tree).props.negotiation.open, true);
  const started = await openGig({ poster_id: user.id, selected_provider_id: "helper-1", start_requested_at: "2026-10-02T10:00:00Z" });
  assert.equal(chat(started.tree).props.negotiation.open, false, "the price is fixed once the helper asks to start");
  const running = await openGig({ poster_id: user.id, selected_provider_id: "helper-1", status: "in_progress" });
  assert.equal(chat(running.tree).props.negotiation.open, false);
});

test("A price notification opens the chat where the proposal waits; other notification links are unchanged", async () => {
  const bell = await loadLib("src/components/NotificationsBell.tsx", {
    react: {}, "next/navigation": {}, "@/lib/supabase/client": {}, "@/lib/auth-context": {}, "react/jsx-runtime": { jsx() {}, jsxs() {} },
  });
  for (const type of ["price_proposed", "price_accepted", "price_declined", "price_withdrawn"]) assert.equal(bell.notificationHref({ gig_id: "g1", type }), "/gigs/g1#messages", type);
  assert.equal(bell.notificationHref({ gig_id: "g1", type: "gig_request" }), "/gigs/g1#request");
  assert.equal(bell.notificationHref({ gig_id: "g1", type: "claim_received" }), "/gigs/g1#proposals");
  assert.equal(bell.notificationHref({ gig_id: "g1", type: "selected" }), "/gigs/g1");
});

test("Chat negotiation: on a server without migration 0021 the price controls stay hidden and the chat still works", async () => {
  const missing = { code: "PGRST205", message: "Could not find the table 'public.price_proposals' in the schema cache" };
  const { tree, inserts, app, props } = await openChat({ negotiation: open, proposalsError: missing, rows: [{ id: "m1", sender_id: "them", body: "Hi", created_at: nowIso(3), read_at: null }] });
  assert.equal(proposeButton(tree), undefined, "no button that could not work");
  assert.equal(proposalCards(tree).length, 0);
  assert.equal(nodes(tree, (node) => node.props.role === "alert").length, 0, "and no scary error");
  assert.match(textOf(tree), /Hi/, "messages still load");
  nodes(app.render(props), (node) => node.type === "input")[0].props.onChange({ target: { value: "Still here" } });
  await nodes(app.render(props), (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  await flush();
  assert.deepEqual(inserts, [{ gig_id: "g1", sender_id: "me", body: "Still here" }], "sending messages is unaffected");
});

test("negotiation errors: an upgrade-pending server is reported as unavailable, not as a generic failure", () => {
  const { negotiationUnavailable, negotiationActionError } = negotiationLib;
  for (const code of ["PGRST205", "PGRST202", "42P01", "42883"]) assert.equal(negotiationUnavailable({ code }), true, code);
  for (const bad of [null, undefined, {}, { code: "P0001" }, { code: "42501" }]) assert.equal(negotiationUnavailable(bad), false);
  assert.equal(negotiationActionError({ code: "PGRST202", message: "Could not find the function public.propose_price(p_amount, p_gig_id) in the schema cache" }), "Price negotiation isn't available on this server yet.");
  assert.doesNotMatch(negotiationActionError({ code: "PGRST202", message: "Could not find the function public.propose_price" }), /schema cache|public./);
});

// ===========================================================================
// Repost a closed gig as a new gig
// ===========================================================================
test("repost helpers: only your own cancelled, completed or incomplete gigs, a validated id, and a draft that leaves out what must not be copied", () => {
  const { canRepost, repostParam, repostHref, repostPrivateHref, repostDraft, REPOSTABLE_STATUSES } = repostLib;
  assert.deepEqual([...REPOSTABLE_STATUSES], ["cancelled", "completed", "incomplete"]);
  for (const status of REPOSTABLE_STATUSES) assert.equal(canRepost({ poster_id: "me", status }, "me"), true, status);
  for (const status of ["draft", "active", "in_progress", "awaiting_payment", "disputed"]) assert.equal(canRepost({ poster_id: "me", status }, "me"), false, status);
  assert.equal(canRepost({ poster_id: "someone", status: "cancelled" }, "me"), false, "only the poster");
  assert.equal(canRepost({ poster_id: "me", status: "cancelled" }, null), false);
  assert.equal(repostParam("11111111-2222-4333-8444-555555555555"), "11111111-2222-4333-8444-555555555555");
  assert.equal(repostParam("11111111-2222-4333-8444-55555555555G"), null);
  for (const bad of [null, undefined, "", "abc", "../x", "1; drop table gigs", "11111111-2222-4333-8444-5555555555555"]) assert.equal(repostParam(bad), null, String(bad));
  assert.equal(repostHref("g-1"), "/post?repost=g-1");
  assert.equal(repostPrivateHref("g-1", "HelperOne", "Yard Work"), "/post?helper=HelperOne&category=Yard+Work&repost=g-1");

  const gig = { service_type: "Cleaning", title: "Rake leaves", description: "Front yard", amount: 55, location_text: "Kävlinge", lat: 55.79, lng: 13.11, photo_url: "https://x.invalid/p.jpg",
    gig_tags: [{ tag_id: "t1" }, { tag_id: "t2" }, { tag_id: "t1" }],
    // Everything below must never reach the draft:
    status: "cancelled", scheduled_at: "2020-01-01T00:00:00Z", selected_provider_id: "h", requested_helper_id: "h", agreed_amount: 70, id: "old" };
  const draft = repostDraft(gig, "Storgatan 1");
  assert.deepEqual({ ...draft, tagIds: [...draft.tagIds] }, { serviceType: "Cleaning", title: "Rake leaves", description: "Front yard", amount: "55", locationText: "Kävlinge", lat: 55.79, lng: 13.11,
    photoUrl: "https://x.invalid/p.jpg", tagIds: ["t1", "t2"], privateAddress: "Storgatan 1" }, "the original budget, tags de-duplicated, the private address kept");
  assert.equal(repostDraft({ ...gig, location_text: null, photo_url: null, gig_tags: null }, null).locationText, "");
  assert.deepEqual(Object.keys(draft).sort(), ["amount", "description", "lat", "lng", "locationText", "photoUrl", "privateAddress", "serviceType", "tagIds", "title"], "no date, status, helper or price history in the draft");
});

test("Gig page: a closed gig of yours offers Repost as a new gig; nobody else, and no other status, does", async () => {
  const repostSection = (tree) => nodes(tree, (node) => node.props["aria-label"] === "Repost this gig")[0];
  for (const status of ["cancelled", "completed", "incomplete"]) {
    const { tree } = await openGig({ poster_id: user.id, status, selected_provider_id: status === "cancelled" ? null : "helper-1" });
    const section = repostSection(tree);
    assert.ok(section, status);
    const link = nodes(section, (node) => node.type === "a" && textOf(node) === "Repost as a new gig")[0];
    assert.equal(link.props.href, "/post?repost=gig-1");
    assert.match(link.props.className, /min-h-11/, "44px target");
    assert.match(textOf(section), /stays in your history as it is/);
    assert.equal(nodes(section, (node) => node.type === "a").length, 1, "a public gig has only the one action");
  }
  for (const status of ["draft", "active", "in_progress", "awaiting_payment", "disputed"]) {
    assert.equal(repostSection((await openGig({ poster_id: user.id, status, selected_provider_id: status === "draft" || status === "active" ? null : "helper-1" })).tree), undefined, status);
  }
  assert.equal(repostSection((await openGig({ poster_id: "poster-1", status: "cancelled" })).tree), undefined, "someone else's gig");
  assert.equal(repostSection((await openGig({ poster_id: "poster-1", status: "completed", selected_provider_id: user.id })).tree), undefined, "the helper cannot repost the poster's gig");
});

test("Gig page: a closed private request can be reposted publicly or sent to the same helper again", async () => {
  const { tree } = await openGig({ poster_id: user.id, status: "cancelled", requested_helper_id: "helper-1", service_type: "Yard Work", price_type: "negotiable" });
  const section = nodes(tree, (node) => node.props["aria-label"] === "Repost this gig")[0];
  const links = nodes(section, (node) => node.type === "a");
  assert.deepEqual(links.map(textOf), ["Repost as a new gig", "Send to @helper1 again"]);
  assert.equal(links[1].props.href, "/post?helper=helper1&category=Yard+Work&repost=gig-1");
  assert.match(textOf(section), /private request.*visible to every helper/);
});

// ---- the Post a Gig form, prefilled ----
const REPOST_ID = "11111111-2222-4333-8444-555555555555";
async function openRepostForm({ search = `repost=${REPOST_ID}`, gig, address = "Storgatan 1, 2tr", gigError = null, stored = new Map(), asUser = user, helper = null } = {}) {
  const calls = [], destinations = [], queries = [];
  const base = { id: REPOST_ID, poster_id: asUser.id, status: "cancelled", service_type: "Cleaning", title: "Rake leaves", description: "Front yard", amount: 55, agreed_amount: 70,
    location_text: "Kävlinge", lat: 55.79, lng: 13.11, photo_url: "https://x.invalid/p.jpg", requested_helper_id: null, selected_provider_id: null, scheduled_at: "2020-01-01T00:00:00Z",
    gig_tags: [{ tag_id: "t1" }], ...gig };
  const tables = { gigs: gig === null ? null : base, gig_private_locations: address == null ? null : { address_text: address }, public_profiles: helper };
  const client = {
    from: (table) => {
      const api = { select: () => api, eq: (field, value) => { queries.push([table, field, value]); return api; }, maybeSingle: async () => ({ data: tables[table] ?? null, error: table === "gigs" ? gigError : null }) };
      return api;
    },
    rpc: async (name, payload) => { calls.push({ name, payload }); return { data: { id: "new-gig", status: payload.p_publish ? "active" : "draft" }, error: null }; },
  };
  const app = await component("src/app/post/page.tsx", "PostGigForm", {
    client,
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
    globals: { crypto: { randomUUID: () => "99999999-9999-4999-8999-999999999999" } },
    mocks: {
      "next/navigation": { useSearchParams: () => new URLSearchParams(search), useRouter: () => ({ replace: (url) => destinations.push(url) }) },
      "@/lib/location": { loadJourneyLocation: () => ({ text: "Somewhere else", lat: 1, lng: 2 }), reverseGeocodeGeneralArea: async () => null },
    },
  });
  app.auth.user = asUser;
  app.render(); await flush(); await flush();
  return { app, calls, destinations, queries, stored, tree: app.render() };
}
const setField = (app, predicate, value) => { nodes(app.render(), predicate)[0].props.onChange({ target: { value } }); };
const titleInput = (node) => node.type === "input" && node.props.maxLength === 120;
const dateInput = (node) => node.props.type === "datetime-local";

test("Repost: the form opens prefilled from the closed gig, asks for a new date, and posts a NEW public gig through create_gig", async () => {
  const { app, calls, destinations, queries, tree } = await openRepostForm();
  assert.deepEqual(queries.filter(([table]) => table === "gigs"), [["gigs", "id", REPOST_ID]], "reads only the gig named in the link");
  assert.match(textOf(nodes(tree, (node) => node.props.role === "note")[0]), /Reposting .Rake leaves. as a new gig/);
  assert.match(textOf(nodes(tree, (node) => node.props.role === "note")[0]), /every helper can see/);
  assert.equal(nodes(tree, titleInput)[0].props.value, "Rake leaves");
  assert.equal(nodes(tree, (node) => node.type === "textarea")[0].props.value, "Front yard");
  assert.equal(nodes(tree, (node) => node.props.type === "number")[0].props.value, "55", "the original budget, not the 70 the price was renegotiated to");
  assert.equal(nodes(tree, dateInput)[0].props.value, "", "the old date is not carried over; the poster picks a new one");
  assert.match(textOf(tree), /original photo will be reused/);
  assert.equal(nodes(tree, (node) => node.type === "selection-chip" && node.props.role === "radio" && node.props.selected)[0].props.children, "Cleaning");

  // Without a date the gig cannot be published, and nothing is sent.
  button(app.render(), "Post Gig").props.onClick(); await flush();
  assert.equal(calls.length, 0);
  assert.match(textOf(nodes(app.render(), (node) => node.props.role === "alert")[0]), /future date/);

  setField(app, dateInput, new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 16));
  button(app.render(), "Post Gig").props.onClick(); await flush();
  assert.equal(calls.length, 1);
  const payload = calls[0].payload;
  assert.equal(calls[0].name, "create_gig");
  assert.equal(payload.p_request_id, "99999999-9999-4999-8999-999999999999", "a brand-new creation request, not the old gig");
  assert.deepEqual([payload.p_service_type, payload.p_title, payload.p_description, payload.p_amount, payload.p_price_type], ["Cleaning", "Rake leaves", "Front yard", 55, "fixed"]);
  assert.deepEqual([payload.p_location_text, payload.p_lat, payload.p_lng], ["Kävlinge", 55.79, 13.11]);
  assert.equal(payload.p_photo_url, "https://x.invalid/p.jpg", "the photo is reused, not re-uploaded");
  assert.deepEqual([...payload.p_tag_ids], ["t1"]);
  assert.equal(payload.p_private_address, "Storgatan 1, 2tr");
  assert.equal(payload.p_publish, true);
  assert.equal("p_requested_helper_id" in payload, false, "a plain repost is public");
  assert.match(payload.p_scheduled_at, /^20\d\d-/);
  assert.ok(new Date(payload.p_scheduled_at) > new Date(), "the new date is in the future");
  assert.deepEqual(destinations, ["/gigs/new-gig"]);
});

test("Repost: Save as Draft works too, and the poster can change anything before posting", async () => {
  const { app, calls, destinations } = await openRepostForm({ gig: { status: "completed", selected_provider_id: "h" } });
  setField(app, titleInput, "Rake leaves again");
  setField(app, (node) => node.props.type === "number", "60");
  button(app.render(), "Save as Draft").props.onClick(); await flush();
  assert.equal(calls[0].payload.p_title, "Rake leaves again");
  assert.equal(calls[0].payload.p_amount, 60);
  assert.equal(calls[0].payload.p_publish, false);
  assert.equal(calls[0].payload.p_scheduled_at, null);
  assert.deepEqual(destinations, ["/my-gigs?created=new-gig"]);
});

test("Repost: only your own cancelled, completed or incomplete gig can be reposted; anything else stops with a reason and no form", async () => {
  const cases = [
    [{ gig: { poster_id: "someone-else" } }, /only repost your own gigs/],
    [{ gig: { status: "active" } }, /Only a cancelled or completed gig/],
    [{ gig: { status: "in_progress" } }, /Only a cancelled or completed gig/],
    [{ gig: null }, /couldn't be found/],
    [{ gigError: new Error("offline") }, /Couldn't load that gig/],
    [{ search: "repost=not-an-id" }, /repost link isn't valid/],
    [{ search: "repost=../../etc" }, /repost link isn't valid/],
  ];
  for (const [options, message] of cases) {
    const { tree, calls } = await openRepostForm(options);
    assert.match(textOf(nodes(tree, (node) => node.props.role === "alert")[0]), message, JSON.stringify(options).slice(0, 60));
    assert.equal(nodes(tree, titleInput).length, 0, "no form to submit");
    assert.ok(nodes(tree, (node) => node.type === "a" && node.props.href === "/post"), "a way to post from scratch");
    assert.equal(calls.length, 0);
  }
});

test("Repost: a request still awaiting confirmation takes priority over the repost link", async () => {
  const stored = new Map([[`esg:post:${user.id}`, JSON.stringify({ p_request_id: "r1", p_service_type: "Other", p_title: "Pending thing", p_description: "d", p_amount: 9, p_price_type: "fixed",
    p_scheduled_at: null, p_location_text: "x", p_lat: null, p_lng: null, p_photo_url: null, p_publish: true, p_tag_ids: [], p_requested_helper_id: null })]]);
  const { tree, queries } = await openRepostForm({ stored });
  assert.equal(queries.filter(([table]) => table === "gigs").length, 0, "the old gig is not even read");
  assert.equal(nodes(tree, titleInput)[0].props.value, "Pending thing");
  assert.equal(nodes(tree, (node) => node.props.role === "note").length, 0);
});

test("Repost to the same helper: the private-request form keeps the helper's categories and copies the details, but not the category tags", async () => {
  const helper = { id: "helper-9", username: "HelperNine", skills: ["Cleaning", "Other"] };
  const { app, calls, tree } = await openRepostForm({ search: `helper=HelperNine&category=Cleaning&repost=${REPOST_ID}`, helper, gig: { requested_helper_id: "helper-9", price_type: "negotiable" } });
  assert.match(textOf(nodes(tree, (node) => node.type === "h1")[0]), /for @HelperNine/);
  assert.equal(nodes(tree, titleInput)[0].props.value, "Rake leaves");
  assert.equal(nodes(tree, (node) => node.type === "selection-chip" && node.props.role === "radio" && node.props.selected)[0].props.children, "Cleaning");
  assert.equal(nodes(tree, (node) => node.props.role === "note").length, 2, "the repost note and the private-request note");
  setField(app, dateInput, new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 16));
  button(app.render(), "Send request").props.onClick(); await flush();
  assert.equal(calls[0].payload.p_requested_helper_id, "helper-9");
  assert.deepEqual([...calls[0].payload.p_tag_ids], [], "tags belong to the gig's category and are re-picked for a private request");
  assert.equal(calls[0].payload.p_title, "Rake leaves");
});

// ===========================================================================
// Delay start, wait or withdraw, then post it again (migration 0022)
// ===========================================================================
test("start-flow helpers: who sees which step of the start request, and when the server can delay at all", () => {
  const { startView, delayAvailable, helperWithdrew } = startFlowLib;
  const gig = (fields) => ({ status: "active", poster_id: "poster", selected_provider_id: "helper", start_requested_at: "2026-10-01T10:00:00Z", start_delayed_at: null, ...fields });
  assert.equal(startView(gig(), "poster"), "poster-review");
  assert.equal(startView(gig(), "helper"), "helper-waiting");
  assert.equal(startView(gig({ start_delayed_at: "2026-10-01T11:00:00Z" }), "poster"), "poster-delayed");
  assert.equal(startView(gig({ start_delayed_at: "2026-10-01T11:00:00Z" }), "helper"), "helper-delayed");
  assert.equal(startView(gig(), "stranger"), "none", "only the two people in the gig");
  assert.equal(startView(gig(), null), "none");
  assert.equal(startView(gig({ start_requested_at: null }), "poster"), "none", "no request, nothing to review");
  assert.equal(startView(gig({ selected_provider_id: null }), "poster"), "none");
  for (const status of ["draft", "in_progress", "awaiting_payment", "completed", "cancelled", "disputed"]) assert.equal(startView(gig({ status }), "poster"), "none", status);
  assert.equal(delayAvailable({ start_delayed_at: null }), true, "the column comes back (even when empty)");
  assert.equal(delayAvailable({ id: "g" }), false, "a server without migration 0022 does not send it");
  assert.equal(helperWithdrew({ status: "cancelled", helper_withdrawn_at: "2026-10-02T10:00:00Z" }), true);
  assert.equal(helperWithdrew({ status: "cancelled", helper_withdrawn_at: null }), false, "a plain cancellation");
  assert.equal(helperWithdrew({ status: "active", helper_withdrawn_at: "2026-10-02T10:00:00Z" }), false);
});

const startGig = (fields) => ({ requested_helper_id: null, selected_provider_id: "helper-1", agreed_amount: 55, start_requested_at: "2026-10-02T10:00:00Z", start_delayed_at: null, helper_withdrawn_at: null, ...fields });

test("Poster: a start request can be accepted or delayed (after a confirmation), and a delayed start can still be accepted", async () => {
  const review = await openRequest({ asUser: "poster-1", gig: startGig() });
  assert.ok(buttonText(review.tree, "ACCEPT START — LET'S GO"));
  const delay = buttonText(review.tree, "Delay start");
  assert.ok(delay, "Delay start sits next to Accept");
  assert.match(delay.props.className, /min-h-11/);
  await delay.props.onClick();
  assert.deepEqual(review.rpcs, [["delay_start", { p_gig_id: "gig-1" }]]);
  assert.match(review.confirms[0], /helper will be asked to wait.*withdraw/);

  const declined = await openRequest({ asUser: "poster-1", gig: startGig(), confirm: false });
  await buttonText(declined.tree, "Delay start").props.onClick();
  assert.deepEqual(declined.rpcs, [], "cancelling the dialog sends nothing");

  const delayed = await openRequest({ asUser: "poster-1", gig: startGig({ start_delayed_at: "2026-10-02T11:00:00Z" }) });
  assert.match(textOf(delayed.tree), /You delayed the start\. @helper1 can wait or withdraw/);
  assert.equal(buttonText(delayed.tree, "Delay start"), undefined, "a start can be delayed once");
  await buttonText(delayed.tree, "ACCEPT START — LET'S GO").props.onClick();
  assert.deepEqual(delayed.rpcs, [["approve_start", { p_gig_id: "gig-1" }]], "the existing approval still works");
});

test("Poster: on a server without migration 0022 the Delay button is not offered, and Accept still works", async () => {
  const gig = startGig(); delete gig.start_delayed_at; delete gig.helper_withdrawn_at;
  const { tree } = await openRequest({ asUser: "poster-1", gig });
  assert.equal(buttonText(tree, "Delay start"), undefined);
  assert.ok(buttonText(tree, "ACCEPT START — LET'S GO"));
});

test("Helper: waits quietly until the poster responds; when the start is delayed they can wait or withdraw", async () => {
  const waiting = await openRequest({ asUser: "helper-1", gig: startGig(), claims: { "helper-1": { id: "c", state: "selected", provider_id: "helper-1" } } });
  assert.match(textOf(waiting.tree), /Waiting for the Poster to approve start/);
  assert.equal(nodes(waiting.tree, (node) => node.props["aria-label"] === "Start delayed").length, 0);

  const delayedGig = startGig({ start_delayed_at: "2026-10-02T11:00:00Z" });
  const delayed = await openRequest({ asUser: "helper-1", gig: delayedGig, claims: { "helper-1": { id: "c", state: "selected", provider_id: "helper-1" } } });
  const card = nodes(delayed.tree, (node) => node.props["aria-label"] === "Start delayed")[0];
  assert.ok(card, "the choice card");
  assert.match(textOf(card), /The poster asked you to wait/);
  assert.deepEqual(nodes(card, (node) => node.type === "button").map(textOf), ["I'll wait", "Withdraw"]);
  for (const b of nodes(card, (node) => node.type === "button")) assert.match(b.props.className, /min-h-11/);

  // Wait: no server call, the choices go away, and the helper is told what happens next.
  nodes(card, (node) => node.type === "button" && textOf(node) === "I'll wait")[0].props.onClick();
  const after = delayed.again();
  assert.deepEqual(delayed.rpcs, []);
  assert.equal(nodes(after, (node) => node.type === "button" && textOf(node) === "Withdraw").length, 0);
  assert.match(textOf(after), /notified as soon as the poster approves/);

  // Withdraw: asks first, then calls the new function.
  const leaving = await openRequest({ asUser: "helper-1", gig: delayedGig, claims: { "helper-1": { id: "c", state: "selected", provider_id: "helper-1" } } });
  await nodes(leaving.tree, (node) => node.type === "button" && textOf(node) === "Withdraw")[0].props.onClick();
  assert.deepEqual(leaving.rpcs, [["withdraw_from_gig", { p_gig_id: "gig-1" }]]);
  assert.match(leaving.confirms[0], /cannot claim it again/);
  const kept = await openRequest({ asUser: "helper-1", gig: delayedGig, confirm: false, claims: { "helper-1": { id: "c", state: "selected", provider_id: "helper-1" } } });
  await nodes(kept.tree, (node) => node.type === "button" && textOf(node) === "Withdraw")[0].props.onClick();
  assert.deepEqual(kept.rpcs, [], "cancelling the dialog does not withdraw");
});

test("Nobody else gets the start decisions: not a stranger, not the poster as helper, not the helper as poster", async () => {
  const delayedGig = startGig({ start_delayed_at: "2026-10-02T11:00:00Z" });
  const stranger = await openRequest({ asUser: "stranger", gig: delayedGig });
  for (const label of ["Delay start", "Withdraw", "I'll wait", "ACCEPT START — LET'S GO"]) assert.equal(buttonText(stranger.tree, label), undefined, label);
  const helperView = await openRequest({ asUser: "helper-1", gig: startGig(), claims: { "helper-1": { id: "c", state: "selected", provider_id: "helper-1" } } });
  assert.equal(buttonText(helperView.tree, "Delay start"), undefined, "the helper cannot delay their own request");
  assert.equal(buttonText(helperView.tree, "ACCEPT START — LET'S GO"), undefined);
  const posterView = await openRequest({ asUser: "poster-1", gig: delayedGig });
  assert.equal(buttonText(posterView.tree, "Withdraw"), undefined, "the poster cannot withdraw the helper");
});

test("After the helper withdraws: the poster is offered to post it publicly again, the helper sees they withdrew", async () => {
  const withdrawn = { status: "cancelled", selected_provider_id: null, agreed_amount: null, start_requested_at: null, start_delayed_at: null, helper_withdrawn_at: "2026-10-03T10:00:00Z", requested_helper_id: null };
  const poster = await openRequest({ asUser: "poster-1", gig: withdrawn });
  const section = nodes(poster.tree, (node) => node.props["aria-label"] === "Repost this gig")[0];
  assert.match(textOf(section), /Your helper withdrew/);
  const link = nodes(section, (node) => node.type === "a")[0];
  assert.equal(textOf(link), "Post it publicly as a new gig");
  assert.equal(link.props.href, "/post?repost=gig-1", "the existing repost opens the form prefilled");
  assert.equal(nodes(section, (node) => node.type === "a").length, 1);

  // A private request: the withdrawn helper is not offered the request again.
  const privateGig = await openRequest({ asUser: "poster-1", gig: { ...withdrawn, requested_helper_id: "helper-1" } });
  const privateLinks = nodes(nodes(privateGig.tree, (node) => node.props["aria-label"] === "Repost this gig")[0], (node) => node.type === "a").map(textOf);
  assert.deepEqual(privateLinks, ["Post it publicly as a new gig"], "no 'Send to @helper again' for the helper who withdrew");

  const helper = await openRequest({ asUser: "helper-1", gig: withdrawn, claims: { "helper-1": { id: "c", state: "withdrawn", provider_id: "helper-1" } } });
  assert.match(textOf(helper.tree), /You withdrew from this gig/);
  assert.equal(nodes(helper.tree, (node) => node.props["aria-label"] === "Repost this gig").length, 0, "only the poster can repost");
  assert.equal(nodes(helper.tree, (node) => node.type === "chat-panel").length, 0, "and the conversation is closed for the helper");

  // An ordinary cancellation keeps its old wording.
  const plain = await openRequest({ asUser: "poster-1", gig: { ...withdrawn, helper_withdrawn_at: null } });
  assert.match(textOf(nodes(plain.tree, (node) => node.props["aria-label"] === "Repost this gig")[0]), /Need this done again\?/);
});

test("My Gigs: a gig whose helper withdrew says so on the poster's card", async () => {
  const gig = myGig("g-w", { status: "cancelled", helper_withdrawn_at: "2026-10-03T10:00:00Z", requested_helper_id: null });
  const client = fakeDb((query) => {
    if (query.table === "gigs" && query.eq.poster_id) return { data: [gig, myGig("g-plain", { status: "cancelled" })], error: null };
    return { data: [], error: null };
  });
  const app = await component("src/app/my-gigs/page.tsx", "MyGigsInner", { client });
  app.render(); await flush();
  const cancelled = sectionNamed(app.render(), "Cancelled");
  assert.equal((textOf(cancelled).match(/Your helper withdrew/g) ?? []).length, 1, "only the withdrawn gig carries the note");
  assert.match(textOf(cancelled), /post it again for everyone/);
});

// ===========================================================================
// An unanswered start request (wait twice, then withdraw: the poster gets a lemon) and removing a helper (migration 0023)
// ===========================================================================
test("start-flow silence: the poster has 24 hours, then two waits of 24 hours, then the helper may withdraw", () => {
  const { silence, timeUntil, helperRemoved, removeAvailable, waitAvailable } = startFlowLib;
  const hour = 3600 * 1000;
  const t0 = Date.parse("2026-10-01T10:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const asked = { start_requested_at: iso(t0), start_wait_count: 0, start_wait_until: null };
  assert.equal(silence({ start_requested_at: null }, t0), null, "no request, nothing to wait for");
  assert.deepEqual(silence(asked, t0 + 23 * hour), { phase: "answering", waitsUsed: 0, waitsLeft: 2, nextAt: t0 + 24 * hour });
  assert.equal(silence(asked, t0 + 24 * hour).phase, "can-wait", "after 24 hours of silence");
  const first = { ...asked, start_wait_count: 1, start_wait_until: iso(t0 + 48 * hour) };
  assert.equal(silence(first, t0 + 30 * hour).phase, "answering", "the first wait is still running");
  assert.deepEqual(silence(first, t0 + 48 * hour), { phase: "can-wait", waitsUsed: 1, waitsLeft: 1, nextAt: t0 + 48 * hour });
  const second = { ...asked, start_wait_count: 2, start_wait_until: iso(t0 + 72 * hour) };
  assert.equal(silence(second, t0 + 60 * hour).phase, "answering");
  assert.deepEqual(silence(second, t0 + 72 * hour), { phase: "can-withdraw", waitsUsed: 2, waitsLeft: 0, nextAt: t0 + 72 * hour });
  assert.equal(silence({ start_requested_at: "not a date" }, t0), null);
  assert.equal(timeUntil(t0 + 5 * hour + 12 * 60000, t0), "5 h 12 min");
  assert.equal(timeUntil(t0 + 42 * 60000, t0), "42 min");
  assert.equal(timeUntil(t0, t0), "1 min", "never shows zero");
  assert.equal(helperRemoved({ status: "cancelled", helper_removed_at: "2026-10-02T10:00:00Z" }), true);
  assert.equal(helperRemoved({ status: "cancelled", helper_removed_at: null }), false);
  assert.equal(helperRemoved({ status: "active", helper_removed_at: "2026-10-02T10:00:00Z" }), false);
  assert.equal(removeAvailable({ helper_removed_at: null }), true);
  assert.equal(removeAvailable({ id: "g" }), false, "a server without migration 0023");
  assert.equal(waitAvailable({ start_wait_count: 0 }), true);
  assert.equal(waitAvailable({ id: "g" }), false);
});

const hoursAgo = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
const hoursAhead = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
const quietGig = (fields) => startGig({ start_wait_count: 0, start_wait_until: null, helper_removed_at: null, ...fields });
const selectedClaim = { "helper-1": { id: "c", state: "selected", provider_id: "helper-1" } };

test("Helper: while the poster still has time there are no buttons, only how long until they can wait again", async () => {
  const { tree } = await openRequest({ asUser: "helper-1", gig: quietGig({ start_requested_at: hoursAgo(2) }), claims: selectedClaim });
  const card = nodes(tree, (node) => node.props["aria-label"] === "Start request")[0];
  assert.match(textOf(card), /Waiting for the Poster to approve start/);
  assert.match(textOf(card), /you can wait again in 2[12] h \d+ min/);
  assert.equal(nodes(card, (node) => node.type === "button").length, 0);
  const second = await openRequest({ asUser: "helper-1", gig: quietGig({ start_requested_at: hoursAgo(60), start_wait_count: 2, start_wait_until: hoursAhead(12) }), claims: selectedClaim });
  assert.match(textOf(second.tree), /waited 2 times.*can withdraw in 1[12] h/);
  assert.equal(nodes(second.tree, (node) => node.type === "button").length, 0, "not before the second wait is over");
});

test("Helper: after 24 hours of silence they can wait another 24 hours, up to twice", async () => {
  const first = await openRequest({ asUser: "helper-1", gig: quietGig({ start_requested_at: hoursAgo(25) }), claims: selectedClaim });
  const wait = buttonText(first.tree, "Wait another 24 hours");
  assert.ok(wait, "the first wait");
  assert.match(wait.props.className, /min-h-11/);
  assert.match(textOf(first.tree), /up to 2 times/);
  assert.equal(buttonText(first.tree, "Withdraw (the poster gets a lemon)"), undefined, "withdrawing comes only after both waits");
  await wait.props.onClick();
  assert.deepEqual(first.rpcs, [["wait_for_start", { p_gig_id: "gig-1" }]]);
  assert.deepEqual(first.confirms, [], "waiting needs no dialog");

  const last = await openRequest({ asUser: "helper-1", gig: quietGig({ start_requested_at: hoursAgo(50), start_wait_count: 1, start_wait_until: hoursAgo(1) }), claims: selectedClaim });
  assert.match(textOf(last.tree), /one last time/);
  assert.ok(buttonText(last.tree, "Wait another 24 hours"));
  assert.equal(buttonText(last.tree, "Withdraw (the poster gets a lemon)"), undefined, "one wait is left, so no withdrawing yet");
});

test("Helper: after two waits and no answer they can withdraw, after a confirmation that says the poster gets a lemon", async () => {
  const gig = quietGig({ start_requested_at: hoursAgo(80), start_wait_count: 2, start_wait_until: hoursAgo(1) });
  const open = await openRequest({ asUser: "helper-1", gig, claims: selectedClaim });
  assert.equal(buttonText(open.tree, "Wait another 24 hours"), undefined, "there is no third wait");
  const withdraw = buttonText(open.tree, "Withdraw (the poster gets a lemon)");
  assert.ok(withdraw);
  assert.match(textOf(open.tree), /lemon/);
  await withdraw.props.onClick();
  assert.deepEqual(open.rpcs, [["withdraw_unanswered", { p_gig_id: "gig-1" }]]);
  assert.match(open.confirms[0], /poster gets a lemon.*cannot claim it again/);
  const kept = await openRequest({ asUser: "helper-1", gig, claims: selectedClaim, confirm: false });
  await buttonText(kept.tree, "Withdraw (the poster gets a lemon)").props.onClick();
  assert.deepEqual(kept.rpcs, [], "cancelling the dialog withdraws nothing");
});

test("Silence controls never reach the wrong person or the wrong moment", async () => {
  const silent = quietGig({ start_requested_at: hoursAgo(80), start_wait_count: 2, start_wait_until: hoursAgo(1) });
  const labels = ["Wait another 24 hours", "Withdraw (the poster gets a lemon)"];
  for (const asUser of ["poster-1", "stranger"]) {
    const { tree } = await openRequest({ asUser, gig: silent });
    for (const label of labels) assert.equal(buttonText(tree, label), undefined, `${asUser}: ${label}`);
  }
  // Once the poster answered by delaying, the delayed-start choices apply instead (migration 0022), not the silence ones.
  const delayed = await openRequest({ asUser: "helper-1", gig: { ...silent, start_delayed_at: hoursAgo(1) }, claims: selectedClaim });
  for (const label of labels) assert.equal(buttonText(delayed.tree, label), undefined, label);
  assert.ok(buttonText(delayed.tree, "Withdraw"));
  // A server without migration 0023 shows the plain waiting line and nothing to press.
  const old = quietGig({ start_requested_at: hoursAgo(80) });
  delete old.start_wait_count; delete old.start_wait_until; delete old.helper_removed_at;
  const plain = await openRequest({ asUser: "helper-1", gig: old, claims: selectedClaim });
  assert.match(textOf(plain.tree), /Waiting for the Poster to approve start/);
  assert.equal(nodes(plain.tree, (node) => node.type === "button" && labels.includes(textOf(node))).length, 0);
});

test("Poster: can remove the helper before the gig starts (after a confirmation), also while a start request waits", async () => {
  for (const gig of [quietGig(), quietGig({ start_requested_at: null }), quietGig({ start_delayed_at: hoursAgo(1) })]) {
    const open = await openRequest({ asUser: "poster-1", gig });
    const remove = buttonText(open.tree, "Remove helper");
    assert.ok(remove, "Remove helper is offered");
    assert.match(remove.props.className, /min-h-11/);
    await remove.props.onClick();
    assert.deepEqual(open.rpcs, [["remove_helper", { p_gig_id: "gig-1" }]]);
    assert.match(open.confirms[0], /Remove @helper1 from this gig.*post it again for everyone/);
  }
  const kept = await openRequest({ asUser: "poster-1", gig: quietGig(), confirm: false });
  await buttonText(kept.tree, "Remove helper").props.onClick();
  assert.deepEqual(kept.rpcs, [], "cancelling the dialog removes nobody");
});

test("Remove helper is not offered once the gig has started, to the helper or a stranger, or on a server without 0023", async () => {
  const started = await openRequest({ asUser: "poster-1", gig: quietGig({ status: "in_progress" }) });
  assert.equal(buttonText(started.tree, "Remove helper"), undefined, "after the start the helper cannot be removed");
  for (const asUser of ["helper-1", "stranger"]) {
    const { tree } = await openRequest({ asUser, gig: quietGig(), claims: selectedClaim });
    assert.equal(buttonText(tree, "Remove helper"), undefined, asUser);
  }
  const old = quietGig();
  delete old.start_wait_count; delete old.start_wait_until; delete old.helper_removed_at;
  assert.equal(buttonText((await openRequest({ asUser: "poster-1", gig: old })).tree, "Remove helper"), undefined);
});

test("Poster: told when the helper has waited, with the lemon risk spelled out", async () => {
  const waited = await openRequest({ asUser: "poster-1", gig: quietGig({ start_requested_at: hoursAgo(30), start_wait_count: 1, start_wait_until: hoursAhead(18) }) });
  assert.match(textOf(waited.tree), /@helper1 is still waiting for your answer.*withdraw.*lemon/);
  assert.ok(buttonText(waited.tree, "ACCEPT START — LET'S GO"));
  const fresh = await openRequest({ asUser: "poster-1", gig: quietGig({ start_requested_at: hoursAgo(1) }) });
  assert.doesNotMatch(textOf(fresh.tree), /still waiting for your answer/);
});

test("After the poster removes the helper: the poster may post it again, the helper is told", async () => {
  const removed = { status: "cancelled", selected_provider_id: null, agreed_amount: null, start_requested_at: null, start_delayed_at: null, helper_withdrawn_at: null, helper_removed_at: hoursAgo(1), start_wait_count: 0, start_wait_until: null, requested_helper_id: null };
  const poster = await openRequest({ asUser: "poster-1", gig: removed });
  const section = nodes(poster.tree, (node) => node.props["aria-label"] === "Repost this gig")[0];
  assert.match(textOf(section), /You removed your helper/);
  assert.equal(textOf(nodes(section, (node) => node.type === "a")[0]), "Post it publicly as a new gig");
  const privateGig = await openRequest({ asUser: "poster-1", gig: { ...removed, requested_helper_id: "helper-1" } });
  assert.deepEqual(nodes(nodes(privateGig.tree, (node) => node.props["aria-label"] === "Repost this gig")[0], (node) => node.type === "a").map(textOf), ["Post it publicly as a new gig"], "no 'Send to @helper again' for the helper who was removed");

  const helper = await openRequest({ asUser: "helper-1", gig: removed, claims: { "helper-1": { id: "c", state: "rejected", provider_id: "helper-1" } } });
  assert.match(textOf(helper.tree), /The poster removed you from this gig/);
  assert.equal(nodes(helper.tree, (node) => node.props["aria-label"] === "Repost this gig").length, 0);
  const requestedHelper = await openRequest({ asUser: "helper-1", gig: { ...removed, requested_helper_id: "helper-1" }, claims: { "helper-1": { id: "c", state: "rejected", provider_id: "helper-1" } } });
  assert.equal((textOf(requestedHelper.tree).match(/removed you/g) ?? []).length, 1, "said once, not twice");
});

test("My Gigs: a gig whose helper was removed says so on the poster's card", async () => {
  const gig = myGig("g-r", { status: "cancelled", helper_removed_at: "2026-10-03T10:00:00Z", requested_helper_id: null });
  const client = fakeDb((query) => {
    if (query.table === "gigs" && query.eq.poster_id) return { data: [gig, myGig("g-plain", { status: "cancelled" })], error: null };
    return { data: [], error: null };
  });
  const app = await component("src/app/my-gigs/page.tsx", "MyGigsInner", { client });
  app.render(); await flush();
  const cancelled = sectionNamed(app.render(), "Cancelled");
  assert.equal((textOf(cancelled).match(/You removed your helper/g) ?? []).length, 1, "only the gig with a removed helper carries the note");
});

// ===========================================================================
// The other offers are kept when a helper is chosen (migration 0024)
// ===========================================================================
test("My Gigs grouping: an offer kept after another helper was chosen is 'On hold', and closes with the gig", () => {
  const { helperSection, helperBadge } = myGigsLib;
  const gig = (status) => ({ status, selected_provider_id: "someone-else", requested_helper_id: null });
  for (const status of ["active", "in_progress", "awaiting_payment", "disputed"]) assert.equal(helperSection(gig(status), "pending", "me"), "proposals", status);
  for (const status of ["completed", "incomplete", "cancelled"]) assert.equal(helperSection(gig(status), "pending", "me"), "closed", status);
  assert.equal(helperSection(gig("active"), "rejected", "me"), "closed", "an offer that was rejected stays closed");
  assert.deepEqual(helperBadge("proposals", gig("active"), "pending"), { label: "On hold", tone: "neutral" });
  assert.deepEqual(helperBadge("proposals", { ...gig("active"), selected_provider_id: null }, "pending"), { label: "Proposal pending", tone: "pending" }, "an open gig keeps its old label");
});

test("Gig page: a helper whose offer is kept sees where it stands and can still withdraw it", async () => {
  const claims = { "other-1": { id: "c2", state: "pending", provider_id: "other-1", offer_amount: 90, message: null } };
  const chosen = await openRequest({ asUser: "other-1", gig: startGig({ requested_helper_id: null }), claims });
  assert.match(textOf(chosen.tree), /Offer sent: 90 CAD.*the poster chose another helper.*can choose you/);
  assert.ok(buttonText(chosen.tree, "Withdraw offer"), "they can still take the offer back");
  const open = await openRequest({ asUser: "other-1", gig: startGig({ requested_helper_id: null, selected_provider_id: null }), claims });
  assert.match(textOf(open.tree), /waiting for the poster to choose a helper/);
  assert.equal(nodes(chosen.tree, (node) => node.type === "chat-panel").length, 0, "a waiting helper gets no chat");
});

test("Gig page: the poster sees the offers that are kept, and removing the helper says the gig reopens", async () => {
  const pending = [{ id: "c2", gig_id: "gig-1", provider_id: "other-1", state: "pending", offer_amount: 90, message: null, created_at: "2026-10-01T10:00:00Z" },
    { id: "c3", gig_id: "gig-1", provider_id: "other-2", state: "pending", offer_amount: 95, message: null, created_at: "2026-10-01T11:00:00Z" }];
  const open = await openRequest({ asUser: "poster-1", gig: quietGig(), pending });
  const section = nodes(open.tree, (node) => node.props["aria-label"] === "Other offers")[0];
  assert.ok(section);
  assert.match(textOf(section), /2 other offers kept/);
  assert.match(textOf(section), /90 CAD/);
  assert.match(textOf(section), /95 CAD/);
  assert.match(textOf(section), /gig reopens/);
  assert.equal(nodes(section, (node) => node.type === "button").length, 0, "no way to swap helpers while one is chosen");
  await buttonText(open.tree, "Remove helper").props.onClick();
  assert.match(open.confirms[0], /The gig reopens so you can choose another offer/);

  const one = await openRequest({ asUser: "poster-1", gig: quietGig(), pending: pending.slice(0, 1) });
  assert.match(textOf(nodes(one.tree, (node) => node.props["aria-label"] === "Other offers")[0]), /1 other offer kept/);
  const none = await openRequest({ asUser: "poster-1", gig: quietGig() });
  assert.equal(nodes(none.tree, (node) => node.props["aria-label"] === "Other offers").length, 0, "nothing to show without other offers");
  await buttonText(none.tree, "Remove helper").props.onClick();
  assert.match(none.confirms[0], /The gig will close and you can post it again for everyone/, "with no other offers the old wording stays");
  const started = await openRequest({ asUser: "poster-1", gig: quietGig({ status: "in_progress" }), pending });
  assert.equal(nodes(started.tree, (node) => node.props["aria-label"] === "Other offers").length, 0, "once started there is no fallback to offer");
  const helperView = await openRequest({ asUser: "helper-1", gig: quietGig(), claims: selectedClaim });
  assert.equal(nodes(helperView.tree, (node) => node.props["aria-label"] === "Other offers").length, 0, "the helper never sees the others");
});
