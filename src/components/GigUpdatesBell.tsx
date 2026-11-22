"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import Icon from "@/components/Icon";
import type { Notification } from "@/lib/database.types";

// Every update opens its gig -- the permanent place to manage it. A new
// proposal lands on the poster's proposals list within that gig.
export function notificationHref(n: Pick<Notification, "gig_id" | "type">) {
  if (n.type === "claim_received") return `/gigs/${n.gig_id}#proposals`;
  // A new request lands on the Accept / Decline panel for the requested helper.
  if (n.type === "gig_request") return `/gigs/${n.gig_id}#request`;
  // A price proposal or its answer lands in the chat, where the Accept / Decline buttons are.
  if (n.type.startsWith("price_")) return `/gigs/${n.gig_id}#messages`;
  // Find Help Profile Swiping v1.0: a direct request has no UI on /gigs/[id] (that page has
  // never had a role for "pending direct-request recipient", unlike the old gig_request's
  // #request panel) -- the Interested/Decline/Accept actions live in My Gigs instead.
  if (n.type === "direct_request") return "/my-gigs?tab=helping";
  if (n.type === "direct_request_interested" || n.type === "direct_request_declined") return "/my-gigs?tab=posted";
  return `/gigs/${n.gig_id}`;
}

export default function GigUpdatesBell() {
  const { user } = useAuth();
  const supabase = createClient();
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user) return;

    let active = true;
    supabase
      .from("notifications")
      .select("*")
      .eq("recipient_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (active) setItems((data as Notification[]) ?? []);
      });

    const channel = supabase
      .channel(`notifications-${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `recipient_id=eq.${user.id}` },
        (payload) => {
          setItems((prev) => [payload.new as Notification, ...prev]);
        }
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [user, supabase]);

  // Close the list on a click/tap anywhere outside it and on Escape.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!user) return null;

  const unreadCount = items.filter((n) => !n.read).length;

  async function openNotification(n: Notification) {
    if (!n.read) {
      await supabase.from("notifications").update({ read: true }).eq("id", n.id);
      setItems((prev) => prev.map((i) => (i.id === n.id ? { ...i, read: true } : i)));
    }
    setOpen(false);
    if (n.gig_id) router.push(notificationHref(n));
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-11 w-11 items-center justify-center rounded-full text-neutral-800 hover:bg-neutral-100"
        aria-label={unreadCount > 0 ? `Gig Updates, ${unreadCount} unread` : "Gig Updates"}
        aria-expanded={open}
      >
        <Icon name="bell" className="h-6 w-6" />
        {unreadCount > 0 && (
          <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-xs font-bold text-white ring-2 ring-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 max-h-96 w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-neutral-200 bg-white shadow-lg">
          <div className="border-b border-neutral-100 px-3 py-2 text-sm font-semibold">Gig Updates</div>
          {items.length === 0 && <div className="p-4 text-sm text-neutral-500">No updates yet.</div>}
          {items.map((n) => (
            <button
              key={n.id}
              onClick={() => openNotification(n)}
              className={`block min-h-11 w-full border-b border-neutral-50 px-3 py-2 text-left text-sm hover:bg-neutral-50 ${
                n.read ? "text-neutral-500" : "font-medium text-neutral-900"
              }`}
            >
              {n.message}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
