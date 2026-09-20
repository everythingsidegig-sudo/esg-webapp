import { approximateCoordinates } from "./journey";
import { generalAreaLabel } from "./geocoding";

export const LOCATION_KEY = "esg:general-area";
const GEOCODE_CACHE_PREFIX = "esg:general-area-label:";

function cacheKey(lat: number, lng: number) {
  return `${GEOCODE_CACHE_PREFIX}${lat.toFixed(2)},${lng.toFixed(2)}`;
}

export function cachedGeneralArea(lat: number, lng: number): string | null {
  try {
    const value = sessionStorage.getItem(cacheKey(lat, lng));
    return value && value.length <= 200 ? value : null;
  } catch { return null; }
}

export function cacheGeneralArea(lat: number, lng: number, label: string) {
  try { sessionStorage.setItem(cacheKey(lat, lng), label); } catch {}
}

export async function reverseGeocodeGeneralArea(lat: number, lng: number): Promise<string | null> {
  const cached = cachedGeneralArea(lat, lng);
  if (cached) return cached;
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.search = new URLSearchParams({
    format: "jsonv2",
    lat: String(lat),
    lon: String(lng),
    zoom: "10",
    addressdetails: "1",
  }).toString();
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Reverse geocoding failed");
  const label = generalAreaLabel(await response.json());
  if (label) cacheGeneralArea(lat, lng, label);
  return label;
}

export function loadJourneyLocation(): { text: string; lat: number | null; lng: number | null } {
  try {
    const value = JSON.parse(sessionStorage.getItem(LOCATION_KEY) ?? "null");
    if (!value || typeof value.text !== "string") return { text: "", lat: null, lng: null };
    return { text: value.text, ...approximateCoordinates(value.lat ?? null, value.lng ?? null) };
  } catch { return { text: "", lat: null, lng: null }; }
}
