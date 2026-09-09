"use client";

import { Suspense, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

function AuthGuardInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!loading && !user) {
      const next = encodeURIComponent(`${pathname}?${searchParams.toString()}`);
      router.replace(`/auth/sign-in?next=${next}`);
    }
  }, [loading, user, pathname, searchParams, router]);

  if (loading || !user) {
    return <div className="p-8 text-center text-neutral-500">Loading…</div>;
  }

  return <>{children}</>;
}

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="p-8 text-center text-neutral-500">Loading…</div>}>
      <AuthGuardInner>{children}</AuthGuardInner>
    </Suspense>
  );
}
