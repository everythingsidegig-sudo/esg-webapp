"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import type { Notification } from "@/lib/database.types";

export default function NotificationsBell() {
  const { user } = useAuth();
  const supabase = createClient();
  const router = useRouter();
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

  if (!user) return null;

  const unreadCount = items.filter((n) => !n.read).length;

  async function openNotification(n: Notification) {
    if (!n.read) {
      await supabase.from("notifications").update({ read: true }).eq("id", n.id);
      setItems((prev) => prev.map((i) => (i.id === n.id ? { ...i, read: true } : i)));
    }
    setOpen(false);
    if (n.gig_id) router.push(`/gigs/${n.gig_id}`);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-full p-2 hover:bg-neutral-100"
        aria-label="Gig Updates"
      >
        🤝
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 max-h-96 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg">
          <div className="border-b border-neutral-100 px-3 py-2 text-sm font-semibold">Gigs So Far</div>
          {items.length === 0 && <div className="p-4 text-sm text-neutral-500">No updates yet.</div>}
          {items.map((n) => (
            <button
              key={n.id}
              onClick={() => openNotification(n)}
              className={`block w-full border-b border-neutral-50 px-3 py-2 text-left text-sm hover:bg-neutral-50 ${
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
