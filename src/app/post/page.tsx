"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import SelectionChip from "@/components/SelectionChip";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { approximateCoordinates, friendlyError, gigInputError } from "@/lib/journey";
import { loadJourneyLocation, reverseGeocodeGeneralArea } from "@/lib/location";
import { SERVICE_TYPES } from "@/lib/services";
import { CURRENCY } from "@/lib/money";
import { PRICE_CHOICES, requestUsername, requestableCategories } from "@/lib/helper-request";
import { loadTagCatalog, MAX_GIG_TAGS } from "@/lib/tags";
import { canRepost, repostDraft, repostParam } from "@/lib/repost";
import type { Gig, PriceType, Tag } from "@/lib/database.types";

interface CreationRequest {
  p_request_id: string; p_service_type: string; p_title: string; p_description: string;
  p_amount: number; p_price_type: string; p_scheduled_at: string | null;
  p_location_text: string; p_lat: number | null; p_lng: number | null;
  p_photo_url: string | null; p_publish: boolean; p_tag_ids: string[]; p_private_address?: string | null;
  // Set only for a private request to one helper (/post?helper=<username>); absent for a public gig.
  p_requested_helper_id?: string | null;
}
// The helper a private request is addressed to, as the page knows them.
type RequestedHelper = { id: string; username: string; categories: string[] };
// Reposting a closed gig (/post?repost=<id>): its details prefill this same form.
type RepostLoad = { state: "none" } | { state: "loading" } | { state: "ready"; title: string } | { state: "error"; message: string };
type HelperLookup = { state: "none" } | { state: "loading" } | { state: "ready"; helper: RequestedHelper } | { state: "error"; message: string };
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
  // A retried request keeps its original helper, whatever the address bar says now.
  const helperParam = params.get("helper");
  const helperUsername = requestUsername(helperParam);
  const helperId = retained?.p_requested_helper_id ?? null;
  const [lookup, setLookup] = useState<HelperLookup>(() => helperId || helperUsername ? { state: "loading" }
    : helperParam !== null ? { state: "error", message: "That helper link isn't valid." } : { state: "none" });
  // A request still awaiting confirmation always wins over a repost link.
  const repostRaw = params.get("repost");
  const repostId = retained ? null : repostParam(repostRaw);
  const [repost, setRepost] = useState<RepostLoad>(() => retained ? { state: "none" }
    : repostId ? { state: "loading" } : repostRaw !== null ? { state: "error", message: "That repost link isn't valid." } : { state: "none" });
  const [priceType, setPriceType] = useState<PriceType>(retained?.p_price_type === "negotiable" ? "negotiable" : "fixed");
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
  const [privateAddress, setPrivateAddress] = useState(retained?.p_private_address ?? "");
  const [photo, setPhoto] = useState<File | null>(null);
  const [uploadedPhoto, setUploadedPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const input = "w-full rounded-lg border border-neutral-300 px-3 py-2";

  useEffect(() => {
    if (!helperId && !helperUsername) return;
    let active = true;
    const base = supabase.from("public_profiles").select("id,username,skills");
    (helperId ? base.eq("id", helperId) : base.eq("username", helperUsername!)).maybeSingle().then(({ data, error: lookupError }) => {
      if (!active) return;
      const row = data as { id: string; username: string; skills: string[] | null } | null;
      if (lookupError) { setLookup({ state: "error", message: "Couldn't load that helper. Check your connection and try again." }); return; }
      if (!row) { setLookup({ state: "error", message: "That helper couldn't be found." }); return; }
      if (row.id === user!.id) { setLookup({ state: "error", message: "You can't send a request to yourself." }); return; }
      const categories = requestableCategories(row.skills, SERVICE_TYPES);
      if (categories.length === 0) { setLookup({ state: "error", message: `@${row.username} hasn't listed a service you can request yet.` }); return; }
      setLookup({ state: "ready", helper: { id: row.id, username: row.username, categories } });
      // The helper only does what they offer: start on the category that was searched for, if any.
      const wanted = params.get("category") ?? "";
      setServiceType((current) => retained ? current : categories.includes(wanted) ? wanted : categories.includes(current) ? current : categories[0]);
    }, () => { if (active) setLookup({ state: "error", message: "Couldn't load that helper. Check your connection and try again." }); });
    return () => { active = false; };
    // The helper is looked up once per link; the retained request only supplies the id at load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, helperId, helperUsername]);

  useEffect(() => {
    if (!repostId) return;
    let active = true;
    (async () => {
      try {
        const { data, error: loadError } = await supabase.from("gigs").select("*, gig_tags(tag_id)").eq("id", repostId).maybeSingle();
        if (!active) return;
        if (loadError) { setRepost({ state: "error", message: "Couldn't load that gig. Check your connection and try again." }); return; }
        const gig = data as (Gig & { gig_tags: { tag_id: string }[] | null }) | null;
        if (!gig) { setRepost({ state: "error", message: "That gig couldn't be found." }); return; }
        if (gig.poster_id !== user!.id) { setRepost({ state: "error", message: "You can only repost your own gigs." }); return; }
        if (!canRepost(gig, user!.id)) { setRepost({ state: "error", message: "Only a cancelled or completed gig can be reposted." }); return; }
        const { data: addressRow } = await supabase.from("gig_private_locations").select("address_text").eq("gig_id", repostId).maybeSingle();
        if (!active) return;
        const draft = repostDraft(gig, (addressRow as { address_text: string } | null)?.address_text);
        setTitle(draft.title);
        setDescription(draft.description);
        setAmount(draft.amount);
        if (draft.locationText) { setLocationText(draft.locationText); setCoordinates({ lat: draft.lat, lng: draft.lng }); }
        setPrivateAddress(draft.privateAddress);
        setUploadedPhoto(draft.photoUrl);
        // A private request keeps the helper's own categories; otherwise copy the category and its tags.
        if (!helperUsername) { setServiceType(draft.serviceType); setTagIds(draft.tagIds); }
        setRepost({ state: "ready", title: gig.title });
      } catch {
        if (active) setRepost({ state: "error", message: "Couldn't load that gig. Check your connection and try again." });
      }
    })();
    return () => { active = false; };
    // Loaded once per link; helperUsername only decides whether the category is copied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, repostId]);

  useEffect(() => {
    let active = true;
    loadTagCatalog(supabase).then((catalog) => { if (active) setTagCatalog(catalog); }).catch(() => {});
    return () => { active = false; };
  }, [supabase]);

  // Same behavior as the profile helper-location button: rounded coordinates
  // only, resolved to a locality label; never the literal "Current location".
  function useMyLocation() {
    if (locating) return;
    setLocationNotice(null);
    if (!navigator.geolocation) { setLocationNotice("Geolocation isn't available in this browser. Enter an area manually."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(async (position) => {
      try {
        const approx = approximateCoordinates(position.coords.latitude, position.coords.longitude) as { lat: number; lng: number };
        setCoordinates(approx);
        const label = await reverseGeocodeGeneralArea(approx.lat, approx.lng);
        if (label) setLocationText(label);
        else setLocationNotice("Couldn't determine your area automatically. Enter it manually.");
      } catch {
        setLocationNotice("Couldn't determine your area automatically. Enter it manually.");
      } finally { setLocating(false); }
    }, () => { setLocationNotice("We couldn't access your location. Enter your area manually."); setLocating(false); },
    { timeout: 10000, maximumAge: 60000 });
  }

  function toggleTag(id: string) {
    setTagIds((current) => current.includes(id) ? current.filter((item) => item !== id)
      : current.length >= MAX_GIG_TAGS ? current : [...current, id]);
  }

  async function submit(publish: boolean) {
    if (pending.current) return;
    setError(null);
    if (lookup.state === "loading" || lookup.state === "error") return;
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
          p_price_type: requestedHelper ? priceType : "fixed", p_scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
          p_location_text: locationText.trim(), p_lat: coords.lat, p_lng: coords.lng,
          p_photo_url: photoUrl, p_publish: publish, p_tag_ids: tagIds,
          p_private_address: privateAddress.trim() || null,
          ...(requestedHelper ? { p_requested_helper_id: requestedHelper.id } : {}) };
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
      setError(friendlyError(error, requestedHelper
        ? "We couldn't confirm whether your request was saved. Retry this same request to safely check without creating another one."
        : "We couldn't confirm whether your gig was saved. Retry this same request to safely check without creating another gig."));
    } finally { pending.current = false; setSubmitting(false); }
  }
  const requestedHelper = lookup.state === "ready" ? lookup.helper : null;
  const categoryChoices = requestedHelper ? requestedHelper.categories : SERVICE_TYPES;
  if (lookup.state === "error") {
    return <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-semibold">Post a Gig</h1>
      <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{lookup.message}</p>
      <Link href="/find-helper" className="touch-link block text-sm font-medium text-emerald-700">← Back to Find a Helper</Link>
      <Link href="/post" className="touch-link block text-sm font-medium text-emerald-700">Post a public gig instead</Link>
    </div>;
  }
  if (lookup.state === "loading") return <p className="text-neutral-500">Loading the helper…</p>;
  if (repost.state === "error") {
    return <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-semibold">Repost a gig</h1>
      <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{repost.message}</p>
      <Link href="/my-gigs" className="touch-link block text-sm font-medium text-emerald-700">← Back to My Gigs</Link>
      <Link href="/post" className="touch-link block text-sm font-medium text-emerald-700">Post a new gig from scratch</Link>
    </div>;
  }
  if (repost.state === "loading") return <p className="text-neutral-500">Loading the gig…</p>;
  return <div className="mx-auto max-w-lg space-y-4">
    <h1 className="text-xl font-semibold">{requestedHelper ? `Post a Gig for @${requestedHelper.username}` : "Post a Gig"}</h1>
    {requestedHelper && (
      <div role="note" className="space-y-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
        <p><strong>Private request.</strong> Only @{requestedHelper.username} will see it, and it isn&apos;t posted publicly or shown in Browse.</p>
        {!retained && <Link href="/post" className="touch-link font-medium underline">Post a public gig instead</Link>}
      </div>
    )}
    {repost.state === "ready" && (
      <div role="note" className="space-y-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
        <p><strong>Reposting &ldquo;{repost.title}&rdquo; as a new gig.</strong> The details are copied below. Choose a new date and check everything before you post. The original gig stays as it is.</p>
        {!requestedHelper && <p>The repost is a regular gig that every helper can see.</p>}
      </div>
    )}
    {retained && <p role="status">A previous request is awaiting confirmation. Retry it to check the saved gig safely.</p>}
    <fieldset disabled={submitting || !!retained} className="space-y-4">
      <div role="radiogroup" aria-labelledby="category-label">
        <p id="category-label" className="text-sm font-medium">Choose a category</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {categoryChoices.map((item, index) => <SelectionChip key={item} role="radio"
            selected={serviceType === item} tabIndex={serviceType === item ? 0 : -1}
            onClick={() => { setServiceType(item); setTagIds([]); }}
            onKeyDown={(event) => {
              const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
              if (direction === undefined) return;
              event.preventDefault();
              const next = (index + direction + categoryChoices.length) % categoryChoices.length;
              setServiceType(categoryChoices[next]);
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
      <label className="block">Brief Description<textarea required maxLength={50} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className={input} /></label>
      <label className="block">Photo (optional)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { setPhoto(e.target.files?.[0] ?? null); setUploadedPhoto(null); }} /></label>
      {uploadedPhoto && !photo && repost.state === "ready" && <p className="text-sm text-neutral-500">The original photo will be reused. Choose a file to replace it.</p>}
      <label className="block">Budget ({CURRENCY})<input type="number" min="0.01" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} className={input} /></label>
      {requestedHelper ? (
        <div role="radiogroup" aria-labelledby="pricing-label">
          <p id="pricing-label" className="text-sm font-medium">Pricing</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {PRICE_CHOICES.map((choice) => <SelectionChip key={choice.value} role="radio" selected={priceType === choice.value}
              tabIndex={priceType === choice.value ? 0 : -1} onClick={() => setPriceType(choice.value)}
              onKeyDown={(event) => {
                if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
                event.preventDefault();
                const other = PRICE_CHOICES.find((item) => item.value !== choice.value)!;
                setPriceType(other.value);
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[PRICE_CHOICES.indexOf(other)]?.focus();
              }}>{choice.label}</SelectionChip>)}
          </div>
          <p className="mt-1 text-sm text-neutral-500">{PRICE_CHOICES.find((choice) => choice.value === priceType)!.hint}</p>
        </div>
      ) : <p className="text-sm">Pricing: Fixed</p>}
      <label className="block">Expected Date/Time<input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className={input} /></label>
      <label className="block">Approximate Location<input maxLength={200} value={locationText} onChange={(e) => { setLocationText(e.target.value); setCoordinates({ lat: null, lng: null }); }} className={input} /></label>
      <button type="button" onClick={useMyLocation} className="text-sm font-medium text-emerald-700">{locating ? "Locating…" : "📍 Use my current location"}</button>
      {locationNotice && <p role="status" className="text-sm text-neutral-600">{locationNotice}</p>}
      <p className="text-sm text-neutral-500">Use a neighborhood, ZIP or city here. This is what everyone can see. Coordinates, if collected, are rounded to a general area.</p>
      <label className="block">Exact address (optional, private)<input maxLength={300} autoComplete="street-address" value={privateAddress} onChange={(e) => setPrivateAddress(e.target.value)} className={input} /></label>
      <p className="text-sm text-neutral-500">Only you and the helper you accept can see this. It is never shown on the gig page to anyone else.</p>
    </fieldset>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <div className="flex gap-3">
      {!retained && <button onClick={() => void submit(false)} disabled={submitting} className="flex-1 rounded-lg border py-2.5 disabled:opacity-60">Save as Draft</button>}
      <button onClick={() => void submit(true)} disabled={submitting} className="flex-1 rounded-lg bg-emerald-600 py-2.5 text-white disabled:opacity-60">{submitting ? (requestedHelper ? "Sending…" : "Posting…") : retained ? "Retry previous request" : requestedHelper ? "Send request" : "Post Gig"}</button>
    </div>
  </div>;
}
export default function PostGig() { return <AuthGuard><Suspense fallback={<p>Loading posting form…</p>}><PostGigForm /></Suspense></AuthGuard>; }
