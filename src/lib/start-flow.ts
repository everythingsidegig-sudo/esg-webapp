import type { GigStatus } from "./database.types";

// What each person sees once the helper has asked to start. The database (migration 0022) decides what
// is allowed; this only picks the right screen.
//
//   helper asks to start ->  poster: Accept start | Delay start
//   delayed              ->  poster: Accept start (when ready)   helper: wait | withdraw
//   helper withdraws     ->  the gig closes as cancelled; the poster can post it again for everyone (repost)

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

// A helper left while the start was delayed (the gig is closed, helper_withdrawn_at is set).
export function helperWithdrew(gig: { status: GigStatus; helper_withdrawn_at?: string | null }): boolean {
  return gig.status === "cancelled" && !!gig.helper_withdrawn_at;
}
