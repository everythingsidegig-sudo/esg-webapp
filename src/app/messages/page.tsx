"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AuthGuard from "@/components/AuthGuard";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { timeAgo } from "@/lib/my-gigs";
import type { ChatMessage } from "@/lib/database.types";

type GigRow = { id: string; title: string; poster_id: string; selected_provider_id: string | null };
type Conversation = { gig: GigRow; last: ChatMessage; unread: number; other: string | null };

// Conversations are the existing gig-scoped chats (poster <-> selected helper):
// one row per gig that has messages, newest first. Opening one goes to that
// gig's Messages section; nothing here can start a free-form DM.
function MessagesInner() {
  const supabase = createClient();
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    async function load() {
      try {
        const { data: gigRows, error: gigError } = await supabase
          .from("gigs")
          .select("id,title,poster_id,selected_provider_id")
          .not("selected_provider_id", "is", null)
          .or(`poster_id.eq.${user!.id},selected_provider_id.eq.${user!.id}`);
        if (gigError) throw gigError;
        const gigs = (gigRows ?? []) as GigRow[];
        if (gigs.length === 0) { if (alive) setConversations([]); return; }

        const { data: messageRows, error: messageError } = await supabase
          .from("chat_messages")
          .select("id,gig_id,sender_id,body,created_at,read_at")
          .in("gig_id", gigs.map((gig) => gig.id))
          .order("created_at", { ascending: false })
          .limit(500);
        if (messageError) throw messageError;

        const byGig = new Map<string, { last: ChatMessage; unread: number }>();
        for (const message of (messageRows ?? []) as ChatMessage[]) {
          const entry = byGig.get(message.gig_id) ?? { last: message, unread: 0 };
          if (message.sender_id !== user!.id && !message.read_at) entry.unread += 1;
          byGig.set(message.gig_id, entry);
        }
        const chats = gigs.filter((gig) => byGig.has(gig.id));
        const otherIds = [...new Set(chats.map((gig) => (gig.poster_id === user!.id ? gig.selected_provider_id : gig.poster_id)).filter((id): id is string => !!id))];
        const names = new Map<string, string>();
        if (otherIds.length > 0) {
          const { data: profiles, error: profileError } = await supabase.from("public_profiles").select("id,username").in("id", otherIds);
          if (profileError) throw profileError;
          for (const profile of (profiles ?? []) as { id: string; username: string }[]) names.set(profile.id, profile.username);
        }
        const list = chats.map((gig) => {
          const { last, unread } = byGig.get(gig.id)!;
          const otherId = gig.poster_id === user!.id ? gig.selected_provider_id : gig.poster_id;
          return { gig, last, unread, other: otherId ? names.get(otherId) ?? null : null };
        }).sort((a, b) => b.last.created_at.localeCompare(a.last.created_at));
        if (alive) setConversations(list);
      } catch { if (alive) setError("Couldn't load your messages. Check your connection and retry."); }
    }
    void load();
    const channel = supabase
      .channel(`messages-inbox-${user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, () => { void load(); })
      .subscribe();
    return () => { alive = false; supabase.removeChannel(channel); };
  }, [user, supabase, reload]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Messages</h1>
      {error && <p role="alert" className="text-sm text-red-600">{error} <button onClick={() => { setError(null); setConversations(null); setReload((value) => value + 1); }} className="font-medium underline">Retry</button></p>}
      {!error && conversations === null && <p className="text-neutral-500">Loading messages…</p>}
      {conversations?.length === 0 && (
        <p className="text-neutral-500">No conversations yet. Messaging opens once a helper is selected for a gig.</p>
      )}
      <ul className="space-y-2">
        {conversations?.map(({ gig, last, unread, other }) => (
          <li key={gig.id}>
            <Link href={`/gigs/${gig.id}#messages`} className="flex min-h-16 items-center gap-3 rounded-xl border border-neutral-200 bg-white p-3 shadow-sm hover:shadow-md">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`truncate ${unread > 0 ? "font-semibold" : "font-medium"}`}>{gig.title}</span>
                  <span className="shrink-0 text-xs text-neutral-500">{timeAgo(last.created_at)}</span>
                </div>
                <div className="text-sm text-neutral-500">{other ? `@${other}` : "Conversation"}</div>
                <div className={`truncate text-sm ${unread > 0 ? "text-neutral-900" : "text-neutral-500"}`}>
                  {last.sender_id === user?.id ? "You: " : ""}{last.body}
                </div>
              </div>
              {unread > 0 && (
                <span role="img" aria-label={`${unread} unread`} className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 px-1.5 text-xs font-medium text-white">{unread}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Messages() {
  return <AuthGuard><MessagesInner /></AuthGuard>;
}
