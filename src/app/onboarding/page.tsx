"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import ProfileSetup from "@/components/ProfileSetup";
import { useAuth } from "@/lib/auth-context";
import { safeNext, servicesStepHref } from "@/lib/journey";

function OnboardingInner() {
  const { profile } = useAuth();
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  // Registration continues with the optional services step before going on to where the member was heading.
  const after = servicesStepHref(next);
  useEffect(() => { if (profile?.onboarding_completed_at) router.replace(after); }, [profile, router, after]);
  if (!profile || profile.onboarding_completed_at) return <p>Loading your journey…</p>;
  return <div className="mx-auto max-w-lg space-y-4"><h1 className="text-xl font-semibold">Finish your ESG profile</h1>
    <ProfileSetup key={profile.id} profile={profile} onFinish={() => router.replace(after)} /></div>;
}
export default function Onboarding() { return <AuthGuard><Suspense fallback={<p>Loading setup…</p>}><OnboardingInner /></Suspense></AuthGuard>; }
