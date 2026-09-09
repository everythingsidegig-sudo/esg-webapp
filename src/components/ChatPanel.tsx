"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ChatMessage } from "@/lib/database.types";

export default function ChatPanel({
  gigId,
  currentUserId,
  readOnly,
}: {
  gigId: string;
  currentUserId: string;
  readOnly: boolean;
}) {
  const supabase = createClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    supabase
      .from("chat_messages")
      .select("*")
      .eq("gig_id", gigId)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (active) setMessages((data as ChatMessage[]) ?? []);
      });

    const channel = supabase
      .channel(`chat-${gigId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `gig_id=eq.${gigId}` },
        (payload) => {
          setMessages((prev) => [...prev, payload.new as ChatMessage]);
        }
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [gigId, supabase]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function send() {
    if (!draft.trim()) return;
    setSending(true);
    const { error } = await supabase.from("chat_messages").insert({
      gig_id: gigId,
      sender_id: currentUserId,
      body: draft.trim(),
    });
    setSending(false);
    if (!error) setDraft("");
  }

  return (
    <div className="flex h-80 flex-col rounded-xl border border-neutral-200 bg-white">
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.length === 0 && <p className="text-sm text-neutral-400">No messages yet. Say hello!</p>}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[75%] rounded-lg px-3 py-1.5 text-sm ${
              m.sender_id === currentUserId ? "ml-auto bg-emerald-600 text-white" : "bg-neutral-100 text-neutral-900"
            }`}
          >
            {m.body}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {!readOnly ? (
        <div className="flex gap-2 border-t border-neutral-100 p-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Message…"
            className="flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm"
          />
          <button
            onClick={send}
            disabled={sending}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            Send
          </button>
        </div>
      ) : (
        <div className="border-t border-neutral-100 p-2 text-center text-xs text-neutral-400">
          Chat is read-only now.
        </div>
      )}
    </div>
  );
}
