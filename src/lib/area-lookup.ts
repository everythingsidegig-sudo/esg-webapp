import { postcodeCandidates, lookupPostcode, isPostcodeNotFound } from "@/lib/zip-location";
import { searchAreas, type AreaMatch } from "@/lib/area-search";

export type AreaLookup =
  | { kind: "single"; area: AreaMatch }
  | { kind: "choices"; choices: AreaMatch[] }
  | { kind: "none" };

// One place for "what did the visitor mean by this text?". A postcode (US ZIP, Swedish
// postcode, or a five-digit code that could be either) is looked up directly: exactly one
// hit selects itself, several let the visitor choose. Anything else -- a neighborhood, a
// city, another country's postcode -- goes to the area search and is returned as choices.
// Network failures are not swallowed: a lookup that cannot run throws, so the caller can
// say so instead of claiming nothing exists.
export async function resolveAreaQuery(text: string, signal: AbortSignal): Promise<AreaLookup> {
  const query = text.trim();
  const candidates = postcodeCandidates(query);
  if (candidates.length > 0) {
    const settled = await Promise.allSettled(candidates.map((candidate) => lookupPostcode(candidate.country, candidate.code, signal)));
    const found: AreaMatch[] = settled.flatMap((result) => result.status === "fulfilled"
      ? [{ label: result.value.label, areaLabel: result.value.label, lat: result.value.lat, lng: result.value.lng }] : []);
    if (found.length === 1) return { kind: "single", area: found[0] };
    if (found.length > 1) return { kind: "choices", choices: found };
    // Nothing found: either the service said "no such code", or it could not be asked.
    const unreachable = settled.flatMap((result) => result.status === "rejected" && !isPostcodeNotFound(result.reason) ? [result.reason] : []);
    if (unreachable.length > 0) throw unreachable[0];
    // A bare five-digit code that neither a US ZIP nor a Swedish postcode matches is not a place:
    // a fuzzy name search would only return unrelated towns that happen to contain the digits.
    if (/^\d{5}$/.test(query)) return { kind: "none" };
  }
  const matches = await searchAreas(query, signal);
  return matches.length > 0 ? { kind: "choices", choices: matches } : { kind: "none" };
}
