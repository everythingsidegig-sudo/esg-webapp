"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import { approximateCoordinates } from "@/lib/journey";
import { LOCATION_KEY } from "@/lib/location";

function LocationEntryInner() {
  const router = useRouter();

  const [locationText, setLocationText] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  function useMyLocation() {
    setError(null);
    setLocating(true);
    if (!navigator.geolocation) {
      setError("Geolocation isn't available in this browser. Enter a location manually.");
      setLocating(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords(approximateCoordinates(pos.coords.latitude, pos.coords.longitude) as { lat: number; lng: number });
        setLocationText("Current location");
        setLocating(false);
      },
      () => {
        setError("Location permission denied. Enter a location manually below.");
        setLocating(false);
      },
      { timeout: 10000, maximumAge: 60000 }
    );
  }

  function continueJourney() {
    if (locating) return;
    if (!locationText.trim() || locationText.trim().length > 200) {
      setError("Enter a general area of 1–200 characters or use your current location.");
      return;
    }
    try { sessionStorage.setItem(LOCATION_KEY, JSON.stringify({ text: locationText.trim(), ...coords })); }
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
    <div className="mx-auto max-w-md space-y-5">
      <div>
        <h1 className="text-xl font-semibold">What would you like to do?</h1>
        <p className="mt-1 text-sm text-neutral-500">Choose a journey for {locationText.trim()}.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/need-help" className="rounded-xl border border-neutral-200 bg-white p-6 text-center shadow-sm transition hover:shadow-md">
          <div className="text-2xl">🙋</div>
          <div className="mt-2 font-semibold">I Need Help</div>
          <div className="mt-1 text-sm text-neutral-500">Post a gig or find a helper.</div>
        </Link>
        <button type="button" onClick={browseGigs} aria-label="Help & Earn Money" className="rounded-xl border border-neutral-200 bg-white p-6 text-center shadow-sm transition hover:shadow-md">
          <div className="text-2xl">💪</div>
          <div className="mt-2 font-semibold">Help &amp; Earn Money</div>
          <div className="mt-1 text-sm text-neutral-500">Browse gigs nearby.</div>
        </button>
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-md space-y-5">
      <h1 className="text-xl font-semibold">Where should we look?</h1>
      <p className="text-sm text-neutral-500">
        Enter a general area, not your street address. Current-location coordinates are rounded before use.
      </p>

      <button
        onClick={useMyLocation}
        disabled={locating}
        className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {locating ? "Locating…" : "📍 Use My Location"}
      </button>

      <div className="flex items-center gap-2 text-xs text-neutral-400">
        <div className="h-px flex-1 bg-neutral-200" /> or enter manually <div className="h-px flex-1 bg-neutral-200" />
      </div>

      <input
        aria-label="General area"
        maxLength={200}
        value={locationText}
        onChange={(e) => {
          setLocationText(e.target.value);
          setCoords(null);
        }}
        placeholder="ZIP, neighborhood, or city"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2"
      />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        onClick={continueJourney}
        disabled={locating}
        className="w-full rounded-lg border border-emerald-600 py-2.5 font-medium text-emerald-700 hover:bg-emerald-50"
      >
        Continue
      </button>
    </div>
  );
}

export default function LocationEntry() {
  return (
    <AuthGuard>
      <LocationEntryInner />
    </AuthGuard>
  );
}
