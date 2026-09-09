"use client";

import { useState } from "react";
import AuthGuard from "@/components/AuthGuard";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";

function ProfileInner() {
  const supabase = createClient();
  const { user, profile, refreshProfile } = useAuth();
  const [skillsInput, setSkillsInput] = useState((profile?.skills ?? []).join(", "));
  const [servicesInput, setServicesInput] = useState((profile?.services ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!profile || !user) return <p className="text-neutral-500">Loading…</p>;

  const womPct = profile.wom_count + profile.lemon_count > 0
    ? Math.round((profile.wom_count / (profile.wom_count + profile.lemon_count)) * 100)
    : null;

  async function uploadPhoto(file: File) {
    const path = `${user!.id}/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from("profile-photos").upload(path, file, { upsert: true });
    if (error) {
      setMessage("Upload failed: " + error.message);
      return;
    }
    const url = supabase.storage.from("profile-photos").getPublicUrl(path).data.publicUrl;
    await supabase.from("profiles").update({ photo_url: url }).eq("id", user!.id);
    await refreshProfile();
    setMessage("Photo updated.");
  }

  async function saveSkillsServices() {
    setSaving(true);
    const skills = skillsInput.split(",").map((s) => s.trim()).filter(Boolean);
    const services = servicesInput.split(",").map((s) => s.trim()).filter(Boolean);
    await supabase.from("profiles").update({ skills, services }).eq("id", user!.id);
    await refreshProfile();
    setSaving(false);
    setMessage("Saved.");
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-4">
        {profile.photo_url ? (
          <img src={profile.photo_url} alt="" className="h-16 w-16 rounded-full object-cover" />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-200 text-xl">👤</div>
        )}
        <div>
          <div className="text-lg font-semibold">@{profile.username}</div>
          <label className="cursor-pointer text-sm text-emerald-700">
            Change photo
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0])}
            />
          </label>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="rounded-lg border border-neutral-200 bg-white p-3">
          <div className="text-lg font-semibold">{womPct ?? "—"}{womPct != null && "%"}</div>
          <div className="text-xs text-neutral-500">WOM%</div>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-3">
          <div className="text-lg font-semibold">{profile.lemon_count}</div>
          <div className="text-xs text-neutral-500">Lemons (private)</div>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-3">
          <div className="text-lg font-semibold">${profile.money_made.toFixed(2)}</div>
          <div className="text-xs text-neutral-500">Money Made (private)</div>
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Skills (comma-separated)</label>
          <input
            value={skillsInput}
            onChange={(e) => setSkillsInput(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Services I May Need (comma-separated)</label>
          <input
            value={servicesInput}
            onChange={(e) => setServicesInput(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2"
          />
        </div>
        <button
          onClick={saveSkillsServices}
          disabled={saving}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {message && <p className="text-sm text-neutral-500">{message}</p>}
      </div>
    </div>
  );
}

export default function Profile() {
  return (
    <AuthGuard>
      <ProfileInner />
    </AuthGuard>
  );
}
