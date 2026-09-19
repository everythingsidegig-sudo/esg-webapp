"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { approximateCoordinates } from "@/lib/journey";
import { LOCATION_KEY } from "@/lib/location";

function LocationEntryInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const journey = searchParams.get("journey") ?? "need_help";

  const [locationText, setLocationText] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
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
    const params = new URLSearchParams();
    try { sessionStorage.setItem(LOCATION_KEY, JSON.stringify({ text: locationText.trim(), ...coords })); }
    catch { setError("Enable site storage in your browser to continue."); return; }
    // Public browsing uses only rounded coordinates; posting reads session storage.
    if (coords && journey === "earn_money") {
      params.set("lat", String(coords.lat));
      params.set("lng", String(coords.lng));
    }
    router.push(journey === "earn_money" ? `/browse?${params.toString()}` : "/post");
  }

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
    <Suspense>
      <LocationEntryInner />
    </Suspense>
  );
}
