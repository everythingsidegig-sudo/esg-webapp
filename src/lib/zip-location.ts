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

// ---------------------------------------------------------------------------
// Postcodes beyond the US. api.zippopotam.us serves both formats below with the same
// response shape. A five-digit code is genuinely ambiguous (a US ZIP and a Swedish
// postcode look alike), so callers look up every candidate and let the visitor choose
// when more than one place exists.
// ---------------------------------------------------------------------------
export type PostcodeCountry = "us" | "se";

// Swedish postcodes are written "244 31" (or "SE-244 31", or unspaced "24431").
export function swedishPostcode(value: string): string | null {
  const match = /^(?:SE[-\s]?)?(\d{3})\s?(\d{2})$/i.exec(value.trim());
  return match ? `${match[1]}${match[2]}` : null;
}

export function postcodeCandidates(value: string): { country: PostcodeCountry; code: string }[] {
  const candidates: { country: PostcodeCountry; code: string }[] = [];
  const us = usZipCode(value);
  if (us) candidates.push({ country: "us", code: us });
  const se = swedishPostcode(value);
  if (se) candidates.push({ country: "se", code: se });
  return candidates;
}

export function parsePostcodeLocation(value: unknown, code: string, country: PostcodeCountry) {
  const data = value as { places?: Array<Record<string, unknown>> } | null;
  const place = data?.places?.[0];
  const name = place?.["place name"];
  if (!place || typeof place.latitude !== "string" || typeof place.longitude !== "string"
      || !place.latitude.trim() || !place.longitude.trim() || typeof name !== "string" || !name) throw new Error("Invalid postcode location");
  const lat = Number(place.latitude);
  const lng = Number(place.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("Invalid postcode coordinates");
  const rounded = { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 };
  if (country === "us") {
    if (typeof place["state abbreviation"] !== "string") throw new Error("Invalid postcode location");
    return { ...rounded, label: `${name}, ${place["state abbreviation"]} ${code}` };
  }
  const county = typeof place.state === "string" && place.state ? `, ${place.state}` : "";
  return { ...rounded, label: `${code.slice(0, 3)} ${code.slice(3)} ${name}${county}, Sweden` };
}

export async function lookupPostcode(country: PostcodeCountry, code: string, signal: AbortSignal) {
  if (!postcodeCandidates(code).some((candidate) => candidate.country === country)) throw new Error("Invalid postcode");
  const response = await fetch(`https://api.zippopotam.us/${country}/${code}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  // 404 means the service answered and the code does not exist; anything else is a failure of the
  // lookup itself, which callers must not report as "no such postcode".
  if (response.status === 404) { const missing = new Error("Postcode not found"); missing.name = "PostcodeNotFoundError"; throw missing; }
  if (!response.ok) throw new Error("Postcode lookup failed");
  return parsePostcodeLocation(await response.json(), code, country);
}

export const isPostcodeNotFound = (reason: unknown) => (reason as { name?: string } | null)?.name === "PostcodeNotFoundError";
