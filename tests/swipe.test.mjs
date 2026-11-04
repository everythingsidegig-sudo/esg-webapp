import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SWIPE_COMMIT_PX, resolveSwipe, loadDecidedGigIds, markGigDecided, unmarkGigDecided,
  loadSkippedProviderIds, markProviderSkipped, skippedProviderIdsKey,
} from "../src/lib/swipe.ts";

// ---- resolveSwipe: pure gesture math (ESG Gig Swipe Discovery v1.0) ----
test("a tap (near-zero movement) never resolves as a swipe", () => {
  assert.equal(resolveSwipe(0, 0), null);
  assert.equal(resolveSwipe(3, -2), null);
});
test("small horizontal movement below the commit threshold snaps back, not a decision", () => {
  assert.equal(resolveSwipe(SWIPE_COMMIT_PX - 1, 0), null);
  assert.equal(resolveSwipe(-(SWIPE_COMMIT_PX - 1), 0), null);
});
test("crossing the commit threshold to the right is Accept, to the left is Reject", () => {
  assert.equal(resolveSwipe(SWIPE_COMMIT_PX, 0), "accept");
  assert.equal(resolveSwipe(SWIPE_COMMIT_PX + 40, 0), "accept");
  assert.equal(resolveSwipe(-SWIPE_COMMIT_PX, 0), "reject");
  assert.equal(resolveSwipe(-(SWIPE_COMMIT_PX + 40), 0), "reject");
});
test("vertical scrolling never commits a decision, even past the horizontal threshold, once vertical dominates", () => {
  assert.equal(resolveSwipe(SWIPE_COMMIT_PX + 10, SWIPE_COMMIT_PX + 50), null, "mostly vertical movement");
  assert.equal(resolveSwipe(SWIPE_COMMIT_PX + 10, SWIPE_COMMIT_PX + 10), null, "equal movement favors scrolling, not a swipe");
  assert.equal(resolveSwipe(SWIPE_COMMIT_PX + 10, SWIPE_COMMIT_PX + 9), "accept", "horizontal just barely dominant still commits");
});

// ---- session-only decided list (spec's own recommended default: session, not persistent) ----
const fakeStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); } };
};

test("a fresh store has nothing decided", () => assert.deepEqual(loadDecidedGigIds(fakeStorage()), []));
test("marking a gig decided adds it once, even if marked twice", () => {
  const store = fakeStorage();
  markGigDecided("g1", store);
  markGigDecided("g1", store);
  markGigDecided("g2", store);
  assert.deepEqual(loadDecidedGigIds(store), ["g1", "g2"]);
});
test("undo removes exactly the one id, leaving the rest decided", () => {
  const store = fakeStorage();
  markGigDecided("g1", store);
  markGigDecided("g2", store);
  unmarkGigDecided("g1", store);
  assert.deepEqual(loadDecidedGigIds(store), ["g2"]);
});
test("a tampered or missing store never throws, and just reports nothing decided", () => {
  assert.deepEqual(loadDecidedGigIds(fakeStorage({ "esg:discovery-decided": "not json" })), []);
  assert.deepEqual(loadDecidedGigIds(fakeStorage({ "esg:discovery-decided": JSON.stringify({ not: "an array" }) })), []);
  assert.deepEqual(loadDecidedGigIds(fakeStorage({ "esg:discovery-decided": JSON.stringify(["g1", 42, null]) })), ["g1"], "non-string entries are dropped, not thrown on");
  const broken = { getItem: () => { throw new Error("storage unavailable"); }, setItem: () => { throw new Error("storage unavailable"); } };
  assert.deepEqual(loadDecidedGigIds(broken), []);
  assert.doesNotThrow(() => markGigDecided("g1", broken));
  assert.doesNotThrow(() => unmarkGigDecided("g1", broken));
});

// ---- per-gig skipped-provider list (Find Help Profile Swiping v1.0, section 7.2) ----
test("a skip is scoped to its own gig: skipping a provider for one gig's deck never hides them from another gig's deck", () => {
  const store = fakeStorage();
  markProviderSkipped("gig-a", "p1", store);
  assert.deepEqual(loadSkippedProviderIds("gig-a", store), ["p1"]);
  assert.deepEqual(loadSkippedProviderIds("gig-b", store), [], "a different gig's deck starts clean");
});
test("skipping the same provider twice on one gig only records it once", () => {
  const store = fakeStorage();
  markProviderSkipped("gig-a", "p1", store);
  markProviderSkipped("gig-a", "p1", store);
  markProviderSkipped("gig-a", "p2", store);
  assert.deepEqual(loadSkippedProviderIds("gig-a", store), ["p1", "p2"]);
});
test("a tampered or missing store never throws for the skipped-provider list either", () => {
  assert.deepEqual(loadSkippedProviderIds("gig-a", fakeStorage({ [skippedProviderIdsKey("gig-a")]: "not json" })), []);
  const broken = { getItem: () => { throw new Error("storage unavailable"); }, setItem: () => { throw new Error("storage unavailable"); } };
  assert.deepEqual(loadSkippedProviderIds("gig-a", broken), []);
  assert.doesNotThrow(() => markProviderSkipped("gig-a", "p1", broken));
});
