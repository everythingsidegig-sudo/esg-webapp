"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import StatusBadge from "@/components/StatusBadge";
import ChatPanel from "@/components/ChatPanel";
import TagChip from "@/components/TagChip";
import { gigTagNames } from "@/lib/tags";
import type { Claim, CompletionOutcome, FeedbackType, GigWithTags, IncompleteChoice, PublicProfile } from "@/lib/database.types";

type ClaimWithProfile = Claim & { profile?: PublicProfile };

function GigDetails({ id }: { id: string }) {
  const supabase = createClient();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [gig, setGig] = useState<GigWithTags | null | undefined>(undefined);
  const [claims, setClaims] = useState<ClaimWithProfile[]>([]);
  const [myClaim, setMyClaim] = useState<Claim | null>(null);
  const [myCompletion, setMyCompletion] = useState<CompletionOutcome | null>(null);
  const [myIncompleteChoice, setMyIncompleteChoice] = useState<IncompleteChoice | null>(null);
  const [myFeedback, setMyFeedback] = useState<FeedbackType | null>(null);
  const [paymentInput, setPaymentInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const { data: gigData } = await supabase.from("gigs").select("*, gig_tags(tag:tags(id,name))").eq("id", id).maybeSingle();
    setGig((gigData as GigWithTags) ?? null);
    if (!gigData) return;

    if (user && gigData.poster_id === user.id) {
      const { data: claimRows } = await supabase
        .from("claims")
        .select("*")
        .eq("gig_id", id)
        .eq("state", "pending");
      const rows = (claimRows as Claim[]) ?? [];
      if (rows.length > 0) {
        const { data: profiles } = await supabase
          .from("public_profiles")
          .select("*")
          .in("id", rows.map((c) => c.provider_id));
        const byId = new Map((profiles as PublicProfile[] | null)?.map((p) => [p.id, p]));
        setClaims(rows.map((c) => ({ ...c, profile: byId.get(c.provider_id) })));
      } else {
        setClaims([]);
      }
    }

    if (user) {
      const { data: claimRow } = await supabase
        .from("claims")
        .select("*")
        .eq("gig_id", id)
        .eq("provider_id", user.id)
        .maybeSingle();
      setMyClaim((claimRow as Claim) ?? null);

      const { data: completionRow } = await supabase
        .from("gig_completions")
        .select("outcome")
        .eq("gig_id", id)
        .eq("user_id", user.id)
        .maybeSingle();
      setMyCompletion((completionRow as { outcome: CompletionOutcome } | null)?.outcome ?? null);

      const { data: choiceRow } = await supabase
        .from("gig_incomplete_choices")
        .select("choice")
        .eq("gig_id", id)
        .eq("user_id", user.id)
        .maybeSingle();
      setMyIncompleteChoice((choiceRow as { choice: IncompleteChoice } | null)?.choice ?? null);

      const { data: feedbackRow } = await supabase
        .from("feedback")
        .select("type")
        .eq("gig_id", id)
        .eq("from_id", user.id)
        .maybeSingle();
      setMyFeedback((feedbackRow as { type: FeedbackType } | null)?.type ?? null);
    }
  }, [supabase, id, user]);

  useEffect(() => {
    if (authLoading) return;
    // Fetching from Supabase (an external system) on mount/dependency change, not deriving
    // state from props — the lint rule can't tell those apart, hence the disable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
  }, [authLoading, loadAll]);

  useEffect(() => {
    const channel = supabase
      .channel(`gig-${id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "gigs", filter: `id=eq.${id}` }, () => {
        loadAll();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "claims", filter: `gig_id=eq.${id}` }, () => {
        loadAll();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, supabase, loadAll]);

  async function run(action: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error: actionError } = await action();
    setBusy(false);
    if (actionError) {
      setError(actionError.message);
    } else {
      loadAll();
    }
  }

  if (gig === undefined || authLoading) return <p className="text-neutral-500">Loading…</p>;
  if (gig === null) return <p className="text-neutral-500">Gig not found.</p>;

  const isPoster = user?.id === gig.poster_id;
  const isSelectedProvider = user?.id === gig.selected_provider_id;
  const canClaim = user && !isPoster && gig.status === "active" && !gig.selected_provider_id && !myClaim;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-emerald-700">{gig.service_type}</span>
          <StatusBadge status={gig.status} />
        </div>
        <h1 className="mt-1 text-xl font-semibold">{gig.title}</h1>
        <p className="mt-2 text-neutral-600">{gig.description}</p>
        {gig.photo_url && <img src={gig.photo_url} alt="" className="mt-3 max-h-64 rounded-lg object-cover" />}
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-500">
          <span>💵 ${gig.amount} (Fixed)</span>
          <span>📍 {gig.location_text}</span>
          <span>🗓️ {gig.scheduled_at ? new Date(gig.scheduled_at).toLocaleString() : "Flexible"}</span>
        </div>
        {gigTagNames(gig).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {gigTagNames(gig).map((name) => <TagChip key={name}>{name}</TagChip>)}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!user && gig.status === "active" && (
        <button
          onClick={() => router.push(`/auth/sign-in?next=/gigs/${id}`)}
          className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700"
        >
          Sign in to Claim
        </button>
      )}

      {canClaim && (
        <button
          disabled={busy}
          onClick={() => run(() => supabase.rpc("create_claim", { p_gig_id: id }))}
          className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          Claim at ${gig.amount}
        </button>
      )}

      {myClaim?.state === "pending" && (
        <p className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">
          Claim submitted — waiting for the Poster to select a provider.
        </p>
      )}

      {isPoster && gig.status === "active" && !gig.selected_provider_id && (
        <div className="space-y-2">
          <h2 className="font-medium">Claims ({claims.length})</h2>
          {claims.length === 0 && <p className="text-sm text-neutral-500">No claims yet.</p>}
          {claims.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-3">
              <Link href={`/profile/${c.profile?.username}`} className="text-sm font-medium hover:underline">
                @{c.profile?.username ?? "provider"} · {c.profile?.wom_count ?? 0} WOM
              </Link>
              <button
                disabled={busy}
                onClick={() => run(() => supabase.rpc("select_provider", { p_gig_id: id, p_claim_id: c.id }))}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
              >
                SELECT
              </button>
            </div>
          ))}
        </div>
      )}

      {(isPoster || isSelectedProvider) && gig.selected_provider_id && (
        <>
          {gig.status === "active" && !gig.start_requested_at && isSelectedProvider && (
            <button
              disabled={busy}
              onClick={() => run(() => supabase.rpc("request_start", { p_gig_id: id }))}
              className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60"
            >
              START
            </button>
          )}
          {gig.status === "active" && gig.start_requested_at && isPoster && (
            <button
              disabled={busy}
              onClick={() => run(() => supabase.rpc("approve_start", { p_gig_id: id }))}
              className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60"
            >
              ACCEPT START — LET&apos;S GO
            </button>
          )}
          {gig.status === "active" && gig.start_requested_at && isSelectedProvider && (
            <p className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">Waiting for the Poster to approve start.</p>
          )}

          {gig.status === "in_progress" && !gig.incomplete_choice_phase && (
            <div className="space-y-2 rounded-xl border border-neutral-200 bg-white p-4">
              <h2 className="font-medium">Mark this gig</h2>
              {myCompletion ? (
                <p className="text-sm text-neutral-500">
                  You marked it <strong>{myCompletion}</strong>. Waiting for the other party.
                </p>
              ) : (
                <div className="flex gap-3">
                  <button
                    disabled={busy}
                    onClick={() => run(() => supabase.rpc("submit_completion", { p_gig_id: id, p_outcome: "complete" }))}
                    className="flex-1 rounded-lg bg-blue-600 py-2 font-medium text-white disabled:opacity-60"
                  >
                    COMPLETE
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => run(() => supabase.rpc("submit_completion", { p_gig_id: id, p_outcome: "incomplete" }))}
                    className="flex-1 rounded-lg bg-red-600 py-2 font-medium text-white disabled:opacity-60"
                  >
                    INCOMPLETE
                  </button>
                </div>
              )}
            </div>
          )}

          {gig.status === "in_progress" && gig.incomplete_choice_phase && (
            <div className="space-y-2 rounded-xl border border-neutral-200 bg-white p-4">
              <h2 className="font-medium">Both sides marked Incomplete — choose payment</h2>
              {myIncompleteChoice ? (
                <p className="text-sm text-neutral-500">
                  You chose <strong>{myIncompleteChoice.replace("_", " ")}</strong>. Waiting for the other party.
                </p>
              ) : (
                <div className="flex gap-3">
                  <button
                    disabled={busy}
                    onClick={() => run(() => supabase.rpc("submit_incomplete_choice", { p_gig_id: id, p_choice: "partial_pay" }))}
                    className="flex-1 rounded-lg bg-neutral-800 py-2 font-medium text-white disabled:opacity-60"
                  >
                    PARTIAL PAY
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => run(() => supabase.rpc("submit_incomplete_choice", { p_gig_id: id, p_choice: "no_pay" }))}
                    className="flex-1 rounded-lg bg-neutral-500 py-2 font-medium text-white disabled:opacity-60"
                  >
                    NO PAY
                  </button>
                </div>
              )}
            </div>
          )}

          {gig.status === "awaiting_payment" && (
            <div className="space-y-2 rounded-xl border border-neutral-200 bg-white p-4">
              <h2 className="font-medium">{isPoster ? "Enter Amount Paid" : "Enter Amount Received"}</h2>
              {(isPoster && gig.amount_paid != null) || (isSelectedProvider && gig.amount_received != null) ? (
                <p className="text-sm text-neutral-500">Submitted. Waiting for the other party to confirm the amount.</p>
              ) : (
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={paymentInput}
                    onChange={(e) => setPaymentInput(e.target.value)}
                    className="flex-1 rounded-lg border border-neutral-300 px-3 py-2"
                  />
                  <button
                    disabled={busy || !paymentInput}
                    onClick={() =>
                      run(() => supabase.rpc("submit_payment_amount", { p_gig_id: id, p_amount: Number(paymentInput) }))
                    }
                    className="rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white disabled:opacity-60"
                  >
                    Submit
                  </button>
                </div>
              )}
            </div>
          )}

          {gig.status === "in_progress" || gig.status === "active" ? (
            <ChatPanel gigId={id} currentUserId={user!.id} readOnly={gig.status !== "in_progress" && gig.status !== "active"} />
          ) : (
            (gig.status === "completed" || gig.status === "incomplete") && (
              <ChatPanel gigId={id} currentUserId={user!.id} readOnly />
            )
          )}

          {(gig.status === "completed" || gig.status === "incomplete") && (
            <div className="space-y-2 rounded-xl border border-neutral-200 bg-white p-4">
              <h2 className="font-medium">Feedback</h2>
              {myFeedback ? (
                <p className="text-sm text-neutral-500">Thanks — you submitted feedback ({myFeedback}).</p>
              ) : (
                <div className="flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() => run(() => supabase.rpc("submit_feedback", { p_gig_id: id, p_type: "wom" }))}
                    className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-medium text-white disabled:opacity-60"
                  >
                    👍 WOM (Recommend)
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => run(() => supabase.rpc("submit_feedback", { p_gig_id: id, p_type: "lemon" }))}
                    className="flex-1 rounded-lg bg-neutral-700 py-2 text-sm font-medium text-white disabled:opacity-60"
                  >
                    👎 Lemon (Private)
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => run(() => supabase.rpc("submit_feedback", { p_gig_id: id, p_type: "skip" }))}
                    className="flex-1 rounded-lg bg-neutral-300 py-2 text-sm font-medium text-neutral-800 disabled:opacity-60"
                  >
                    Skip
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {gig.status === "disputed" && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          This gig is under dispute. Resolution isn&apos;t handled in-app yet.
        </p>
      )}
    </div>
  );
}

export default function GigDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <GigDetails id={id} />;
}
