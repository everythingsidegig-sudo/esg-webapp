"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import GigUpdatesBell from "@/components/GigUpdatesBell";
import Icon from "@/components/Icon";
import MessagesLink from "@/components/MessagesLink";
import LogoutButton from "@/components/LogoutButton";

// On the sign-in screen a signed-out visitor was sent to from My Gigs or Profile, the address carries
// ?next=/my-gigs (or /profile): that tab stays highlighted so the bar still shows where they were headed.
// Read from the address bar (not useSearchParams) so the layout needs no Suspense boundary.
const noSubscription = () => () => {};
function useNextPath(): string | null {
  const search = useSyncExternalStore(noSubscription, () => (typeof window === "undefined" ? "" : window.location.search), () => "");
  const next = new URLSearchParams(search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next.split(/[?#]/)[0] : null;
}

export default function Nav() {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const nextPath = useNextPath();
  // While signing in, the tab the visitor was heading to counts as the current one.
  const currentPath = pathname?.startsWith("/auth") && nextPath ? nextPath : pathname;

  const destinations = [
    { label: "Home", href: "/", icon: "home" },
    { label: "Explore", href: "/browse", icon: "search" },
    { label: "My Gigs", href: "/my-gigs", icon: "gigs" },
    { label: "Profile", href: "/profile", icon: "profile" },
  ] as const;

  return <>
    <header className="sticky top-0 z-30 border-b border-neutral-200/80 bg-white/90 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <div className="mx-auto flex h-[var(--app-bar-height)] w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex min-h-11 items-center font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-brand-700" aria-label="ESG home">
          ESG
        </Link>
        <div className="flex min-h-11 items-center gap-2 sm:gap-3">
          {user ? <>
            <MessagesLink />
            <GigUpdatesBell />
            <LogoutButton className="hidden min-h-11 rounded-full px-3 text-sm font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-60 sm:inline-flex sm:items-center" />
          </> : loading ? <span className="px-2 text-sm text-neutral-500">Loading…</span> : (
            <Link href="/auth/sign-in" className="flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-brand-700 hover:bg-brand-50">
              Sign In
            </Link>
          )}
        </div>
      </div>
    </header>

    {/* Shown to everyone, on every screen (including sign-in and sign-up): the landing page and Explore are
        public, and My Gigs and Profile send a signed-out visitor to sign in with the bar still in view. */}
    <nav aria-label="Primary" className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-3 pb-[env(safe-area-inset-bottom)]"><div className="pointer-events-auto mx-auto mb-3 grid max-w-md grid-cols-4 gap-1 rounded-3xl bg-brand-900 p-1.5 shadow-xl shadow-brand-900/30 ring-1 ring-white/10">
      {destinations.map(({ label, href, icon }) => {
        const active = href === "/" ? currentPath === "/" || currentPath === "/location" : currentPath === href || !!currentPath?.startsWith(`${href}/`);
        return <Link
          key={href}
          href={href}
          aria-current={active ? "page" : undefined}
          className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-xs font-semibold transition-colors ${active ? "bg-brand-100 text-brand-800" : "text-brand-200 hover:bg-white/10 hover:text-white"}`}
        >
          <Icon name={icon} className="h-6 w-6" strokeWidth={active ? 2.4 : 2} />
          <span>{label}</span>
        </Link>;
      })}
    </div></nav>
  </>;
}
