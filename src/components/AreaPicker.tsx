"use client";

import { useEffect, useRef, useState } from "react";
import MapPicker, { type MapPoint } from "@/components/MapPicker";
import { approximateCoordinates } from "@/lib/journey";
import { LOCATION_KEY, reverseGeocodeGeneralArea } from "@/lib/location";
import { resolveAreaQuery } from "@/lib/area-lookup";
import type { AreaMatch } from "@/lib/area-search";

export type Area = { text: string; lat: number | null; lng: number | null };

// Same journey-location record /location writes, so Browse and Post a Gig pick the chosen
// area up too, and it survives closing the browser -- signing back in later finds it already
// set. Coordinates are always the rounded ones (postcode lookup, area search, the map pin and
// approximateCoordinates all round to two decimals); a street address is never stored.
function saveArea(area: Area) {
  try { localStorage.setItem(LOCATION_KEY, JSON.stringify(area)); } catch { /* storage unavailable: the choice still applies for this page */ }
}

const POSTCODE_LIKE = /^[A-Za-z]{0,3}[-\s]?\d{3,5}\s?\d{0,2}$/;

// A visitor does not need an account to say where they are looking: a ZIP or postal code, a
// neighborhood or city, or the current location -- then fine-tune it with the map pin. The
// text, the saved coordinates and the pin always describe the same place.
export default function AreaPicker({ area, onChange, radiusKm }: { area: Area; onChange: (area: Area) => void; radiusKm?: number | null }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<AreaMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const latest = useRef(0);

  // Collapsed to a one-line summary once an area is set, so the search box, "use my
  // location" and the map don't stay permanently open and take up the page. A caller
  // that starts with an empty area and fills it in shortly after hydration (localStorage
  // isn't visible to the server render) still collapses once, the first time that happens;
  // syncedInitialArea stops that from fighting a later manual "Update location" click.
  const [expanded, setExpanded] = useState(!area.text);
  const syncedInitialArea = useRef(Boolean(area.text));

  useEffect(() => {
    if (syncedInitialArea.current || !area.text) return;
    syncedInitialArea.current = true;
    setExpanded(false);
  }, [area.text]);

  function choose(next: Area) {
    saveArea(next);
    onChange(next);
    setQuery("");
    setMatches([]);
    setError(null);
    setExpanded(false);
  }

  useEffect(() => {
    const text = query.trim();
    if (text.length < 3) return;
    const request = ++latest.current;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const result = await resolveAreaQuery(text, controller.signal);
        if (request !== latest.current) return;
        if (result.kind === "single") choose({ text: result.area.areaLabel, lat: result.area.lat, lng: result.area.lng });
        else if (result.kind === "choices") { setMatches(result.choices); setError(null); }
        else { setMatches([]); setError(POSTCODE_LIKE.test(text) ? "No place found for that postcode. Check it, add the country, or use your current location." : "No matching area found. Try a ZIP or postal code, or a nearby city."); }
      } catch {
        if (request === latest.current) {
          setMatches([]);
          setError("Couldn't search for that place right now. Try again, enter a postcode, or use your current location.");
        }
      } finally {
        if (request === latest.current) setBusy(false);
      }
    }, 450);
    return () => { clearTimeout(timer); controller.abort(); };
    // choose only closes over setters and onChange; the query is what drives a new search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function useMyLocation() {
    const request = ++latest.current;
    setError(null);
    setMatches([]);
    if (!navigator.geolocation) { setError("Location isn't available in this browser. Enter a ZIP or postal code instead."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(async (position) => {
      if (request !== latest.current) return;
      const approx = approximateCoordinates(position.coords.latitude, position.coords.longitude) as { lat: number; lng: number };
      let label: string | null = null;
      try { label = await reverseGeocodeGeneralArea(approx.lat, approx.lng); } catch { /* the rounded coordinates are enough */ }
      if (request === latest.current) choose({ text: label ?? "Current location", lat: approx.lat, lng: approx.lng });
      setLocating(false);
    }, () => {
      if (request !== latest.current) return;
      setError("We couldn't access your location. Enter a ZIP or postal code instead.");
      setLocating(false);
    }, { timeout: 10000, maximumAge: 60000 });
  }

  // The pin moved: keep the coordinates the pin says, and re-label the area to match when the
  // reverse lookup works (otherwise say plainly that it is a pinned spot).
  async function pinMoved(point: MapPoint) {
    const request = ++latest.current;
    // Until the label is known the text must not describe the old place.
    saveArea({ text: "Pinned location", ...point });
    onChange({ text: "Pinned location", ...point });
    let label: string | null = null;
    try { label = await reverseGeocodeGeneralArea(point.lat, point.lng); } catch { /* keep the existing label */ }
    if (request === latest.current) choose({ text: label ?? "Pinned location", ...point });
  }

  if (!expanded) {
    return (
      <section aria-label="Search area">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2.5">
          <p role="status" className="flex flex-wrap items-center gap-x-2 text-sm text-neutral-700">
            <span>📍 {area.text}</span>
            {area.lat == null && <span className="text-neutral-500">(no map position, so distance can&apos;t be shown)</span>}
          </p>
          <button type="button" onClick={() => setExpanded(true)}
            className="shrink-0 text-sm font-medium text-emerald-700 hover:underline">
            Update location
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Search area" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Where are you looking?</p>
        {area.text && (
          <button type="button" onClick={() => setExpanded(false)}
            className="text-sm font-medium text-neutral-500 hover:underline">
            Cancel
          </button>
        )}
      </div>
      {area.text && (
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-sm text-neutral-700">
          <span>📍 {area.text}</span>
          {area.lat == null && <span className="text-neutral-500">(no map position, so distance can&apos;t be shown)</span>}
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input value={query} onChange={(e) => { setQuery(e.target.value); setError(null); if (e.target.value.trim().length < 3) setMatches([]); }}
          maxLength={200} inputMode="search" autoComplete="postal-code" aria-label="ZIP code, postal code or area"
          placeholder="ZIP or postal code, neighborhood or city"
          className="min-h-11 w-full rounded-lg border border-neutral-300 px-3 py-2 sm:flex-1" />
        <button type="button" onClick={useMyLocation} disabled={locating}
          className="min-h-11 shrink-0 rounded-lg border border-emerald-600 px-4 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-wait disabled:opacity-60">
          {locating ? "Locating…" : "📍 Use my location"}
        </button>
      </div>
      {busy && <p role="status" className="text-sm text-neutral-500">Searching…</p>}
      {matches.length > 0 && (
        <ul aria-label="Matching areas" className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 bg-white">
          {matches.map((match) => (
            <li key={`${match.label}|${match.lat}|${match.lng}`}>
              <button type="button" onClick={() => choose({ text: match.areaLabel, lat: match.lat, lng: match.lng })}
                className="min-h-11 w-full px-3 py-2 text-left text-sm hover:bg-neutral-50">{match.areaLabel}</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {area.lat != null && area.lng != null && <MapPicker lat={area.lat} lng={area.lng} radiusKm={radiusKm} onPick={(point) => { void pinMoved(point); }} />}
      <p className="text-xs text-neutral-500">A general area is enough. Coordinates are rounded and never include a street address.</p>
    </section>
  );
}
