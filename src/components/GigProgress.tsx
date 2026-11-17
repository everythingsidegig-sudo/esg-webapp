import { PROGRESS_STEPS, progressReached } from "@/lib/gig-progress";

// Posted -> Matched -> Started -> Done as joined circles: finished steps are filled, the current one is
// ringed. Shown only while a gig is on its way (see progressReached).
export default function GigProgress({ gig }: { gig: { status: string; selected_provider_id: string | null } }) {
  const reached = progressReached(gig);
  if (reached === 0) return null;
  return (
    <ol aria-label="Gig progress" className="my-4 flex items-start">
      {PROGRESS_STEPS.map((label, index) => {
        const done = index < reached;
        const current = index === reached - 1;
        return (
          <li key={label} aria-current={current ? "step" : undefined} className="relative flex flex-1 flex-col items-center text-center">
            {index > 0 && <span aria-hidden="true" className={`absolute right-1/2 top-4 h-0.5 w-full -translate-y-1/2 ${done ? "bg-brand-600" : "bg-neutral-200"}`} />}
            <span className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${done ? "bg-brand-600 text-white" : "bg-neutral-200 text-neutral-500"} ${current ? "ring-4 ring-brand-200" : ""}`}>
              {done && !current ? "✓" : index + 1}
            </span>
            <span className={`mt-1 text-xs ${done ? "font-medium text-brand-800" : "text-neutral-500"}`}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
