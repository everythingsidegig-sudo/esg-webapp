"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
  const pathname = usePathname();
  const supabase = createClient();

  const destinations = [
    { label: "Home", href: "/location", icon: "⌂" },
    { label: "Explore", href: "/browse", icon: "⌕" },
    { label: "Activity", href: "/my-gigs", icon: "◷" },
    { label: "Profile", href: "/profile", icon: "○" },
  ];

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

  return <>
    <header className="sticky top-0 z-30 border-b border-neutral-200/80 bg-white/90 backdrop-blur-md">
      <div className="mx-auto flex h-[var(--app-bar-height)] w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex min-h-11 items-center text-xl font-extrabold tracking-tight text-emerald-700" aria-label="ESG home">
          ESG
        </Link>
        <div className="flex min-h-11 items-center gap-1 sm:gap-2">
          {user ? <>
            <NotificationsBell />
            <Link href="/profile" className="hidden min-h-11 items-center rounded-full px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-100 sm:flex">
              @{profile?.username ?? "profile"}
            </Link>
            <button disabled={signingOut} onClick={signOut} className="min-h-11 rounded-full px-3 text-sm font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-60">
              {signingOut ? "Logging out…" : "Log out"}
            </button>
          </> : loading ? <span className="px-2 text-sm text-neutral-500">Loading…</span> : (
            <Link href="/auth/sign-in" className="flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50">
              Sign In
            </Link>
          )}
        </div>
      </div>
      {error && <p role="alert" className="border-t border-red-100 bg-red-50 px-4 py-2 text-center text-sm text-red-700">{error}</p>}
    </header>

    {user && <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 mx-auto grid w-full grid-cols-4 border-t border-neutral-200 bg-white/95 px-2 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_30px_rgba(15,23,42,0.08)] backdrop-blur-md md:bottom-4 md:max-w-lg md:rounded-2xl md:border md:px-3 md:shadow-xl">
      {destinations.map(({ label, href, icon }) => {
        const active = pathname === href || (href !== "/location" && pathname.startsWith(`${href}/`));
        return <Link
          key={href}
          href={href}
          aria-current={active ? "page" : undefined}
          className={`flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-xs font-medium transition-colors ${active ? "text-emerald-700" : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900"}`}
        >
          <span aria-hidden="true" className="text-xl leading-none">{icon}</span>
          <span>{label}</span>
        </Link>;
      })}
    </nav>}
  </>;
}
