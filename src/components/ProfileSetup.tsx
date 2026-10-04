"use client";

import { useEffect, useRef, useState } from "react";
import OptionSheet from "@/components/OptionSheet";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { approximateCoordinates, friendlyError } from "@/lib/journey";
import { reverseGeocodeGeneralArea } from "@/lib/location";
import { SERVICE_TYPES, SPECIALIZATION_PROMPTS } from "@/lib/services";
import { loadTagCatalog, MAX_PROFILE_TAGS } from "@/lib/tags";
import type { Profile, Tag } from "@/lib/database.types";

const ALL_SKILLS = "*";

// Mounted only after the saved profile loads. Background refreshes never initialize empty edits.
export default function ProfileSetup({ profile, onFinish }: { profile: Profile; onFinish?: () => void }) {
  const supabase = createClient();
  const { refreshProfile } = useAuth();
  const [step, setStep] = useState(0);
  const [username, setUsername] = useState(profile.username);
  const [photoUrl, setPhotoUrl] = useState(profile.photo_url);
  const [area, setArea] = useState(profile.private_location_text ?? "");
  const [coords, setCoords] = useState({ lat: profile.private_lat, lng: profile.private_lng });
  const [skills, setSkills] = useState(profile.skills);
  const [services, setServices] = useState(profile.services);
  const [tagCatalog, setTagCatalog] = useState<Record<string, Tag[]>>({});
  const [specializationTags, setSpecializationTags] = useState<Record<string, string[]>>({});
  const [sheetScope, setSheetScope] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const catalog = [...new Set<string>([...SERVICE_TYPES, ...profile.skills, ...profile.services])];
  const input = "w-full rounded-lg border border-neutral-300 px-3 py-2";
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

  useEffect(() => {
    let active = true;
    loadTagCatalog(supabase).then((result) => { if (active) setTagCatalog(result); }).catch(() => {});
    return () => { active = false; };
  }, [supabase]);

  // Specializations (optional) for every chosen skill, picked in a sheet and
  // shown together as removable chips -- same pattern as the profile page.
  const specializationSkills = skills.filter((skill) => (tagCatalog[skill]?.length ?? 0) > 0);
  const chosenSpecializations = specializationSkills.flatMap((skill) =>
    (tagCatalog[skill] ?? []).filter((tag) => (specializationTags[skill] ?? []).includes(tag.id)).map((tag) => ({ skill, tag })));
  const sheetSkills = sheetScope === ALL_SKILLS ? specializationSkills : specializationSkills.filter((skill) => skill === sheetScope);

  function toggleSkill(item: string) {
    const adding = !skills.includes(item);
    setSkills(toggle(skills, item));
    if (adding && (tagCatalog[item]?.length ?? 0) > 0) setSheetScope(item);
  }
  function toggleSpecialization(category: string, tagId: string) {
    setSpecializationTags((current) => {
      const selected = current[category] ?? [];
      const next = selected.includes(tagId) ? selected.filter((id) => id !== tagId)
        : selected.length >= MAX_PROFILE_TAGS ? selected : [...selected, tagId];
      return { ...current, [category]: next };
    });
  }

  async function upload(file: File) {
    if (pending.current) return;
    setError(null); setMessage(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError("Choose a JPG, PNG or WebP image smaller than 5 MB."); return;
    }
    pending.current = true; setBusy(true);
    const path = `${profile.id}/${crypto.randomUUID()}`;
    try {
      const { error } = await supabase.storage.from("profile-photos").upload(path, file);
      if (error) throw error;
      setPhotoUrl(supabase.storage.from("profile-photos").getPublicUrl(path).data.publicUrl);
      setMessage("Photo ready. Finish setup to save it to your profile.");
    } catch { setError("Photo upload failed. Check your connection and try again."); }
    finally { pending.current = false; setBusy(false); }
  }
  function locate() {
    if (locating) return;
    setError(null);
    if (!navigator.geolocation) { setError("Location isn't available. Enter an address or area manually."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(async (position) => {
      setCoords({ lat: position.coords.latitude, lng: position.coords.longitude });
      try {
        // Only rounded coordinates leave the browser for the label lookup;
        // the exact private coordinates above are untouched.
        const rounded = approximateCoordinates(position.coords.latitude, position.coords.longitude) as { lat: number; lng: number };
        const label = await reverseGeocodeGeneralArea(rounded.lat, rounded.lng);
        if (label) setArea((current) => current || label);
        else setMessage("Couldn't determine your area automatically. Enter it manually.");
      } catch {
        setMessage("Couldn't determine your area automatically. Enter it manually.");
      } finally { setLocating(false); }
    }, () => { setError("Couldn't get your location. Enter an address or area manually."); setLocating(false); },
    { timeout: 10000, maximumAge: 60000 });
  }
  function nextStep() {
    setError(null); setMessage(null);
    if (step === 0 && !/^[A-Za-z0-9]{6,40}$/.test(username)) { setError("Username must be 6–40 letters/numbers."); return; }
    if (step === 1 && (!area.trim() || area.trim().length > 200)) { setError("Enter an address or area of 1–200 characters."); return; }
    setStep(step + 1);
  }
  async function save() {
    if (pending.current || locating) return;
    pending.current = true; setBusy(true); setError(null); setMessage(null);
    let profileSaved = false;
    try {
      const { data, error } = await supabase.rpc("save_onboarding", {
        p_username: username, p_photo_url: photoUrl, p_location_text: area.trim(),
        p_lat: coords.lat, p_lng: coords.lng, p_skills: skills, p_services: services,
      });
      if (error || !data) throw error ?? new Error("Profile was not saved");
      profileSaved = true;
      // Specializations need the skills saved first. Saving again is safe, so a failure here is retried by the same button.
      for (const category of skills) {
        const ids = specializationTags[category] ?? [];
        if (ids.length === 0) continue;
        const { error: tagError } = await supabase.rpc("set_helper_tags", { p_service_type: category, p_tag_ids: ids });
        if (tagError) throw tagError;
      }
      await refreshProfile();
      setMessage("Profile saved.");
      onFinish?.();
    } catch (error) {
      setError(profileSaved
        ? "Your profile saved, but some specializations couldn't be saved. Press the button again to retry."
        : friendlyError(error, "We couldn't save your profile. Please retry."));
    }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="space-y-4 rounded-lg border border-neutral-200 bg-white p-4">
    <p className="text-sm text-neutral-500">Step {step + 1} of 3: {['Basic profile', 'Private address / location', 'Skills & services'][step]}</p>
    <fieldset disabled={busy || locating} className="space-y-4">
      {step === 0 && <>
        <label className="block">Username<input required maxLength={40} value={username} onChange={(e) => setUsername(e.target.value)} className={input} /></label>
        <label className="block">Profile photo (optional)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { if (e.target.files?.[0]) void upload(e.target.files[0]); }} /></label>
        {photoUrl && <p className="text-sm">A profile photo is selected.</p>}
      </>}
      {step === 1 && <>
        <label className="block">Address or general area<input maxLength={200} value={area} onChange={(e) => { setArea(e.target.value); setCoords({ lat: null, lng: null }); }} className={input} /></label>
        <p className="text-sm text-neutral-500">This location stays private. Public gigs use a separate general area; never enter a street address on a gig.</p>
        <button type="button" onClick={locate} className="text-emerald-700">{locating ? "Locating…" : "Use my current location"}</button>
        {coords.lat != null && <p className="text-sm">Current location collected.</p>}
      </>}
      {step === 2 && <>
        <fieldset><legend className="font-medium">Skills I can use to make money</legend>{catalog.map((item) => <label key={item} className="check-row"><input type="checkbox" checked={skills.includes(item)} onChange={() => toggleSkill(item)} /> {item}</label>)}</fieldset>
        {specializationSkills.length > 0 && (
          <fieldset><legend className="font-medium">Specializations (optional)</legend>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {chosenSpecializations.map(({ skill, tag }) => (
                <span key={tag.id} className="inline-flex items-center rounded-full bg-neutral-100 pl-3 text-sm text-neutral-800">
                  {tag.name}
                  <button type="button" onClick={() => toggleSpecialization(skill, tag.id)} aria-label={`Remove ${tag.name}`}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-neutral-500 hover:text-neutral-900">✕</button>
                </span>
              ))}
              {chosenSpecializations.length === 0 && <span className="text-sm text-neutral-500">None added yet.</span>}
              <button type="button" onClick={() => setSheetScope(ALL_SKILLS)} aria-label="Add specializations"
                className="inline-flex min-h-9 items-center rounded-full border border-dashed border-emerald-600 px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-50">+ Add</button>
            </div>
          </fieldset>
        )}
        <fieldset><legend className="font-medium">Services I might need</legend>{catalog.map((item) => <label key={item} className="check-row"><input type="checkbox" checked={services.includes(item)} onChange={() => setServices(toggle(services, item))} /> {item}</label>)}</fieldset>
        <p className="text-sm text-neutral-500">Choose any that apply. One account can both post gigs and provide help.</p>
      </>}
    </fieldset>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {message && <p role="status" className="text-emerald-700">{message}</p>}
    <div className="flex gap-3">
      {step > 0 && <button disabled={busy || locating} onClick={() => { setStep(step - 1); setError(null); }} className="rounded-lg border px-4 py-2">Back</button>}
      <button disabled={busy || locating} onClick={step < 2 ? nextStep : save} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-60">{busy ? "Saving…" : step < 2 ? "Continue" : "Save profile & continue"}</button>
    </div>
    {step === 2 && sheetSkills.length > 0 && (
      <OptionSheet title={sheetScope === ALL_SKILLS ? "Add specializations" : (SPECIALIZATION_PROMPTS[sheetSkills[0]] ?? `What kind of ${sheetSkills[0].toLowerCase()}?`)}
        onClose={() => setSheetScope(null)}
        footer={<div className="flex items-center justify-between gap-3">
          <p className="text-sm text-neutral-500">{chosenSpecializations.filter(({ skill }) => sheetSkills.includes(skill)).length} selected</p>
          <button type="button" onClick={() => setSheetScope(null)} className="rounded-lg bg-emerald-600 px-6 py-2.5 font-medium text-white hover:bg-emerald-700">Done</button>
        </div>}>
        {sheetSkills.map((skill) => {
          const selectedIds = specializationTags[skill] ?? [];
          return <div key={skill} role="group" aria-label={`${skill} specializations`} className="pb-2">
            <p className="px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-emerald-700">{skill}</p>
            {(tagCatalog[skill] ?? []).map((tag) => {
              const selected = selectedIds.includes(tag.id);
              const atLimit = !selected && selectedIds.length >= MAX_PROFILE_TAGS;
              return <button key={tag.id} type="button" role="checkbox" aria-checked={selected} disabled={atLimit}
                onClick={() => toggleSpecialization(skill, tag.id)}
                className="flex min-h-12 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-sm text-neutral-900 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50">
                <span>{tag.name}</span>
                <span aria-hidden="true" className={`flex h-6 w-6 items-center justify-center rounded-md border text-sm ${selected ? "border-emerald-600 bg-emerald-600 text-white" : "border-neutral-300 text-transparent"}`}>✓</span>
              </button>;
            })}
          </div>;
        })}
      </OptionSheet>
    )}
  </div>;
}
