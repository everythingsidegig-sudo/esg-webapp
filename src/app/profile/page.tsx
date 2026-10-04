"use client";

import AuthGuard from "@/components/AuthGuard";
import OptionSheet from "@/components/OptionSheet";
import SelectionChip from "@/components/SelectionChip";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { approximateCoordinates, friendlyError } from "@/lib/journey";
import { reverseGeocodeGeneralArea, clearGeneralAreaState } from "@/lib/location";
import { SERVICE_TYPES, SPECIALIZATION_PROMPTS } from "@/lib/services";
import { loadTagCatalog, MAX_PROFILE_TAGS } from "@/lib/tags";
import type { Profile as ProfileRow, Tag } from "@/lib/database.types";

const ALL_SKILLS = "*";

function ProfileInner() {
  const { profile } = useAuth();
  if (!profile) return <p>Loading your profile…</p>;
  return <ProfileEditor key={profile.id} profile={profile} />;
}

function ProfileEditor({ profile }: { profile: ProfileRow }) {
  const supabase = createClient();
  const router = useRouter();
  const { refreshProfile } = useAuth();
  const [username, setUsername] = useState(profile.username);
  const [skills, setSkills] = useState(profile.skills);
  const [services, setServices] = useState(profile.services);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const catalog = [...new Set<string>([...SERVICE_TYPES, ...profile.skills, ...profile.services])];
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

  // Specializations are edited inline under each selected skill below, and
  // saved as part of the one Save action. The catalog and the caller's
  // existing selections load once; until they do, saving the profile skips
  // syncing specializations rather than risk overwriting real selections
  // with an empty draft.
  const [tagCatalog, setTagCatalog] = useState<Record<string, Tag[]>>({});
  const [specializationTags, setSpecializationTags] = useState<Record<string, string[]>>({});
  const [savedSpecializations, setSavedSpecializations] = useState<Record<string, string[]>>({});
  const [helperDataLoaded, setHelperDataLoaded] = useState(false);

  // "Update profile" is only actionable once something differs from what's saved.
  const sameItems = (a: string[], b: string[]) => a.length === b.length && a.every((item) => b.includes(item));
  const dirty = username !== profile.username
    || !sameItems(skills, profile.skills)
    || !sameItems(services, profile.services)
    || (helperDataLoaded && skills.some((category) => !sameItems(specializationTags[category] ?? [], savedSpecializations[category] ?? [])));

  useEffect(() => {
    let active = true;
    Promise.all([
      loadTagCatalog(supabase),
      supabase.from("profile_tags").select("tag:tags(id,name,service_type)").eq("profile_id", profile.id),
    ]).then(([catalogResult, { data }]) => {
      if (!active) return;
      setTagCatalog(catalogResult);
      const byCategory: Record<string, string[]> = {};
      for (const row of (data ?? []) as unknown as { tag: { id: string; service_type: string } }[]) {
        (byCategory[row.tag.service_type] ??= []).push(row.tag.id);
      }
      setSpecializationTags(byCategory);
      setSavedSpecializations(byCategory);
      setHelperDataLoaded(true);
    }).catch(() => {});
    return () => { active = false; };
  }, [supabase, profile.id]);

  // Specializations for every selected skill live in one place: removable
  // chips for what's chosen, and a bottom sheet (large rows, easy on phones)
  // to add more.
  // The sheet opens for one skill when it's newly selected, or for all selected
  // skills (grouped) from the "+ Add" pill.
  const [sheetScope, setSheetScope] = useState<string | null>(null);
  const specializationSkills = skills.filter((skill) => (tagCatalog[skill]?.length ?? 0) > 0);
  const sheetSkills = sheetScope === ALL_SKILLS ? specializationSkills : specializationSkills.filter((skill) => skill === sheetScope);
  function toggleSkill(item: string) {
    const adding = !skills.includes(item);
    setSkills(toggle(skills, item));
    if (adding && (tagCatalog[item]?.length ?? 0) > 0) setSheetScope(item);
  }
  const chosenSpecializations = specializationSkills.flatMap((skill) =>
    (tagCatalog[skill] ?? []).filter((tag) => (specializationTags[skill] ?? []).includes(tag.id)).map((tag) => ({ skill, tag })));

  function toggleSpecializationTag(category: string, tagId: string) {
    setSpecializationTags((current) => {
      const selected = current[category] ?? [];
      const next = selected.includes(tagId) ? selected.filter((id) => id !== tagId)
        : selected.length >= MAX_PROFILE_TAGS ? selected : [...selected, tagId];
      return { ...current, [category]: next };
    });
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
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const approx = approximateCoordinates(pos.coords.latitude, pos.coords.longitude) as { lat: number; lng: number };
      setHelperCoords(approx);
      try {
        const label = await reverseGeocodeGeneralArea(approx.lat, approx.lng);
        if (label) setHelperLocationText((current) => current || label);
        else setLocationError("Couldn't determine your area automatically. Enter it manually.");
      } catch {
        setLocationError("Couldn't determine your area automatically. Enter it manually.");
      } finally {
        setLocatingHelper(false);
      }
    }, () => { setLocationError("We couldn't access your location. Enter your area manually."); setLocatingHelper(false); },
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

  // One Save action from the user's perspective: save the profile/skills,
  // then persist specialization selections for the saved skills. A skill
  // that's being deselected has its specializations cleared first, while
  // set_helper_tags can still validate that category against the
  // not-yet-updated skill list (it would reject the same call once the
  // skill is actually gone from profiles.skills).
  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current || !dirty) return;
    setError(null); setMessage(null);
    if (!/^[A-Za-z0-9]{6,40}$/.test(username)) { setError("Username must be 6–40 letters/numbers."); return; }
    pending.current = true; setSaving(true);
    let profileSaved = false;
    try {
      if (helperDataLoaded) {
        for (const category of profile.skills.filter((item) => !skills.includes(item))) {
          const { error: clearError } = await supabase.rpc("set_helper_tags", { p_service_type: category, p_tag_ids: [] });
          if (clearError) throw clearError;
        }
      }
      const { error: profileError } = await supabase.from("profiles").update({ username, skills, services }).eq("id", profile.id).select("id").single();
      if (profileError) throw profileError;
      profileSaved = true;
      if (helperDataLoaded) {
        for (const category of skills) {
          const { error: tagError } = await supabase.rpc("set_helper_tags", { p_service_type: category, p_tag_ids: specializationTags[category] ?? [] });
          if (tagError) throw tagError;
        }
        setSavedSpecializations(specializationTags);
      }
      await confirmSave("Profile updated.");
    } catch (error) {
      setError(friendlyError(error, profileSaved
        ? "Your profile saved, but some specializations couldn't be saved. Try saving again."
        : "Couldn't save your profile. Please try again."));
      if (profileSaved) { try { await refreshProfile(); } catch {} }
    } finally { pending.current = false; setSaving(false); }
  }

  function openDeleteDialog() {
    setDeleteError(null);
    setDeleteConfirmText("");
    setShowDeleteDialog(true);
  }

  function closeDeleteDialog() {
    if (deleting) return;
    setShowDeleteDialog(false);
    setDeleteConfirmText("");
    setDeleteError(null);
  }

  // Deletion itself runs server-side (delete_own_account() RPC + the Admin
  // API in src/app/api/account/delete/route.ts) so the service-role key
  // never reaches the browser, and the account acted on is always whichever
  // one the caller's own session belongs to.
  async function confirmDeleteAccount() {
    if (deleteConfirmText !== "DELETE" || pending.current) return;
    pending.current = true; setDeleting(true); setDeleteError(null);
    try {
      // A network failure would otherwise surface the browser's raw "Failed to fetch".
      const response = await fetch("/api/account/delete", { method: "POST" })
        .catch(() => { throw new Error("Couldn't delete your account. Check your connection and try again."); });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || "Couldn't delete your account. Please try again.");
      }
      await supabase.auth.signOut();
      clearGeneralAreaState();
      router.replace("/");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Couldn't delete your account. Please try again.");
    } finally {
      pending.current = false; setDeleting(false);
    }
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
        <div>
          <label className="block text-sm font-medium">Username<input required maxLength={40} aria-describedby="username-hint" value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2" /></label>
          <p id="username-hint" className="mt-1 text-xs text-neutral-500">6–40 letters or numbers, no spaces or symbols.</p>
        </div>
        <fieldset className="min-w-0"><legend className="text-sm font-medium">Skills I can use to make money</legend>
          <div className="mt-2 flex flex-wrap gap-2">{catalog.map((item) => <SelectionChip key={item} selected={skills.includes(item)} onClick={() => toggleSkill(item)}>{item}</SelectionChip>)}</div>
        </fieldset>
        {specializationSkills.length > 0 && (
          <fieldset className="min-w-0"><legend className="text-sm font-medium">Specializations (optional)</legend>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {chosenSpecializations.map(({ skill, tag }) => (
                <span key={tag.id} className="inline-flex items-center rounded-full bg-neutral-100 pl-3 text-sm text-neutral-800">
                  {tag.name}
                  <button type="button" onClick={() => toggleSpecializationTag(skill, tag.id)} aria-label={`Remove ${tag.name}`}
                    className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-500 hover:text-neutral-900">✕</button>
                </span>
              ))}
              {chosenSpecializations.length === 0 && <span className="text-sm text-neutral-500">None added yet.</span>}
              <button type="button" onClick={() => setSheetScope(ALL_SKILLS)} aria-label="Add specializations"
                className="inline-flex min-h-9 items-center rounded-full border border-dashed border-emerald-600 px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-50">+ Add</button>
            </div>
          </fieldset>
        )}
        <fieldset className="min-w-0"><legend className="text-sm font-medium">Services I might need</legend>
          <div className="mt-2 flex flex-wrap gap-2">{catalog.map((item) => <SelectionChip key={item} selected={services.includes(item)} onClick={() => setServices(toggle(services, item))}>{item}</SelectionChip>)}</div>
        </fieldset>
        <button type="submit" disabled={!dirty} className={`flex w-full items-center justify-center whitespace-nowrap rounded-lg px-4 py-2.5 font-medium transition-colors disabled:cursor-not-allowed ${dirty
          ? "bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
          : "bg-neutral-200 text-neutral-500"}`}>{saving ? "Updating…" : "Update profile"}</button>
        <p className="text-center text-xs text-neutral-500">{dirty ? "You have unsaved changes." : "No changes yet."}</p>
      </fieldset>
    </form>
    {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

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

    <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-4">
      <h2 className="text-sm font-semibold text-red-700">Danger zone</h2>
      <div>
        <p className="text-sm font-medium text-neutral-900">Delete account</p>
        <p className="text-sm text-neutral-500">Permanently delete your account and associated personal data.</p>
      </div>
      <button
        type="button"
        onClick={openDeleteDialog}
        className="rounded-lg border border-red-600 bg-white px-4 py-2.5 font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Delete account
      </button>
    </div>

    {sheetSkills.length > 0 && (
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
                onClick={() => toggleSpecializationTag(skill, tag.id)}
                className="flex min-h-12 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-sm text-neutral-900 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50">
                <span>{tag.name}</span>
                <span aria-hidden="true" className={`flex h-6 w-6 items-center justify-center rounded-md border text-sm ${selected ? "border-emerald-600 bg-emerald-600 text-white" : "border-neutral-300 text-transparent"}`}>✓</span>
              </button>;
            })}
          </div>;
        })}
      </OptionSheet>
    )}

    {showDeleteDialog && (
      <div role="dialog" aria-modal="true" aria-labelledby="delete-account-heading" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-sm space-y-4 rounded-lg bg-white p-5">
          <div>
            <h2 id="delete-account-heading" className="text-lg font-semibold text-neutral-900">Delete your account?</h2>
            <p className="mt-1 text-sm text-neutral-500">This action cannot be undone.</p>
          </div>
          <label className="block text-sm font-medium">Type DELETE to confirm
            <input
              autoComplete="off"
              disabled={deleting}
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          {deleteError && <p role="alert" className="text-sm text-red-600">{deleteError}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeDeleteDialog} disabled={deleting} className="rounded-lg border border-neutral-300 px-4 py-2.5 font-medium text-neutral-700 disabled:cursor-not-allowed disabled:opacity-60">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDeleteAccount()}
              disabled={deleteConfirmText !== "DELETE" || deleting}
              className="rounded-lg bg-red-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deleting ? "Deleting…" : "Delete account"}
            </button>
          </div>
        </div>
      </div>
    )}
  </div>;
}
export default function Profile() { return <AuthGuard><ProfileInner /></AuthGuard>; }
