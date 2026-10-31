"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { postcodeCandidates } from "@/lib/zip-location";
import { resolveAreaQuery } from "@/lib/area-lookup";
import type { AreaMatch } from "@/lib/area-search";
import AuthGuard from "@/components/AuthGuard";
import MapPicker, { type MapPoint } from "@/components/MapPicker";
import { approximateCoordinates } from "@/lib/journey";
import { LOCATION_KEY, loadJourneyLocation, reverseGeocodeGeneralArea } from "@/lib/location";

function LocationEntryInner() {
  const router = useRouter();
  const locationRequest = useRef(0);
  // Text the page wrote itself (a current-location label) is already resolved; searching for it
  // again would only offer choices for a place the visitor has already pinned.
  const resolvedText = useRef<string | null>(null);

  // A location already saved this session (or just restored after an email-link sign-in) means
  // the visitor already did this step; land them straight on "What would you like to do?"
  // instead of asking them to pick an area again.
  const [initialLocation] = useState(loadJourneyLocation);

  const [locationText, setLocationText] = useState(initialLocation.text);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
    initialLocation.lat != null && initialLocation.lng != null
      ? { lat: initialLocation.lat, lng: initialLocation.lng }
      : null
  );
  const [confirmed, setConfirmed] = useState(Boolean(initialLocation.text));
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  // lookingUpZip: a postcode is being resolved (Continue waits for it). searching: a neighborhood or
  // city search is running in the background (Continue never waits for that: typed text is enough).
  const [lookingUpZip, setLookingUpZip] = useState(false);
  const [searching, setSearching] = useState(false);
  const [zipArea, setZipArea] = useState<string | null>(initialLocation.text || null);
  const [choices, setChoices] = useState<AreaMatch[]>([]);

  // A postcode (US ZIP, Swedish postcode, ...) or a neighborhood/city typed here resolves to a place
  // and a map pin. One match selects itself; several are offered as choices. Failures say so and
  // leave manual entry (and the current-location button) untouched.
  useEffect(() => {
    const text = locationText.trim();
    if (text.length < 3 || text === "Current location" || text === resolvedText.current) return;
    const postcode = postcodeCandidates(text).length > 0;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const result = await resolveAreaQuery(text, controller.signal);
        if (!active) return;
        if (result.kind === "single") {
          setCoords({ lat: result.area.lat, lng: result.area.lng });
          setZipArea(result.area.areaLabel);
          setChoices([]);
        } else if (result.kind === "choices") {
          setChoices(result.choices);
        } else if (postcode) {
          setCoords(null);
          setError("Couldn't find that postcode. Check it, add the country, or use your current location.");
        }
      } catch {
        if (active) {
          setCoords(null);
          setError(postcode
            ? "Couldn't look up that postcode right now. Try again, or use your current location."
            : "Couldn't search for that place right now. You can still continue with what you typed, or use your current location.");
        }
      } finally { if (active) { setLookingUpZip(false); setSearching(false); } }
    }, 450);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [locationText]);

  function chooseMatch(match: AreaMatch) {
    setCoords({ lat: match.lat, lng: match.lng });
    setZipArea(match.areaLabel);
    setChoices([]);
    setError(null);
  }

  // The pin moved on the map: its rounded point is now the saved position, and the label follows it
  // (or says "Pinned location" if the reverse lookup is unavailable) so text and pin never disagree.
  async function pinMoved(point: MapPoint) {
    const request = ++locationRequest.current;
    setCoords(point);
    setZipArea("Pinned location");
    try {
      const label = await reverseGeocodeGeneralArea(point.lat, point.lng);
      if (label && request === locationRequest.current) setZipArea(label);
    } catch { /* keep "Pinned location": the coordinates are authoritative */ }
  }

  function useMyLocation() {
    const request = ++locationRequest.current;
    setLookingUpZip(false);
    setSearching(false);
    setChoices([]);
    setZipArea(null);
    setLocationText("Current location");
    setCoords(null);
    setError(null);
    setLocating(true);
    if (!navigator.geolocation) {
      setError("Geolocation isn't available in this browser. Enter a location manually.");
      setLocating(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        if (request !== locationRequest.current) return;
        const approximate = approximateCoordinates(pos.coords.latitude, pos.coords.longitude) as { lat: number; lng: number };
        setCoords(approximate);
        setLocationText("Current location");
        try {
          const label = await reverseGeocodeGeneralArea(approximate.lat, approximate.lng);
          if (label && request === locationRequest.current) { resolvedText.current = label; setLocationText(label); }
        } catch {
          // Coordinates remain valid and authoritative when the optional label lookup fails.
        } finally { if (request === locationRequest.current) setLocating(false); }
      },
      () => {
        if (request !== locationRequest.current) return;
        setError("Location permission denied. Enter a location manually below.");
        setLocating(false);
      },
      { timeout: 10000, maximumAge: 60000 }
    );
  }

  function continueJourney() {
    if (locating || lookingUpZip) return;
    if (postcodeCandidates(locationText).length > 0 && !coords) {
      setError("Wait for the ZIP code to appear on the map, or choose another location.");
      return;
    }
    if (!locationText.trim() || locationText.trim().length > 200) {
      setError("Enter a general area of 1–200 characters or use your current location.");
      return;
    }
    try { sessionStorage.setItem(LOCATION_KEY, JSON.stringify({ text: zipArea ?? locationText.trim(), ...coords })); }
    catch { setError("Enable site storage in your browser to continue."); return; }
    setConfirmed(true);
  }

  function browseGigs() {
    // continueJourney() already saved this area to sessionStorage; Browse reads it
    // the same way Find a Helper does.
    router.push("/browse");
  }

  if (confirmed) return (
    <section className="app-screen app-card space-y-6 p-5 sm:p-7">
      <div className="space-y-2">
        <p className="text-sm font-semibold text-emerald-700">You&apos;re all set</p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">What would you like to do?</h1>
        <p className="text-sm leading-6 text-neutral-500">Choose a journey for {zipArea ?? locationText.trim()}.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/need-help" className="flex min-h-36 flex-col items-start justify-center rounded-2xl border border-neutral-200 bg-white p-5 text-left shadow-sm transition hover:border-emerald-200 hover:shadow-md">
          <div className="text-3xl">🙋</div>
          <div className="mt-3 font-bold">I Need Help</div>
          <div className="mt-1 text-sm leading-5 text-neutral-500">Post a gig or find a helper.</div>
        </Link>
        <button type="button" onClick={browseGigs} aria-label="Help & Earn Money" className="flex min-h-36 flex-col items-start justify-center rounded-2xl border border-neutral-200 bg-white p-5 text-left shadow-sm transition hover:border-emerald-200 hover:shadow-md">
          <div className="text-3xl">💪</div>
          <div className="mt-3 font-bold">Help &amp; Earn Money</div>
          <div className="mt-1 text-sm leading-5 text-neutral-500">Browse gigs nearby.</div>
        </button>
      </div>
    </section>
  );

  return (
    <section className="app-screen app-card p-5 sm:p-7">
      <div className="mb-7 space-y-2">
        <p className="text-sm font-semibold text-emerald-700">Set your area</p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Where should we look?</h1>
        <p className="text-sm leading-6 text-neutral-500">Choose an area to find nearby gigs and helpers.</p>
      </div>

      <button
        onClick={useMyLocation}
        disabled={locating}
        className="touch-control w-full bg-emerald-700 px-4 font-semibold text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60"
      >
        {locating ? "Finding your location…" : "📍 Use My Location"}
      </button>

      <div className="my-6 flex items-center gap-3 text-xs font-medium uppercase tracking-wider text-neutral-400">
        <div className="h-px flex-1 bg-neutral-200" /> or <div className="h-px flex-1 bg-neutral-200" />
      </div>

      <label htmlFor="general-area" className="mb-2 block text-sm font-semibold text-neutral-800">ZIP or postal code, neighborhood or city</label>
      <input
        id="general-area"
        aria-label="General area"
        maxLength={200}
        value={locationText}
        onChange={(e) => {
          locationRequest.current++;
          setLocating(false);
          setError(null);
          setZipArea(null);
          setChoices([]);
          setLookingUpZip(postcodeCandidates(e.target.value).length > 0);
          resolvedText.current = null;
          setLocationText(e.target.value);
          setCoords(null);
        }}
        placeholder="ZIP or postal code, neighborhood or city"
        className="app-input"
      />
      {(lookingUpZip || searching) && <p role="status" className="mt-3 text-sm text-neutral-500">{lookingUpZip ? "Finding postcode…" : "Searching…"}</p>}
      {choices.length > 0 && (
        <ul aria-label="Matching areas" className="mt-3 divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white">
          {choices.map((match) => (
            <li key={`${match.label}|${match.lat}|${match.lng}`}>
              <button type="button" onClick={() => chooseMatch(match)} className="min-h-11 w-full px-3 py-2 text-left text-sm hover:bg-neutral-50">{match.areaLabel}</button>
            </li>
          ))}
        </ul>
      )}
      {coords && (
        <div className="mt-4 space-y-2">
          <MapPicker lat={coords.lat} lng={coords.lng} onPick={(point) => { void pinMoved(point); }} />
          <p role="status" className="rounded-lg bg-white px-3 py-2 text-sm text-neutral-600">{zipArea ?? locationText} — approximate area</p>
        </div>
      )}
      <p className="mt-2 text-xs leading-5 text-neutral-400">
        Location names © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap contributors</a>
      </p>

      <p className="mt-4 text-xs leading-5 text-neutral-500">Use a general area, not your street address. Current-location coordinates are rounded before use.</p>

      {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</p>}

      <button
        onClick={continueJourney}
        disabled={locating || lookingUpZip || (postcodeCandidates(locationText).length > 0 && !coords)}
        className="touch-control mt-7 w-full border border-emerald-700 bg-white px-4 font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-wait disabled:opacity-60"
      >
        Continue
      </button>
    </section>
  );
}

export default function LocationEntry() {
  return (
    <AuthGuard>
      <LocationEntryInner />
    </AuthGuard>
  );
}

