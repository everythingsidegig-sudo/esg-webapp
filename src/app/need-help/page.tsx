import Link from "next/link";

export default function NeedHelp() {
  return (
    <div className="mx-auto max-w-md space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold">I Need Help</h1>
        <p className="mt-1 text-neutral-700">Post a gig and let people nearby offer to help.</p>
      </div>

      <div className="grid gap-4">
        <Link
          href="/post"
          className="flex items-center gap-4 rounded-3xl border border-neutral-200 bg-white p-5 shadow-md shadow-brand-900/5 transition hover:-translate-y-0.5 hover:shadow-lg"
        >
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-100 text-3xl" aria-hidden="true">📝</span>
          <div className="min-w-0 flex-1 text-left">
            <div className="text-lg font-extrabold text-neutral-900">Post a Gig</div>
            <div className="mt-0.5 leading-snug text-neutral-700">Create a gig and let people nearby offer to help.</div>
          </div>
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-brand-700" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
        </Link>
      </div>
    </div>
  );
}
