"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { setupDestination } from "@/lib/journey";

// Unauthenticated: send them through the existing sign-in flow, preserving
// which journey they picked via the same `next` param AuthGuard already uses.
// Authenticated + onboarded: go straight to the journey. Authenticated but
// not yet onboarded: setupDestination() (used everywhere else) forwards them
// through the existing onboarding flow and back out to the journey after.
function journeyHref(user: unknown, onboardingCompletedAt: string | null | undefined, destination: string) {
  if (!user) return `/auth/sign-in?next=${encodeURIComponent(destination)}`;
  return onboardingCompletedAt ? destination : setupDestination(destination);
}

export default function Home() {
  const { user, profile, loading } = useAuth();

  if (loading) {
    return <div className="py-12 text-center text-neutral-500">Preparing your journey…</div>;
  }

  // I Need Help itself requires no auth/onboarding: it only shows a choice
  // between Post a Gig (its own AuthGuard gates that) and Find a Helper
  // (public browsing, no auth needed at all). Gating the destinations
  // individually -- not this landing link -- is what lets an anonymous
  // visitor browse helpers without ever hitting sign-in.
  const needHelpHref = "/need-help";
  const helpMoneyHref = journeyHref(user, profile?.onboarding_completed_at, "/browse");

  return (
    <div className="flex flex-col items-center gap-8 py-12 text-center">
      <div>
        <h1 className="text-4xl font-bold text-emerald-700">ESG</h1>
        <p className="mt-2 text-neutral-600">Everything SideGig — post a gig, or find work nearby.</p>
      </div>
      <div className="grid w-full max-w-md gap-4 sm:grid-cols-2">
        <Link
          href={needHelpHref}
          className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <div className="font-semibold">I Need Help</div>
          <div className="mt-1 text-sm text-neutral-500">Post a gig or find a helper nearby.</div>
        </Link>
        <Link
          href={helpMoneyHref}
          className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <div className="font-semibold">Help &amp; Make Money</div>
          <div className="mt-1 text-sm text-neutral-500">Browse gigs nearby and start earning.</div>
        </Link>
      </div>
    </div>
  );
}
