"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import MyOfferedServices from "@/components/MyOfferedServices";
import { hasPromptedForLocation, loadJourneyLocation, markLocationPrompted } from "@/lib/location";

// Both landing options are public entry points. Authentication is requested
// only at the point an account is actually needed: Post a Gig (its own
// AuthGuard) and opening a specific gig (gigs/[id]'s AuthGuard).
function HomeInner() {
  const router = useRouter();
  // ESG-AUTH-004 v1.0 §10: Account Deleted confirmation, shown once on the
  // signed-out Home a deletion redirects to.
  const deleted = useSearchParams().get("accountDeleted") === "1";

  // First visit with no area set yet: ask once, up front, before either journey -- then continue
  // straight there. Once an area is set (or this has already run once), both links work as before.
  function goVia(event: React.MouseEvent, destination: string) {
    if (loadJourneyLocation().text || hasPromptedForLocation()) return;
    event.preventDefault();
    markLocationPrompted();
    router.push(`/location?next=${encodeURIComponent(destination)}`);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      {deleted && (
        <p role="status" className="rounded-lg bg-neutral-100 px-4 py-2 text-center text-sm text-neutral-700">
          Account Deleted — Your ESG account has been deleted.
        </p>
      )}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-600 to-brand-500 p-6 text-white shadow-lg shadow-brand-900/20">
        <div aria-hidden="true" className="absolute -right-8 -top-8 h-36 w-36 rounded-full bg-accent-400/30" />
        <div aria-hidden="true" className="absolute -bottom-10 right-10 h-24 w-24 rounded-full bg-white/10" />
        <h1 className="relative text-3xl font-extrabold leading-tight">Everything SideGig</h1>
        <p className="relative mt-2 max-w-[18rem] text-brand-50">Post a gig and get help nearby, or pick up work and start earning.</p>
      </section>
      <div className="grid gap-4">
        <Link
          href="/need-help"
          onClick={(event) => goVia(event, "/need-help")}
          className="group flex items-center gap-4 rounded-2xl border border-brand-100 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-3xl" aria-hidden="true">🙋</div>
          <div className="text-left">
            <div className="font-semibold">I Need Help</div>
            <div className="mt-0.5 text-sm text-neutral-500">Post a gig or find a helper nearby.</div>
          </div>
          <span aria-hidden="true" className="ml-auto text-xl text-brand-600 transition group-hover:translate-x-0.5">›</span>
        </Link>
        <Link
          href="/browse"
          onClick={(event) => goVia(event, "/browse")}
          className="group flex items-center gap-4 rounded-2xl border border-accent-100 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent-50 text-3xl" aria-hidden="true">💪</div>
          <div className="text-left">
            <div className="font-semibold">Help &amp; Make Money</div>
            <div className="mt-0.5 text-sm text-neutral-500">Browse gigs nearby and start earning.</div>
          </div>
          <span aria-hidden="true" className="ml-auto text-xl text-accent-700 transition group-hover:translate-x-0.5">›</span>
        </Link>
      </div>
      <MyOfferedServices />
      <section aria-label="How it works" className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">How it works</h2>
        <ol className="mt-3 grid grid-cols-3 gap-2 text-center text-sm">
          {[["1", "Post", "Describe the gig"], ["2", "Match", "Pick your helper"], ["3", "Done", "Rate each other"]].map(([n, title, hint]) => (
            <li key={n} className="space-y-1">
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 font-bold text-brand-800">{n}</div>
              <div className="font-medium">{title}</div>
              <div className="text-xs text-neutral-500">{hint}</div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export default function Home() {
  return <Suspense><HomeInner /></Suspense>;
}
