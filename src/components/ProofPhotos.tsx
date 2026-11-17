"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { rpcActionError } from "@/lib/journey";
import { MAX_PROOF_PHOTOS, PROOF_BUCKET, proofPhotoError, proofPhotoPath } from "@/lib/proof-photos";
import type { GigProofPhoto } from "@/lib/database.types";

const SIGNED_URL_SECONDS = 60 * 60;

// Proof / supporting photos for a finished gig (migration 0035). The helper can add up to five once
// they have marked the gig complete and remove their own; the poster just sees them. The bucket is
// private, so every photo is shown through a short-lived signed link. Renders nothing when there is
// nothing to show and nothing to add.
export default function ProofPhotos({ gigId, userId, canAdd, helperName }: {
  gigId: string;
  userId: string;
  canAdd: boolean;
  helperName?: string;
}) {
  const supabase = createClient();
  const [photos, setPhotos] = useState<GigProofPhoto[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      const { data, error: loadError } = await supabase.from("gig_proof_photos").select("*").eq("gig_id", gigId).order("created_at", { ascending: true });
      if (!active) return;
      if (loadError) { setError("Couldn't load the photos. Check your connection and try again."); setLoaded(true); return; }
      const rows = (data as GigProofPhoto[] | null) ?? [];
      setPhotos(rows);
      if (rows.length > 0) {
        const { data: signed } = await supabase.storage.from(PROOF_BUCKET).createSignedUrls(rows.map((row) => row.storage_path), SIGNED_URL_SECONDS);
        if (!active) return;
        const next: Record<string, string> = {};
        for (const item of signed ?? []) if (item.path && item.signedUrl) next[item.path] = item.signedUrl;
        setUrls(next);
      }
      setLoaded(true);
    }
    void load();
    return () => { active = false; };
  }, [supabase, gigId, reload]);

  async function add(file: { type: string; size: number } & Blob) {
    const problem = proofPhotoError(file, photos.filter((photo) => photo.uploader_id === userId).length);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    const path = proofPhotoPath(gigId, userId, crypto.randomUUID());
    const { error: uploadError } = await supabase.storage.from(PROOF_BUCKET).upload(path, file, { contentType: file.type });
    if (uploadError) { setBusy(false); setError("The photo didn't upload. Check your connection and try again."); return; }
    const { error: saveError } = await supabase.rpc("add_proof_photo", { p_gig_id: gigId, p_path: path });
    if (saveError) {
      // Don't leave an orphaned file behind when the record was refused.
      await supabase.storage.from(PROOF_BUCKET).remove([path]);
      setBusy(false);
      setError(rpcActionError(saveError));
      return;
    }
    setBusy(false);
    setReload((value) => value + 1);
  }

  async function remove(photo: GigProofPhoto) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error: removeError } = await supabase.rpc("remove_proof_photo", { p_photo_id: photo.id });
    if (removeError) { setBusy(false); setError(rpcActionError(removeError)); return; }
    // Best effort: the record is already gone, so a leftover file is unreachable.
    await supabase.storage.from(PROOF_BUCKET).remove([photo.storage_path]);
    setBusy(false);
    setReload((value) => value + 1);
  }

  if (!loaded && !canAdd) return null;
  if (loaded && photos.length === 0 && !canAdd && !error) return null;
  const mine = photos.filter((photo) => photo.uploader_id === userId).length;

  return (
    <section aria-label="Proof photos" className="space-y-2 rounded-xl border border-neutral-200 bg-white p-4">
      <h2 className="font-medium">{canAdd ? "Proof photos" : `Photos from ${helperName ? `@${helperName}` : "your helper"}`}</h2>
      {canAdd && <p className="text-sm text-neutral-500">Add photos that show the finished work. Only you and the poster can see them. Up to {MAX_PROOF_PHOTOS}.</p>}
      {photos.length > 0 && (
        <ul className="grid grid-cols-3 gap-2">
          {photos.map((photo) => (
            <li key={photo.id} className="space-y-1">
              {urls[photo.storage_path]
                ? <a href={urls[photo.storage_path]} target="_blank" rel="noreferrer"><img src={urls[photo.storage_path]} alt="Proof of the finished work" className="aspect-square w-full rounded-lg object-cover" /></a>
                : <div className="aspect-square w-full rounded-lg bg-neutral-100" />}
              {photo.uploader_id === userId && (
                <button type="button" disabled={busy} onClick={() => void remove(photo)} className="text-xs font-medium text-red-700 disabled:opacity-60">Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canAdd && mine < MAX_PROOF_PHOTOS && (
        <label className="flex min-h-11 w-full cursor-pointer items-center justify-center rounded-lg border border-emerald-600 px-4 py-2.5 text-center font-medium text-emerald-700 hover:bg-emerald-50">
          {busy ? "Uploading…" : "Add a photo"}
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} className="sr-only" aria-label="Add a photo"
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void add(file); }} />
        </label>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
