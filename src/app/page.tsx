"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import HowItWorks from "@/components/HowItWorks";
import Icon from "@/components/Icon";
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
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-800 via-brand-700 to-brand-500 p-6 text-white shadow-lg shadow-brand-900/20">
        {/* Soft mesh + a faint dot grid give the banner depth without a busy picture. */}
        <div aria-hidden="true" className="absolute -right-10 -top-10 h-44 w-44 rounded-full bg-brand-300/30 blur-2xl" />
        <div aria-hidden="true" className="absolute -bottom-12 left-6 h-32 w-32 rounded-full bg-accent-400/25 blur-2xl" />
        <div aria-hidden="true" className="absolute inset-0 opacity-[0.12]" style={{ backgroundImage: "radial-gradient(circle, #fff 1px, transparent 1.5px)", backgroundSize: "18px 18px" }} />
        <h1 className="relative text-3xl font-extrabold leading-tight">Everything SideGig</h1>
        <p className="relative mt-3 max-w-[19rem] leading-relaxed text-white/95">Post a gig and get help nearby, or pick up work and start earning.</p>
      </section>
      <div className="grid gap-4">
        <Link
          href="/need-help"
          onClick={(event) => goVia(event, "/need-help")}
          className="flex items-center gap-4 rounded-3xl border border-neutral-200 bg-white p-5 shadow-md shadow-brand-900/5 transition hover:-translate-y-0.5 hover:shadow-lg"
        >
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-100 text-brand-700"><Icon name="hand" className="h-7 w-7" /></span>
          <div className="min-w-0 flex-1 text-left">
            <div className="text-lg font-extrabold text-neutral-900">I Need Help</div>
            <div className="mt-0.5 leading-snug text-neutral-700">Post a gig or find a helper nearby.</div>
          </div>
          <Icon name="chevron" className="h-5 w-5 shrink-0 text-brand-700" strokeWidth={2.5} />
        </Link>
        <Link
          href="/browse"
          onClick={(event) => goVia(event, "/browse")}
          className="flex items-center gap-4 rounded-3xl border border-neutral-200 bg-white p-5 shadow-md shadow-brand-900/5 transition hover:-translate-y-0.5 hover:shadow-lg"
        >
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-100 text-brand-700"><Icon name="wallet" className="h-7 w-7" /></span>
          <div className="min-w-0 flex-1 text-left">
            <div className="text-lg font-extrabold text-neutral-900">Help &amp; Make Money</div>
            <div className="mt-0.5 leading-snug text-neutral-700">Browse gigs nearby and start earning.</div>
          </div>
          <Icon name="chevron" className="h-5 w-5 shrink-0 text-brand-700" strokeWidth={2.5} />
        </Link>
      </div>
      <HowItWorks />
    </div>
  );
}

export default function Home() {
  return <Suspense><HomeInner /></Suspense>;
}
