"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

// Both landing options are public entry points. Authentication is requested
// only at the point an account is actually needed: Post a Gig (its own
// AuthGuard) and opening a specific gig (gigs/[id]'s AuthGuard).
function HomeInner() {
  // ESG-AUTH-004 v1.0 §10: Account Deleted confirmation, shown once on the
  // signed-out Home a deletion redirects to.
  const deleted = useSearchParams().get("accountDeleted") === "1";
  return (
    <div className="flex flex-col items-center gap-8 py-12 text-center">
      {deleted && (
        <p role="status" className="rounded-lg bg-neutral-100 px-4 py-2 text-sm text-neutral-700">
          Account Deleted — Your ESG account has been deleted.
        </p>
      )}
      <div>
        <h1 className="text-4xl font-bold text-emerald-700">ESG</h1>
        <p className="mt-2 text-neutral-600">Everything SideGig — post a gig, or find work nearby.</p>
      </div>
      <div className="grid w-full max-w-md gap-4 sm:grid-cols-2">
        <Link
          href="/need-help"
          className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <div className="mb-3 text-4xl" aria-hidden="true">🙋</div>
          <div className="font-semibold">I Need Help</div>
          <div className="mt-1 text-sm text-neutral-500">Post a gig or find a helper nearby.</div>
        </Link>
        <Link
          href="/browse"
          className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <div className="mb-3 text-4xl" aria-hidden="true">💪</div>
          <div className="font-semibold">Help &amp; Make Money</div>
          <div className="mt-1 text-sm text-neutral-500">Browse gigs nearby and start earning.</div>
        </Link>
      </div>
    </div>
  );
}

export default function Home() {
  return <Suspense><HomeInner /></Suspense>;
}
