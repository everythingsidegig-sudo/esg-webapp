"use client";

import AuthGuard from "@/components/AuthGuard";
import SelectionChip from "@/components/SelectionChip";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { approximateCoordinates, friendlyError } from "@/lib/journey";
import { SERVICE_TYPES } from "@/lib/services";
import { loadTagCatalog, MAX_PROFILE_TAGS } from "@/lib/tags";
import type { Profile as ProfileRow, Tag } from "@/lib/database.types";

function ProfileInner() {
  const { profile } = useAuth();
  if (!profile) return <p>Loading your profile…</p>;
  return <ProfileEditor key={profile.id} profile={profile} />;
}

function ProfileEditor({ profile }: { profile: ProfileRow }) {
  const supabase = createClient();
  const { refreshProfile } = useAuth();
  const [username, setUsername] = useState(profile.username);
  const [skills, setSkills] = useState(profile.skills);
  const [services, setServices] = useState(profile.services);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const catalog = [...new Set<string>([...SERVICE_TYPES, ...profile.skills, ...profile.services])];
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

  // Specializations are scoped to the caller's already-saved skills (not the
  // live, possibly-unsaved `skills` selection above), since set_helper_tags
  // validates the category against the database, not this form's draft state.
  const [tagCatalog, setTagCatalog] = useState<Record<string, Tag[]>>({});
  const [specializationTags, setSpecializationTags] = useState<Record<string, string[]>>({});
  const [savingTags, setSavingTags] = useState(false);
  const [tagsMessage, setTagsMessage] = useState<string | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadTagCatalog(supabase).then((value) => { if (active) setTagCatalog(value); }).catch(() => {});
    supabase.from("profile_tags").select("tag:tags(id,name,service_type)").eq("profile_id", profile.id)
      .then(({ data }) => {
        if (!active || !data) return;
        const byCategory: Record<string, string[]> = {};
        for (const row of data as unknown as { tag: { id: string; service_type: string } }[]) {
          (byCategory[row.tag.service_type] ??= []).push(row.tag.id);
        }
        setSpecializationTags(byCategory);
      });
    return () => { active = false; };
  }, [supabase, profile.id]);

  function toggleSpecializationTag(category: string, tagId: string) {
    setSpecializationTags((current) => {
      const selected = current[category] ?? [];
      const next = selected.includes(tagId) ? selected.filter((id) => id !== tagId)
        : selected.length >= MAX_PROFILE_TAGS ? selected : [...selected, tagId];
      return { ...current, [category]: next };
    });
  }

  async function saveSpecializations() {
    if (pending.current) return;
    pending.current = true; setSavingTags(true); setTagsError(null); setTagsMessage(null);
    try {
      for (const category of profile.skills) {
        const { error } = await supabase.rpc("set_helper_tags", { p_service_type: category, p_tag_ids: specializationTags[category] ?? [] });
        if (error) throw error;
      }
      setTagsMessage("Specializations saved.");
    } catch (error) { setTagsError(friendlyError(error, "Couldn't save specializations. Please try again.")); }
    finally { pending.current = false; setSavingTags(false); }
  }

  // Opt-in, separate from the private onboarding address: null until a helper
  // explicitly sets it here, never derived or copied from the private fields.
  const [helperLocationText, setHelperLocationText] = useState(profile.public_location_text ?? "");
  const [helperCoords, setHelperCoords] = useState({ lat: profile.public_lat, lng: profile.public_lng });
  const [locatingHelper, setLocatingHelper] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const [locationMessage, setLocationMessage] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);

  function useMyHelperLocation() {
    if (locatingHelper) return;
    setLocationError(null);
    if (!navigator.geolocation) { setLocationError("Geolocation isn't available in this browser. Enter an area manually."); return; }
    setLocatingHelper(true);
    navigator.geolocation.getCurrentPosition((pos) => {
      const approx = approximateCoordinates(pos.coords.latitude, pos.coords.longitude) as { lat: number; lng: number };
      setHelperCoords(approx);
      setHelperLocationText((current) => current || "Current location");
      setLocatingHelper(false);
    }, () => { setLocationError("Couldn't get your location. Enter an area manually."); setLocatingHelper(false); },
    { timeout: 10000, maximumAge: 60000 });
  }

  async function saveHelperLocation() {
    if (pending.current) return;
    if (!helperLocationText.trim() || helperLocationText.trim().length > 200) {
      setLocationError("Enter a general area of 1–200 characters."); return;
    }
    pending.current = true; setSavingLocation(true); setLocationError(null); setLocationMessage(null);
    try {
      const { error } = await supabase.rpc("set_helper_location", { p_location_text: helperLocationText.trim(), p_lat: helperCoords.lat, p_lng: helperCoords.lng });
      if (error) throw error;
      setLocationMessage("Helper location saved. You may now appear in nearby Find a Helper results.");
    } catch (error) { setLocationError(friendlyError(error, "Couldn't save your helper location. Please try again.")); }
    finally { pending.current = false; setSavingLocation(false); }
  }

  async function clearHelperLocation() {
    if (pending.current) return;
    pending.current = true; setSavingLocation(true); setLocationError(null); setLocationMessage(null);
    try {
      const { error } = await supabase.rpc("set_helper_location", { p_location_text: null, p_lat: null, p_lng: null });
      if (error) throw error;
      setHelperLocationText(""); setHelperCoords({ lat: null, lng: null });
      setLocationMessage("Opted out. You won't appear in location-based Find a Helper results.");
    } catch (error) { setLocationError(friendlyError(error, "Couldn't update your helper location. Please try again.")); }
    finally { pending.current = false; setSavingLocation(false); }
  }

  async function confirmSave(success: string) {
    setMessage(success);
    try { await refreshProfile(); }
    catch { setError("Your changes were saved, but the profile couldn't be refreshed. Retry the refresh above."); }
  }

  async function uploadPhoto(file: File) {
    if (pending.current) return;
    setError(null); setMessage(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError("Choose a JPG, PNG or WebP image smaller than 5 MB."); return;
    }
    pending.current = true; setSaving(true);
    try {
      const path = `${profile.id}/${crypto.randomUUID()}`;
      const { error: uploadError } = await supabase.storage.from("profile-photos").upload(path, file);
      if (uploadError) throw uploadError;
      const url = supabase.storage.from("profile-photos").getPublicUrl(path).data.publicUrl;
      const { error: saveError } = await supabase.from("profiles").update({ photo_url: url }).eq("id", profile.id).select("id").single();
      if (saveError) throw saveError;
      await confirmSave("Photo updated.");
    } catch (error) { setError(friendlyError(error, "Couldn't update your photo. Please try again.")); }
    finally { pending.current = false; setSaving(false); }
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current) return;
    setError(null); setMessage(null);
    if (!/^[A-Za-z0-9]{6,40}$/.test(username)) { setError("Username must be 6–40 letters/numbers."); return; }
    pending.current = true; setSaving(true);
    try {
      const { error } = await supabase.from("profiles").update({ username, skills, services }).eq("id", profile.id).select("id").single();
      if (error) throw error;
      await confirmSave("Profile saved.");
    } catch (error) { setError(friendlyError(error, "Couldn't save your profile. Please try again.")); }
    finally { pending.current = false; setSaving(false); }
  }

  const total = profile.wom_count + profile.lemon_count;
  return <div className="mx-auto max-w-lg space-y-6">
    <div className="flex items-center gap-4">
      {profile.photo_url ? <img src={profile.photo_url} alt="Profile photo" className="h-16 w-16 rounded-full object-cover" />
        : <div className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-200 text-xl">👤</div>}
      <div>
        <h1 className="text-lg font-semibold">@{profile.username}</h1>
        <label className="cursor-pointer text-sm text-emerald-700">Change photo
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={saving} className="hidden" onChange={(e) => { if (e.target.files?.[0]) void uploadPhoto(e.target.files[0]); }} />
        </label>
      </div>
    </div>
    <div className="grid grid-cols-3 gap-3 text-center">
      <div className="rounded-lg border border-neutral-200 bg-white p-3"><div className="text-lg font-semibold">{total ? `${Math.round(profile.wom_count / total * 100)}%` : "—"}</div><div className="text-xs text-neutral-500">WOM%</div></div>
      <div className="rounded-lg border border-neutral-200 bg-white p-3"><div className="text-lg font-semibold">{profile.lemon_count}</div><div className="text-xs text-neutral-500">Lemons (private)</div></div>
      <div className="rounded-lg border border-neutral-200 bg-white p-3"><div className="text-lg font-semibold">${Number(profile.money_made).toFixed(2)}</div><div className="text-xs text-neutral-500">Money Made (private)</div></div>
    </div>
    <form onSubmit={saveProfile} className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4">
      <fieldset disabled={saving} className="space-y-3">
        <label className="block text-sm font-medium">Username<input required maxLength={40} value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2" /></label>
        <fieldset className="min-w-0"><legend className="text-sm font-medium">Skills I can use to make money</legend>
          <div className="mt-2 flex flex-wrap gap-2">{catalog.map((item) => <SelectionChip key={item} selected={skills.includes(item)} onClick={() => setSkills(toggle(skills, item))}>{item}</SelectionChip>)}</div>
        </fieldset>
        <fieldset className="min-w-0"><legend className="text-sm font-medium">Services I might need</legend>
          <div className="mt-2 flex flex-wrap gap-2">{catalog.map((item) => <SelectionChip key={item} selected={services.includes(item)} onClick={() => setServices(toggle(services, item))}>{item}</SelectionChip>)}</div>
        </fieldset>
        <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{saving ? "Saving…" : "Save"}</button>
      </fieldset>
    </form>
    {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

    {profile.skills.length > 0 && (
      <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-medium">Specializations (optional)</h2>
        <p className="text-sm text-neutral-500">Choose up to {MAX_PROFILE_TAGS} tags per skill to help people find you for specific work.</p>
        <fieldset disabled={savingTags} className="space-y-3">
          {profile.skills.map((category) => (tagCatalog[category]?.length ?? 0) > 0 && (
            <fieldset key={category} className="min-w-0">
              <legend className="text-sm font-medium">{category}</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {tagCatalog[category].map((tag) => (
                  <SelectionChip key={tag.id} selected={(specializationTags[category] ?? []).includes(tag.id)}
                    onClick={() => toggleSpecializationTag(category, tag.id)}>
                    {tag.name}
                  </SelectionChip>
                ))}
              </div>
            </fieldset>
          ))}
          <button type="button" onClick={() => void saveSpecializations()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {savingTags ? "Saving…" : "Save specializations"}
          </button>
        </fieldset>
        {tagsMessage && <p role="status" className="text-sm text-emerald-700">{tagsMessage}</p>}
        {tagsError && <p role="alert" className="text-sm text-red-600">{tagsError}</p>}
      </div>
    )}

    {profile.skills.length > 0 && (
      <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-medium">Helper location (optional)</h2>
        <p className="text-sm text-neutral-500">
          Share an approximate area so people nearby can find you in Find a Helper. This is separate from your private address, is rounded before anyone sees it, and is never enabled unless you set it here. Leave it blank to stay out of location-based search.
        </p>
        <fieldset disabled={savingLocation || locatingHelper} className="space-y-2">
          <label className="block text-sm">Approximate area
            <input maxLength={200} value={helperLocationText} onChange={(e) => { setHelperLocationText(e.target.value); setHelperCoords({ lat: null, lng: null }); }} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2" placeholder="Neighborhood, ZIP or city" />
          </label>
          <button type="button" onClick={useMyHelperLocation} className="text-sm text-emerald-700">{locatingHelper ? "Locating…" : "Use my current location"}</button>
          <div className="flex gap-3">
            <button type="button" onClick={() => void saveHelperLocation()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
              {savingLocation ? "Saving…" : "Save location"}
            </button>
            {(profile.public_location_text || helperLocationText) && (
              <button type="button" onClick={() => void clearHelperLocation()} className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-60">Opt out</button>
            )}
          </div>
        </fieldset>
        {locationMessage && <p role="status" className="text-sm text-emerald-700">{locationMessage}</p>}
        {locationError && <p role="alert" className="text-sm text-red-600">{locationError}</p>}
      </div>
    )}
  </div>;
}
export default function Profile() { return <AuthGuard><ProfileInner /></AuthGuard>; }
