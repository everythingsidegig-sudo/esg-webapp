"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import NotificationsBell from "@/components/NotificationsBell";
import { useRef, useState } from "react";
import { LOCATION_KEY } from "@/lib/location";

export default function Nav() {
  const { user, profile, loading } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const router = useRouter();
  const supabase = createClient();

  async function signOut() {
    if (pending.current) return;
    pending.current = true; setSigningOut(true); setError(null);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      try { sessionStorage.removeItem(LOCATION_KEY); } catch {}
      router.replace("/");
    } catch { setError("Couldn't log out. Check your connection and retry."); }
    finally { pending.current = false; setSigningOut(false); }
  }

  return (
    <nav className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
      <div className="flex items-center gap-4">
        <Link href="/" className="text-lg font-bold text-emerald-700">
          ESG
        </Link>
        {user && (
          <>
            <Link href="/browse" className="text-sm text-neutral-600 hover:text-neutral-900">
              Find Gigs
            </Link>
            <Link href="/post" className="text-sm text-neutral-600 hover:text-neutral-900">
              Post a Gig
            </Link>
            <Link href="/my-gigs" className="text-sm text-neutral-600 hover:text-neutral-900">
              Activity
            </Link>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        {user ? (
          <>
            <NotificationsBell />
            <Link href="/profile" className="text-sm text-neutral-600 hover:text-neutral-900">
              @{profile?.username ?? "profile"}
            </Link>
            <button disabled={signingOut} onClick={signOut} className="text-sm text-neutral-500 hover:text-neutral-900">
              {signingOut ? "Logging out…" : "Log out"}
            </button>
          </>
        ) : loading ? <span className="text-sm">Loading…</span> : (
          <Link href="/auth/sign-in" className="text-sm font-medium text-emerald-700">
            Sign In
          </Link>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </nav>
  );
}
