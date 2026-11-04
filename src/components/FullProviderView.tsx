"use client";

import { useState } from "react";
import Link from "next/link";
import TagChip from "@/components/TagChip";
import { profileTagsForCategory } from "@/lib/tags";
import { resolveSwipe } from "@/lib/swipe";
import type { ProviderStats } from "@/components/ProviderCard";
import type { PublicProfileWithTags } from "@/lib/database.types";

// Find Help Profile Swiping v1.0, "Full Profile": opened via View Full Profile without leaving
// the deck (rendered as an overlay by the caller, same pattern as FullGigView). Preserves Send
// Gig/Skip without ever sending anything merely by being opened (spec section 6).
export default function FullProviderView({
  profile,
  category,
  distanceKm,
  stats,
  disabled,
  onClose,
  onSendGig,
  onSkip,
}: {
  profile: PublicProfileWithTags;
  category: string;
  distanceKm?: number;
  stats: ProviderStats | null;
  disabled?: boolean;
  onClose: () => void;
  onSendGig: () => void;
  onSkip: () => void;
}) {
  // Not a shared hook (deliberately): pointer handling is simple enough to duplicate between
  // this view and ProviderCard, and both need their own useState bound to their own render.
  const [drag, setDrag] = useState<{ x: number; y: number; startX: number; startY: number } | null>(null);
  function onPointerDown(e: React.PointerEvent) {
    if (disabled) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ x: 0, y: 0, startX: e.clientX, startY: e.clientY });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    setDrag({ ...drag, x: e.clientX - drag.startX, y: e.clientY - drag.startY });
  }
  function settle() {
    if (!drag) return;
    const decision = resolveSwipe(drag.x, drag.y);
    setDrag(null);
    if (decision === "accept") onSendGig();
    else if (decision === "reject") onSkip();
  }
  const dragX = drag?.x ?? 0;
  const feedback = dragX > 24 ? "send" : dragX < -24 ? "skip" : null;

  const tags = profileTagsForCategory(profile, category);
  const offered = [...new Set(profile.skills ?? [])];
  const womLabel = stats?.womPercentage != null ? `${stats.womPercentage}%` : "Not available";
  const completedLabel = stats ? stats.gigsWorkedCount : "Not available";

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" role="dialog" aria-label="Full provider profile">
      <div
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={settle} onPointerCancel={() => setDrag(null)}
        style={{ touchAction: "pan-y", transform: drag ? `translateX(${dragX}px) rotate(${dragX / 24}deg)` : undefined }}
        className="relative max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
      >
        {feedback && (
          <div className={`pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white px-4 py-1.5 text-base font-bold uppercase tracking-wide shadow-md ${
            feedback === "send" ? "border-emerald-500 text-emerald-600" : "border-red-500 text-red-600"
          }`}>
            {feedback === "send" ? "Send Gig" : "Skip"}
          </div>
        )}

        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            {profile.photo_url ? (
              <img src={profile.photo_url} alt="" className="h-16 w-16 shrink-0 rounded-full object-cover" />
            ) : (
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xl">👤</div>
            )}
            <div>
              <h2 className="text-xl font-semibold">@{profile.username}</h2>
              <p className="text-sm text-neutral-500">{distanceKm != null ? `${distanceKm.toFixed(1)} km away` : "Distance: Not available"}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Back to profiles" className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
            Back
          </button>
        </div>

        <section aria-label="Trust" className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>👍 {womLabel} WOM</span>
          <span>✅ {completedLabel} gigs completed</span>
          <span>🪪 ID Verified: Not available</span>
        </section>

        {tags.length > 0 && (
          <section aria-label="Specializations">
            <h3 className="text-sm font-medium text-neutral-500">Specializations</h3>
            <div className="mt-1 flex flex-wrap gap-1.5">{tags.map((tag) => <TagChip key={tag.id}>{tag.name}</TagChip>)}</div>
          </section>
        )}

        {offered.length > 0 && (
          <section aria-label="Services offered">
            <h3 className="text-sm font-medium text-neutral-500">Services offered</h3>
            <p className="mt-1 text-sm text-neutral-700">{offered.join(" · ")}</p>
          </section>
        )}

        <p className="text-sm text-neutral-500">Typical rate: Not available</p>

        <Link href={`/profile/${profile.username}`} className="block text-sm font-medium text-emerald-700 hover:underline">View public profile page →</Link>

        <div className="flex gap-2 pt-1">
          <button type="button" disabled={disabled} onClick={onSkip} className="flex-1 rounded-lg border border-neutral-300 bg-white py-2.5 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60">Skip</button>
          <button type="button" disabled={disabled} onClick={onSendGig} className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">Send Gig</button>
        </div>
      </div>
    </div>
  );
}
