"use client";

import { useEffect, useState } from "react";

// A person's avatar. When they have a photo it is tappable and opens full size (tap anywhere,
// or press Escape, to close) -- the same pattern as the gig photo in FullGigView. Without a
// photo it is the plain placeholder, which has nothing to open.
export default function ProfilePhoto({ url, username, sizeClass, placeholderTextClass = "text-xl" }: {
  url: string | null;
  username: string;
  sizeClass: string;
  placeholderTextClass?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  if (!url) {
    return <div className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-full bg-neutral-200 ${placeholderTextClass}`}>👤</div>;
  }
  return (
    <>
      <button type="button" onClick={() => setExpanded(true)} aria-label={`View @${username}'s photo`} className={`${sizeClass} shrink-0 rounded-full`}>
        <img src={url} alt="" className="h-full w-full rounded-full object-cover" />
      </button>
      {expanded && (
        <div role="dialog" aria-label={`@${username}'s photo`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setExpanded(false)}>
          <img src={url} alt={`@${username}`} className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
    </>
  );
}
