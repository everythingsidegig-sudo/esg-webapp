import type { GigStatus } from "./database.types";

// What each person sees once the helper has asked to start. The database (migrations 0022 and 0023) decides
// what is allowed; this only picks the right screen.
//
//   helper asks to start ->  poster: Accept start | Delay start | Remove helper
//   delayed              ->  poster: Accept start (when ready)   helper: ask to start again | wait | withdraw
//   helper asks again    ->  (resubmit_start, migration 0031) back to the first step: poster sees Accept start | Delay start
//   no answer            ->  helper: after 24 hours wait again (at most twice), then withdraw (the poster gets a lemon)
//   helper withdraws / is removed -> the gig closes as cancelled; the poster can post it again for everyone (repost)

export type StartView = "none" | "poster-review" | "poster-delayed" | "helper-waiting" | "helper-delayed";

type StartGig = {
  status: GigStatus;
  poster_id: string;
  selected_provider_id: string | null;
  start_requested_at: string | null;
  start_delayed_at?: string | null;
};

export function startView(gig: StartGig, userId: string | null | undefined): StartView {
  if (!userId || gig.status !== "active" || !gig.selected_provider_id || !gig.start_requested_at) return "none";
  const delayed = !!gig.start_delayed_at;
  if (gig.poster_id === userId) return delayed ? "poster-delayed" : "poster-review";
  if (gig.selected_provider_id === userId) return delayed ? "helper-delayed" : "helper-waiting";
  return "none";
}

// The server has not been upgraded for delaying a start yet (migration 0022): the column does not come back.
export function delayAvailable(gig: object): boolean {
  return "start_delayed_at" in gig;
}

// A helper left while the start was delayed or unanswered (the gig is closed, helper_withdrawn_at is set).
export function helperWithdrew(gig: { status: GigStatus; helper_withdrawn_at?: string | null }): boolean {
  return gig.status === "cancelled" && !!gig.helper_withdrawn_at;
}

// The poster removed the helper before the start (the gig is closed, helper_removed_at is set).
export function helperRemoved(gig: { status: GigStatus; helper_removed_at?: string | null }): boolean {
  return gig.status === "cancelled" && !!gig.helper_removed_at;
}

// Removing a helper and waiting out an unanswered start need migration 0023: its columns come back with the gig.
export function removeAvailable(gig: object): boolean {
  return "helper_removed_at" in gig;
}

export function waitAvailable(gig: object): boolean {
  return "start_wait_count" in gig;
}

// Mirrors the constants in migration 0023 (c_wait, c_max_waits); the database enforces them.
export const START_WAIT_HOURS = 24;
export const START_MAX_WAITS = 2;
const WAIT_MS = START_WAIT_HOURS * 60 * 60 * 1000;

// ESG-CAN-001 v1.0: the helper can withdraw with no reason before the start has gone unanswered
// long enough to carry the poster's Lemon (withdraw_unanswered, migration 0023/0024) and before the
// poster has delayed it (withdraw_from_gig already covers that). Mirrors withdraw_before_start's own
// check (migration 0026) so the button only shows when the call would actually succeed.
export function canWithdrawBeforeStart(gig: { start_requested_at: string | null; start_delayed_at?: string | null }, now: number): boolean {
  if (gig.start_delayed_at) return false;
  if (!gig.start_requested_at) return true;
  return now < Date.parse(gig.start_requested_at) + WAIT_MS;
}

// Migration 0039: the poster can delay a start twice at most. After the first delay the helper can ask
// to start again; after the second they cannot, and the poster owes an answer within 24 hours or the
// helper may withdraw and the poster gets a lemon. Removing the helper after the second delay also
// gives the poster a lemon. The database enforces all of it; this only picks the right screen.
export const START_MAX_DELAYS = 2;

// Delays used so far. A server without migration 0039 does not send the count, so a delayed start
// counts as one.
export function delaysUsed(gig: { start_delay_count?: number | null; start_delayed_at?: string | null }): number {
  return gig.start_delay_count ?? (gig.start_delayed_at ? 1 : 0);
}

export function delaysLeft(gig: { start_delay_count?: number | null; start_delayed_at?: string | null }): number {
  return Math.max(0, START_MAX_DELAYS - delaysUsed(gig));
}

// The helper can ask to start again only while the poster has delayed once, not twice.
export function canResubmitStart(gig: { start_delay_count?: number | null; start_delayed_at?: string | null }): boolean {
  return !!gig.start_delayed_at && delaysUsed(gig) < START_MAX_DELAYS;
}

// After the second delay: has the poster used up the 24 hours to answer? ("final" is false before then,
// and for a start that was delayed fewer than twice.)
export type FinalDelay = { final: boolean; deadline: number; overdue: boolean };

export function finalDelay(gig: { start_delay_count?: number | null; start_delayed_at?: string | null }, now: number): FinalDelay {
  const delayedAt = gig.start_delayed_at ? Date.parse(gig.start_delayed_at) : NaN;
  if (delaysUsed(gig) < START_MAX_DELAYS || Number.isNaN(delayedAt)) return { final: false, deadline: 0, overdue: false };
  const deadline = delayedAt + WAIT_MS;
  return { final: true, deadline, overdue: now >= deadline };
}

// Where an unanswered start request stands for the helper. "answering": the poster still has time.
// "can-wait": 24 hours of silence passed and a wait is left. "can-withdraw": both waits are used and over.
export type Silence = { phase: "answering" | "can-wait" | "can-withdraw"; waitsUsed: number; waitsLeft: number; nextAt: number };

export function silence(
  gig: { start_requested_at: string | null; start_wait_count?: number | null; start_wait_until?: string | null },
  now: number,
): Silence | null {
  if (!gig.start_requested_at) return null;
  const waitsUsed = gig.start_wait_count ?? 0;
  const waitsLeft = Math.max(0, START_MAX_WAITS - waitsUsed);
  const nextAt = gig.start_wait_until ? Date.parse(gig.start_wait_until) : Date.parse(gig.start_requested_at) + WAIT_MS;
  if (Number.isNaN(nextAt)) return null;
  if (now < nextAt) return { phase: "answering", waitsUsed, waitsLeft, nextAt };
  return { phase: waitsLeft > 0 ? "can-wait" : "can-withdraw", waitsUsed, waitsLeft, nextAt };
}

// "5 h 12 min" / "42 min" until a moment, rounded up so it never shows 0.
export function timeUntil(at: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((at - now) / 60000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}
