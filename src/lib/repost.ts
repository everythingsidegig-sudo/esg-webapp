import type { Gig, GigStatus } from "./database.types";

// Repost a closed gig as a NEW gig. Nothing about the old gig changes: the new gig is created through
// the ordinary Post a Gig form (create_gig, with all its validation), prefilled from the old one.

// "Closed" = it ended without a live relationship left to manage: cancelled, completed or incomplete.
// Drafts, open gigs, gigs in progress and disputes are not reposted from here.
export const REPOSTABLE_STATUSES: readonly GigStatus[] = ["cancelled", "completed", "incomplete"];

export function canRepost(gig: { poster_id: string; status: GigStatus }, userId: string | null | undefined): boolean {
  return !!userId && gig.poster_id === userId && REPOSTABLE_STATUSES.includes(gig.status);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The gig id in /post?repost=<id>. Anything else is ignored, never passed to a query.
export function repostParam(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

export function repostHref(gigId: string): string {
  return `/post?repost=${encodeURIComponent(gigId)}`;
}

// Same gig, sent privately to the same helper again (the existing private-request form).
export function repostPrivateHref(gigId: string, username: string, category: string): string {
  const params = new URLSearchParams({ helper: username, category, repost: gigId });
  return `/post?${params.toString()}`;
}

// What the form is prefilled with. Deliberately NOT carried over: the date (it is in the past and must
// be chosen again), the status, the selected or requested helper, the agreed price, claims and chat.
export type RepostDraft = {
  serviceType: string;
  title: string;
  description: string;
  amount: string;
  locationText: string;
  lat: number | null;
  lng: number | null;
  photoUrl: string | null;
  tagIds: string[];
  privateAddress: string;
};

export function repostDraft(
  gig: Pick<Gig, "service_type" | "title" | "description" | "amount" | "location_text" | "lat" | "lng" | "photo_url"> & { gig_tags?: { tag_id: string }[] | null },
  privateAddress: string | null | undefined,
): RepostDraft {
  return {
    serviceType: gig.service_type,
    title: gig.title,
    description: gig.description,
    amount: String(gig.amount),            // the original budget, not a renegotiated agreed price
    locationText: gig.location_text ?? "",
    lat: gig.lat ?? null,
    lng: gig.lng ?? null,
    photoUrl: gig.photo_url ?? null,
    tagIds: [...new Set((gig.gig_tags ?? []).map((row) => row.tag_id))],
    privateAddress: privateAddress ?? "",
  };
}
