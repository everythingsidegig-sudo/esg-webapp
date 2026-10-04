"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";

// Header entry to the Messages inbox. Unread = messages from the other party
// that haven't been opened yet (RLS already limits rows to the user's own gigs).
export default function MessagesLink() {
  const { user } = useAuth();
  const supabase = createClient();
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!user) return;
    let active = true;
    async function refresh() {
      const { count } = await supabase.from("chat_messages").select("id", { count: "exact", head: true }).is("read_at", null).neq("sender_id", user!.id);
      if (active) setUnread(count ?? 0);
    }
    void refresh();
    const channel = supabase
      .channel(`messages-badge-${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_messages" }, () => { void refresh(); })
      .subscribe();
    window.addEventListener("esg:messages-read", refresh);
    return () => {
      active = false;
      window.removeEventListener("esg:messages-read", refresh);
      supabase.removeChannel(channel);
    };
  }, [user, supabase]);

  if (!user) return null;

  return (
    <Link
      href="/messages"
      aria-label={unread > 0 ? `Messages, ${unread} unread` : "Messages"}
      aria-current={pathname === "/messages" ? "page" : undefined}
      className="relative flex h-11 w-11 items-center justify-center rounded-full text-xl hover:bg-neutral-100"
    >
      <span aria-hidden="true">💬</span>
      {unread > 0 && (
        <span aria-hidden="true" className="absolute right-0.5 top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs text-white">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Link>
  );
}
