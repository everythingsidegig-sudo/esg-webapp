import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CATALOG, CATEGORY_BY_ID, SERVICE_BY_ID, SUBSERVICE_BY_ID } from "../src/lib/service-catalog.ts";
import {
  emptySelection, toggleSubservice, allState, setAll, setCustomChecked, setCustomText, customError, selectionProblems, isEmptySelection,
  countForService, countForCategory, totalSelected, toPayload, fromRows, sameSelection, summarize, searchCatalog, pathLabel,
} from "../src/lib/service-selection.ts";

const service = (id) => SERVICE_BY_ID.get(id).service;
const ids = (list) => list.map((item) => item.id);

// ---- the catalog ----
test("catalog: the 23 approved categories, in the spec's order, with unique stable ids and a parent for every entry", () => {
  assert.equal(CATALOG.length, 23);
  assert.deepEqual(CATALOG.map((c) => c.name), [
    "Home Cleaning & Housekeeping", "Furniture Assembly & Installation", "Handyman & Minor Repairs", "Moving, Lifting & Hauling", "Errands, Shopping & Local Delivery",
    "Lawn, Garden & Landscaping", "Snow, Ice & Seasonal Outdoor", "Pet Care & Animal Services", "Childcare & Family Assistance", "Senior & Adult Assistance",
    "Personal Assistance & Home Organization", "Technology & Electronics", "Tutoring, Teaching & Coaching", "Events, Parties & Entertainment", "Automotive & Bicycle Services",
    "Plumbing, Electrical & HVAC", "Construction, Renovation & Skilled Trades", "Beauty, Wellness & Fitness", "Business, Office & Administrative", "Photography, Video & Creative Arts",
    "Travel, Vacation & Property Management", "Agricultural, Rural & Recreational Services", "Cooking, Baking & Food Services",
  ], "the spec's section 11 list, verbatim and in order");
  const all = [...CATALOG.map((c) => c.id), ...CATALOG.flatMap((c) => c.services.map((s) => s.id)), ...CATALOG.flatMap((c) => c.services.flatMap((s) => s.subservices.map((u) => u.id)))];
  assert.equal(new Set(all).size, all.length, "ids are unique");
  for (const category of CATALOG) {
    assert.match(category.id, /^c\d\d$/);
    assert.ok(category.services.length >= 4, `${category.name} has services`);
    for (const svc of category.services) {
      assert.ok(svc.id.startsWith(category.id) && /^c\d\ds\d\d$/.test(svc.id));
      assert.ok(svc.subservices.length >= 3, `${svc.name} has subservices`);
      for (const sub of svc.subservices) assert.ok(sub.id.startsWith(svc.id) && /^c\d\ds\d\du\d\d$/.test(sub.id));
    }
  }
});

test("catalog: includes the spec's own mockup entries exactly, and keeps out specialized care and professional advice", () => {
  const find = (name) => CATALOG.flatMap((c) => c.services.flatMap((s) => [{ level: "service", name: s.name, category: c.name }, ...s.subservices.map((u) => ({ level: "sub", name: u.name, category: c.name, service: s.name }))])).filter((item) => item.name === name);
  assert.deepEqual(find("Mobile App Testing (iOS / Android)").map((i) => [i.category, i.service]), [["Technology & Electronics", "App & Software Testing"]]);
  assert.equal(find("App & Software Testing")[0].category, "Technology & Electronics");
  assert.equal(find("App Setup")[0].service, "Mobile Devices");
  assert.equal(find("App Data Entry")[0].category, "Business, Office & Administrative");
  for (const name of ["User Experience & Usability Testing", "Website & Web App Testing", "Functional Software Testing", "Bug Testing & Verification", "Game Testing", "AI Software Testing", "Beta & Product Research Testing"]) {
    assert.equal(find(name)[0].service, "App & Software Testing", name);
  }
  const everything = CATALOG.flatMap((c) => [c.name, ...c.services.flatMap((s) => [s.name, ...s.subservices.map((u) => u.name)])]).join("\n").toLowerCase();
  for (const banned of ["babysit", "nanny", "bathing assist", "toileting", "dressing assist", "medication", "nursing", "caregiver", "legal advice", "tax prep", "bookkeep", "investment", "diagnos", "massage therapy", "physical therapy"]) {
    assert.equal(everything.includes(banned), false, `out of scope: ${banned}`);
  }
});

test("catalog: services that normally need a licence are flagged for verification", () => {
  const flagged = CATALOG.flatMap((c) => c.services).filter((s) => s.regulated).map((s) => s.name).sort();
  assert.deepEqual(flagged, ["Basic Nail & Beauty", "Event Catering", "HVAC Installation & Repair", "Licensed Electrical Work", "Licensed Plumbing Work", "Pesticide & Chemical Application", "Structural & Roofing Work"]);
});

