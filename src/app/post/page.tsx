"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import SelectionChip from "@/components/SelectionChip";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { approximateCoordinates, friendlyError, gigInputError } from "@/lib/journey";
import { loadJourneyLocation } from "@/lib/location";
import { SERVICE_TYPES } from "@/lib/services";
import { loadTagCatalog, MAX_GIG_TAGS } from "@/lib/tags";
import type { Tag } from "@/lib/database.types";

interface CreationRequest {
  p_request_id: string; p_service_type: string; p_title: string; p_description: string;
  p_amount: number; p_price_type: string; p_scheduled_at: string | null;
  p_location_text: string; p_lat: number | null; p_lng: number | null;
  p_photo_url: string | null; p_publish: boolean; p_tag_ids: string[];
}
function readPending(key: string): CreationRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return value && typeof value.p_request_id === "string" ? value : null;
  } catch { return null; }
}
function localDate(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function PostGigForm() {
  const supabase = createClient();
  const router = useRouter();
  const params = useSearchParams();
  const { user } = useAuth();
  const key = `esg:post:${user!.id}`;
  const [retained, setRetained] = useState<CreationRequest | null>(() => readPending(key));
  const [initialLocation] = useState(loadJourneyLocation);
  const [serviceType, setServiceType] = useState<string>(retained?.p_service_type ?? SERVICE_TYPES[0]);
  const [tagCatalog, setTagCatalog] = useState<Record<string, Tag[]>>({});
  const [tagIds, setTagIds] = useState<string[]>(retained?.p_tag_ids ?? []);
  const [title, setTitle] = useState(retained?.p_title ?? "");
  const [description, setDescription] = useState(retained?.p_description ?? "");
  const [amount, setAmount] = useState(retained ? String(retained.p_amount) : "");
  const [scheduledAt, setScheduledAt] = useState(localDate(retained?.p_scheduled_at));
  const [locationText, setLocationText] = useState(retained?.p_location_text ?? (initialLocation.text || params.get("loc") || ""));
  const [coordinates, setCoordinates] = useState({ lat: retained?.p_lat ?? initialLocation.lat, lng: retained?.p_lng ?? initialLocation.lng });
  const [photo, setPhoto] = useState<File | null>(null);
  const [uploadedPhoto, setUploadedPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const input = "w-full rounded-lg border border-neutral-300 px-3 py-2";

  useEffect(() => {
    let active = true;
    loadTagCatalog(supabase).then((catalog) => { if (active) setTagCatalog(catalog); }).catch(() => {});
    return () => { active = false; };
  }, [supabase]);

  function toggleTag(id: string) {
    setTagIds((current) => current.includes(id) ? current.filter((item) => item !== id)
      : current.length >= MAX_GIG_TAGS ? current : [...current, id]);
  }

  async function submit(publish: boolean) {
    if (pending.current) return;
    setError(null);
    if (!retained) {
      const invalid = gigInputError(title, description, amount, scheduledAt, locationText, publish);
      if (invalid) { setError(invalid); return; }
    }
    pending.current = true; setSubmitting(true);
    try {
      let request = retained;
      if (!request) {
        let photoUrl = uploadedPhoto;
        if (photo && !photoUrl) {
          if (!["image/jpeg", "image/png", "image/webp"].includes(photo.type) || photo.size > 5 * 1024 * 1024) {
            setError("Choose a JPG, PNG or WebP image smaller than 5 MB."); return;
          }
          const path = `${user!.id}/${crypto.randomUUID()}`;
          const { error } = await supabase.storage.from("gig-photos").upload(path, photo);
          if (error) { setError("Photo upload failed. Check your connection and try again."); return; }
          photoUrl = supabase.storage.from("gig-photos").getPublicUrl(path).data.publicUrl;
          setUploadedPhoto(photoUrl);
        }
        const coords = approximateCoordinates(coordinates.lat, coordinates.lng);
        request = { p_request_id: crypto.randomUUID(), p_service_type: serviceType,
          p_title: title.trim(), p_description: description.trim(), p_amount: Number(amount),
          p_price_type: "fixed", p_scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
          p_location_text: locationText.trim(), p_lat: coords.lat, p_lng: coords.lng,
          p_photo_url: photoUrl, p_publish: publish, p_tag_ids: tagIds };
        // Preserve the request before sending. Ambiguous network failures reuse this ID/payload.
        try { sessionStorage.setItem(key, JSON.stringify(request)); } catch {
          setError("Browser storage is unavailable. Enable site storage before posting so retries stay safe."); return;
        }
        setRetained(request);
      }
      const { data, error } = await supabase.rpc("create_gig", request);
      if (error || !data) {
        // Known validation failures cannot have committed: let the user correct the form.
        if (error?.code === "22023") { sessionStorage.removeItem(key); setRetained(null); }
        throw error ?? new Error("Missing creation response");
      }
      sessionStorage.removeItem(key);
      router.replace(data.status === "draft" ? `/my-gigs?created=${encodeURIComponent(data.id)}` : `/gigs/${encodeURIComponent(data.id)}`);
    } catch (error) {
      setError(friendlyError(error, "We couldn't confirm whether your gig was saved. Retry this same request to safely check without creating another gig."));
    } finally { pending.current = false; setSubmitting(false); }
  }
  return <div className="mx-auto max-w-lg space-y-4">
    <h1 className="text-xl font-semibold">Post a Gig</h1>
    {retained && <p role="status">A previous request is awaiting confirmation. Retry it to check the saved gig safely.</p>}
    <fieldset disabled={submitting || !!retained} className="space-y-4">
      <div role="radiogroup" aria-labelledby="category-label">
        <p id="category-label" className="text-sm font-medium">Choose a category</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {SERVICE_TYPES.map((item, index) => <SelectionChip key={item} role="radio"
            selected={serviceType === item} tabIndex={serviceType === item ? 0 : -1}
            onClick={() => { setServiceType(item); setTagIds([]); }}
            onKeyDown={(event) => {
              const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
              if (direction === undefined) return;
              event.preventDefault();
              const next = (index + direction + SERVICE_TYPES.length) % SERVICE_TYPES.length;
              setServiceType(SERVICE_TYPES[next]);
              setTagIds([]);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            }}>{item}</SelectionChip>)}
        </div>
      </div>
      {(tagCatalog[serviceType]?.length ?? 0) > 0 && (
        <fieldset className="min-w-0">
          <legend className="text-sm font-medium">Tags (optional, up to {MAX_GIG_TAGS})</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {tagCatalog[serviceType].map((tag) => (
              <SelectionChip key={tag.id} selected={tagIds.includes(tag.id)} onClick={() => toggleTag(tag.id)}>{tag.name}</SelectionChip>
            ))}
          </div>
        </fieldset>
      )}
      <label className="block">Gig Title<input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={input} /></label>
      <label className="block">Brief Description<textarea required maxLength={280} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className={input} /></label>
      <label className="block">Photo (optional)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { setPhoto(e.target.files?.[0] ?? null); setUploadedPhoto(null); }} /></label>
      <label className="block">Amount ($)<input type="number" min="0.01" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} className={input} /></label>
      <p className="text-sm">Pricing: Fixed</p>
      <label className="block">Expected Date/Time<input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className={input} /></label>
      <label className="block">Approximate Location<input maxLength={200} value={locationText} onChange={(e) => { setLocationText(e.target.value); setCoordinates({ lat: null, lng: null }); }} className={input} /></label>
      <p className="text-sm text-neutral-500">Use a neighborhood, ZIP or city. Never post your street address. Coordinates, if collected, are rounded to a general area.</p>
    </fieldset>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <div className="flex gap-3">
      {!retained && <button onClick={() => void submit(false)} disabled={submitting} className="flex-1 rounded-lg border py-2.5 disabled:opacity-60">Save as Draft</button>}
      <button onClick={() => void submit(true)} disabled={submitting} className="flex-1 rounded-lg bg-emerald-600 py-2.5 text-white disabled:opacity-60">{submitting ? "Posting…" : retained ? "Retry previous request" : "Post Gig"}</button>
    </div>
  </div>;
}
export default function PostGig() { return <AuthGuard><Suspense fallback={<p>Loading posting form…</p>}><PostGigForm /></Suspense></AuthGuard>; }
