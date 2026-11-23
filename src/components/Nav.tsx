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
    <nav aria-label="Primary" className="pointer-events-none fixed inset-x-0 bottom-0 z-30 overflow-visible px-3 pb-[env(safe-area-inset-bottom)]">
      {/* Floating plum bar. overflow-visible (here and on every tab) lets the active icon bubble pop up past the top edge. */}
      <div className="pointer-events-auto mx-auto mb-3 flex h-[68px] max-w-md overflow-visible rounded-[24px] bg-[#2b1449] shadow-xl shadow-[#2b1449]/30">
        {destinations.map(({ label, href, icon }) => {
          const active = href === "/" ? currentPath === "/" || currentPath === "/location" : currentPath === href || !!currentPath?.startsWith(`${href}/`);
          return <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className="relative block h-[68px] flex-1 overflow-visible"
          >
            {/* Every tab has the same 42px circle in the same spot. Active: it lifts and grows on a spring curve, turns
                white with a purple icon, and gets a page-coloured ring that reads as a cut-out notch in the bar. */}
            <span
              className={`absolute left-1/2 top-[3px] -ml-[21px] flex h-[42px] w-[42px] items-center justify-center rounded-full border-4 transition-[transform,background-color,border-color,color] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none ${
                active ? "-translate-y-[22px] scale-[1.12] border-[#f7f5fa] bg-white text-[#5b2ca0] shadow-md" : "border-transparent bg-transparent text-[#a996c4]"
              }`}
            >
              <Icon name={icon} className="h-6 w-6" strokeWidth={active ? 2.4 : 2} />
            </span>
            {/* Labels are pinned to the same offset with the same size and weight, so they stay on one straight baseline. */}
            <span
              className={`absolute inset-x-0 bottom-[9px] text-center text-xs font-semibold leading-none transition-colors ${active ? "text-white [text-shadow:0_0_8px_rgba(255,255,255,0.55)]" : "text-[#a996c4]"}`}
            >{label}</span>
          </Link>;
        })}
      </div>
    </nav>
  </>;
}
