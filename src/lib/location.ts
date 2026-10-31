import { approximateCoordinates } from "./journey";
import { generalAreaLabel } from "./geocoding";

export const LOCATION_KEY = "esg:general-area";
const GEOCODE_CACHE_PREFIX = "esg:general-area-label:";

function cacheKey(lat: number, lng: number) {
  return `${GEOCODE_CACHE_PREFIX}${lat.toFixed(2)},${lng.toFixed(2)}`;
}

export function cachedGeneralArea(lat: number, lng: number): string | null {
  try {
    const value = localStorage.getItem(cacheKey(lat, lng));
    return value && value.length <= 200 ? value : null;
  } catch { return null; }
}

export function cacheGeneralArea(lat: number, lng: number, label: string) {
  try { localStorage.setItem(cacheKey(lat, lng), label); } catch {}
}

// Clears every piece of saved general-area state: the chosen area itself plus any
// cached reverse-geocode labels. Used on sign-out and account deletion so no
// ESG-specific location data survives on this device once the visitor is gone.
export function clearGeneralAreaState() {
  try { localStorage.removeItem(AUTH_AREA_KEY); } catch {}
  try {
    localStorage.removeItem(LOCATION_KEY);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(GEOCODE_CACHE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {}
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
    const value = JSON.parse(localStorage.getItem(LOCATION_KEY) ?? "null");
    if (value && typeof value.text === "string" && value.text) return { text: value.text.slice(0, 200), ...approximateCoordinates(value.lat ?? null, value.lng ?? null) };
  } catch { /* fall through to the post-sign-in copy */ }
  return restoreAreaAfterAuth();
}

// A short-lived copy of the general area -- text and rounded coordinates only, never an
// address -- carries the visitor's search across to a sign-in or registration that
// finishes on a fresh profile with no area picked yet (e.g. a new browser profile, or
// local storage cleared between visits).
export const AUTH_AREA_KEY = "esg:post-auth-area";
const AUTH_AREA_TTL_MS = 30 * 60 * 1000;
type AreaValue = { text: string; lat: number | null; lng: number | null };
type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function rememberAreaForAuth(store?: KeyValueStore, session?: Pick<Storage, "getItem">, now = Date.now()): boolean {
  try {
    const area = JSON.parse((session ?? localStorage).getItem(LOCATION_KEY) ?? "null");
    if (!area || typeof area.text !== "string" || !area.text || area.text.length > 200) return false;
    const coords = approximateCoordinates(area.lat ?? null, area.lng ?? null);
    (store ?? localStorage).setItem(AUTH_AREA_KEY, JSON.stringify({ text: area.text, ...coords, expires: now + AUTH_AREA_TTL_MS }));
    return true;
  } catch { return false; }
}

export function restoreAreaAfterAuth(store?: KeyValueStore, session?: Pick<Storage, "setItem">, now = Date.now()): AreaValue {
  const empty = { text: "", lat: null, lng: null };
  try {
    const target = store ?? localStorage;
    const raw = target.getItem(AUTH_AREA_KEY);
    target.removeItem(AUTH_AREA_KEY);
    if (!raw) return empty;
    const value = JSON.parse(raw);
    if (typeof value?.text !== "string" || !value.text || value.text.length > 200 || typeof value.expires !== "number" || value.expires < now) return empty;
    const area = { text: value.text, ...approximateCoordinates(typeof value.lat === "number" ? value.lat : null, typeof value.lng === "number" ? value.lng : null) };
    try { (session ?? localStorage).setItem(LOCATION_KEY, JSON.stringify(area)); } catch { /* the area still applies to this page */ }
    return area;
  } catch { return empty; }
}

// Same formula Browse already uses for gig distance, in kilometers for Find a Helper's radius filter.
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
