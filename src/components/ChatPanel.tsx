"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CURRENCY, formatMoney } from "@/lib/money";
import { MAX_PRICE_ROUNDS, negotiationActionError, negotiationUnavailable, negotiationView, proposalAmountError, proposalStatus } from "@/lib/negotiation";
import type { ChatMessage, PriceProposal } from "@/lib/database.types";

// Messages within this gap from the same person read as one group (one time stamp, tight spacing).
const GROUP_GAP_MS = 5 * 60 * 1000;

const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function dayLabel(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

// Messages and price proposals share one timeline, oldest first.
type Item =
  | { kind: "message"; at: string; message: ChatMessage }
  | { kind: "proposal"; at: string; proposal: PriceProposal };

const upsert = (list: PriceProposal[], row: PriceProposal) =>
  list.some((item) => item.id === row.id) ? list.map((item) => (item.id === row.id ? row : item)) : [...list, row];

export default function ChatPanel({
  gigId,
  currentUserId,
  readOnly,
  negotiation,
  otherName,
  onPriceChanged,
}: {
  gigId: string;
  currentUserId: string;
  readOnly: boolean;
  // open: the price can still be negotiated (before the helper starts). agreedAmount: the price now.
  negotiation?: { open: boolean; agreedAmount: number };
  otherName?: string;
  onPriceChanged?: () => void;
}) {
  const supabase = createClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<PriceProposal[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [priceFormOpen, setPriceFormOpen] = useState(false);
  const [priceDraft, setPriceDraft] = useState("");
  const [priceBusy, setPriceBusy] = useState<string | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  // The server has not been upgraded for price negotiation yet (migration 0021): hide the controls
  // instead of showing buttons that cannot work. The conversation itself is unaffected.
  const [unavailable, setUnavailable] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Opening the conversation marks the other party's messages as read (the only
  // column clients may update on chat_messages), which drives the Messages badge.
  async function markRead() {
    const { error } = await supabase.from("chat_messages").update({ read_at: new Date().toISOString() })
      .eq("gig_id", gigId).neq("sender_id", currentUserId).is("read_at", null);
    if (!error) window.dispatchEvent(new Event("esg:messages-read"));
  }

  async function loadProposals() {
    const { data, error } = await supabase.from("price_proposals").select("*").eq("gig_id", gigId).order("created_at", { ascending: true });
    if (negotiationUnavailable(error)) { setUnavailable(true); return; }
    setProposals((data as PriceProposal[] | null) ?? []);
  }

  useEffect(() => {
    let active = true;
    supabase
      .from("chat_messages")
      .select("*")
      .eq("gig_id", gigId)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (!active) return;
        const rows = (data as ChatMessage[]) ?? [];
        setMessages(rows);
        if (rows.some((m) => m.sender_id !== currentUserId && !m.read_at)) void markRead();
      });
    supabase
      .from("price_proposals")
      .select("*")
      .eq("gig_id", gigId)
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (!active) return;
        if (negotiationUnavailable(error)) { setUnavailable(true); return; }
        setProposals((data as PriceProposal[] | null) ?? []);
      });

    const channel = supabase
      .channel(`chat-${gigId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `gig_id=eq.${gigId}` },
        (payload) => {
          setMessages((prev) => [...prev, payload.new as ChatMessage]);
          if ((payload.new as ChatMessage).sender_id !== currentUserId) void markRead();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "price_proposals", filter: `gig_id=eq.${gigId}` },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          setProposals((prev) => upsert(prev, payload.new as PriceProposal));
          onPriceChanged?.();
        }
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  // markRead and onPriceChanged only close over props already listed or stable callbacks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gigId, currentUserId, supabase]);

  const timeline: Item[] = [
    ...messages.map((message): Item => ({ kind: "message", at: message.created_at, message })),
    ...proposals.map((proposal): Item => ({ kind: "proposal", at: proposal.created_at, proposal })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timeline.length]);

  async function send() {
    if (!draft.trim() || sending) return;
    setSending(true);
    const { error } = await supabase.from("chat_messages").insert({
      gig_id: gigId,
      sender_id: currentUserId,
      body: draft.trim(),
    });
    setSending(false);
    if (!error) setDraft("");
  }

  const open = !!negotiation?.open && !readOnly && !unavailable;
  const view = negotiationView(proposals, currentUserId, open);
  const agreedAmount = negotiation?.agreedAmount ?? 0;

  async function propose() {
    if (priceBusy) return;
    const problem = proposalAmountError(priceDraft, agreedAmount);
    if (problem) { setPriceError(problem); return; }
    setPriceBusy("propose");
    setPriceError(null);
    const { error } = await supabase.rpc("propose_price", { p_gig_id: gigId, p_amount: Number(priceDraft.trim()) });
    setPriceBusy(null);
    await loadProposals();
    if (error) { setPriceError(negotiationActionError(error)); return; }
    setPriceDraft("");
    setPriceFormOpen(false);
    onPriceChanged?.();
  }

  async function answer(proposal: PriceProposal, accept: boolean) {
    if (priceBusy) return;
    setPriceBusy(proposal.id);
    setPriceError(null);
    const { error } = await supabase.rpc("respond_price_proposal", { p_proposal_id: proposal.id, p_accept: accept });
    setPriceBusy(null);
    await loadProposals();
    if (error) { setPriceError(negotiationActionError(error)); return; }
    onPriceChanged?.();
  }

  async function withdraw(proposal: PriceProposal) {
    if (priceBusy) return;
    setPriceBusy(proposal.id);
    setPriceError(null);
    const { error } = await supabase.rpc("withdraw_price_proposal", { p_proposal_id: proposal.id });
    setPriceBusy(null);
    await loadProposals();
    if (error) { setPriceError(negotiationActionError(error)); return; }
    onPriceChanged?.();
  }

  // Seen: only on the last message you sent, and only once the other person has opened it.
  const lastMineIndex = timeline.reduce((found, item, i) => (item.kind === "message" && item.message.sender_id === currentUserId ? i : found), -1);
  const canSend = draft.trim().length > 0 && !sending;
  const other = otherName ?? "They";
  const button = "min-h-11 rounded-full px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div className="flex h-[30rem] max-h-[80vh] flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50 shadow-sm">
      <div role="log" aria-label="Conversation" aria-live="polite" className="flex-1 overflow-y-auto px-4 py-4">
        {timeline.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <span aria-hidden="true" className="text-3xl">💬</span>
            <p className="text-sm font-medium text-neutral-700">No messages yet</p>
            <p className="text-xs text-neutral-500">Say hello to get the conversation started.</p>
          </div>
        )}
        {timeline.map((item, i) => {
          const prev = timeline[i - 1];
          const next = timeline[i + 1];
          const newDay = !prev || !sameDay(prev.at, item.at);
          const dateChip = newDay && (
            <div className="my-3 flex justify-center first:mt-0">
              <span className="rounded-full bg-neutral-200/70 px-3 py-0.5 text-[11px] font-medium text-neutral-600">{dayLabel(item.at)}</span>
            </div>
          );

          if (item.kind === "proposal") {
            const proposal = item.proposal;
            const mine = proposal.proposer_id === currentUserId;
            const status = proposalStatus(proposal, currentUserId, open);
            const busy = priceBusy === proposal.id;
            return (
              <div key={`p-${proposal.id}`}>
                {dateChip}
                <div className={`flex ${mine ? "justify-end" : "justify-start"} ${newDay ? "mt-0" : "mt-3"}`}>
                  <section
                    aria-label={`Price proposal, round ${proposal.round} of ${MAX_PRICE_ROUNDS}`}
                    className={`w-full max-w-[85%] rounded-2xl border bg-white p-3.5 shadow-sm ${
                      status === "accepted" ? "border-emerald-300" : "border-neutral-200"
                    }`}
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                      Price proposal · Round {proposal.round} of {MAX_PRICE_ROUNDS}
                    </p>
                    <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xl font-semibold text-neutral-900">
                      {formatMoney(proposal.amount)}
                      <span className="text-sm font-normal text-neutral-400 line-through">{formatMoney(proposal.from_amount)}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-500">{mine ? "You proposed this" : `${other} proposed this`} · {timeLabel(proposal.created_at)}</p>

                    {status === "answer" && (
                      <div className="mt-3 flex gap-2">
                        <button type="button" disabled={busy} onClick={() => void answer(proposal, true)}
                          aria-label={`Accept ${formatMoney(proposal.amount)}`}
                          className={`${button} flex-1 bg-emerald-600 text-white shadow-sm hover:bg-emerald-700`}>Accept</button>
                        <button type="button" disabled={busy} onClick={() => void answer(proposal, false)}
                          aria-label={`Decline ${formatMoney(proposal.amount)}`}
                          className={`${button} flex-1 border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50`}>Decline</button>
                      </div>
                    )}
                    {status === "waiting" && (
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <p className="text-sm text-neutral-500">Waiting for a reply…</p>
                        <button type="button" disabled={busy} onClick={() => void withdraw(proposal)}
                          className="min-h-11 px-2 text-sm font-medium text-neutral-600 underline-offset-2 hover:underline disabled:opacity-60">Withdraw</button>
                      </div>
                    )}
                    {status === "closed" && <p className="mt-2 text-sm text-neutral-500">The price can no longer be changed.</p>}
                    {status === "accepted" && <p className="mt-2 text-sm font-medium text-emerald-700">✓ Accepted. The agreed price is {formatMoney(proposal.amount)}.</p>}
                    {status === "declined" && <p className="mt-2 text-sm text-neutral-500">Declined</p>}
                    {status === "withdrawn" && <p className="mt-2 text-sm text-neutral-500">Withdrawn</p>}
                  </section>
                </div>
              </div>
            );
          }

          const m = item.message;
          const mine = m.sender_id === currentUserId;
          const joinsPrev = prev?.kind === "message" && !newDay && prev.message.sender_id === m.sender_id
            && new Date(m.created_at).getTime() - new Date(prev.at).getTime() < GROUP_GAP_MS;
          const joinsNext = next?.kind === "message" && sameDay(m.created_at, next.at) && next.message.sender_id === m.sender_id
            && new Date(next.at).getTime() - new Date(m.created_at).getTime() < GROUP_GAP_MS;
          return (
            <div key={m.id}>
              {dateChip}
              <div className={`flex flex-col ${mine ? "items-end" : "items-start"} ${joinsPrev ? "mt-0.5" : newDay ? "mt-0" : "mt-3"}`}>
                <div
                  className={`max-w-[80%] whitespace-pre-wrap break-words px-3.5 py-2 text-[15px] leading-snug ${
                    mine
                      ? `bg-emerald-600 text-white shadow-sm rounded-2xl ${joinsNext ? "" : "rounded-br-md"}`
                      : `border border-neutral-200 bg-white text-neutral-900 shadow-sm rounded-2xl ${joinsNext ? "" : "rounded-bl-md"}`
                  }`}
                >
                  {m.body}
                </div>
                {!joinsNext && (
                  <p className="mt-1 px-1 text-[11px] text-neutral-400">
                    {timeLabel(m.created_at)}
                    {mine && i === lastMineIndex && m.read_at ? " · Seen" : ""}
                  </p>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {open && (
        <div className="border-t border-neutral-200 bg-white px-3 pt-3">
          {priceError && <p role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{priceError}</p>}
          {!priceFormOpen && view.canPropose && (
            <button type="button" onClick={() => { setPriceFormOpen(true); setPriceError(null); }}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-emerald-600 px-4 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50">
              <span aria-hidden="true">💶</span>
              {view.pendingFromOther ? "Counter with another price" : "Propose a new price"}
              <span className="text-xs font-normal text-neutral-500">({view.remaining} of {MAX_PRICE_ROUNDS} left)</span>
            </button>
          )}
          {priceFormOpen && view.canPropose && (
            <form onSubmit={(event) => { event.preventDefault(); void propose(); }} aria-label="Propose a new price" className="space-y-2">
              <label className="block text-sm font-medium text-neutral-700" htmlFor="new-price">
                New price ({CURRENCY}) <span className="font-normal text-neutral-500">· now {formatMoney(agreedAmount)} · round {view.nextRound} of {MAX_PRICE_ROUNDS}</span>
              </label>
              <input id="new-price" inputMode="decimal" autoComplete="off" value={priceDraft}
                onChange={(e) => { setPriceDraft(e.target.value); setPriceError(null); }}
                placeholder={String(agreedAmount)}
                className="min-h-11 w-full rounded-xl border border-neutral-300 bg-neutral-50 px-4 text-[15px] outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100" />
              <div className="flex gap-2">
                <button type="submit" disabled={!priceDraft.trim() || !!priceBusy} className={`${button} flex-1 bg-emerald-600 text-white shadow-sm hover:bg-emerald-700`}>
                  {priceBusy === "propose" ? "Sending…" : "Send proposal"}
                </button>
                <button type="button" onClick={() => { setPriceFormOpen(false); setPriceDraft(""); setPriceError(null); }}
                  className={`${button} border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50`}>Cancel</button>
              </div>
            </form>
          )}
          {!view.canPropose && !view.pendingFromMe && (view.agreed || view.remaining === 0) && (
            <p className="pb-1 text-center text-xs text-neutral-500">
              {view.agreed ? "A new price was agreed. It can't be changed again." : "All three price proposals have been used."}
            </p>
          )}
        </div>
      )}

      {!readOnly ? (
        <form
          onSubmit={(event) => { event.preventDefault(); void send(); }}
          className={`flex items-end gap-2 bg-white p-3 ${open ? "" : "border-t border-neutral-200"}`}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a message…"
            aria-label="Message"
            autoComplete="off"
            enterKeyHint="send"
            className="min-h-11 flex-1 rounded-full border border-neutral-300 bg-neutral-50 px-4 text-[15px] outline-none transition placeholder:text-neutral-400 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 disabled:shadow-none"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" />
              <path d="m13 6 6 6-6 6" />
            </svg>
          </button>
        </form>
      ) : (
        <div className="flex items-center justify-center gap-1.5 border-t border-neutral-200 bg-neutral-100 px-3 py-2.5 text-xs text-neutral-500">
          <span aria-hidden="true">🔒</span> This conversation is read-only now.
        </div>
      )}
    </div>
  );
}
