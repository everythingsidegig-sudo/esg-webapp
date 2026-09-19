"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { setupDestination } from "@/lib/journey";

export default function Home() {
  const { user, profile, loading, profileLoading, profileError } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user && !profileLoading && profile) {
      router.replace(profile.onboarding_completed_at ? "/location" : setupDestination("/location"));
    }
  }, [loading, user, profileLoading, profile, router]);

  if (loading || user) {
    return <div className="py-12 text-center text-neutral-500">
      {profileError && !profile ? profileError : "Preparing your journey…"}
    </div>;
  }

  return (
    <div className="flex flex-col items-center gap-8 py-12 text-center">
      <div>
        <h1 className="text-4xl font-bold text-emerald-700">ESG</h1>
        <p className="mt-2 text-neutral-600">Everything SideGig — post a gig, or find work nearby.</p>
      </div>
      <div className="grid w-full max-w-md gap-4 sm:grid-cols-2">
        <Link
          href="/auth/sign-in"
          className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <div className="font-semibold">Sign In</div>
          <div className="mt-1 text-sm text-neutral-500">Continue with your ESG account.</div>
        </Link>
        <Link
          href="/auth/sign-up"
          className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <div className="font-semibold">Create Account</div>
          <div className="mt-1 text-sm text-neutral-500">Join ESG and set up your profile.</div>
        </Link>
      </div>
    </div>
  );
}
