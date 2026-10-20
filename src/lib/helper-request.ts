import type { ClaimState, GigStatus, PriceType } from "./database.types";

// A helper request is an ordinary gig addressed to one helper (gigs.requested_helper_id,
// migration 0019). Nothing here is a new status: the stage is derived from the gig and the
// requested helper's own claim, exactly as the lifecycle RPCs leave them.

const USERNAME = /^[A-Za-z0-9_]{1,40}$/;

// The helper named in /post?helper=<username>. Anything that is not a plain username is ignored,
// so a crafted link can neither inject markup into the page nor widen the lookup.
export function requestUsername(value: string | null | undefined): string | null {
  return value && USERNAME.test(value) ? value : null;
}

export function postRequestHref(username: string, category?: string | null): string {
  const safe = requestUsername(username);
  if (!safe) return "/post";
  const params = new URLSearchParams({ helper: safe });
  if (category) params.set("category", category);
  return `/post?${params.toString()}`;
}

export const PRICE_CHOICES: { value: PriceType; label: string; hint: string }[] = [
  { value: "fixed", label: "Fixed", hint: "The helper accepts or declines your price." },
  { value: "negotiable", label: "Negotiable", hint: "The helper may accept, decline, or counteroffer. You choose whether to accept a counteroffer." },
];

export function priceLabel(type: PriceType): string {
  return type === "negotiable" ? "Negotiable" : "Fixed price";
}

// A helper can only be asked for something they offer (the database checks this too): the
// categories the helper lists that this app knows, in the app's order.
export function requestableCategories(skills: readonly string[] | null | undefined, known: readonly string[]): string[] {
  const offered = new Set(skills ?? []);
  return known.filter((category) => offered.has(category));
}

export type RequestStage = "draft" | "waiting" | "countered" | "declined" | "accepted" | "closed";

type RequestLike = { status: GigStatus; selected_provider_id: string | null; requested_helper_id: string | null };

// Where a private request stands. null = this gig is not (or is no longer) a private request.
export function requestStage(gig: RequestLike, helperClaim: ClaimState | null): RequestStage | null {
  if (!gig.requested_helper_id) return null;
  if (gig.status === "draft") return "draft";
  if (gig.status === "cancelled") return "closed";
  if (gig.selected_provider_id) return "accepted";
  if (gig.status !== "active") return "closed";
  if (helperClaim === "withdrawn" || helperClaim === "rejected") return "declined";
  if (helperClaim === "pending") return "countered";
  return "waiting";
}
