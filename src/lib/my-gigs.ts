import type { ClaimState, GigStatus } from "./database.types";

// UI grouping over the EXISTING gig/claim lifecycle. Nothing here introduces a
// status: every section is derived from gigs.status, gigs.selected_provider_id
// and claims.state exactly as the lifecycle RPCs set them.

type GigLike = { status: GigStatus; selected_provider_id: string | null };

// ---------------------------------------------------------------- I Need Help
export type PosterSection = "open" | "accepted" | "in_progress" | "disputed" | "completed" | "draft" | "cancelled";

export const POSTER_SECTIONS: { key: PosterSection; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "accepted", label: "Accepted" },
  { key: "in_progress", label: "In progress" },
  { key: "disputed", label: "Needs attention" },
  { key: "completed", label: "Completed" },
  { key: "draft", label: "Drafts" },
  { key: "cancelled", label: "Cancelled" },
];

export function posterSection(gig: GigLike): PosterSection {
  switch (gig.status) {
    case "draft": return "draft";
    case "active": return gig.selected_provider_id ? "accepted" : "open";
    case "in_progress":
    case "awaiting_payment": return "in_progress";
    case "completed":
    case "incomplete": return "completed";
    case "disputed": return "disputed";
    case "cancelled": return "cancelled";
  }
}

// ----------------------------------------------------------------- I'm Helping
export type HelperSection = "proposals" | "accepted" | "in_progress" | "disputed" | "completed" | "closed";

export const HELPER_SECTIONS: { key: HelperSection; label: string }[] = [
  { key: "proposals", label: "Proposals" },
  { key: "accepted", label: "Accepted" },
  { key: "in_progress", label: "In progress" },
  { key: "disputed", label: "Needs attention" },
  { key: "completed", label: "Completed" },
  { key: "closed", label: "Not selected or closed" },
];

export function helperSection(gig: GigLike, claimState: ClaimState | null, userId: string): HelperSection {
  if (gig.selected_provider_id === userId) {
    switch (gig.status) {
      case "active": return "accepted";
      case "in_progress":
      case "awaiting_payment": return "in_progress";
      case "completed":
      case "incomplete": return "completed";
      case "disputed": return "disputed";
      default: return "closed";
    }
  }
  if (gig.status === "active" && !gig.selected_provider_id && claimState === "pending") return "proposals";
  return "closed";
}

export function helperBadge(section: HelperSection, gig: GigLike, claimState: ClaimState | null): { label: string; tone: "pending" | "good" | "neutral" | "bad" } {
  switch (section) {
    case "proposals": return { label: "Proposal pending", tone: "pending" };
    case "accepted": return { label: "Accepted", tone: "good" };
    case "in_progress": return { label: gig.status === "awaiting_payment" ? "Awaiting payment" : "In progress", tone: "good" };
    case "completed": return { label: gig.status === "incomplete" ? "Incomplete" : "Completed", tone: "neutral" };
    case "disputed": return { label: "Disputed", tone: "bad" };
    case "closed":
      if (gig.status === "cancelled") return { label: "Gig cancelled", tone: "bad" };
      if (claimState === "withdrawn") return { label: "Withdrawn", tone: "neutral" };
      return { label: "Not selected", tone: "neutral" };
  }
}

// -------------------------------------------------------------------- shared
export function proposalCountLabel(count: number) {
  return `${count} proposal${count === 1 ? "" : "s"}`;
}

export function shortDate(iso: string | null | undefined, fallback = "Flexible") {
  if (!iso) return fallback;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return fallback;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function timeAgo(iso: string, now: number = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return shortDate(iso, "");
}
