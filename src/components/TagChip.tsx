import type { ReactNode } from "react";

// Read-only display chip (a <span>, not a control) for showing a gig's tags —
// distinct from SelectionChip, which is an interactive selection control.
export default function TagChip({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-neutral-100 px-3 py-1 text-sm text-neutral-700">{children}</span>;
}
