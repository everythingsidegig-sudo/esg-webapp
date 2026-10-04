import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { safeNext, setupDestination, registrationError, passwordError, approximateCoordinates, gigInputError, friendlyError, rpcActionError } from "../src/lib/journey.ts";
import { generalAreaLabel } from "../src/lib/geocoding.ts";
import { posterSection, helperSection, helperBadge, proposalCountLabel, timeAgo } from "../src/lib/my-gigs.ts";
import { SERVICE_TYPES } from "../src/lib/services.ts";

for (const value of [null, "https://evil.invalid", "//evil.invalid", "javascript:alert(1)", "/\\evil.invalid", "/%2f/evil.invalid", "/%255c%255cevil.invalid", "/post\n", "/auth/callback", "/onboarding", "/unknown", "/post?x=%0aevil", "/post?x=%ZZ"]) {
  test(`unsafe or cyclic destination rejected: ${JSON.stringify(value)}`, () => assert.equal(safeNext(value), "/"));
}
for (const value of ["/", "/post", "/post?loc=New%20York", "/my-gigs", "/need-help", "/location?journey=need_help", "/browse?lat=0&lng=0", "/profile", "/gigs/12345678-1234-1234-1234-123456789012"]) {
  test(`safe destination preserved: ${value}`, () => assert.equal(safeNext(value), value));
}
test("setup preserves intended post destination", () => assert.equal(setupDestination("/post?loc=Test"), "/onboarding?next=%2Fpost%3Floc%3DTest"));
test("setup sanitizes external next", () => assert.equal(setupDestination("https://evil.invalid"), "/onboarding?next=%2F"));
test("valid registration", () => assert.equal(registrationError("Tester123", "Password1!", "Password1!"), null));
test("valid replacement password", () => assert.equal(passwordError("Replacement1!", "Replacement1!"), null));
test("replacement passwords must match", () => assert.match(passwordError("Replacement1!", "Different1!") ?? "", /match/));
for (const [username, password, confirm] of [["short", "Password1!", "Password1!"], ["has spaces", "Password1!", "Password1!"], ["Tester123", "short1!", "short1!"], ["Tester123", "Password!!", "Password!!"], ["Tester123", "Password12", "Password12"], ["Tester123", "Password1!", "different"]]) {
  test(`registration validation ${username}/${password.length}/${confirm.length}`, () => assert.ok(registrationError(username, password, confirm)));
}
test("approximation rounds exact coordinates", () => assert.deepEqual(approximateCoordinates(12.345678, -45.678912), { lat: 12.35, lng: -45.68 }));
test("zero coordinates valid", () => assert.deepEqual(approximateCoordinates(0, 0), { lat: 0, lng: 0 }));
test("manual area needs no fabricated coordinates", () => assert.deepEqual(approximateCoordinates(null, null), { lat: null, lng: null }));
test("reverse geocoding uses locality and country without street details", () => assert.equal(generalAreaLabel({ address: {
  house_number: "12", road: "Private Street", postcode: "12345", town: "Kävlinge", state: "Skåne", country: "Sweden",
} }), "Kävlinge, Sweden"));
test("reverse geocoding falls back to region and country", () => assert.equal(generalAreaLabel({ address: {
  road: "Private Street", state: "Skåne", country: "Sweden",
} }), "Skåne, Sweden"));
for (const pair of [[91, 0], [0, 181], [NaN, 0], [Infinity, 0], [null, 0]]) {
  test(`malformed coordinates ${pair}`, () => assert.throws(() => approximateCoordinates(...pair)));
}
const future = new Date(Date.now() + 86400000).toISOString();
test("valid gig input", () => assert.equal(gigInputError("Gig", "Description", "0.01", future, "Test city", true), null));
test("existing draft accepts no scheduled date", () => assert.equal(gigInputError("Gig", "Description", "10", "", "Test city", false), null));
for (const amount of ["", "0", "-1", "NaN", "Infinity", "1.001", "10000000000"]) {
  test(`invalid gig price ${amount}`, () => assert.ok(gigInputError("Gig", "Description", amount, future, "Test city", true)));
}
for (const date of ["", "not a date", "2000-01-01"]) {
  test(`invalid gig schedule ${date}`, () => assert.ok(gigInputError("Gig", "Description", "10", date, "Test city", true)));
}
test("blank title rejected", () => assert.ok(gigInputError(" ", "Description", "10", future, "Test city", true)));
test("oversized description rejected", () => assert.ok(gigInputError("Gig", "x".repeat(281), "10", future, "Test city", true)));
test("blank area rejected", () => assert.ok(gigInputError("Gig", "Description", "10", future, " ", true)));
test("database internals not shown", () => assert.equal(friendlyError({ code: "42P01", message: "secret SQL details" }), "Something went wrong. Please try again."));
test("unverified login actionable", () => assert.match(friendlyError({ code: "email_not_confirmed" }), /Verify your email/));
test("duplicate username actionable", () => assert.match(friendlyError({ code: "23505" }), /username is already taken/));
test("signup/sign-in errors that were previously generic now say what is wrong", () => {
  assert.match(friendlyError({ code: "email_address_invalid" }), /email address isn't valid/);
  assert.match(friendlyError({ code: "user_banned" }), /no longer available/);
  assert.match(friendlyError({ code: "signup_disabled" }), /Registration is currently unavailable/);
  assert.match(friendlyError({ code: "unexpected_failure", message: "Database error saving new user" }), /username may have just been taken/);
  assert.equal(friendlyError({ code: "unexpected_failure", message: "something else with user_id=1" }), "Something went wrong. Please try again.");
});
test("lifecycle RPC errors: only our own raised messages are shown, everything else is generic", () => {
  assert.equal(rpcActionError({ code: "P0001", message: "Gig is not open for claims" }), "Gig is not open for claims");
  assert.match(rpcActionError({ code: "42501", message: "Not authorized" }), /sign in again/);
  assert.match(rpcActionError({ code: "429" }), /Too many requests/);
  for (const error of [
    { code: "23505", message: 'duplicate key value violates unique constraint "claims_gig_id_provider_id_key"' },
    { code: "42883", message: "function public.secret_fn does not exist" },
    { message: "TypeError: Failed to fetch" },
    null,
  ]) assert.equal(rpcActionError(error), "Couldn't complete that action. Please try again.");
});
test("the gig page never renders a raw RPC error message", async () => {
  const source = await readFile(new URL("../src/app/gigs/[id]/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /setError\(actionError\.message\)/);
  assert.match(source, /rpcActionError\(actionError\)/);
});
test("mobile app shell: full-screen viewport, installable manifest, safe-area padding and 44px touch targets", async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const layout = await read("../src/app/layout.tsx");
  assert.match(layout, /viewportFit: "cover"/, "uses the full screen on notched phones");
  assert.match(layout, /themeColor/);
  assert.match(layout, /appleWebApp: \{ capable: true/);
  const manifest = await read("../src/app/manifest.ts");
  assert.match(manifest, /display: "standalone"/);
  assert.match(manifest, /start_url: "\/"/);
  assert.match(manifest, /sizes: "512x512"/);
  const nav = await read("../src/components/Nav.tsx");
  assert.match(nav, /pt-\[env\(safe-area-inset-top\)\]/, "header clears the status bar/notch");
  assert.match(nav, /pb-\[env\(safe-area-inset-bottom\)\]/, "bottom tab bar clears the home indicator");
  const css = await read("../src/app/globals.css");
  assert.match(css, /min-height: 2\.75rem/, "buttons and fields are at least 44px tall");
  assert.match(css, /touch-action: manipulation/);
  assert.match(css, /\.touch-link/);
  assert.match(css, /\.check-row/);
});
test("My Gigs sections are derived only from existing statuses and claim states", () => {
  const gig = (status, selected_provider_id = null) => ({ status, selected_provider_id });
  assert.deepEqual(
    ["draft", "active", "in_progress", "awaiting_payment", "completed", "incomplete", "disputed", "cancelled"].map((status) => posterSection(gig(status))),
    ["draft", "open", "in_progress", "in_progress", "completed", "completed", "disputed", "cancelled"]);
  assert.equal(posterSection(gig("active", "h")), "accepted", "a selected helper on an active gig is 'accepted'");
  const me = "me";
  assert.equal(helperSection(gig("active"), "pending", me), "proposals");
  assert.equal(helperSection(gig("active", me), "selected", me), "accepted");
  assert.equal(helperSection(gig("in_progress", me), "selected", me), "in_progress");
  assert.equal(helperSection(gig("awaiting_payment", me), "selected", me), "in_progress");
  assert.equal(helperSection(gig("incomplete", me), "selected", me), "completed");
  assert.equal(helperSection(gig("disputed", me), "selected", me), "disputed");
  assert.equal(helperSection(gig("active", "someone-else"), "rejected", me), "closed", "another helper was chosen");
  assert.equal(helperSection(gig("cancelled"), "rejected", me), "closed");
  assert.equal(helperSection(gig("active"), "withdrawn", me), "closed");
  assert.deepEqual(helperBadge("proposals", gig("active"), "pending"), { label: "Proposal pending", tone: "pending" });
  assert.equal(helperBadge("closed", gig("cancelled"), "rejected").label, "Gig cancelled");
  assert.equal(helperBadge("closed", gig("active", "x"), "rejected").label, "Not selected");
  assert.equal(helperBadge("closed", gig("active"), "withdrawn").label, "Withdrawn");
  assert.equal(proposalCountLabel(1), "1 proposal");
  assert.equal(proposalCountLabel(3), "3 proposals");
});
test("relative times for the Messages inbox", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(timeAgo("2026-10-10T11:59:40Z", now), "now");
  assert.equal(timeAgo("2026-10-10T11:58:00Z", now), "2m");
  assert.equal(timeAgo("2026-10-10T09:00:00Z", now), "3h");
  assert.equal(timeAgo("2026-10-08T12:00:00Z", now), "2d");
});
test("/messages and My Gigs deep links survive sign-in via next", () => {
  assert.equal(safeNext("/messages"), "/messages");
  assert.equal(safeNext("/my-gigs?tab=helping"), "/my-gigs?tab=helping");
  assert.equal(safeNext("/gigs/12345678-1234-1234-1234-123456789012#proposals"), "/gigs/12345678-1234-1234-1234-123456789012#proposals");
  assert.equal(safeNext("/messages/../../evil"), "/");
});
test("existing catalog retained", () => assert.deepEqual(SERVICE_TYPES, ["Yard Work", "Moving Help", "Cleaning", "Handyman", "Delivery", "Pet Care", "Tech Help", "Other"]));
test("database validation uses the same POC catalog", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20240101000004_onboarding_post_gig.sql", import.meta.url), "utf8");
  const catalogs = [...sql.matchAll(/array\[('Yard Work'[^\]]+)\]/g)];
  assert.equal(catalogs.length, 2);
  for (const [, catalog] of catalogs) assert.deepEqual(catalog.split(",").map((label) => label.slice(1, -1)), [...SERVICE_TYPES]);
});
test("gig tags migration validates against the same POC catalog", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20240101000006_gig_tags.sql", import.meta.url), "utf8");
  const catalogs = [...sql.matchAll(/array\[('Yard Work'[^\]]+)\]/g)];
  assert.equal(catalogs.length, 2);
  for (const [, catalog] of catalogs) assert.deepEqual(catalog.split(",").map((label) => label.slice(1, -1)), [...SERVICE_TYPES]);
});
test("seeded tag catalog only uses approved categories and excludes scheduling/location terms", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20240101000006_gig_tags.sql", import.meta.url), "utf8");
  const seed = sql.match(/insert into public\.tags \(service_type, name\) values\n([\s\S]+?)\non conflict/)[1];
  const rows = [...seed.matchAll(/\('([^']+)','([^']+)'\)/g)].map(([, category, name]) => ({ category, name }));
  assert.ok(rows.length > 0);
  for (const { category } of rows) assert.ok(SERVICE_TYPES.includes(category), `unexpected category: ${category}`);
  const excluded = ["Weekend", "Same-Day", "Seasonal", "Local", "Long Distance"];
  for (const { name } of rows) assert.ok(!excluded.includes(name), `excluded scheduling/location term used as a tag: ${name}`);
});
