"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import SelectionChip from "@/components/SelectionChip";
import AreaPicker, { type Area } from "@/components/AreaPicker";
import AcceptConfirm from "@/components/AcceptConfirm";
import FullGigView from "@/components/FullGigView";
import GigTile from "@/components/GigTile";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { rpcActionError, safeNext } from "@/lib/journey";
import type { GigWithTags, Tag } from "@/lib/database.types";
import { SERVICE_TYPES as CATEGORIES } from "@/lib/services";
import { loadTagCatalog, gigTagNames } from "@/lib/tags";
import { hasPromptedForLocation, haversineKm, loadJourneyLocation, markLocationPrompted } from "@/lib/location";
import { loadDecidedGigIds, markGigDecided, unmarkGigDecided } from "@/lib/swipe";
import RadiusSlider from "@/components/RadiusSlider";

const SERVICE_TYPES = [
  "All Services",
  ...CATEGORIES,
];

function BrowseInner() {
  const supabase = createClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  // The area saved on /location (or wherever it was last set) carries over here, the
  // same way Find a Helper picks it up; editable right on this page too via AreaPicker.
  // localStorage isn't visible to the server render, so this is read after hydration
  // (as Find a Helper already does) rather than as the initial state, which would mismatch.
  const [area, setArea] = useState<Area>({ text: "", lat: null, lng: null });
  const { lat, lng } = area;

  const [gigs, setGigs] = useState<GigWithTags[]>([]);
  const [service, setService] = useState("All Services");
  const [radiusKm, setRadiusKm] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tagCatalog, setTagCatalog] = useState<Record<string, Tag[]>>({});
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  // Gig Swipe Discovery v1.0: gigs swiped (or Accepted/Rejected) on in this session
  // stop reappearing in the feed -- session-only, per the confirmed default.
  const [decidedIds, setDecidedIds] = useState<string[]>(() => loadDecidedGigIds());
  const [viewingGig, setViewingGig] = useState<GigWithTags | null>(null);
  const [confirming, setConfirming] = useState<GigWithTags | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lastRejected, setLastRejected] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadJourneyLocation();
    if (saved.text) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setArea(saved);
      return;
    }
    // Arrived here directly (not via Home), with no area set yet: the same one-time nudge Home
    // gives, so this isn't the one way into the app that silently skips asking altogether.
    if (!hasPromptedForLocation()) {
      markLocationPrompted();
      router.replace("/location?next=/browse");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    Promise.resolve(supabase
      .from("gigs")
      .select("*, gig_tags(tag:tags(id,name))")
      .eq("status", "active")
      .order("created_at", { ascending: false }))
      .then(({ data, error }) => {
        if (error) setError("Couldn't load gigs. Please refresh and try again.");
        setGigs((data as GigWithTags[]) ?? []);
        setLoading(false);
      }).catch(() => { setError("Couldn't load gigs. Please refresh and try again."); setLoading(false); });
  }, [supabase]);

  useEffect(() => {
    loadTagCatalog(supabase).then(setTagCatalog).catch(() => {});
  }, [supabase]);

  // ESG Gig Swipe Discovery v1.0, AT-05: a signed-out Accept sends the visitor to sign in
  // with this exact gig as `next` (already a whitelisted destination); once the list has
  // loaded, a `resume` id in the URL reopens that gig's confirm step automatically instead
  // of losing the card. (Registering a brand-new account still lands at Home as it always
  // does -- no cross-tab intent memory is built for that path, matching this app's existing,
  // deliberate "registration never resumes a protected journey" rule.)
  useEffect(() => {
    if (loading) return;
    const resumeId = searchParams.get("resume");
    if (!resumeId) return;
    const resumed = gigs.find((g) => g.id === resumeId);
    router.replace("/browse");
    // Reacting to a query param set by a prior navigation (the post-sign-in redirect), not
    // deriving state from props/state already available this render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (resumed) setConfirming(resumed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, gigs]);

  const categoryTags = useMemo(
    () => service === "All Services" ? [] : (tagCatalog[service] ?? []),
    [service, tagCatalog]
  );
  const selectedTagNames = useMemo(
    () => new Set(categoryTags.filter((t) => selectedTagIds.includes(t.id)).map((t) => t.name)),
    [categoryTags, selectedTagIds]
  );

  const decided = useMemo(() => new Set(decidedIds), [decidedIds]);
  const filtered = useMemo(() => {
    return gigs
      .filter((g) => !decided.has(g.id))
      .filter((g) => service === "All Services" || g.service_type === service)
      .filter((g) => selectedTagNames.size === 0 || gigTagNames(g).some((name) => selectedTagNames.has(name)))
      .filter((g) => {
        if (!lat || !lng || g.lat == null || g.lng == null) return true;
        return haversineKm(lat, lng, g.lat, g.lng) <= radiusKm;
      });
  }, [gigs, decided, service, selectedTagNames, radiusKm, lat, lng]);

  function requestAccept(gig: GigWithTags) {
    if (!user) {
      router.push(`/auth/sign-in?next=${encodeURIComponent(safeNext(`/browse?resume=${gig.id}`))}`);
      return;
    }
    setConfirmError(null);
    setConfirming(gig);
  }

  function reject(gig: GigWithTags) {
    markGigDecided(gig.id);
    setDecidedIds((current) => [...current, gig.id]);
    setLastRejected(gig.id);
    if (viewingGig?.id === gig.id) setViewingGig(null);
  }

  function undoReject() {
    if (!lastRejected) return;
    unmarkGigDecided(lastRejected);
    setDecidedIds((current) => current.filter((id) => id !== lastRejected));
    setLastRejected(null);
  }

  async function confirmAccept(amount: number, message: string | null) {
    if (!confirming) return;
    setConfirmBusy(true);
    setConfirmError(null);
    const { error: claimError } = await supabase.rpc("create_claim", { p_gig_id: confirming.id, p_offer_amount: amount, p_message: message });
    setConfirmBusy(false);
    if (claimError) { setConfirmError(rpcActionError(claimError)); return; }
    markGigDecided(confirming.id);
    setDecidedIds((current) => [...current, confirming.id]);
    setViewingGig(null);
    setConfirming(null);
    setLastRejected(null);
    setToast(`Claim sent for "${confirming.title}". The poster has been notified.`);
  }

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!lastRejected) return;
    const timer = setTimeout(() => setLastRejected(null), 4000);
    return () => clearTimeout(timer);
  }, [lastRejected]);

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Gigs Nearby</h1>

      <AreaPicker area={area} onChange={setArea} radiusKm={radiusKm} />

      <div className="flex flex-wrap gap-3">
        <fieldset className="min-w-0 w-full">
          <legend className="text-sm font-medium">Service category</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {SERVICE_TYPES.map((s) => <SelectionChip key={s} selected={service === s} onClick={() => { setService(s); setSelectedTagIds([]); }}>{s}</SelectionChip>)}
          </div>
        </fieldset>
        {categoryTags.length > 0 && (
          <fieldset className="min-w-0 w-full">
            <legend className="text-sm font-medium">Tags</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {categoryTags.map((tag) => (
                <SelectionChip key={tag.id} selected={selectedTagIds.includes(tag.id)}
                  onClick={() => setSelectedTagIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])}>
                  {tag.name}
                </SelectionChip>
              ))}
            </div>
          </fieldset>
        )}
        {lat && lng && (
          <div className="w-full max-w-xs">
            <RadiusSlider valueKm={radiusKm} onChange={setRadiusKm} id="browse-radius" />
          </div>
        )}
      </div>

      {loading && <p className="text-neutral-500">Loading gigs…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && filtered.length === 0 && (
        <p className="text-neutral-500">No gigs found. Try widening your filters{decidedIds.length > 0 ? ", or check back later for new ones" : ""}.</p>
      )}

      <div className="grid gap-3">
        {filtered.map((gig) => (
          <GigTile key={gig.id} gig={gig} onView={() => setViewingGig(gig)} onRequestAccept={() => requestAccept(gig)} onReject={() => reject(gig)} />
        ))}
      </div>

      {viewingGig && !confirming && (
        <FullGigView gig={viewingGig} onClose={() => setViewingGig(null)} onAccept={() => requestAccept(viewingGig)} onReject={() => reject(viewingGig)} />
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="presentation">
          <div className="w-full max-w-md">
            <AcceptConfirm gig={confirming} busy={confirmBusy} error={confirmError}
              onConfirm={confirmAccept} onCancel={() => { setConfirming(null); setConfirmError(null); }} />
          </div>
        </div>
      )}

      {toast && (
        <div role="status" className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-lg bg-neutral-900 px-4 py-3 text-center text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
      {lastRejected && !toast && (
        <div role="status" className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md items-center justify-between gap-3 rounded-lg bg-neutral-900 px-4 py-3 text-sm text-white shadow-lg">
          <span>Skipped.</span>
          <button type="button" onClick={undoReject} className="font-semibold text-emerald-300 hover:underline">Undo</button>
        </div>
      )}
    </div>
  );
}

export default function Browse() {
  return (
    <Suspense>
      <BrowseInner />
    </Suspense>
  );
}
