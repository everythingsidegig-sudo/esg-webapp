"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import NotificationsBell from "@/components/NotificationsBell";
import MessagesLink from "@/components/MessagesLink";
import LogoutButton from "@/components/LogoutButton";

export default function Nav() {
  const { user, loading } = useAuth();
  const pathname = usePathname();

  const destinations = [
    { label: "Home", href: "/location", icon: "⌂" },
    { label: "Explore", href: "/browse", icon: "⌕" },
    { label: "My Gigs", href: "/my-gigs", icon: "◷" },
    { label: "Profile", href: "/profile", icon: "○" },
  ];

  return <>
    <header className="sticky top-0 z-30 border-b border-neutral-200/80 bg-white/90 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <div className="mx-auto flex h-[var(--app-bar-height)] w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex min-h-11 items-center text-xl font-extrabold tracking-tight text-emerald-700" aria-label="ESG home">
          ESG
        </Link>
        <div className="flex min-h-11 items-center gap-1 sm:gap-2">
          {user ? <>
            <MessagesLink />
            <NotificationsBell />
            <LogoutButton className="hidden min-h-11 rounded-full px-3 text-sm font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-60 sm:inline-flex sm:items-center" />
          </> : loading ? <span className="px-2 text-sm text-neutral-500">Loading…</span> : (
            <Link href="/auth/sign-in" className="flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50">
              Sign In
            </Link>
          )}
        </div>
      </div>
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
