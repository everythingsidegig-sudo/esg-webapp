"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AreaPicker, { type Area } from "@/components/AreaPicker";
import HelperSignInPrompt from "@/components/HelperSignInPrompt";
import OptionSheet from "@/components/OptionSheet";
import SelectionChip from "@/components/SelectionChip";
import TagChip from "@/components/TagChip";
import { useAuth } from "@/lib/auth-context";
import { helperProfileHref } from "@/lib/journey";
import { createClient } from "@/lib/supabase/client";
import type { PublicProfile, PublicProfileWithTags, Tag } from "@/lib/database.types";
import { SERVICE_TYPES, SPECIALIZATION_PROMPTS } from "@/lib/services";
import { loadTagCatalog, profileTagsForCategory, withProfileTags } from "@/lib/tags";
import { pathLabel, searchCatalog, type SearchHit } from "@/lib/service-selection";
import { hasPromptedForLocation, haversineKm, loadJourneyLocation, markLocationPrompted } from "@/lib/location";
import RadiusSlider from "@/components/RadiusSlider";

const DEFAULT_RADIUS_KM = 10;

// A signed-out visitor can see the list but not the profile behind a card: the click is
// intercepted to show the sign-in prompt. The link itself still points at the profile route,
// which the server (src/proxy.ts) protects, so a new tab, middle click or typed URL is covered too.
function HelperCard({ profile, category, distanceKm, gated = false, onGate, plainLink = false }: {
  profile: PublicProfileWithTags; category: string; distanceKm?: number; gated?: boolean; onGate?: (username: string) => void;
  // A result from "Search by service": the profile opens without the category-search context, because
  // the private-request flow still works from the old categories on a helper's profile.
  plainLink?: boolean;
}) {
  const tags = profileTagsForCategory(profile, category);
  // Every service the helper has chosen to offer, the one searched for first. Nothing is capped
  // or invented: the list is exactly the skills on the helper's profile.
  const offered = [...new Set(profile.skills ?? [])];
  const services = [...offered.filter((skill) => skill === category), ...offered.filter((skill) => skill !== category)];
  return (
    <Link
      href={helperProfileHref(profile.username, plainLink ? null : category) ?? "/find-helper"}
      onClick={(event) => { if (gated) { event.preventDefault(); onGate?.(profile.username); } }}
      className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm hover:shadow-md"
    >
      {profile.photo_url ? (
        <img src={profile.photo_url} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover" />
      ) : (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-lg">👤</div>
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium">@{profile.username}</div>
        <div className="text-sm text-neutral-500">
          {profile.wom_count} WOM{distanceKm != null && ` · ${distanceKm.toFixed(1)} km away`}
        </div>
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((tag) => <TagChip key={tag.id}>{tag.name}</TagChip>)}
          </div>
        )}
        {services.length > 0 && (
          <div className="mt-1.5 text-xs text-neutral-500">
            <span className="font-medium text-neutral-600">Offers:</span>{" "}
            <ul aria-label={`Services offered by @${profile.username}`} className="inline">
              {services.map((skill, index) => <li key={skill} className="inline">{index > 0 && " · "}{skill}</li>)}
            </ul>
          </div>
        )}
      </div>
    </Link>
  );
}

