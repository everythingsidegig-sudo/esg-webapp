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
import type { ClaimState, GigWithTags } from "@/lib/database.types";

type PosterRow = { gig: GigWithTags; proposals: number; helper: string | null };
type HelperRow = { gig: GigWithTags; claimState: ClaimState | null; offer: number | null; customer: string | null };

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

function posterCard({ gig, proposals, helper }: PosterRow) {
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
        {tagChips(gig)}
      </Link>
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
        {customer && <p className="mt-2 text-sm text-neutral-600">Customer: @{customer}</p>}
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
          usernames(supabase, unique(gigs.map((gig) => gig.selected_provider_id))),
        ]);
        if (claimsResult.error) throw claimsResult.error;
        const counts = new Map<string, number>();
        for (const claim of (claimsResult.data ?? []) as { gig_id: string }[]) counts.set(claim.gig_id, (counts.get(claim.gig_id) ?? 0) + 1);
        if (alive) setPosted(gigs.map((gig) => ({ gig, proposals: counts.get(gig.id) ?? 0, helper: gig.selected_provider_id ? names.get(gig.selected_provider_id) ?? null : null })));
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

        const orParts = [`selected_provider_id.eq.${user!.id}`];
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
      <div role="tabpanel" className="space-y-6">
        {loading ? <p className="text-neutral-500">Loading gigs…</p> : error ? null : tab === "posted" ? (
          posted.length === 0
            ? <p className="text-neutral-500">You haven&apos;t posted a gig yet. <Link href="/post" className="touch-link font-medium text-emerald-700">Post a gig</Link></p>
            : POSTER_SECTIONS.map(({ key, label }) => {
              const rows = posted.filter((row) => posterSection(row.gig) === key);
              if (rows.length === 0) return null;
              return <section key={key} aria-label={label} className="space-y-2">
                <h2 className="text-sm font-semibold text-neutral-500">{label} ({rows.length})</h2>
                {rows.map(posterCard)}
              </section>;
            })
        ) : (
          helping.length === 0
            ? <p className="text-neutral-500">You haven&apos;t sent any offers yet. <Link href="/browse" className="touch-link font-medium text-emerald-700">Explore gigs</Link></p>
            : HELPER_SECTIONS.map(({ key, label }) => {
              const rows = helping.filter((row) => helperSection(row.gig, row.claimState, user!.id) === key);
              if (rows.length === 0) return null;
              return <section key={key} aria-label={label} className="space-y-2">
                <h2 className="text-sm font-semibold text-neutral-500">{label} ({rows.length})</h2>
                {rows.map((row) => helperCard(row, user!.id))}
              </section>;
            })
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
