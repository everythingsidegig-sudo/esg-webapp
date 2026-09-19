"use client";

import { Suspense, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { setupDestination } from "@/lib/journey";

function AuthGuardInner({ children }: { children: React.ReactNode }) {
  const { user, loading, profile, profileLoading, profileError, refreshProfile } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requiresOnboarding = pathname === "/post" || pathname === "/location";

  useEffect(() => {
    if (!loading && !user) {
      const next = encodeURIComponent(`${pathname}${searchParams.size ? `?${searchParams.toString()}` : ""}`);
      router.replace(`/auth/sign-in?next=${next}`);
    } else if (!loading && user && !profileLoading && profile && !profile.onboarding_completed_at && requiresOnboarding) {
      router.replace(setupDestination(`${pathname}${searchParams.size ? `?${searchParams.toString()}` : ""}`));
    }
  }, [loading, user, profileLoading, profile, pathname, searchParams, router, requiresOnboarding]);

  if (loading || !user) {
    return <div className="p-8 text-center text-neutral-500">Loading…</div>;
  }

  if (profileError && !profile) return <div role="alert">{profileError} <button onClick={() => void refreshProfile().catch(() => {})}>Retry</button></div>;
  if (!profile || (requiresOnboarding && !profile.onboarding_completed_at)) return <p>Loading your profile…</p>;

  return <>
    {profileError && <div role="alert">{profileError} <button onClick={() => void refreshProfile().catch(() => {})}>Retry</button></div>}
    {children}
  </>;
}

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="p-8 text-center text-neutral-500">Loading…</div>}>
      <AuthGuardInner>{children}</AuthGuardInner>
    </Suspense>
  );
}
