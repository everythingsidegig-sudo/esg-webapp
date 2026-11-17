import type { GigStatus } from "./database.types";

// Proof / supporting photos (migration 0035). The helper adds them after marking a gig complete; the
// poster and the helper can both see them. The database enforces every rule here too.
export const MAX_PROOF_PHOTOS = 5;
export const MAX_PROOF_PHOTO_BYTES = 5 * 1024 * 1024;
export const PROOF_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PROOF_BUCKET = "proof-photos";

// Mirrors the statuses migration 0035 allows photos to be added in.
const PHOTO_STATUSES: readonly GigStatus[] = ["in_progress", "awaiting_payment", "completed", "incomplete"];

// The helper can add photos once they have marked the gig complete.
export function canAddProofPhotos(
  gig: { status: GigStatus; selected_provider_id: string | null },
  userId: string | null | undefined,
  myCompletion: string | null,
): boolean {
  return !!userId && gig.selected_provider_id === userId && myCompletion === "complete" && PHOTO_STATUSES.includes(gig.status);
}

// Problem with a chosen file, or null when it is fine to upload.
export function proofPhotoError(file: { type: string; size: number }, existingCount: number): string | null {
  if (existingCount >= MAX_PROOF_PHOTOS) return `You can add up to ${MAX_PROOF_PHOTOS} photos.`;
  if (!(PROOF_PHOTO_TYPES as readonly string[]).includes(file.type) || file.size > MAX_PROOF_PHOTO_BYTES) {
    return "Choose a JPG, PNG or WebP image smaller than 5 MB.";
  }
  return null;
}

// <gig id>/<uploader id>/<file id>: the folder layout the storage policies and add_proof_photo() check.
export function proofPhotoPath(gigId: string, userId: string, fileId: string): string {
  return `${gigId}/${userId}/${fileId}`;
}
