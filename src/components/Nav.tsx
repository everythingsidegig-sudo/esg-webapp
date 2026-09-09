"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import NotificationsBell from "@/components/NotificationsBell";

export default function Nav() {
  const { user, profile } = useAuth();
  const router = useRouter();
  const supabase = createClient();

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/");
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
              My Gigs
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
            <button onClick={signOut} className="text-sm text-neutral-500 hover:text-neutral-900">
              Log out
            </button>
          </>
        ) : (
          <Link href="/auth/sign-in" className="text-sm font-medium text-emerald-700">
            Sign In
          </Link>
        )}
      </div>
    </nav>
  );
}
