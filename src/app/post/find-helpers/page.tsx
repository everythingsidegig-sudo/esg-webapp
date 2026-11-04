"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AuthGuard from "@/components/AuthGuard";
import ProviderCard, { type ProviderStats } from "@/components/ProviderCard";
import FullProviderView from "@/components/FullProviderView";
import RadiusSlider from "@/components/RadiusSlider";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { rpcActionError } from "@/lib/journey";
import { formatMoney } from "@/lib/money";
import { priceLabel } from "@/lib/helper-request";
import { haversineKm } from "@/lib/location";
import { withProfileTags } from "@/lib/tags";
import { loadSkippedProviderIds, markProviderSkipped } from "@/lib/swipe";
import type { Gig, PublicProfile, PublicProfileWithTags } from "@/lib/database.types";

const DEFAULT_RADIUS_KM = 10;

// Find Help Profile Swiping v1.0: the poster's swipe deck for a gig just saved via "Save & Find
// Helpers Nearby" (/post?gig=<id> sets the status to saved_non_public; this page is reached
// only from there, or from My Gigs' "Resume Finding Helpers"). One provider shown at a time
// ("Profile 1 of N", matching the spec's own mockup), not a scrollable list like Browse's gig
// deck -- a deliberately different layout for a deliberately different feature.
function FindHelpersInner() {
  const supabase = createClient();
  const params = useSearchParams();
  const { user } = useAuth();
  const gigId = params.get("gig");

  const [gig, setGig] = useState<Gig | null>(null);
  const [gigError, setGigError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!gigId);
  const [error, setError] = useState<string | null>(null);
  const [radiusKm, setRadiusKm] = useState(DEFAULT_RADIUS_KM);
  const [providers, setProviders] = useState<(PublicProfileWithTags & { distanceKm?: number })[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [stats, setStats] = useState<Map<string, ProviderStats>>(new Map());
  const [skippedIds, setSkippedIds] = useState<string[]>(() => gigId ? loadSkippedProviderIds(gigId) : []);
  const [viewing, setViewing] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);

  useEffect(() => {
    // No gig id at all is a render-time fact (the URL), not something fetched -- handled
    // directly in the JSX below instead of round-tripping through state.
    if (!gigId) return;
    let active = true;
    Promise.resolve(supabase.from("gigs").select("*").eq("id", gigId).maybeSingle())
      .then(({ data, error }) => {
        if (!active) return;
        if (error || !data) { setGigError("Couldn't find that gig."); setLoading(false); return; }
        const row = data as Gig;
        if (row.status !== "saved_non_public") {
          setGigError("This gig is no longer open for finding helpers.");
          setLoading(false);
          return;
        }
        setGig(row);
      }).catch(() => { if (active) { setGigError("Couldn't find that gig."); setLoading(false); } });
    return () => { active = false; };
  }, [supabase, gigId]);

  useEffect(() => {
    if (!gig || !user) return;
    let active = true;
    // Fetching from Supabase (an external system) on gig/radius change, not deriving state
    // from props already available this render -- the lint rule can't tell those apart.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    Promise.all([
      supabase.from("public_profiles").select("*").contains("skills", JSON.stringify([gig.service_type])).neq("id", user.id),
      supabase.from("direct_requests").select("provider_id").eq("gig_id", gig.id).in("state", ["pending", "interested"]),
    ]).then(async ([profilesRes, requestsRes]) => {
      if (profilesRes.error) throw profilesRes.error;
      if (requestsRes.error) throw requestsRes.error;
      // Avoid re-contacting a provider who already has an active request on this gig (spec
      // section 9) -- excluded here, server-side, so it holds even in a brand-new session,
      // not just via the client-only skip list below.
      const alreadyRequested = new Set((requestsRes.data as { provider_id: string }[] | null ?? []).map((row) => row.provider_id));
      const eligible = ((profilesRes.data as PublicProfile[] | null) ?? []).filter((profile) => !alreadyRequested.has(profile.id));
      return withProfileTags(supabase, eligible);
    }).then((rows) => {
      if (!active) return;
      const located = gig.lat != null && gig.lng != null;
      const withDistance = rows
        .map((profile) => ({
          ...profile,
          distanceKm: located && profile.public_lat != null && profile.public_lng != null
            ? haversineKm(gig.lat!, gig.lng!, profile.public_lat, profile.public_lng) : undefined,
        }))
        .filter((profile) => !located || profile.distanceKm == null || profile.distanceKm <= radiusKm)
        .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
      setProviders(withDistance);
      setTotalCount(withDistance.length);
      setLoading(false);
    }, () => {
      if (!active) return;
      setError("Couldn't load nearby helpers. Please refresh and try again.");
      setLoading(false);
    });
    return () => { active = false; };
  }, [supabase, gig, user, radiusKm]);

  useEffect(() => {
    if (providers.length === 0) return;
    let active = true;
    Promise.all(providers.map((profile) => supabase.rpc("get_public_stats", { p_profile_id: profile.id })))
      .then((results) => {
        if (!active) return;
        const next = new Map<string, ProviderStats>();
        results.forEach((result, index) => {
          const row = (result.data as { gigs_worked_count: number; wom_percentage: number | null }[] | null)?.[0];
          next.set(providers[index].id, { gigsWorkedCount: row?.gigs_worked_count ?? 0, womPercentage: row?.wom_percentage ?? null });
        });
        setStats(next);
      }).catch(() => {});
    return () => { active = false; };
  }, [supabase, providers]);

  const remaining = useMemo(() => providers.filter((profile) => !skippedIds.includes(profile.id)), [providers, skippedIds]);
  const current = remaining[0] ?? null;

  function skip(providerId: string) {
    if (!gigId) return;
    markProviderSkipped(gigId, providerId);
    setSkippedIds((ids) => [...ids, providerId]);
    if (viewing === providerId) setViewing(null);
  }

  async function sendGig(providerId: string) {
    if (!gig || sending) return;
    setSending(true);
    const { error } = await supabase.rpc("send_direct_request", { p_gig_id: gig.id, p_provider_id: providerId });
    setSending(false);
    if (error) {
      setToastIsError(true);
      setToast(rpcActionError(error));
      return;
    }
    if (!gigId) return;
    markProviderSkipped(gigId, providerId);
    setSkippedIds((ids) => [...ids, providerId]);
    setViewing(null);
    setToastIsError(false);
    const name = providers.find((p) => p.id === providerId)?.username;
    setToast(name ? `Gig sent to @${name}.` : "Gig sent.");
  }

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!gigId || gigError) {
    return <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-semibold">Find Helpers Nearby</h1>
      <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{gigError ?? "No gig was specified."}</p>
      <Link href="/my-gigs" className="touch-link block text-sm font-medium text-emerald-700">← Back to My Gigs</Link>
    </div>;
  }
  if (!gig) return <p className="text-neutral-500">Loading…</p>;

  const viewingProfile = viewing ? remaining.find((p) => p.id === viewing) ?? null : null;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="sticky top-0 z-10 -mx-4 space-y-1 border-b border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:px-4">
        <h1 className="text-lg font-semibold">{gig.title}</h1>
        <p className="text-sm text-neutral-600">{gig.service_type} · {formatMoney(gig.amount)} · {priceLabel(gig.price_type)} · {radiusKm} km radius</p>
      </div>

      <div className="max-w-xs"><RadiusSlider valueKm={radiusKm} onChange={setRadiusKm} id="find-helpers-radius" /></div>

      {loading && <p className="text-neutral-500">Loading nearby helpers…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && totalCount === 0 && (
        <p className="text-neutral-500">No helpers found for {gig.service_type} yet. Try widening the radius.</p>
      )}
      {!loading && !error && totalCount > 0 && !current && (
        <p className="text-neutral-500">That&apos;s everyone nearby for now. Check My Gigs to see who you&apos;ve sent this to, or widen the radius above.</p>
      )}
      {current && (
        <>
          <p className="text-center text-sm text-neutral-500">Profile {totalCount - remaining.length + 1} of {totalCount}</p>
          <ProviderCard
            key={current.id}
            profile={current}
            category={gig.service_type}
            distanceKm={current.distanceKm}
            stats={stats.get(current.id) ?? null}
            onView={() => setViewing(current.id)}
            onSendGig={() => void sendGig(current.id)}
            onSkip={() => skip(current.id)}
          />
        </>
      )}

      {viewingProfile && (
        <FullProviderView
          profile={viewingProfile}
          category={gig.service_type}
          distanceKm={viewingProfile.distanceKm}
          stats={stats.get(viewingProfile.id) ?? null}
          disabled={sending}
          onClose={() => setViewing(null)}
          onSendGig={() => void sendGig(viewingProfile.id)}
          onSkip={() => skip(viewingProfile.id)}
        />
      )}

      {toast && (
        <div role="status" className={`fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-lg px-4 py-3 text-center text-sm font-medium text-white shadow-lg ${toastIsError ? "bg-red-600" : "bg-neutral-900"}`}>
          {toast}
        </div>
      )}

      <Link href="/my-gigs" className="touch-link block text-center text-sm font-medium text-emerald-700">Done for now — go to My Gigs</Link>
    </div>
  );
}

export default function FindHelpersForGig() {
  return (
    <AuthGuard>
      <Suspense fallback={<p>Loading…</p>}>
        <FindHelpersInner />
      </Suspense>
    </AuthGuard>
  );
}
