// ESG Gig Swipe Discovery v1.0: pure gesture math (independent of any real pointer
// event, so it's trivially unit-testable) plus the session-only "already decided"
// list the spec calls for -- a gig a visitor swiped on (either direction) in this
// session stops reappearing in their discovery feed, but a fresh session can
// rediscover it (per the spec's own recommended default: session-only retention,
// not a persistent hide).

// Crossing this many horizontal pixels, with horizontal movement clearly dominant
// over vertical, commits the gesture. Below it, the card just tracks the finger and
// snaps back on release -- an ordinary tap (near-zero movement) never commits.
export const SWIPE_COMMIT_PX = 80;

export type SwipeDecision = "accept" | "reject";

export function resolveSwipe(deltaX: number, deltaY: number): SwipeDecision | null {
  if (Math.abs(deltaX) < SWIPE_COMMIT_PX) return null;
  if (Math.abs(deltaX) <= Math.abs(deltaY)) return null;
  return deltaX > 0 ? "accept" : "reject";
}

const DECIDED_KEY = "esg:discovery-decided";
type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

// `sessionStorage` is referenced only inside each try block, never as a default parameter
// value -- a bare default-parameter reference evaluates eagerly, outside any try/catch, and
// throws immediately during server rendering (sessionStorage isn't a global there at all,
// even for a "use client" component's first server-rendered pass).
export function loadDecidedGigIds(store?: KeyValueStore): string[] {
  try {
    const value = JSON.parse((store ?? sessionStorage).getItem(DECIDED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch { return []; }
}

export function markGigDecided(id: string, store?: KeyValueStore) {
  try {
    const current = loadDecidedGigIds(store);
    if (!current.includes(id)) (store ?? sessionStorage).setItem(DECIDED_KEY, JSON.stringify([...current, id]));
  } catch { /* worst case the gig can be swiped on again; create_claim is idempotent either way */ }
}

// Undo (spec: "reverse a recent local skip before it is committed as a persistent
// hide"): since the hide is already just session-scoped, undo is simply removing
// the one id again -- never used for an already-submitted claim (accept has no undo).
export function unmarkGigDecided(id: string, store?: KeyValueStore) {
  try { (store ?? sessionStorage).setItem(DECIDED_KEY, JSON.stringify(loadDecidedGigIds(store).filter((existing) => existing !== id))); } catch {}
}

// Find Help Profile Swiping v1.0, section 7.2: a provider skipped while swiping on ONE saved
// gig's deck "does not re-show in the same session unless discovery is reset" -- scoped per
// gig (not global like discovery-decided above) so skipping a provider for gig A never hides
// them from gig B's own deck in the same session. A provider already sent an active request on
// the server (section 9's "avoid re-contacting") is excluded by the page's own query instead --
// this is only the local, undo-free skip gesture, which has no server effect to reverse.
export function skippedProviderIdsKey(gigId: string) {
  return `esg:direct-discovery-skipped:${gigId}`;
}

export function loadSkippedProviderIds(gigId: string, store?: KeyValueStore): string[] {
  try {
    const value = JSON.parse((store ?? sessionStorage).getItem(skippedProviderIdsKey(gigId)) ?? "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch { return []; }
}

export function markProviderSkipped(gigId: string, providerId: string, store?: KeyValueStore) {
  try {
    const current = loadSkippedProviderIds(gigId, store);
    if (!current.includes(providerId)) (store ?? sessionStorage).setItem(skippedProviderIdsKey(gigId), JSON.stringify([...current, providerId]));
  } catch { /* worst case the provider can be swiped on again this session */ }
}
