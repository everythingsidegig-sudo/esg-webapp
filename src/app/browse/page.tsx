"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import SelectionChip from "@/components/SelectionChip";
import TagChip from "@/components/TagChip";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { GigWithTags, Tag } from "@/lib/database.types";
import { SERVICE_TYPES as CATEGORIES } from "@/lib/services";
import { loadTagCatalog, gigTagNames } from "@/lib/tags";

const SERVICE_TYPES = [
  "All Services",
  ...CATEGORIES,
];

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function BrowseInner() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const lat = searchParams.get("lat") ? Number(searchParams.get("lat")) : null;
  const lng = searchParams.get("lng") ? Number(searchParams.get("lng")) : null;

  const [gigs, setGigs] = useState<GigWithTags[]>([]);
  const [service, setService] = useState("All Services");
  const [radius, setRadius] = useState(5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tagCatalog, setTagCatalog] = useState<Record<string, Tag[]>>({});
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

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

  const categoryTags = useMemo(
    () => service === "All Services" ? [] : (tagCatalog[service] ?? []),
    [service, tagCatalog]
  );
  const selectedTagNames = useMemo(
    () => new Set(categoryTags.filter((t) => selectedTagIds.includes(t.id)).map((t) => t.name)),
    [categoryTags, selectedTagIds]
  );

  const filtered = useMemo(() => {
    return gigs
      .filter((g) => service === "All Services" || g.service_type === service)
      .filter((g) => selectedTagNames.size === 0 || gigTagNames(g).some((name) => selectedTagNames.has(name)))
      .filter((g) => {
        if (!lat || !lng || g.lat == null || g.lng == null) return true;
        return haversineMiles(lat, lng, g.lat, g.lng) <= radius;
      });
  }, [gigs, service, selectedTagNames, radius, lat, lng]);

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Find Providers Nearby</h1>

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
          <select
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          >
            {[1, 5, 10].map((r) => (
              <option key={r} value={r}>
                Within {r} mi
              </option>
            ))}
          </select>
        )}
      </div>

      {loading && <p className="text-neutral-500">Loading gigs…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && filtered.length === 0 && <p className="text-neutral-500">No gigs found. Try widening your filters.</p>}

      <div className="grid gap-3">
        {filtered.map((gig) => (
          <Link
            key={gig.id}
            href={`/gigs/${gig.id}`}
            className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm hover:shadow-md"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-emerald-700">{gig.service_type}</span>
              <span className="font-semibold">${gig.amount}</span>
            </div>
            <div className="mt-1 font-medium">{gig.title}</div>
            <div className="mt-1 text-sm text-neutral-500">
              {gig.location_text} · {gig.scheduled_at ? new Date(gig.scheduled_at).toLocaleString() : "Flexible"}
            </div>
            {gigTagNames(gig).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {gigTagNames(gig).map((name) => <TagChip key={name}>{name}</TagChip>)}
              </div>
            )}
          </Link>
        ))}
      </div>
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