// Only helpers with an opted-in public location can be placed on the map: their distance is
// shown whenever the visitor's area is known, but it never narrows results when "Any distance"
// is selected. A radius filters and sorts nearest-first. Never surfaces raw lat/lng.
function withDistance(list: PublicProfileWithTags[], radiusKm: number | null, searcher: { lat: number | null; lng: number | null }) {
  const located = searcher.lat != null && searcher.lng != null;
  const measure = (profile: PublicProfileWithTags) => located && profile.public_lat != null && profile.public_lng != null
    ? haversineKm(searcher.lat!, searcher.lng!, profile.public_lat, profile.public_lng) : undefined;
  if (radiusKm === null || !located) {
    return list.map((profile) => ({ profile, distanceKm: measure(profile) }));
  }
  return list
    .filter((profile) => profile.public_lat != null && profile.public_lng != null)
    .map((profile) => ({ profile, distanceKm: measure(profile)! }))
    .filter((entry) => entry.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

export default function FindHelper() {
  const supabase = createClient();
  const router = useRouter();
  const [category, setCategory] = useState<string | null>(null);
  const [tagCatalog, setTagCatalog] = useState<Record<string, Tag[]>>({});
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [helpers, setHelpers] = useState<PublicProfileWithTags[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Defaults to a visible radius, same as Browse's slider, rather than hidden behind
  // "Any distance" -- opting into no limit is still one click away.
  const [radiusKm, setRadiusKm] = useState<number | null>(DEFAULT_RADIUS_KM);
  const [searcherLocation, setSearcherLocation] = useState<Area>({ text: "", lat: null, lng: null });
  const { user, loading: authLoading } = useAuth();
  const gated = !authLoading && !user;
  const [gate, setGate] = useState<string | null>(null);
  // "Search by service": the new catalog (Category > Service > Subservice). Helpers are matched on what they
  // OFFER, by id, through find_providers_by_service(); a member's "Services I Need Help" list never matches.
  const [serviceQuery, setServiceQuery] = useState("");
  const [serviceFilter, setServiceFilter] = useState<SearchHit | null>(null);
  const [serviceHelpers, setServiceHelpers] = useState<PublicProfileWithTags[]>([]);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);

  useEffect(() => {
    if (!serviceFilter) return;
    let active = true;
    // Loading from the database on a new filter, not deriving state from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setServiceLoading(true);
    setServiceError(null);
    Promise.resolve(supabase.rpc("find_providers_by_service", { p_level: serviceFilter.level, p_id: serviceFilter.id }))
      .then(async ({ data, error }) => {
        if (error) throw error;
        const ids = ((data as { provider_id?: unknown }[] | null) ?? []).map((row) => row.provider_id).filter((id): id is string => typeof id === "string" && id !== user?.id);
        if (ids.length === 0) return [] as PublicProfileWithTags[];
        const { data: profiles, error: profileError } = await supabase.from("public_profiles").select("*").in("id", ids);
        if (profileError) throw profileError;
        return withProfileTags(supabase, (profiles as PublicProfile[] | null) ?? []);
      })
      .then((rows) => { if (active) { setServiceHelpers(rows); setServiceLoading(false); } },
        () => { if (active) { setServiceError("Couldn't load helpers. Please refresh and try again."); setServiceHelpers([]); setServiceLoading(false); } });
    return () => { active = false; };
  }, [supabase, serviceFilter, user]);

  useEffect(() => {
    loadTagCatalog(supabase).then(setTagCatalog).catch(() => {});
  }, [supabase]);

  useEffect(() => {
    if (!category) return;
    let active = true;
    let query = supabase
      .from("public_profiles")
      .select("*")
      // skills is JSONB: a JS array would be sent as the PostgreSQL array literal cs.{Yard Work}
      // (22P02 / HTTP 400), so pass the JSON text to get cs.["Yard Work"].
      .contains("skills", JSON.stringify([category]));
    // Never show a signed-in helper their own profile in their own search.
    if (user) query = query.neq("id", user.id);
    query
      .then(async ({ data, error }) => {
        if (error) throw error;
        return withProfileTags(supabase, (data as PublicProfile[] | null) ?? []);
      })
      .then((rows) => {
        if (!active) return;
        setHelpers(rows);
        setLoading(false);
      }, () => {
        if (!active) return;
        setError("Couldn't load helpers. Please refresh and try again.");
        setHelpers([]);
        setLoading(false);
      });
    return () => { active = false; };
  }, [supabase, category, user]);

  // Arriving with ?category=... (back from a profile, or after signing in) restores that search,
  // and the area saved earlier in this visit (or kept across sign-in) is picked up. Both live in
  // the browser, which the server render cannot see, so they are read after hydration.
  useEffect(() => {
    const saved = loadJourneyLocation();
    if (saved.text) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearcherLocation(saved);
    } else if (!hasPromptedForLocation() && typeof window !== "undefined") {
      // Arrived here directly (not via Home), with no area set yet: the same one-time nudge Home
      // gives, so this isn't the one way into the app that silently skips asking altogether.
      markLocationPrompted();
      router.replace(`/location?next=${encodeURIComponent(`/find-helper${window.location.search}`)}`);
      return;
    }
    if (typeof window === "undefined") return;
    const wanted = new URLSearchParams(window.location.search).get("category");
    if (wanted && (SERVICE_TYPES as readonly string[]).includes(wanted)) {
      chooseCategory(wanted);
    }
    // Once, on arrival; chooseCategory only calls setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const categoryTags = category ? (tagCatalog[category] ?? []) : [];
  const chosenTags = categoryTags.filter((tag) => selectedTagIds.includes(tag.id));
  const toggleTag = (id: string) => setSelectedTagIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  function chooseCategory(next: string) {
    // Keep the chosen category in the address so Back, a shared link, or a return from
    // sign-in lands on the same search (the history entry is replaced, not added).
    try { window.history.replaceState(null, "", `/find-helper?category=${encodeURIComponent(next)}`); } catch { /* no window (tests) */ }
    setCategory(next);
    setServiceFilter(null);
    setServiceQuery("");
    setSelectedTagIds([]);
    setSheetOpen(false);
    setLoading(true);
    setError(null);
  }

  const { matching, others } = useMemo(() => {
    if (selectedTagIds.length === 0 || !category) return { matching: helpers, others: [] as PublicProfileWithTags[] };
    const matching: PublicProfileWithTags[] = [];
    const others: PublicProfileWithTags[] = [];
    for (const helper of helpers) {
      const tags = profileTagsForCategory(helper, category);
      if (tags.some((tag) => selectedTagIds.includes(tag.id))) matching.push(helper);
      else if (tags.length === 0) others.push(helper);
      // Has specialization tags for this category, but none match the filter: excluded entirely.
    }
    return { matching, others };
  }, [helpers, selectedTagIds, category]);

  function chooseService(hit: SearchHit) {
    try { window.history.replaceState(null, "", "/find-helper"); } catch { /* no window (tests) */ }
    setCategory(null);
    setSelectedTagIds([]);
    setServiceQuery("");
    setServiceHelpers([]);
    setServiceFilter(hit);
  }
  const serviceHits = serviceQuery.trim() ? searchCatalog(serviceQuery, 8) : [];
  const serviceByDistance = useMemo(() => withDistance(serviceHelpers, radiusKm, searcherLocation), [serviceHelpers, radiusKm, searcherLocation]);

  const matchingByDistance = useMemo(() => withDistance(matching, radiusKm, searcherLocation), [matching, radiusKm, searcherLocation]);
  const othersByDistance = useMemo(() => withDistance(others, radiusKm, searcherLocation), [others, radiusKm, searcherLocation]);

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Find a Helper</h1>

      <AreaPicker area={searcherLocation} onChange={setSearcherLocation} radiusKm={radiusKm} />

      <div className="max-w-xs space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={radiusKm === null}
            onChange={(e) => setRadiusKm(e.target.checked ? null : DEFAULT_RADIUS_KM)} />
          Any distance
        </label>
        {radiusKm !== null && <RadiusSlider valueKm={radiusKm} onChange={setRadiusKm} id="find-helper-radius" />}
      </div>

      <div className="min-w-0 w-full space-y-2">
        <label htmlFor="find-helper-service" className="text-sm font-medium">Search by service</label>
        <input id="find-helper-service" type="search" placeholder="e.g. Mobile App Testing, dog walking, tile" value={serviceQuery}
          onChange={(event) => setServiceQuery(event.target.value)} className="min-h-11 w-full rounded-lg border border-neutral-300 px-3 py-2" />
        {serviceQuery.trim() && (serviceHits.length === 0
          ? <p className="text-sm text-neutral-500">No matching services.</p>
          : <ul aria-label="Matching services" className="space-y-1">
            {serviceHits.map((hit) => (
              <li key={hit.id}><button type="button" onClick={() => chooseService(hit)}
                className="flex min-h-11 w-full items-center rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-sm hover:bg-neutral-50">{pathLabel(hit)}</button></li>
            ))}
          </ul>)}
      </div>

      {serviceFilter && (
        <section aria-label="Helpers offering this service" className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-500">Helpers offering {pathLabel(serviceFilter)}</h2>
            <button type="button" onClick={() => { setServiceFilter(null); setServiceHelpers([]); }} className="touch-link shrink-0 text-sm font-medium text-emerald-700">Clear</button>
          </div>
          {serviceLoading && <p className="text-neutral-500">Loading helpers…</p>}
          {serviceError && <p role="alert">{serviceError}</p>}
          {!serviceLoading && !serviceError && serviceByDistance.length === 0 && <p className="text-neutral-500">No helpers offer this yet.</p>}
          <div className="grid gap-3">
            {serviceByDistance.map(({ profile, distanceKm }) => <HelperCard key={profile.id} profile={profile} category="" distanceKm={distanceKm} gated={gated} onGate={setGate} plainLink />)}
          </div>
        </section>
      )}

      <fieldset className="min-w-0 w-full">
        <legend className="text-sm font-medium">Choose a category</legend>
        <div role="radiogroup" aria-labelledby="find-helper-category-label" className="mt-2 flex flex-wrap gap-2">
          {SERVICE_TYPES.map((item, index) => (
            <SelectionChip key={item} role="radio"
              selected={category === item}
              tabIndex={category === item || (category === null && index === 0) ? 0 : -1}
              onClick={() => chooseCategory(item)}
              onKeyDown={(event) => {
                const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
                if (direction === undefined) return;
                event.preventDefault();
                const next = (index + direction + SERVICE_TYPES.length) % SERVICE_TYPES.length;
                chooseCategory(SERVICE_TYPES[next]);
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
              }}>
              {item}
            </SelectionChip>
          ))}
        </div>
      </fieldset>

      {!category && !serviceFilter && <p className="text-neutral-500">Choose a category to see nearby helpers.</p>}

      {category && categoryTags.length > 0 && (
        <fieldset className="min-w-0 w-full">
          <legend className="text-sm font-medium">Specializations (optional)</legend>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {chosenTags.map((tag) => (
              <span key={tag.id} className="inline-flex items-center rounded-full bg-neutral-100 pl-3 text-sm text-neutral-800">
                {tag.name}
                <button type="button" onClick={() => toggleTag(tag.id)} aria-label={`Remove ${tag.name}`}
                  className="flex h-11 w-11 items-center justify-center rounded-full text-neutral-500 hover:text-neutral-900">✕</button>
              </span>
            ))}
            {chosenTags.length === 0 && <span className="text-sm text-neutral-500">Any specialization.</span>}
            <button type="button" onClick={() => setSheetOpen(true)} aria-label="Add specializations"
              className="inline-flex min-h-9 items-center rounded-full border border-dashed border-emerald-600 px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-50">+ Add</button>
          </div>
        </fieldset>
      )}

      {category && radiusKm !== null && (searcherLocation.lat == null || searcherLocation.lng == null) && (
        <p role="status" className="text-sm text-neutral-600">Add a ZIP code or use your location above to filter by distance.</p>
      )}
      {category && loading && <p className="text-neutral-500">Loading helpers…</p>}
      {error && <p role="alert">{error}</p>}
      {category && !loading && !error && matchingByDistance.length === 0 && othersByDistance.length === 0 && (
        <p className="text-neutral-500">No helpers found for {category} yet.</p>
      )}

      {category && matchingByDistance.length > 0 && (
        <div className="space-y-2">
          {selectedTagIds.length > 0 && <h2 className="text-sm font-semibold text-neutral-500">Matching specializations</h2>}
          <div className="grid gap-3">
            {matchingByDistance.map(({ profile, distanceKm }) => <HelperCard key={profile.id} profile={profile} category={category} distanceKm={distanceKm} gated={gated} onGate={setGate} />)}
          </div>
        </div>
      )}

      {category && othersByDistance.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-neutral-500">Other {category} helpers</h2>
          <div className="grid gap-3">
            {othersByDistance.map(({ profile, distanceKm }) => <HelperCard key={profile.id} profile={profile} category={category} distanceKm={distanceKm} gated={gated} onGate={setGate} />)}
          </div>
        </div>
      )}
      {gate && (category || serviceFilter) && helperProfileHref(gate, serviceFilter ? null : category) && (
        <OptionSheet title={`Sign in to view @${gate}`} onClose={() => setGate(null)}>
          <HelperSignInPrompt username={gate} destination={helperProfileHref(gate, serviceFilter ? null : category)!} onContinueBrowsing={() => setGate(null)} />
        </OptionSheet>
      )}
      {sheetOpen && category && categoryTags.length > 0 && (
        <OptionSheet title={SPECIALIZATION_PROMPTS[category] ?? `What kind of ${category.toLowerCase()}?`} onClose={() => setSheetOpen(false)}
          footer={<div className="flex items-center justify-between gap-3">
            <p className="text-sm text-neutral-500">{chosenTags.length} selected</p>
            <button type="button" onClick={() => setSheetOpen(false)} className="rounded-lg bg-emerald-600 px-6 py-2.5 font-medium text-white hover:bg-emerald-700">Done</button>
          </div>}>
          {categoryTags.map((tag) => {
            const selected = selectedTagIds.includes(tag.id);
            return <button key={tag.id} type="button" role="checkbox" aria-checked={selected} onClick={() => toggleTag(tag.id)}
              className="flex min-h-12 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-sm text-neutral-900 hover:bg-neutral-50">
              <span>{tag.name}</span>
              <span aria-hidden="true" className={`flex h-6 w-6 items-center justify-center rounded-md border text-sm ${selected ? "border-emerald-600 bg-emerald-600 text-white" : "border-neutral-300 text-transparent"}`}>✓</span>
            </button>;
          })}
        </OptionSheet>
      )}
    </div>
  );
}
