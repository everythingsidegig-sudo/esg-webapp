export interface AreaMatch {
  label: string;
  areaLabel: string;
  lat: number;
  lng: number;
}

export function parseAreaMatches(data: unknown): AreaMatch[] {
  const features = (data as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const matches: AreaMatch[] = [];
  for (const feature of features) {
    const p = feature?.properties;
    const coordinates = feature?.geometry?.coordinates;
    if (!p || !Array.isArray(coordinates)) continue;
    const [lng, lat] = coordinates;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)
        || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
    const join = (parts: unknown[]) => [...new Set(parts.map(text).filter(Boolean))].join(', ');
    const neighborhood = text(p.neighbourhood) || text(p.neighborhood) || text(p.suburb) || text(p.district);
    const areaName = ['district', 'locality', 'city', 'county', 'state', 'country'].includes(p.type)
      || p.osm_key === 'place' ? text(p.name) : '';
    // The saved journey label excludes house numbers and street addresses.
    const areaLabel = join([neighborhood || areaName, p.city || p.county, p.state, p.country]);
    const street = [text(p.housenumber), text(p.street)].filter(Boolean).join(' ');
    const label = join([p.name, street, neighborhood, p.city || p.county, p.state, p.country]);
    if (!label || !areaLabel) continue;
    const match = { label, areaLabel, lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 };
    if (!matches.some(item => item.label === label && item.lat === match.lat && item.lng === match.lng)) matches.push(match);
  }
  return matches.slice(0, 5);
}

export async function searchAreas(query: string, signal: AbortSignal): Promise<AreaMatch[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3 || trimmed.length > 200) return [];
  const url = new URL(process.env.NEXT_PUBLIC_AREA_SEARCH_URL || 'https://photon.komoot.io/api/');
  url.search = new URLSearchParams({ q: trimmed, limit: '5', lang: 'en' }).toString();
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  if (!response.ok) throw new Error('Area search failed');
  return parseAreaMatches(await response.json());
}
