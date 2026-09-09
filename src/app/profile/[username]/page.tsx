"use client";

import { use, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { PublicProfile } from "@/lib/database.types";

function PublicProfileView({ username }: { username: string }) {
  const supabase = createClient();
  const [profile, setProfile] = useState<PublicProfile | null | undefined>(undefined);
  const [gigsWorked, setGigsWorked] = useState<number | null>(null);

  useEffect(() => {
    supabase
      .from("public_profiles")
      .select("*")
      .eq("username", username)
      .maybeSingle()
      .then(async ({ data }) => {
        setProfile((data as PublicProfile) ?? null);
        if (data) {
          const { data: stats } = await supabase.rpc("get_public_stats", { p_profile_id: data.id });
          setGigsWorked(stats?.[0]?.gigs_worked_count ?? 0);
        }
      });
  }, [supabase, username]);

  if (profile === undefined) return <p className="text-neutral-500">Loading…</p>;
  if (profile === null) return <p className="text-neutral-500">User not found.</p>;

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <div className="flex items-center gap-4">
        {profile.photo_url ? (
          <img src={profile.photo_url} alt="" className="h-16 w-16 rounded-full object-cover" />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-200 text-xl">👤</div>
        )}
        <div className="text-lg font-semibold">@{profile.username}</div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-lg border border-neutral-200 bg-white p-3">
          <div className="text-lg font-semibold">{profile.wom_count}</div>
          <div className="text-xs text-neutral-500">WOM</div>
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
    </div>
  );
}

export default function PublicProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params);
  return <PublicProfileView username={username} />;
}
