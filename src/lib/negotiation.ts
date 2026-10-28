import type { PriceProposal } from "./database.types";

// Price negotiation in the gig chat. The database (migration 0021) is the authority for every rule
// below; this module only mirrors them so the screen can show the right buttons and explain a refusal.

export const MAX_PRICE_ROUNDS = 3;

export type NegotiationView = {
  used: number;                 // proposals made so far (each one is a round, whatever became of it)
  remaining: number;
  nextRound: number;
  pending: PriceProposal | null;
  agreed: boolean;              // a proposal was accepted: the negotiation is over
  pendingFromOther: boolean;    // an answer is owed by the viewer
  pendingFromMe: boolean;       // the viewer is waiting for a reply
  canPropose: boolean;
};

// `open` = the gig is still before start (active, helper selected, start not requested).
export function negotiationView(proposals: PriceProposal[], userId: string, open: boolean): NegotiationView {
  const used = proposals.length;
  const pending = proposals.find((proposal) => proposal.state === "pending") ?? null;
  const agreed = proposals.some((proposal) => proposal.state === "accepted");
  const pendingFromMe = !!pending && pending.proposer_id === userId;
  const pendingFromOther = !!pending && pending.proposer_id !== userId;
  return {
    used,
    remaining: Math.max(0, MAX_PRICE_ROUNDS - used),
    nextRound: used + 1,
    pending,
    agreed,
    pendingFromOther,
    pendingFromMe,
    canPropose: open && !agreed && used < MAX_PRICE_ROUNDS && !pendingFromMe,
  };
}

// UX-only check of a typed price against the one currently agreed (the server decides).
export function proposalAmountError(text: string, currentAmount: number): string | null {
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed) || !Number.isFinite(value) || value <= 0 || value > 9999999999.99) {
    return "Enter a positive price with at most two decimal places.";
  }
  if (Math.round(value * 100) === Math.round(currentAmount * 100)) return "That is already the agreed price.";
  return null;
}

// The database has no price_proposals table / propose_price function yet (PostgREST: PGRST205 / PGRST202,
// or Postgres 42P01 / 42883): the server is behind this version of the app.
export function negotiationUnavailable(error: unknown): boolean {
  const code = (error as { code?: string } | null | undefined)?.code;
  return code === "PGRST205" || code === "PGRST202" || code === "42P01" || code === "42883";
}

// Messages our own functions raise are meant for people; anything else gets a generic line.
export function negotiationActionError(error: unknown, fallback = "Couldn't send that. Please try again."): string {
  const value = error as { code?: string; message?: string } | null;
  if ((value?.code === "P0001" || value?.code === "22023") && typeof value.message === "string" && value.message) return value.message;
  if (value?.code === "42501") return "You can't change the price on this gig.";
  if (negotiationUnavailable(error)) return "Price negotiation isn't available on this server yet.";
  return fallback;
}

export type ProposalStatus = "waiting" | "answer" | "closed" | "accepted" | "declined" | "withdrawn";

// What a proposal card should offer this viewer.
export function proposalStatus(proposal: PriceProposal, userId: string, open: boolean): ProposalStatus {
  if (proposal.state !== "pending") return proposal.state;
  if (!open) return "closed";
  return proposal.proposer_id === userId ? "waiting" : "answer";
}
