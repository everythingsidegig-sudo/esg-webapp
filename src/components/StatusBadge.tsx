import type { GigStatus } from "@/lib/database.types";

const STYLES: Record<GigStatus, { label: string; className: string }> = {
  draft: { label: "Drafted", className: "bg-neutral-200 text-neutral-700" },
  active: { label: "Active", className: "bg-yellow-100 text-yellow-800" },
  in_progress: { label: "In Progress", className: "bg-green-100 text-green-800" },
  awaiting_payment: { label: "Awaiting Payment", className: "bg-green-100 text-green-800" },
  completed: { label: "Completed", className: "bg-blue-100 text-blue-800" },
  incomplete: { label: "Incomplete", className: "bg-red-100 text-red-800" },
  disputed: { label: "Disputed", className: "bg-red-200 text-red-900" },
  cancelled: { label: "Cancelled", className: "bg-orange-100 text-orange-800" },
};

export default function StatusBadge({ status }: { status: GigStatus }) {
  const style = STYLES[status];
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${style.className}`}>{style.label}</span>
  );
}
