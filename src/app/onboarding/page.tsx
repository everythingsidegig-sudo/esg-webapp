"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import { useAuth } from "@/lib/auth-context";
import { safeNext } from "@/lib/journey";

// Registration now lives in one place: the /auth/register steps (Username, Password, Photo, Phone,
// Terms), then the categorized services screen. This old route no longer collects anything of its
// own (it used to repeat the username and show the retired flat services list); it only sends
// each visitor on: an unfinished account back into registration, a finished one to where they were heading.
function OnboardingInner() {
  const { profile } = useAuth();
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  useEffect(() => {
    if (profile) router.replace(profile.onboarding_completed_at ? next : "/auth/register");
  }, [profile, router, next]);
  return <p>Loading your journey…</p>;
}
export default function Onboarding() { return <AuthGuard><Suspense fallback={<p>Loading setup…</p>}><OnboardingInner /></Suspense></AuthGuard>; }
