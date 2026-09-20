interface NominatimAddress {
  city?: unknown;
  town?: unknown;
  village?: unknown;
  municipality?: unknown;
  hamlet?: unknown;
  locality?: unknown;
  state?: unknown;
  region?: unknown;
  state_district?: unknown;
  country?: unknown;
}

function firstText(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

export function generalAreaLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const address = (value as { address?: NominatimAddress }).address;
  if (!address || typeof address !== "object") return null;
  const locality = firstText(address.city, address.town, address.village, address.municipality, address.hamlet, address.locality);
  const region = firstText(address.state, address.region, address.state_district);
  const country = firstText(address.country);
  const parts = locality ? [locality, country ?? region] : [region, country];
  const unique = parts.filter((part, index): part is string => !!part && parts.indexOf(part) === index);
  return unique.length ? unique.join(", ") : null;
}
