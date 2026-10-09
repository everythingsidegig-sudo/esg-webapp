// US ZIP codes and ZIP+4 resolve to the general ZIP area, not a home address.
export function usZipCode(value: string): string | null {
  return /^\d{5}(?:-\d{4})?$/.test(value.trim()) ? value.trim().slice(0, 5) : null;
}

export function parseZipLocation(value: unknown, zip: string) {
  const data = value as { places?: Array<Record<string, unknown>> } | null;
  const place = data?.places?.[0];
  if (!place || typeof place.latitude !== "string" || typeof place.longitude !== "string"
      || !place.latitude.trim() || !place.longitude.trim()
      || typeof place["place name"] !== "string" || !place["place name"]
      || typeof place["state abbreviation"] !== "string") throw new Error("Invalid ZIP location");
  const lat = Number(place.latitude);
  const lng = Number(place.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error("Invalid ZIP coordinates");
  }
  return {
    lat: Math.round(lat * 100) / 100,
    lng: Math.round(lng * 100) / 100,
    label: `${place["place name"]}, ${place["state abbreviation"]} ${zip}`,
  };
}

export async function lookupZipCode(zip: string, signal: AbortSignal) {
  const normalized = usZipCode(zip);
  if (!normalized) throw new Error("Invalid ZIP code");
  const response = await fetch(`https://api.zippopotam.us/us/${normalized}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok) throw new Error("ZIP lookup failed");
  return parseZipLocation(await response.json(), normalized);
}
