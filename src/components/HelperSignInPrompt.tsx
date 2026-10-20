"use client";

import Link from "next/link";
import { rememberAuthDestination } from "@/lib/journey";
import { rememberAreaForAuth } from "@/lib/location";

// What a signed-out visitor sees instead of a helper's profile. Used inside a
// sheet on the Find a Helper list and inline on the profile page itself.
//   Log in          -> Sign In, returning to this profile afterwards (validated `next`)
//   Create account  -> registration; the profile is remembered briefly so the new
//                      account can land on it (registration itself is unchanged)
// Both also keep the searched area (rounded, no address) for a short while, so the search is
// still there when the visitor comes back, even through an email link opened in a new tab.
//   Continue browsing -> back to the helper list (a callback when already on it)
export default function HelperSignInPrompt({ username, destination, browseHref = "/find-helper", onContinueBrowsing }: {
  username: string;
  destination: string;
  browseHref?: string;
  onContinueBrowsing?: () => void;
}) {
  const action = "flex min-h-11 w-full items-center justify-center rounded-lg px-4 py-2.5 text-center font-medium";
  return (
    <div role="group" aria-label={`Sign in to view @${username}`} className="space-y-3 px-3 pb-3 pt-1">
      <p className="text-sm text-neutral-600">
        Helper profiles are for ESG members. Sign in or create a free account to view @{username}&apos;s profile.
      </p>
      <Link href={`/auth/sign-in?next=${encodeURIComponent(destination)}`} onClick={() => { rememberAreaForAuth(); }} className={`${action} bg-emerald-600 text-white hover:bg-emerald-700`}>
        Log in
      </Link>
      <Link href="/auth/sign-up" onClick={() => { rememberAuthDestination(destination); rememberAreaForAuth(); }} className={`${action} border border-emerald-600 text-emerald-700 hover:bg-emerald-50`}>
        Create account
      </Link>
      {onContinueBrowsing
        ? <button type="button" onClick={onContinueBrowsing} className={`${action} text-neutral-600 hover:bg-neutral-100`}>Continue browsing</button>
        : <Link href={browseHref} className={`${action} text-neutral-600 hover:bg-neutral-100`}>Continue browsing</Link>}
    </div>
  );
}
