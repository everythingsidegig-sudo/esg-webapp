"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Gig } from "@/lib/database.types";

const SERVICE_TYPES = [
  "All Services",
  "Yard Work",
  "Moving Help",
  "Cleaning",
  "Handyman",
  "Delivery",
  "Pet Care",
  "Tech Help",
  "Other",
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

  const [gigs, setGigs] = useState<Gig[]>([]);
  const [service, setService] = useState("All Services");
  const [radius, setRadius] = useState(5);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from("gigs")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        setGigs((data as Gig[]) ?? []);
        setLoading(false);
      });
  }, [supabase]);

  const filtered = useMemo(() => {
    return gigs
      .filter((g) => service === "All Services" || g.service_type === service)
      .filter((g) => {
        if (!lat || !lng || g.lat == null || g.lng == null) return true;
        return haversineMiles(lat, lng, g.lat, g.lng) <= radius;
      });
  }, [gigs, service, radius, lat, lng]);

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Find Providers Nearby</h1>

      <div className="flex flex-wrap gap-3">
        <select
          value={service}
          onChange={(e) => setService(e.target.value)}
          className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
        >
          {SERVICE_TYPES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
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
      {!loading && filtered.length === 0 && <p className="text-neutral-500">No gigs found. Try widening your filters.</p>}

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
