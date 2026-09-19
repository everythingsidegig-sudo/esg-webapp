"use client";

import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/journey";
import { SERVICE_TYPES } from "@/lib/services";
import type { Profile } from "@/lib/database.types";

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
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const catalog = [...new Set<string>([...SERVICE_TYPES, ...profile.skills, ...profile.services])];
  const input = "w-full rounded-lg border border-neutral-300 px-3 py-2";

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
    navigator.geolocation.getCurrentPosition((position) => {
      setCoords({ lat: position.coords.latitude, lng: position.coords.longitude });
      setArea((current) => current || "Current location"); setLocating(false);
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
    try {
      const { data, error } = await supabase.rpc("save_onboarding", {
        p_username: username, p_photo_url: photoUrl, p_location_text: area.trim(),
        p_lat: coords.lat, p_lng: coords.lng, p_skills: skills, p_services: services,
      });
      if (error || !data) throw error ?? new Error("Profile was not saved");
      await refreshProfile();
      setMessage("Profile saved.");
      onFinish?.();
    } catch (error) { setError(friendlyError(error, "We couldn't save your profile. Please retry.")); }
    finally { pending.current = false; setBusy(false); }
  }
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
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
        <fieldset><legend className="font-medium">Skills I can use to make money</legend>{catalog.map((item) => <label key={item} className="block"><input type="checkbox" checked={skills.includes(item)} onChange={() => setSkills(toggle(skills, item))} /> {item}</label>)}</fieldset>
        <fieldset><legend className="font-medium">Services I might need</legend>{catalog.map((item) => <label key={item} className="block"><input type="checkbox" checked={services.includes(item)} onChange={() => setServices(toggle(services, item))} /> {item}</label>)}</fieldset>
        <p className="text-sm text-neutral-500">Choose any that apply. One account can both post gigs and provide help.</p>
      </>}
    </fieldset>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {message && <p role="status" className="text-emerald-700">{message}</p>}
    <div className="flex gap-3">
      {step > 0 && <button disabled={busy || locating} onClick={() => { setStep(step - 1); setError(null); }} className="rounded-lg border px-4 py-2">Back</button>}
      <button disabled={busy || locating} onClick={step < 2 ? nextStep : save} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-60">{busy ? "Saving…" : step < 2 ? "Continue" : "Save profile & continue"}</button>
    </div>
  </div>;
}
