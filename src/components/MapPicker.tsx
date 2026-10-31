"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type { Map as LeafletMap, Marker, Circle } from "leaflet";
import { approximateCoordinates } from "@/lib/journey";

export type MapPoint = { lat: number; lng: number };

// An OpenStreetMap map with one pin the visitor can drop or drag. Whatever the pin says is
// rounded to two decimals (the same general-area precision the rest of the app stores) and the
// pin snaps to that rounded point, so what is shown is what is saved. The map follows the
// `lat`/`lng` props, so choosing a ZIP, a neighborhood or "use my location" moves the pin, and
// moving the pin reports back through `onPick`; the parent keeps text and coordinates in step.
// An optional `radiusKm` draws a circle around the pin -- the active search radius, where one
// exists (Browse, Find a Helper); omitted elsewhere, where a pin just marks a single spot.
//
// Leaflet touches `window` when it loads, so it is imported only inside the effect, in the
// browser. If it (or the tile service) fails, the page says so and the entered location still
// stands on its own -- the map is never required to continue.
export default function MapPicker({ lat, lng, onPick, radiusKm }: { lat: number; lng: number; onPick: (point: MapPoint) => void; radiusKm?: number | null }) {
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<{ map: LeafletMap; marker: Marker; circle: Circle | null; L: typeof import("leaflet") } | null>(null);
  const pick = useRef(onPick);
  const [failed, setFailed] = useState(false);
  const [tilesFailed, setTilesFailed] = useState(false);

  useEffect(() => { pick.current = onPick; });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const leaflet = await import("leaflet");
        // Bundlers expose the CommonJS module as `default`; a plain require does not.
        const L = ((leaflet as unknown as { default?: typeof import("leaflet") }).default ?? leaflet) as typeof import("leaflet");
        if (cancelled || !container.current) return;
        const map = L.map(container.current, { center: [lat, lng], zoom: 12, scrollWheelZoom: false });
        const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>',
        }).addTo(map);
        tiles.on("tileerror", () => setTilesFailed(true));
        tiles.on("tileload", () => setTilesFailed(false));
        // An emoji pin: no marker image files to resolve through the bundler.
        const icon = L.divIcon({ className: "", html: '<div style="font-size:32px;line-height:32px;transform:translate(-50%,-100%)" aria-hidden="true">📍</div>', iconSize: [0, 0] });
        const marker = L.marker([lat, lng], { draggable: true, icon, title: "Drag to adjust the pin", alt: "Location pin" }).addTo(map);
        const settle = (point: { lat: number; lng: number }) => {
          const rounded = approximateCoordinates(point.lat, point.lng) as MapPoint;
          marker.setLatLng([rounded.lat, rounded.lng]);
          pick.current(rounded);
        };
        marker.on("dragend", () => settle(marker.getLatLng()));
        map.on("click", (event) => settle(event.latlng));
        const circle = radiusKm
          ? L.circle([lat, lng], { radius: radiusKm * 1000, color: "#059669", weight: 1.5, fillColor: "#059669", fillOpacity: 0.08 }).addTo(map)
          : null;
        handle.current = { map, marker, circle, L };
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; handle.current?.map.remove(); handle.current = null; };
    // The map and its initial circle are created once; the effect below keeps both
    // following lat/lng/radiusKm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = handle.current;
    if (!current) return;
    const at = current.marker.getLatLng();
    if (at.lat !== lat || at.lng !== lng) {
      current.marker.setLatLng([lat, lng]);
      current.map.setView([lat, lng]);
    }
    if (!radiusKm) {
      current.circle?.remove();
      current.circle = null;
    } else if (current.circle) {
      current.circle.setLatLng([lat, lng]);
      current.circle.setRadius(radiusKm * 1000);
    } else {
      current.circle = current.L.circle([lat, lng], { radius: radiusKm * 1000, color: "#059669", weight: 1.5, fillColor: "#059669", fillOpacity: 0.08 }).addTo(current.map);
    }
  }, [lat, lng, radiusKm]);

  if (failed) {
    return <p role="status" className="rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-600">The map couldn&apos;t load. Your area is still saved, so you can continue without it.</p>;
  }
  return (
    <div className="space-y-1.5">
      <div ref={container} role="application" aria-label="Map: tap or drag the pin to adjust your area" className="relative z-0 h-64 w-full overflow-hidden rounded-xl border border-neutral-200 isolate" />
      {tilesFailed && <p role="status" className="text-xs text-neutral-500">Map tiles are slow or unavailable. You can still set the pin, or just keep the area you entered.</p>}
      <p className="text-xs text-neutral-500">
        Tap the map or drag the pin to adjust. The pin is rounded to a general area.
        {radiusKm ? ` The circle shows your ${radiusKm} km search radius.` : ""}
      </p>
    </div>
  );
}
