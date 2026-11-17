"use client";

import { useRef, useState } from "react";
import { resolveSwipe } from "@/lib/swipe";

// Wraps any card so it can be swiped: right = the positive answer, left = the negative one, using
// the same threshold as every other swipe card (resolveSwipe). Used for Direct Requests in My Gigs.
// Like GigTile and ProviderCard it keeps its own inline pointer-drag state rather than a shared hook.
//
// The card's own buttons stay: swiping is a shortcut, never the only way to answer (keyboard,
// screen readers and anyone who doesn't swipe). `enabled` off (already answered, or a request is in
// flight) turns the gesture off completely. A drag that moves past a small dead zone also cancels the
// click that follows it, so swiping across a link never opens it.
export default function SwipeCard({
  enabled,
  onSwipeRight,
  onSwipeLeft,
  rightLabel,
  leftLabel,
  className,
  children,
}: {
  enabled: boolean;
  onSwipeRight: () => void;
  onSwipeLeft: () => void;
  rightLabel: string;
  leftLabel: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [drag, setDrag] = useState<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const draggedPastDeadzone = useRef(false);
  function onPointerDown(e: React.PointerEvent) {
    if (!enabled) return;
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
    if (decision === "accept") onSwipeRight();
    else if (decision === "reject") onSwipeLeft();
  }
  const dragX = drag?.x ?? 0;
  const feedback = dragX > 24 ? "right" : dragX < -24 ? "left" : null;

  return (
    <div
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={settle} onPointerCancel={() => setDrag(null)}
      onClickCapture={(e) => { if (draggedPastDeadzone.current) { e.preventDefault(); e.stopPropagation(); draggedPastDeadzone.current = false; } }}
      style={{ touchAction: "pan-y", transform: drag ? `translateX(${dragX}px) rotate(${dragX / 30}deg)` : undefined }}
      className={`relative ${className ?? ""}`}
    >
      {feedback && (
        <div aria-hidden="true" className={`pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white px-4 py-1.5 text-base font-bold uppercase tracking-wide shadow-md ${
          feedback === "right" ? "border-emerald-500 text-emerald-600" : "border-red-500 text-red-600"
        }`}>
          {feedback === "right" ? rightLabel : leftLabel}
        </div>
      )}
      {children}
    </div>
  );
}
