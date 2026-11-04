"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AuthGuard from "@/components/AuthGuard";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import StatusBadge from "@/components/StatusBadge";
import TagChip from "@/components/TagChip";
import { gigTagNames } from "@/lib/tags";
import {
  HELPER_SECTIONS, POSTER_SECTIONS, helperBadge, helperSection, posterSection, proposalCountLabel, shortDate,
} from "@/lib/my-gigs";
import { formatMoney } from "@/lib/money";
import { rpcActionError } from "@/lib/journey";
import type { ClaimState, DirectRequest, DirectRequestState, Gig, GigWithTags } from "@/lib/database.types";

type PosterRow = { gig: GigWithTags; proposals: number; helper: string | null; requestedTo: string | null };
type HelperRow = { gig: GigWithTags; claimState: ClaimState | null; offer: number | null; customer: string | null };
// A sent direct request, as the poster inspects it: who it went to and whether they can accept it yet.
type SentRequestRow = { request: DirectRequest; providerName: string | null };
// A received direct request, as the provider sees it: the gig it's attached to and who sent it.
type ReceivedRequestRow = { request: DirectRequest; gig: Gig; posterName: string | null };

const TONES = {
  pending: "bg-yellow-100 text-yellow-800",
  good: "bg-green-100 text-green-800",
  neutral: "bg-blue-100 text-blue-800",
  bad: "bg-red-100 text-red-800",
};

const unique = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => !!value))];
const gigMeta = (gig: GigWithTags) => [shortDate(gig.scheduled_at), gig.location_text, `Budget ${formatMoney(gig.amount)}`].filter(Boolean).join(" · ");

// Budget is what the poster asked for; once someone is accepted the agreed price (their offer) is what matters.
const agreedLine = (gig: GigWithTags) => gig.selected_provider_id && gig.agreed_amount != null ? `Agreed price: ${formatMoney(gig.agreed_amount)}` : null;

async function usernames(supabase: ReturnType<typeof createClient>, ids: string[]) {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data, error } = await supabase.from("public_profiles").select("id,username").in("id", ids);
  if (error) throw error;
  for (const row of (data ?? []) as { id: string; username: string }[]) names.set(row.id, row.username);
  return names;
}

// Plain render helpers (called, not mounted as components) so the markup stays
// inline in the page tree.
function tagChips(gig: GigWithTags) {
  const names = gigTagNames(gig);
  return names.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{names.map((name) => <TagChip key={name}>{name}</TagChip>)}</div>;
}

const REQUEST_STATE_LABEL: Record<DirectRequestState, string> = {
  pending: "Pending", interested: "Interested", declined: "Declined", accepted: "Accepted", closed: "Closed",
};

