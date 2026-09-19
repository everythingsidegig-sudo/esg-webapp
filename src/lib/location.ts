import { approximateCoordinates } from "./journey";

export const LOCATION_KEY = "esg:general-area";
export function loadJourneyLocation(): { text: string; lat: number | null; lng: number | null } {
  try {
    const value = JSON.parse(sessionStorage.getItem(LOCATION_KEY) ?? "null");
    if (!value || typeof value.text !== "string") return { text: "", lat: null, lng: null };
    return { text: value.text, ...approximateCoordinates(value.lat ?? null, value.lng ?? null) };
  } catch { return { text: "", lat: null, lng: null }; }
}
