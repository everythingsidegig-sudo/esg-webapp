"use client";

import { useState } from "react";
import TagChip from "@/components/TagChip";
import { formatMoney } from "@/lib/money";
import { priceLabel } from "@/lib/helper-request";
import { gigTagNames } from "@/lib/tags";
import { resolveSwipe } from "@/lib/swipe";
import type { GigWithTags } from "@/lib/database.types";

// ESG Gig Swipe Discovery v1.0: a list tile. Swipe right or Accept opens the shared
// confirm step (never submits instantly); swipe left or Reject is a silent, local,
// session-only skip. "View" opens the full-detail overlay without affecting either.
export default function GigTile({
  gig,
  onView,
  onRequestAccept,
  onReject,
}: {
  gig: GigWithTags;
  onView: () => void;
  onRequestAccept: () => void;
  onReject: () => void;
}) {
  // Not a shared hook (deliberately): pointer handling is simple enough to duplicate between
  // this tile and FullGigView, and both need their own useState bound to their own render.
  const [drag, setDrag] = useState<{ x: number; y: number; startX: number; startY: number } | null>(null);
  function onPointerDown(e: React.PointerEvent) {
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
    if (decision === "accept") onRequestAccept();
    else if (decision === "reject") onReject();
  }
  const dragX = drag?.x ?? 0;
  const feedback = dragX > 24 ? "accept" : dragX < -24 ? "reject" : null;

  return (
    <div
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={settle} onPointerCancel={() => setDrag(null)}
      style={{ touchAction: "pan-y", transform: drag ? `translateX(${dragX}px) rotate(${dragX / 30}deg)` : undefined }}
      className="relative rounded-xl border border-neutral-200 bg-white p-4 shadow-sm"
    >
      {feedback && (
        <div className={`pointer-events-none absolute top-3 rounded-full border-2 px-3 py-1 text-sm font-bold uppercase tracking-wide ${
          feedback === "accept" ? "left-3 border-emerald-500 text-emerald-600" : "right-3 border-red-500 text-red-600"
        }`}>
          {feedback === "accept" ? "Accept" : "Reject"}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-emerald-700">{gig.service_type}</span>
        <div className="flex items-center gap-2">
          <span className="font-semibold">{formatMoney(gig.amount)}</span>
          {gig.photo_url && <span aria-hidden="true" title="Has photos">📷</span>}
        </div>
      </div>
      <div className="mt-1 font-medium">{gig.title}</div>
      <div className="mt-1 text-sm text-neutral-500">
        {gig.location_text} · {gig.scheduled_at ? new Date(gig.scheduled_at).toLocaleString() : "Flexible"} · {priceLabel(gig.price_type)}
      </div>
      <p className="mt-1 line-clamp-2 text-sm text-neutral-600">{gig.description}</p>
      {gigTagNames(gig).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {gigTagNames(gig).map((name) => <TagChip key={name}>{name}</TagChip>)}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onView} className="flex-1 rounded-lg border border-neutral-300 bg-white py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">View</button>
        <button type="button" onClick={onRequestAccept} className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-700">Accept</button>
        <button type="button" onClick={onReject} className="flex-1 rounded-lg border border-neutral-300 bg-white py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">Reject</button>
      </div>
    </div>
  );
}
