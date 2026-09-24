"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import SelectionChip from "@/components/SelectionChip";
import TagChip from "@/components/TagChip";
import { createClient } from "@/lib/supabase/client";
import type { PublicProfileWithTags, Tag } from "@/lib/database.types";
import { SERVICE_TYPES, SPECIALIZATION_PROMPTS } from "@/lib/services";
import { loadTagCatalog, profileTagsForCategory } from "@/lib/tags";
import { haversineKm, loadJourneyLocation } from "@/lib/location";

const DISTANCE_OPTIONS = [
  { label: "Any distance", km: null },
  { label: "Within 5 km", km: 5 },
  { label: "Within 10 km", km: 10 },
  { label: "Within 25 km", km: 25 },
];

function HelperCard({ profile, category, distanceKm }: { profile: PublicProfileWithTags; category: string; distanceKm?: number }) {
  const tags = profileTagsForCategory(profile, category);
  return (
    <Link
      href={`/profile/${profile.username}`}
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
      </div>
    </Link>
  );
}

// Only helpers with an opted-in public location participate; distance never
// narrows results when "Any distance" is selected. Never surfaces raw lat/lng.
function withDistance(list: PublicProfileWithTags[], radiusKm: number | null, searcher: { lat: number | null; lng: number | null }) {
  if (radiusKm === null || searcher.lat == null || searcher.lng == null) {
    return list.map((profile) => ({ profile, distanceKm: undefined as number | undefined }));
  }
  return list
    .filter((profile) => profile.public_lat != null && profile.public_lng != null)
    .map((profile) => ({ profile, distanceKm: haversineKm(searcher.lat!, searcher.lng!, profile.public_lat!, profile.public_lng!) }))
    .filter((entry) => entry.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

export default function FindHelper() {
  const supabase = createClient();
  const [category, setCategory] = useState<string | null>(null);
  const [tagCatalog, setTagCatalog] = useState<Record<string, Tag[]>>({});
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [helpers, setHelpers] = useState<PublicProfileWithTags[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [radiusKm, setRadiusKm] = useState<number | null>(null);
  const [searcherLocation] = useState(loadJourneyLocation);

  useEffect(() => {
    loadTagCatalog(supabase).then(setTagCatalog).catch(() => {});
  }, [supabase]);

  useEffect(() => {
    if (!category) return;
    let active = true;
    supabase
      .from("public_profiles")
      .select("*, profile_tags(tag:tags(id,name,service_type))")
      .contains("skills", [category])
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setError("Couldn't load helpers. Please refresh and try again.");
        setHelpers((data as PublicProfileWithTags[]) ?? []);
        setLoading(false);
      });
    return () => { active = false; };
  }, [supabase, category]);

  const categoryTags = category ? (tagCatalog[category] ?? []) : [];

  function chooseCategory(next: string) {
    setCategory(next);
    setSelectedTagIds([]);
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

  const matchingByDistance = useMemo(() => withDistance(matching, radiusKm, searcherLocation), [matching, radiusKm, searcherLocation]);
  const othersByDistance = useMemo(() => withDistance(others, radiusKm, searcherLocation), [others, radiusKm, searcherLocation]);

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Find a Helper</h1>

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

      {!category && <p className="text-neutral-500">Choose a category to see nearby helpers.</p>}

      {category && categoryTags.length > 0 && (
        <fieldset className="min-w-0 w-full">
          <legend className="text-sm font-medium">{SPECIALIZATION_PROMPTS[category] ?? `What kind of ${category.toLowerCase()}?`}</legend>
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

      {category && (
        <label className="block text-sm font-medium">Distance
          <select value={radiusKm ?? ""} onChange={(e) => setRadiusKm(e.target.value ? Number(e.target.value) : null)}
            className="mt-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm">
            {DISTANCE_OPTIONS.map((option) => (
              <option key={option.label} value={option.km ?? ""}>{option.label}</option>
            ))}
          </select>
        </label>
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
            {matchingByDistance.map(({ profile, distanceKm }) => <HelperCard key={profile.id} profile={profile} category={category} distanceKm={distanceKm} />)}
          </div>
        </div>
      )}

      {category && othersByDistance.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-neutral-500">Other {category} helpers</h2>
          <div className="grid gap-3">
            {othersByDistance.map(({ profile, distanceKm }) => <HelperCard key={profile.id} profile={profile} category={category} distanceKm={distanceKm} />)}
          </div>
        </div>
      )}
    </div>
  );
}
