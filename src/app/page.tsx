"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";

export default function Home() {
  const { user } = useAuth();

  return (
    <div className="flex flex-col items-center gap-8 py-12 text-center">
      <div>
        <h1 className="text-4xl font-bold text-emerald-700">ESG</h1>
        <p className="mt-2 text-neutral-600">Everything SideGig — post a gig, or find work nearby.</p>
      </div>
      <div className="grid w-full max-w-md gap-4 sm:grid-cols-2">
        <Link
          href="/location?journey=need_help"
          className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <div className="text-2xl">🙋</div>
          <div className="mt-2 font-semibold">I Need Help</div>
          <div className="mt-1 text-sm text-neutral-500">Post a gig and get it done</div>
        </Link>
        <Link
          href="/location?journey=earn_money"
          className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <div className="text-2xl">💪</div>
          <div className="mt-2 font-semibold">Help and Earn Money</div>
          <div className="mt-1 text-sm text-neutral-500">Find gigs nearby</div>
        </Link>
      </div>
      {!user && (
        <p className="text-sm text-neutral-500">
          Browsing works as a guest —{" "}
          <Link href="/auth/sign-in" className="font-medium text-emerald-700">
            sign in
          </Link>{" "}
          only when you post or select a provider.
        </p>
      )}
    </div>
  );
}
