"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { lookupZipCode, usZipCode } from "@/lib/zip-location";
import AuthGuard from "@/components/AuthGuard";
import { approximateCoordinates } from "@/lib/journey";
import { LOCATION_KEY, reverseGeocodeGeneralArea } from "@/lib/location";

function LocationEntryInner() {
  const router = useRouter();
  const locationRequest = useRef(0);

  const [locationText, setLocationText] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const [lookingUpZip, setLookingUpZip] = useState(false);
  const [zipArea, setZipArea] = useState<string | null>(null);

  useEffect(() => {
    const zip = usZipCode(locationText);
    if (!zip) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const area = await lookupZipCode(zip, controller.signal);
        if (!active) return;
        setCoords({ lat: area.lat, lng: area.lng });
        setZipArea(area.label);
      } catch {
        if (active) {
          setCoords(null);
          setError("Couldn't find that ZIP code. Check it and try again, or use your current location.");
        }
      } finally { if (active) setLookingUpZip(false); }
    }, 450);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [locationText]);

  function useMyLocation() {
    const request = ++locationRequest.current;
    setLookingUpZip(false);
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
          if (label && request === locationRequest.current) setLocationText(label);
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
    if (usZipCode(locationText) && !coords) {
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
    const params = new URLSearchParams();
    if (coords) {
      params.set("lat", String(coords.lat));
      params.set("lng", String(coords.lng));
    }
    router.push(params.size ? `/browse?${params.toString()}` : "/browse");
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

      <label htmlFor="general-area" className="mb-2 block text-sm font-semibold text-neutral-800">City, ZIP or neighborhood</label>
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
          setLookingUpZip(!!usZipCode(e.target.value));
          setLocationText(e.target.value);
          setCoords(null);
        }}
        placeholder="Enter a general area"
        className="app-input"
      />
      {lookingUpZip && <p role="status" className="mt-3 text-sm text-neutral-500">Finding ZIP code…</p>}
      {coords && (
        <div className="mt-4 overflow-hidden rounded-xl border border-neutral-200">
          <iframe
            title="Map of your selected area"
            src={`https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent([coords.lng - 0.04, coords.lat - 0.025, coords.lng + 0.04, coords.lat + 0.025].join(","))}&layer=mapnik&marker=${encodeURIComponent(`${coords.lat},${coords.lng}`)}`}
            className="h-64 w-full border-0"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
          <p role="status" className="bg-white px-3 py-2 text-sm text-neutral-600">{zipArea ?? locationText} — approximate area</p>
        </div>
      )}
      <p className="mt-2 text-xs leading-5 text-neutral-400">
        Location names © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap contributors</a>
      </p>

      <p className="mt-4 text-xs leading-5 text-neutral-500">Use a general area, not your street address. Current-location coordinates are rounded before use.</p>

      {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</p>}

      <button
        onClick={continueJourney}
        disabled={locating || lookingUpZip || (!!usZipCode(locationText) && !coords)}
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

