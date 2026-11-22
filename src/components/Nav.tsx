"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import GigUpdatesBell from "@/components/GigUpdatesBell";
import Icon from "@/components/Icon";
import MessagesLink from "@/components/MessagesLink";
import LogoutButton from "@/components/LogoutButton";

export default function Nav() {
  const { user, loading } = useAuth();
  const pathname = usePathname();

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

    {user && <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 mx-auto grid w-full grid-cols-4 border-t border-neutral-200 bg-white/95 px-2 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_30px_rgba(15,23,42,0.08)] backdrop-blur-md md:bottom-4 md:max-w-lg md:rounded-2xl md:border md:px-3 md:shadow-xl">
      {destinations.map(({ label, href, icon }) => {
        const active = href === "/" ? pathname === "/" || pathname === "/location" : pathname === href || pathname.startsWith(`${href}/`);
        return <Link
          key={href}
          href={href}
          aria-current={active ? "page" : undefined}
          className={`mx-0.5 my-1 flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-xs font-semibold transition-colors ${active ? "bg-brand-800 text-white" : "text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900"}`}
        >
          <Icon name={icon} className="h-6 w-6" strokeWidth={active ? 2.4 : 2} />
          <span>{label}</span>
        </Link>;
      })}
    </nav>}
  </>;
}