function posterCard({ gig, proposals, helper, requestedTo }: PosterRow, savedNonPublic: {
  sentRequests: SentRequestRow[]; busy: string | null; onCancel: (gigId: string) => void; onAccept: (requestId: string) => void;
}) {
  const section = posterSection(gig);
  return (
    <div key={gig.id} className="rounded-xl border border-neutral-200 bg-white shadow-sm">
      <Link href={`/gigs/${gig.id}`} className="block p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-medium">{gig.title}</div>
            <div className="mt-0.5 text-sm text-neutral-500">{gigMeta(gig)}</div>
          </div>
          <StatusBadge status={gig.status} />
        </div>
        {helper && section !== "open" && <p className="mt-2 text-sm text-neutral-600">Helper: @{helper}{agreedLine(gig) ? ` · ${agreedLine(gig)}` : ""}</p>}
        {gig.helper_withdrawn_at && <p className="mt-2 text-sm text-amber-700">Your helper withdrew. You can post it again for everyone.</p>}
        {gig.helper_removed_at && <p className="mt-2 text-sm text-amber-700">You removed your helper. You can post it again for everyone.</p>}
        {gig.requested_helper_id && !gig.selected_provider_id && !gig.helper_withdrawn_at && !gig.helper_removed_at && <p className="mt-2 text-sm text-emerald-800">🔒 Private request{requestedTo ? ` to @${requestedTo}` : ""}</p>}
        {tagChips(gig)}
      </Link>
      {section === "saved_non_public" && (
        <div className="space-y-2 border-t border-neutral-100 px-4 py-3">
          <p className="text-sm text-neutral-600">🔒 Saved privately · not visible to the public</p>
          {savedNonPublic.sentRequests.length === 0 ? (
            <p className="text-sm text-neutral-500">No requests sent yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {savedNonPublic.sentRequests.map(({ request, providerName }) => (
                <li key={request.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>@{providerName ?? "a helper"} — {REQUEST_STATE_LABEL[request.state]}</span>
                  {(request.state === "pending" || request.state === "interested") && (
                    <button type="button" disabled={savedNonPublic.busy === request.id}
                      onClick={() => savedNonPublic.onAccept(request.id)}
                      className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-60">Accept</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-3 pt-1">
            <Link href={`/post/find-helpers?gig=${gig.id}`} className="touch-link text-sm font-medium text-emerald-700">Resume Finding Helpers</Link>
            <button type="button" disabled={savedNonPublic.busy === gig.id} onClick={() => savedNonPublic.onCancel(gig.id)}
              className="text-sm font-medium text-red-700 disabled:opacity-60">Cancel</button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-neutral-100 px-4">
        {section === "open"
          ? proposals > 0
            ? <Link href={`/gigs/${gig.id}#proposals`} className="touch-link text-sm font-semibold text-emerald-700">{proposalCountLabel(proposals)}</Link>
            : <span className="text-sm text-neutral-500">No proposals yet</span>
          : <span />}
        <Link href={`/gigs/${gig.id}`} className="touch-link text-sm font-medium text-emerald-700">View gig</Link>
      </div>
    </div>
  );
}

function receivedRequestCard({ request, gig, posterName }: ReceivedRequestRow, busy: string | null, onRespond: (requestId: string, interested: boolean) => void) {
  return (
    <div key={request.id} className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{gig.title}</div>
          <div className="mt-0.5 text-sm text-neutral-500">{gigMeta(gig)}</div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONES[request.state === "pending" ? "pending" : request.state === "declined" ? "bad" : "neutral"]}`}>
          {REQUEST_STATE_LABEL[request.state]}
        </span>
      </div>
      {posterName && <p className="mt-2 text-sm text-neutral-600">Sent by @{posterName}</p>}
      <p className="mt-1 text-sm text-neutral-600">Offered: {formatMoney(gig.amount)} · {gig.price_type === "negotiable" ? "Negotiable" : "Fixed price"}</p>
      {request.state === "pending" && (
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={busy === request.id} onClick={() => onRespond(request.id, false)}
            className="flex-1 rounded-lg border border-neutral-300 bg-white py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60">Decline</button>
          <button type="button" disabled={busy === request.id} onClick={() => onRespond(request.id, true)}
            className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60">Interested</button>
        </div>
      )}
    </div>
  );
}

function helperCard({ gig, claimState, offer, customer }: HelperRow, userId: string) {
  const section = helperSection(gig, claimState, userId);
  const badge = helperBadge(section, gig, claimState);
  return (
    <div key={gig.id} className="rounded-xl border border-neutral-200 bg-white shadow-sm">
      <Link href={`/gigs/${gig.id}`} className="block p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-medium">{gig.title}</div>
            <div className="mt-0.5 text-sm text-neutral-500">{gigMeta(gig)}</div>
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONES[badge.tone]}`}>{badge.label}</span>
        </div>
        {customer && <p className="mt-2 text-sm text-neutral-600">{section === "requests" ? "Request from" : "Customer:"} @{customer}</p>}
        {section === "requests" && <p className="mt-1 text-sm text-neutral-600">Offered: {formatMoney(gig.amount)} · {gig.price_type === "negotiable" ? "Negotiable" : "Fixed price"}</p>}
        {offer != null && claimState === "pending" && <p className="mt-1 text-sm text-neutral-600">Your offer: {formatMoney(offer)}</p>}
        {gig.selected_provider_id === userId && agreedLine(gig) && <p className="mt-1 text-sm font-medium text-emerald-700">{agreedLine(gig)}</p>}
        {tagChips(gig)}
      </Link>
      <div className="flex justify-end border-t border-neutral-100 px-4">
        <Link href={`/gigs/${gig.id}`} className="touch-link text-sm font-medium text-emerald-700">View gig</Link>
      </div>
    </div>
  );
}

function MyGigsInner() {
  const supabase = createClient();
  const { user } = useAuth();
  const params = useSearchParams();
  const [tab, setTab] = useState<"posted" | "helping">(params.get("tab") === "helping" ? "helping" : "posted");
  const [posted, setPosted] = useState<PosterRow[]>([]);
  const [helping, setHelping] = useState<HelperRow[]>([]);
  const [postedLoading, setPostedLoading] = useState(true);
  const [helpingLoading, setHelpingLoading] = useState(true);
  const [postedError, setPostedError] = useState<string | null>(null);
  const [helpingError, setHelpingError] = useState<string | null>(null);
  const created = params.get("created");
  const [postedReload, setPostedReload] = useState(0);
  const [helpingReload, setHelpingReload] = useState(0);
  // Find Help Profile Swiping v1.0: direct requests are a separate table from claims, so they
  // never show up in the posted/helping queries above -- fetched and rendered independently.
  const [sentRequests, setSentRequests] = useState<Map<string, SentRequestRow[]>>(new Map());
  const [receivedRequests, setReceivedRequests] = useState<ReceivedRequestRow[]>([]);
  const [requestBusy, setRequestBusy] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    async function loadPosted() {
      try {
        const { data, error } = await supabase.from("gigs").select("*, gig_tags(tag:tags(id,name))").eq("poster_id", user!.id).order("created_at", { ascending: false });
        if (error) throw error;
        const gigs = (data as GigWithTags[]) ?? [];
        const ids = gigs.map((gig) => gig.id);
        const [claimsResult, names] = await Promise.all([
          ids.length > 0 ? supabase.from("claims").select("gig_id").in("gig_id", ids).eq("state", "pending") : Promise.resolve({ data: [], error: null }),
          usernames(supabase, unique(gigs.flatMap((gig) => [gig.selected_provider_id, gig.requested_helper_id]))),
        ]);
        if (claimsResult.error) throw claimsResult.error;
        const counts = new Map<string, number>();
        for (const claim of (claimsResult.data ?? []) as { gig_id: string }[]) counts.set(claim.gig_id, (counts.get(claim.gig_id) ?? 0) + 1);
        if (alive) setPosted(gigs.map((gig) => ({ gig, proposals: counts.get(gig.id) ?? 0, helper: gig.selected_provider_id ? names.get(gig.selected_provider_id) ?? null : null,
          requestedTo: gig.requested_helper_id ? names.get(gig.requested_helper_id) ?? null : null })));

        const savedNonPublicIds = gigs.filter((gig) => gig.status === "saved_non_public").map((gig) => gig.id);
        if (savedNonPublicIds.length === 0) { if (alive) setSentRequests(new Map()); return; }
        const { data: requestRows, error: requestError } = await supabase
          .from("direct_requests").select("*").in("gig_id", savedNonPublicIds).order("created_at", { ascending: false });
        if (requestError) throw requestError;
        const requests = (requestRows ?? []) as DirectRequest[];
        const providerNames = await usernames(supabase, unique(requests.map((row) => row.provider_id)));
        const byGig = new Map<string, SentRequestRow[]>();
        for (const request of requests) {
          const list = byGig.get(request.gig_id) ?? [];
          list.push({ request, providerName: providerNames.get(request.provider_id) ?? null });
          byGig.set(request.gig_id, list);
        }
        if (alive) setSentRequests(byGig);
      } catch { if (alive) setPostedError("Couldn't load your gigs. Check your connection and retry."); }
      finally { if (alive) setPostedLoading(false); }
    }
    void loadPosted();
    return () => { alive = false; };
  }, [user, supabase, postedReload]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    async function loadHelping() {
      try {
        const { data: claimRows, error: claimError } = await supabase.from("claims").select("gig_id,state,offer_amount").eq("provider_id", user!.id);
        if (claimError) throw claimError;
        const claimList = (claimRows ?? []) as { gig_id: string; state: ClaimState; offer_amount?: number | null }[];
        const claims = new Map<string, ClaimState>(claimList.map((claim) => [claim.gig_id, claim.state]));
        const offers = new Map<string, number | null>(claimList.map((claim) => [claim.gig_id, claim.offer_amount ?? null]));

        // Requests addressed to this helper have no claim yet, so they are found by the address itself.
        const orParts = [`selected_provider_id.eq.${user!.id}`, `requested_helper_id.eq.${user!.id}`];
        if (claims.size > 0) orParts.push(`id.in.(${[...claims.keys()].join(",")})`);
        const { data, error } = await supabase
          .from("gigs")
          .select("*, gig_tags(tag:tags(id,name))")
          .or(orParts.join(","))
          .order("created_at", { ascending: false });
        if (error) throw error;
        const gigs = (data as GigWithTags[]) ?? [];
        const names = await usernames(supabase, unique(gigs.map((gig) => gig.poster_id)));
        if (alive) setHelping(gigs.map((gig) => ({ gig, claimState: claims.get(gig.id) ?? null, offer: offers.get(gig.id) ?? null, customer: names.get(gig.poster_id) ?? null })));
      } catch { if (alive) setHelpingError("Couldn't load the gigs you're helping with. Check your connection and retry."); }
      finally { if (alive) setHelpingLoading(false); }
    }
    void loadHelping();
    return () => { alive = false; };
  }, [user, supabase, helpingReload]);

  // Direct requests sent to this helper: a separate table from claims (see SentRequestRow/
  // ReceivedRequestRow above), so they never show up in the gigs query just above and are
  // fetched on their own.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    supabase
      .from("direct_requests").select("*, gig:gigs(*)").eq("provider_id", user.id).order("created_at", { ascending: false })
      .then(async ({ data, error }) => {
        if (error || !alive) return;
        const rows = (data ?? []) as (DirectRequest & { gig: Gig | null })[];
        const withGig = rows.filter((row): row is DirectRequest & { gig: Gig } => row.gig != null);
        const names = await usernames(supabase, unique(withGig.map((row) => row.gig.poster_id)));
        if (alive) setReceivedRequests(withGig.map((row) => ({ request: row, gig: row.gig, posterName: names.get(row.gig.poster_id) ?? null })));
      });
    return () => { alive = false; };
  }, [user, supabase, helpingReload]);

  async function cancelSavedGig(gigId: string) {
    if (requestBusy) return;
    setRequestBusy(gigId);
    setRequestError(null);
    const { error } = await supabase.rpc("cancel_gig", { p_gig_id: gigId });
    setRequestBusy(null);
    if (error) { setRequestError(rpcActionError(error)); return; }
    setPostedReload((value) => value + 1);
  }

  async function acceptRequest(requestId: string) {
    if (requestBusy) return;
    setRequestBusy(requestId);
    setRequestError(null);
    const { error } = await supabase.rpc("accept_direct_request", { p_request_id: requestId });
    setRequestBusy(null);
    if (error) { setRequestError(rpcActionError(error)); return; }
    setPostedReload((value) => value + 1);
  }

  async function respondRequest(requestId: string, interested: boolean) {
    if (requestBusy) return;
    setRequestBusy(requestId);
    setRequestError(null);
    const { error } = await supabase.rpc("respond_direct_request", { p_request_id: requestId, p_interested: interested });
    setRequestBusy(null);
    if (error) { setRequestError(rpcActionError(error)); return; }
    setHelpingReload((value) => value + 1);
  }

  const loading = tab === "posted" ? postedLoading : helpingLoading;
  const error = tab === "posted" ? postedError : helpingError;
  function retry() {
    if (tab === "posted") { setPostedLoading(true); setPostedError(null); setPostedReload((value) => value + 1); }
    else { setHelpingLoading(true); setHelpingError(null); setHelpingReload((value) => value + 1); }
  }

  const tabClass = (active: boolean) => `min-h-11 flex-1 rounded-lg px-3 text-sm font-semibold transition-colors ${active ? "bg-white text-emerald-700 shadow-sm" : "text-neutral-500 hover:text-neutral-900"}`;
  const createdGig = created ? posted.find((row) => row.gig.id === created) : undefined;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-xl font-semibold">My Gigs</h1>
      {createdGig && <p role="status" className="text-emerald-700">Gig successfully {createdGig.gig.status === "draft" ? "saved as a draft" : "posted"}. It appears below under I Need Help.</p>}
      <div role="tablist" aria-label="My Gigs" className="flex gap-1 rounded-xl bg-neutral-100 p-1">
        <button role="tab" aria-selected={tab === "posted"} onClick={() => setTab("posted")} className={tabClass(tab === "posted")}>I Need Help</button>
        <button role="tab" aria-selected={tab === "helping"} onClick={() => setTab("helping")} className={tabClass(tab === "helping")}>I&apos;m Helping</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error} <button onClick={retry} className="font-medium underline">Retry</button></p>}
      {requestError && <p role="alert" className="text-sm text-red-600">{requestError}</p>}
      <div role="tabpanel" className="space-y-6">
        {loading ? <p className="text-neutral-500">Loading gigs…</p> : error ? null : tab === "posted" ? (
          posted.length === 0
            ? <p className="text-neutral-500">You haven&apos;t posted a gig yet. <Link href="/post" className="touch-link font-medium text-emerald-700">Post a gig</Link></p>
            : POSTER_SECTIONS.map(({ key, label }) => {
              const rows = posted.filter((row) => posterSection(row.gig) === key);
              if (rows.length === 0) return null;
              return <section key={key} aria-label={label} className="space-y-2">
                <h2 className="text-sm font-semibold text-neutral-500">{label} ({rows.length})</h2>
                {rows.map((row) => posterCard(row, { sentRequests: sentRequests.get(row.gig.id) ?? [], busy: requestBusy, onCancel: (gigId) => void cancelSavedGig(gigId), onAccept: (requestId) => void acceptRequest(requestId) }))}
              </section>;
            })
        ) : (
          helping.length === 0 && receivedRequests.length === 0
            ? <p className="text-neutral-500">You haven&apos;t sent any offers or received any requests yet. <Link href="/browse" className="touch-link font-medium text-emerald-700">Explore gigs</Link></p>
            : <>
              {receivedRequests.length > 0 && (
                <section aria-label="Direct Requests" className="space-y-2">
                  <h2 className="text-sm font-semibold text-neutral-500">Direct Requests ({receivedRequests.length})</h2>
                  {receivedRequests.map((row) => receivedRequestCard(row, requestBusy, (requestId, interested) => void respondRequest(requestId, interested)))}
                </section>
              )}
              {HELPER_SECTIONS.map(({ key, label }) => {
                const rows = helping.filter((row) => helperSection(row.gig, row.claimState, user!.id) === key);
                if (rows.length === 0) return null;
                return <section key={key} aria-label={label} className="space-y-2">
                  <h2 className="text-sm font-semibold text-neutral-500">{label} ({rows.length})</h2>
                  {rows.map((row) => helperCard(row, user!.id))}
                </section>;
              })}
            </>
        )}
      </div>
    </div>
  );
}

export default function MyGigs() {
  return (
    <AuthGuard>
      <Suspense fallback={<p>Loading gigs…</p>}><MyGigsInner /></Suspense>
    </AuthGuard>
  );
}
