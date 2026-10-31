"use client";

export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 50;
const KM_PER_MILE = 1.60934;

export function kmToMiles(km: number): number {
  return km / KM_PER_MILE;
}

// A single drag-to-set radius control, labelled in both km and miles so neither unit needs
// its own toggle. Used anywhere gigs or helpers are filtered by distance.
export default function RadiusSlider({
  valueKm,
  onChange,
  id = "radius-slider",
}: {
  valueKm: number;
  onChange: (km: number) => void;
  id?: string;
}) {
  const miles = kmToMiles(valueKm);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-sm">
        <label htmlFor={id} className="font-medium">Search radius</label>
        <span className="whitespace-nowrap text-neutral-600">{valueKm} km ({miles.toFixed(1)} mi)</span>
      </div>
      <input
        id={id}
        type="range"
        min={MIN_RADIUS_KM}
        max={MAX_RADIUS_KM}
        step={1}
        value={valueKm}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Search radius in kilometers"
        aria-valuetext={`${valueKm} kilometers, ${miles.toFixed(1)} miles`}
        className="w-full accent-emerald-600"
      />
      <div className="flex justify-between text-xs text-neutral-400">
        <span>{MIN_RADIUS_KM} km</span>
        <span>{MAX_RADIUS_KM} km</span>
      </div>
    </div>
  );
}
