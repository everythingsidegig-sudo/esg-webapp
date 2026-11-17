// The four stages a gig moves through, for the progress strip on its page.
export const PROGRESS_STEPS = ["Posted", "Matched", "Started", "Done"] as const;

type ProgressGig = { status: string; selected_provider_id: string | null };

// How many stages are reached: 0 for a gig that is not on the way (draft, private save, cancelled,
// incomplete, disputed -- those have their own banners), otherwise 1 to 4.
export function progressReached(gig: ProgressGig): number {
  switch (gig.status) {
    case "active": return gig.selected_provider_id ? 2 : 1;
    case "in_progress": return 3;
    case "awaiting_payment":
    case "completed": return 4;
    default: return 0;
  }
}
