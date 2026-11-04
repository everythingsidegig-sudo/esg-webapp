"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import TagChip from "@/components/TagChip";
import { createClient } from "@/lib/supabase/client";
import { formatMoney } from "@/lib/money";
import { priceLabel } from "@/lib/helper-request";
import { gigTagNames } from "@/lib/tags";
import { resolveSwipe } from "@/lib/swipe";
import type { GigWithTags, PublicProfile } from "@/lib/database.types";

type PosterInfo = { profile: PublicProfile | null; womPercentage: number | null; gigsPosted: number | null };

// ESG Gig Swipe Discovery v1.0, "Full Gig Details": opened via View without leaving the
// list (the caller renders this as an overlay, not a route change -- list position is
// never lost because the list underneath never unmounts). Works for a signed-out
// visitor too ("discovery can be anonymous") -- every query here is already granted to
// anon (public_profiles, get_public_stats, the gigs row itself via gigs_select).
export default function FullGigView({
  gig,
  disabled,
  onClose,
  onAccept,
  onReject,
}: {
  gig: GigWithTags;
  disabled?: boolean;
  onClose: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const supabase = createClient();
  const [poster, setPoster] = useState<PosterInfo | null>(null);
  const [photoExpanded, setPhotoExpanded] = useState(false);
  // Not a shared hook (deliberately): pointer handling is simple enough to duplicate between
  // this view and GigTile, and both need their own useState bound to their own render.
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
    if (decision === "accept") onAccept();
    else if (decision === "reject") onReject();
  }
  const dragX = drag?.x ?? 0;

  useEffect(() => {
    let active = true;
    // Fetching from Supabase (an external system) on gig change, not deriving state from
    // props already available this render -- the lint rule can't tell those apart.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPoster(null);
    Promise.all([
      supabase.from("public_profiles").select("*").eq("id", gig.poster_id).maybeSingle(),
      supabase.rpc("get_public_stats", { p_profile_id: gig.poster_id }),
      supabase.from("gigs").select("*", { count: "exact", head: true }).eq("poster_id", gig.poster_id),
    ]).then(([profileRes, statsRes, countRes]) => {
      if (!active) return;
      const stats = (statsRes.data as { wom_percentage: number | null }[] | null)?.[0];
      setPoster({
        profile: (profileRes.data as PublicProfile) ?? null,
        womPercentage: stats?.wom_percentage ?? null,
        gigsPosted: countRes.count ?? null,
      });
    }).catch(() => { if (active) setPoster({ profile: null, womPercentage: null, gigsPosted: null }); });
    return () => { active = false; };
  }, [supabase, gig.poster_id]);

  const tags = gigTagNames(gig);
  const feedback = dragX > 24 ? "accept" : dragX < -24 ? "reject" : null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" role="dialog" aria-label="Full gig details">
      <div
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={settle} onPointerCancel={() => setDrag(null)}
        style={{ touchAction: "pan-y", transform: drag ? `translateX(${dragX}px) rotate(${dragX / 24}deg)` : undefined }}
        className="relative max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
      >
        {feedback && (
          // Centered on the card itself (not pinned to an edge): it travels with the card as
          // it's dragged, so it stays squarely in view throughout the swipe.
          <div className={`pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white px-4 py-1.5 text-base font-bold uppercase tracking-wide shadow-md ${
            feedback === "accept" ? "border-emerald-500 text-emerald-600" : "border-red-500 text-red-600"
          }`}>
            {feedback === "accept" ? "Accept" : "Reject"}
          </div>
        )}

        <div className="flex items-start justify-between gap-2">
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-emerald-700">{gig.service_type}</span>
            <h2 className="text-xl font-semibold">{gig.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Back to list" className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
            Back
          </button>
        </div>

        {gig.photo_url ? (
          <button type="button" onClick={() => setPhotoExpanded(true)} className="block w-full">
            <img src={gig.photo_url} alt="" className="max-h-64 w-full rounded-lg object-cover" />
          </button>
        ) : (
          <div className="flex h-32 items-center justify-center rounded-lg bg-neutral-100 text-sm text-neutral-400">No photo</div>
        )}
        {photoExpanded && gig.photo_url && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setPhotoExpanded(false)}>
            <img src={gig.photo_url} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
          </div>
        )}

        <section aria-label="Description">
          <h3 className="text-sm font-medium text-neutral-500">Description</h3>
          <p className="mt-1 whitespace-pre-wrap break-words text-neutral-800">{gig.description}</p>
        </section>

        <section aria-label="Compensation" className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>💵 {formatMoney(gig.amount)} · {priceLabel(gig.price_type)}</span>
          <span>📍 {gig.location_text}</span>
          <span>🗓️ {gig.scheduled_at ? new Date(gig.scheduled_at).toLocaleString() : "Flexible"} · Duration: Not available</span>
        </section>

        {tags.length > 0 && (
          <section aria-label="Requirements">
            <h3 className="text-sm font-medium text-neutral-500">Requirements</h3>
            <div className="mt-1 flex flex-wrap gap-1.5">{tags.map((name) => <TagChip key={name}>{name}</TagChip>)}</div>
          </section>
        )}

        <section aria-label="Posted by" className="rounded-lg bg-neutral-50 p-3 text-sm">
          <h3 className="font-medium text-neutral-700">Posted by</h3>
          {!poster ? (
            <p className="text-neutral-500">Loading…</p>
          ) : poster.profile ? (
            <p className="mt-1 text-neutral-600">
              <Link href={`/profile/${poster.profile.username}`} className="font-medium text-emerald-700 hover:underline">@{poster.profile.username}</Link>
              {" · "}WOM {poster.womPercentage != null ? `${poster.womPercentage}%` : "Not available"}
              {" · "}Gigs Posted {poster.gigsPosted ?? "Not available"}
            </p>
          ) : (
            <p className="mt-1 text-neutral-500">Not available</p>
          )}
        </section>

        <div className="flex gap-2 pt-1">
          <button type="button" disabled={disabled} onClick={onReject} className="flex-1 rounded-lg border border-neutral-300 bg-white py-2.5 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60">Reject</button>
          <button type="button" disabled={disabled} onClick={onAccept} className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">Accept</button>
        </div>
      </div>
    </div>
  );
}