test("catalog: the generated database seed matches the catalog exactly", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20240101000041_service_catalog_seed.sql", import.meta.url), "utf8");
  const unq = (value) => value.replaceAll("''", "'");
  const rows = (table) => {
    const block = sql.match(new RegExp(`insert into public\\.${table} \\([^)]*\\) values\\n([\\s\\S]+?)\\non conflict`))[1];
    return block.split("\n").map((line) => [...line.matchAll(/'((?:[^']|'')*)'|\b(\d+)\b|\b(true|false)\b/g)].map((m) => (m[1] !== undefined ? unq(m[1]) : m[2] ?? m[3])));
  };
  assert.deepEqual(rows("service_categories"), CATALOG.map((c, i) => [c.id, c.name, String(i + 1)]));
  assert.deepEqual(rows("services"), CATALOG.flatMap((c) => c.services.map((s, i) => [s.id, c.id, s.name, String(i + 1), String(s.regulated)])));
  assert.deepEqual(rows("subservices"), CATALOG.flatMap((c) => c.services.flatMap((s) => s.subservices.map((u, i) => [u.id, s.id, u.name, String(i + 1)]))));
});

// ---- selection rules (spec section 4) ----
test("a subservice checkbox toggles only that subservice, across services", () => {
  let state = emptySelection();
  state = toggleSubservice(state, "c12s05u02");
  state = toggleSubservice(state, "c01s01u01");
  assert.deepEqual(state.subservices, ["c12s05u02", "c01s01u01"]);
  state = toggleSubservice(state, "c12s05u02");
  assert.deepEqual(state.subservices, ["c01s01u01"]);
  assert.deepEqual(emptySelection().subservices, [], "the empty state is never shared or mutated");
});

test("All selects every predefined subservice of that service only; partial is indeterminate; unchecking clears only those", () => {
  const target = "c12s05";
  const every = ids(service(target).subservices);
  let state = toggleSubservice(emptySelection(), "c01s01u01");
  assert.equal(allState(state, target), "none");
  state = setAll(state, target, true);
  assert.equal(allState(state, target), "all");
  assert.deepEqual(every.filter((id) => !state.subservices.includes(id)), [], "all of them");
  assert.ok(state.subservices.includes("c01s01u01"), "another service is untouched");
  state = toggleSubservice(state, every[0]);
  assert.equal(allState(state, target), "some", "partial state");
  state = setAll(state, target, true);
  assert.equal(allState(state, target), "all");
  state = setAll(state, target, false);
  assert.equal(allState(state, target), "none");
  assert.deepEqual(state.subservices, ["c01s01u01"], "only this service's subservices were cleared");
});

test("All does not select or clear Other, and unchecking All keeps a separately checked Other", () => {
  let state = setCustomText(setCustomChecked(emptySelection(), "c12s05", true), "c12s05", "Accessibility audits");
  state = setAll(state, "c12s05", true);
  assert.deepEqual(state.custom["c12s05"], { checked: true, text: "Accessibility audits" });
  state = setAll(state, "c12s05", false);
  assert.deepEqual(state.custom["c12s05"], { checked: true, text: "Accessibility audits" });
  let fresh = setAll(emptySelection(), "c12s05", true);
  assert.equal(fresh.custom["c12s05"], undefined, "checking All never checks Other");
  void fresh;
});

test("Other: trimmed, required when checked, at most 100 characters; unchecked text is kept but never validated or saved", () => {
  const entry = (checked, text) => ({ checked, text });
  assert.equal(customError(entry(false, "")), null, "unchecked is never invalid");
  assert.match(customError(entry(true, "   ")), /Enter what you mean/);
  assert.equal(customError(entry(true, "  fine  ")), null);
  assert.equal(customError(entry(true, "x".repeat(100))), null);
  assert.match(customError(entry(true, "x".repeat(101))), /100 characters/);
  assert.equal(customError(entry(true, ` ${"x".repeat(100)} `)), null, "length is measured after trimming");
  let state = setCustomChecked(emptySelection(), "c12s05", true);
  assert.deepEqual(selectionProblems(state), [{ serviceId: "c12s05", message: customError(state.custom["c12s05"]) }]);
  state = setCustomText(state, "c12s05", "Accessibility audits");
  assert.deepEqual(selectionProblems(state), []);
  state = setCustomChecked(state, "c12s05", false);
  assert.equal(state.custom["c12s05"].text, "Accessibility audits", "the text survives toggling");
  assert.deepEqual(toPayload(state).custom, [], "but an unchecked Other is not saved");
});

test("no selections is allowed, and the payload carries only ids, never an All pseudo-option", () => {
  assert.equal(isEmptySelection(emptySelection()), true);
  assert.equal(isEmptySelection(setCustomChecked(emptySelection(), "c12s05", true)), false);
  const state = setAll(emptySelection(), "c12s05", true);
  const payload = toPayload({ ...state, subservices: [...state.subservices, "bogus", state.subservices[0]] });
  assert.deepEqual(payload.subserviceIds, ids(service("c12s05").subservices), "real ids only, de-duplicated");
  assert.ok(payload.subserviceIds.every((id) => SUBSERVICE_BY_ID.has(id)));
});

