"use client";

import AuthGuard from "@/components/AuthGuard";
import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/journey";
import { SERVICE_TYPES } from "@/lib/services";
import type { Profile as ProfileRow } from "@/lib/database.types";

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
        <fieldset><legend className="text-sm font-medium">Skills I can use to make money</legend>{catalog.map((item) => <label key={item} className="block text-sm"><input type="checkbox" checked={skills.includes(item)} onChange={() => setSkills(toggle(skills, item))} /> {item}</label>)}</fieldset>
        <fieldset><legend className="text-sm font-medium">Services I might need</legend>{catalog.map((item) => <label key={item} className="block text-sm"><input type="checkbox" checked={services.includes(item)} onChange={() => setServices(toggle(services, item))} /> {item}</label>)}</fieldset>
        <button type="submit" className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{saving ? "Saving…" : "Save"}</button>
      </fieldset>
    </form>
    {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </div>;
}
export default function Profile() { return <AuthGuard><ProfileInner /></AuthGuard>; }
