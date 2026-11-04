"use client";

import { useRef, useState } from "react";
import TagChip from "@/components/TagChip";
import { profileTagsForCategory } from "@/lib/tags";
import { resolveSwipe } from "@/lib/swipe";
import type { PublicProfileWithTags } from "@/lib/database.types";

export type ProviderStats = { gigsWorkedCount: number; womPercentage: number | null };

// Find Help Profile Swiping v1.0: a provider-profile tile in the poster's "Save & Find Helpers
// Nearby" swipe deck. Mirrors GigTile.tsx's shape (own inline pointer-drag state, same
// resolveSwipe threshold, same tap-vs-drag deadzone) rather than sharing a hook with it -- the
// test harness only auto-invokes one top-level TestedComponent per file, and a shared hook
// calling useState from "react" resolves to React's real dispatcher outside a render, not the
// harness's shim. Skip (left) | View Full Profile | Send Gig (right), matching the swipe
// directions either side -- same left-to-right convention GigTile's Reject/View/Accept uses.
export default function ProviderCard({
  profile,
  category,
  distanceKm,
  stats,
  onView,
  onSendGig,
  onSkip,
}: {
  profile: PublicProfileWithTags;
  category: string;
  distanceKm?: number;
  stats: ProviderStats | null;
  onView: () => void;
  onSendGig: () => void;
  onSkip: () => void;
}) {
  const [drag, setDrag] = useState<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const draggedPastDeadzone = useRef(false);
  function onPointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    draggedPastDeadzone.current = false;
    setDrag({ x: 0, y: 0, startX: e.clientX, startY: e.clientY });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const next = { ...drag, x: e.clientX - drag.startX, y: e.clientY - drag.startY };
    if (Math.abs(next.x) > 8 || Math.abs(next.y) > 8) draggedPastDeadzone.current = true;
    setDrag(next);
  }
  function settle() {
    if (!drag) return;
    const decision = resolveSwipe(drag.x, drag.y);
    setDrag(null);
    if (decision === "accept") onSendGig();
    else if (decision === "reject") onSkip();
  }
  function tapToView() {
    if (!draggedPastDeadzone.current) onView();
  }
  const dragX = drag?.x ?? 0;
  const feedback = dragX > 24 ? "send" : dragX < -24 ? "skip" : null;

  const tags = profileTagsForCategory(profile, category);
  const womLabel = stats?.womPercentage != null ? `${stats.womPercentage}%` : "Not available";
  const completedLabel = stats ? stats.gigsWorkedCount : "Not available";

  return (
    <div
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={settle} onPointerCancel={() => setDrag(null)} onClick={tapToView}
      style={{ touchAction: "pan-y", transform: drag ? `translateX(${dragX}px) rotate(${dragX / 30}deg)` : undefined }}
      className="relative cursor-pointer rounded-xl border border-neutral-200 bg-white p-4 shadow-sm"
    >
      {feedback && (
        <div className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white px-4 py-1.5 text-base font-bold uppercase tracking-wide shadow-md ${
          feedback === "send" ? "border-emerald-500 text-emerald-600" : "border-red-500 text-red-600"
        }`}>
          {feedback === "send" ? "Send Gig" : "Skip"}
        </div>
      )}
      <div className="flex items-center gap-3">
        {profile.photo_url ? (
          <img src={profile.photo_url} alt="" className="h-20 w-20 shrink-0 rounded-full object-cover" />
        ) : (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-2xl">👤</div>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-medium">@{profile.username}</div>
          <div className="text-sm text-neutral-500">
            {distanceKm != null ? `${distanceKm.toFixed(1)} km away` : "Distance: Not available"}
          </div>
          <div className="mt-1 text-sm text-neutral-600">{womLabel} WOM · {completedLabel} gigs completed</div>
          <div className="mt-0.5 text-xs text-neutral-500">ID Verified: Not available · Typical rate: Not available</div>
        </div>
      </div>
      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tags.map((tag) => <TagChip key={tag.id}>{tag.name}</TagChip>)}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={(e) => { e?.stopPropagation(); onSkip(); }} aria-label="Skip" className="flex-1 rounded-lg border border-neutral-300 bg-white py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">Skip (✕)</button>
        <button type="button" onClick={(e) => { e?.stopPropagation(); onView(); }} className="flex-1 rounded-lg border border-neutral-300 bg-white py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">View Full Profile</button>
        <button type="button" onClick={(e) => { e?.stopPropagation(); onSendGig(); }} className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-700">Send Gig</button>
      </div>
    </div>
  );
}