test("rows from the database rebuild the same selection, and 'same' ignores order and blank unchecked Other", () => {
  const state = fromRows([
    { subservice_id: "c12s05u02", service_id: "c12s05", is_custom: false, custom_text: null },
    { subservice_id: "c01s01u01", service_id: "c01s01", is_custom: false, custom_text: null },
    { subservice_id: null, service_id: "c12s05", is_custom: true, custom_text: "Accessibility audits" },
  ]);
  assert.deepEqual(state, { subservices: ["c12s05u02", "c01s01u01"], custom: { c12s05: { checked: true, text: "Accessibility audits" } } });
  const reordered = { subservices: ["c01s01u01", "c12s05u02"], custom: { c12s05: { checked: true, text: " Accessibility audits " }, c01s01: { checked: false, text: "" } } };
  assert.equal(sameSelection(state, reordered), true);
  assert.equal(sameSelection(state, toggleSubservice(state, "c03s01u01")), false);
});

test("counts roll up service -> category -> total, and the review summary groups Category > Service > Subservice", () => {
  let state = setAll(emptySelection(), "c12s05", true);
  state = toggleSubservice(state, "c12s01u01");
  state = setCustomText(setCustomChecked(state, "c12s05", true), "c12s05", "Accessibility audits");
  const apps = service("c12s05").subservices.length;
  assert.equal(countForService(state, "c12s05"), apps + 1, "subservices plus a checked Other");
  assert.equal(countForCategory(state, "c12"), apps + 2);
  assert.equal(totalSelected(state), apps + 2);
  const summary = summarize(state);
  assert.deepEqual(summary.map((c) => c.category.id), ["c12"]);
  assert.deepEqual(summary[0].services.map((s) => s.service.id), ["c12s01", "c12s05"]);
  assert.equal(summary[0].services[1].other, "Accessibility audits");
  assert.equal(summary[0].services[1].subservices.length, apps);
  assert.deepEqual(summarize(emptySelection()), []);
});

test("the two branches are independent states: changing one never changes the other", () => {
  const offer = toggleSubservice(emptySelection(), "c12s05u02");
  const need = emptySelection();
  const offer2 = toggleSubservice(offer, "c01s01u01");
  assert.deepEqual(need, emptySelection());
  assert.deepEqual(offer.subservices, ["c12s05u02"], "toggling returns a new state and leaves the old one alone");
  assert.deepEqual(offer2.subservices, ["c12s05u02", "c01s01u01"]);
});

// ---- search (spec section 5) ----
test("search: case-insensitive partial match across categories, services and subservices, each with its full path", () => {
  const hits = searchCatalog("APP");
  assert.ok(hits.length > 3);
  const paths = hits.map(pathLabel);
  assert.ok(paths.includes("Technology & Electronics > App & Software Testing"), "a service");
  assert.ok(paths.includes("Technology & Electronics > Mobile Devices > App Setup"), "a subservice, shown under its parent service");
  assert.ok(paths.includes("Business, Office & Administrative > App Data Entry"), "a service in another category");
  assert.ok(hits.every((hit) => hit.path.join(" ").toLowerCase().includes("app")));
  const one = searchCatalog("mobile app testing")[0];
  assert.equal(pathLabel(one), "Technology & Electronics > App & Software Testing > Mobile App Testing (iOS / Android)");
  assert.deepEqual([one.level, one.categoryId, one.serviceId, one.id], ["subservice", "c12", "c12s05", SERVICE_BY_ID.get("c12s05").service.subservices[1].id]);
});

test("search: a category match opens a category, a service match a service, and nothing matching returns nothing", () => {
  assert.deepEqual(searchCatalog("pet care").filter((hit) => hit.level === "category").map((hit) => hit.id), ["c08"]);
  const service = searchCatalog("dog walking")[0];
  assert.deepEqual([service.level, service.categoryId, service.serviceId], ["service", "c08", "c08s01"]);
  assert.deepEqual(searchCatalog("zzzz no such thing"), []);
  assert.deepEqual(searchCatalog("   "), []);
  assert.ok(searchCatalog("a", 5).length <= 5, "the list is bounded");
});

test("search: names that start with the query come before ones that merely contain it, and the catalog is never changed by searching", () => {
  const before = JSON.stringify(CATALOG);
  const levels = searchCatalog("clean").map((hit) => hit.path.at(-1));
  assert.ok(levels[0].toLowerCase().startsWith("clean"), levels[0]);
  assert.equal(JSON.stringify(CATALOG), before);
  assert.equal(CATEGORY_BY_ID.size, 23);
});
