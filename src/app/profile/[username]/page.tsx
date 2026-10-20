"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import HelperSignInPrompt from "@/components/HelperSignInPrompt";
import TagChip from "@/components/TagChip";
import { useAuth } from "@/lib/auth-context";
import { findHelperHref, helperProfileHref } from "@/lib/journey";
import { postRequestHref, requestableCategories } from "@/lib/helper-request";
import { SERVICE_TYPES } from "@/lib/services";
import { createClient } from "@/lib/supabase/client";
import { profileTagsForCategory, withProfileTags } from "@/lib/tags";
import type { PublicProfile, PublicProfileWithTags } from "@/lib/database.types";

function PublicProfileView({ username }: { username: string }) {
  const supabase = createClient();
  const { user, loading: authLoading } = useAuth();
  // Search context carried from Find a Helper (and through sign-in): where "Back" goes.
  const params = useSearchParams();
  const category = params.get("category");
  const fromFinder = params.get("from") === "find-helper";
  const [profile, setProfile] = useState<PublicProfileWithTags | null | undefined>(undefined);
  const [gigsWorked, setGigsWorked] = useState<number | null>(null);
  // Lemon count (the other half of this ratio) is private and never leaves
  // get_public_stats() -- only the pre-computed percentage does. ESG-FDBK-001.
  const [womPercentage, setWomPercentage] = useState<number | null>(null);

  useEffect(() => {
    // Defense in depth: src/proxy.ts already keeps signed-out requests away from this
    // route. If a session ends while the page is open, nothing is fetched or shown.
    if (authLoading || !user) return;
    supabase
      .from("public_profiles")
      .select("*")
      .eq("username", username)
      .maybeSingle()
      .then(async ({ data }) => {
        if (!data) { setProfile(null); return; }
        // A tag lookup failure must not hide the profile itself.
        const [withTags] = await withProfileTags(supabase, [data as PublicProfile]).catch(() => [{ ...(data as PublicProfile), profile_tags: [] }]);
        setProfile(withTags);
        const { data: stats } = await supabase.rpc("get_public_stats", { p_profile_id: data.id });
        setGigsWorked(stats?.[0]?.gigs_worked_count ?? 0);
        setWomPercentage(stats?.[0]?.wom_percentage ?? null);
      });
  }, [supabase, username, authLoading, user]);

  if (!authLoading && !user) {
    return (
      <div className="mx-auto max-w-md space-y-3">
        <h1 className="text-xl font-semibold">Sign in to view @{username}</h1>
        <HelperSignInPrompt username={username} destination={helperProfileHref(username, category) ?? "/find-helper"}
          browseHref={findHelperHref(category, SERVICE_TYPES)} />
      </div>
    );
  }

  if (profile === undefined) return <p className="text-neutral-500">Loading…</p>;
  if (profile === null) return <p className="text-neutral-500">User not found.</p>;

  return (
    <div className="mx-auto max-w-lg space-y-5">
      {fromFinder && (
        <Link href={findHelperHref(category, SERVICE_TYPES)} className="touch-link text-sm font-medium text-emerald-700">← Back to Find a Helper</Link>
      )}
      <div className="flex items-center gap-4">
        {profile.photo_url ? (
          <img src={profile.photo_url} alt="" className="h-16 w-16 shrink-0 rounded-full object-cover" />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xl">👤</div>
        )}
        <div className="min-w-0 flex-1 truncate text-lg font-semibold">@{profile.username}</div>
        {/* Another member's profile only: a private request to this helper (never shown on your own). */}
        {user && profile.id !== user.id && (
          <Link href={postRequestHref(profile.username, requestableCategories(profile.skills, SERVICE_TYPES).includes(category ?? "") ? category : null)}
            aria-label={`Post a Gig for @${profile.username}`} title="Send this helper a private request"
            className="flex min-h-11 shrink-0 items-center rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700">
            Post a Gig
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-lg border border-neutral-200 bg-white p-3">
          <div className="text-lg font-semibold">{womPercentage != null ? `${womPercentage}%` : "—"}</div>
          <div className="text-xs text-neutral-500">WOM% ({profile.wom_count})</div>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-3">
          <div className="text-lg font-semibold">{gigsWorked ?? "—"}</div>
          <div className="text-xs text-neutral-500">Gigs Worked</div>
        </div>
      </div>

      {profile.skills.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-medium text-neutral-500">Skills</h3>
          <div className="flex flex-wrap gap-2">
            {profile.skills.map((s) => (
              <span key={s} className="rounded-full bg-neutral-100 px-3 py-1 text-sm">
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {profile.skills.some((s) => profileTagsForCategory(profile, s).length > 0) && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-neutral-500">Specializations</h3>
          {profile.skills.map((skill) => {
            const tags = profileTagsForCategory(profile, skill);
            if (tags.length === 0) return null;
            return (
              <div key={skill}>
                <div className="text-xs font-medium uppercase tracking-wide text-emerald-700">{skill}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {tags.map((tag) => <TagChip key={tag.id}>{tag.name}</TagChip>)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function PublicProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params);
  return <PublicProfileView username={username} />;
}
