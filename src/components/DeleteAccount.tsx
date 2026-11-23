"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/journey";
import { clearGeneralAreaState } from "@/lib/location";

// ESG-AUTH-004: the Delete Account action and its dialogs, shown in Account Settings (where the
// defect script and members look for it) and kept out of the Profile editor.
export default function DeleteAccount() {
  const supabase = createClient();
  const router = useRouter();
  const { user } = useAuth();
  const pending = useRef(false);
  // ESG-AUTH-004 v1.0: eligibility pre-check -> Outstanding Gigs popup (if
  // blocked) or a Warning screen -> Final Confirmation with re-authentication
  // (password, not an arbitrary typed word) before the actual delete call.
  const [deleteStage, setDeleteStage] = useState<"closed" | "checking" | "blocked" | "warning" | "confirm">("closed");
  const [blockers, setBlockers] = useState<{ activeGigsCount: number; openDisputesCount: number } | null>(null);
  const [reauthPassword, setReauthPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function openDeleteDialog() {
    if (pending.current) return;
    pending.current = true; setDeleteError(null); setDeleteStage("checking");
    try {
      const { data, error } = await supabase.rpc("check_deletion_eligibility");
      const row = (data as { eligible: boolean; active_gigs_count: number; open_disputes_count: number }[] | null)?.[0];
      if (error || !row) throw error ?? new Error("Couldn't check your account eligibility.");
      if (row.eligible) {
        setDeleteStage("warning");
      } else {
        setBlockers({ activeGigsCount: Number(row.active_gigs_count), openDisputesCount: Number(row.open_disputes_count) });
        setDeleteStage("blocked");
      }
    } catch (error) {
      setDeleteError(friendlyError(error, "Couldn't check your account eligibility. Please try again."));
      setDeleteStage("closed");
    } finally {
      pending.current = false;
    }
  }

  function closeDeleteDialog() {
    if (deleting) return;
    setDeleteStage("closed");
    setReauthPassword("");
    setDeleteError(null);
  }

  // Deletion itself runs server-side (delete_own_account() RPC + the Admin
  // API in src/app/api/account/delete/route.ts) so the service-role key
  // never reaches the browser, and the account acted on is always whichever
  // one the caller's own session belongs to. Re-authentication (password,
  // per BR-DEL-013) happens client-side first: signInWithPassword either
  // confirms the current password against the live session's own account or
  // fails outright, with no separate identity for it to be confused with.
  async function confirmDeleteAccount() {
    if (!reauthPassword || pending.current || !user?.email) return;
    pending.current = true; setDeleting(true); setDeleteError(null);
    try {
      const { error: reauthError } = await supabase.auth.signInWithPassword({ email: user.email, password: reauthPassword });
      if (reauthError) throw new Error("We couldn't verify your account. Please check your details and try again.");
      // A network failure would otherwise surface the browser's raw "Failed to fetch".
      const response = await fetch("/api/account/delete", { method: "POST" })
        .catch(() => { throw new Error("Couldn't delete your account. Check your connection and try again."); });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || "Couldn't delete your account. Please try again.");
      }
      await supabase.auth.signOut();
      clearGeneralAreaState();
      router.replace("/?accountDeleted=1");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Couldn't delete your account. Please try again.");
    } finally {
      pending.current = false; setDeleting(false);
    }
  }

  return <>
    <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
      <h2 className="text-sm font-semibold text-red-700">Danger zone</h2>
      <div>
        <p className="text-sm font-medium text-neutral-900">Delete account</p>
        <p className="text-sm text-neutral-500">Permanently delete your account and associated personal data.</p>
      </div>
      <button
        type="button"
        disabled={deleteStage === "checking"}
        onClick={() => void openDeleteDialog()}
        className="rounded-xl border border-red-600 bg-white px-4 py-2.5 font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {deleteStage === "checking" ? "Checking…" : "Delete account"}
      </button>
      {deleteError && deleteStage === "closed" && <p role="alert" className="text-sm text-red-600">{deleteError}</p>}
    </div>

    {deleteStage === "blocked" && blockers && (
      <div role="dialog" aria-modal="true" aria-labelledby="blocked-heading" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-sm space-y-4 rounded-xl bg-white p-5">
          <div>
            <h2 id="blocked-heading" className="text-lg font-semibold text-neutral-900">You have Gigs that need attention</h2>
            <p className="mt-1 text-sm text-neutral-500">Before deleting your ESG account, you must resolve any active Gigs or open Disputes.</p>
          </div>
          <ul className="space-y-1 text-sm text-neutral-700">
            <li>Active or in-progress Gigs: {blockers.activeGigsCount}</li>
            <li>Open Disputes: {blockers.openDisputesCount}</li>
          </ul>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeDeleteDialog} className="rounded-xl border border-neutral-300 px-4 py-2.5 font-medium text-neutral-700">Cancel</button>
            <button type="button" onClick={() => { closeDeleteDialog(); router.push("/my-gigs"); }} className="rounded-xl bg-brand-600 px-4 py-2.5 font-medium text-white hover:bg-brand-700">View Gigs</button>
          </div>
        </div>
      </div>
    )}

    {deleteStage === "warning" && (
      <div role="dialog" aria-modal="true" aria-labelledby="delete-warning-heading" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-sm space-y-4 rounded-xl bg-white p-5">
          <div>
            <h2 id="delete-warning-heading" className="text-lg font-semibold text-neutral-900">Delete Account</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Deleting your ESG account will permanently remove your access to Everything SideGig. You will no longer be able to sign in, post Gigs, claim Gigs, contact users, or access your ESG account features.
            </p>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeDeleteDialog} className="rounded-xl border border-neutral-300 px-4 py-2.5 font-medium text-neutral-700">Cancel</button>
            <button type="button" onClick={() => setDeleteStage("confirm")} className="rounded-xl bg-red-600 px-4 py-2.5 font-medium text-white hover:bg-red-700">Continue to Delete</button>
          </div>
        </div>
      </div>
    )}

    {deleteStage === "confirm" && (
      <div role="dialog" aria-modal="true" aria-labelledby="delete-confirm-heading" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-sm space-y-4 rounded-xl bg-white p-5">
          <div>
            <h2 id="delete-confirm-heading" className="text-lg font-semibold text-neutral-900">Permanently Delete Account?</h2>
            <p className="mt-1 text-sm text-neutral-500">This action will delete your ESG account and you will lose access to your profile and ESG account features.</p>
          </div>
          <label className="block text-sm font-medium">Enter your password to confirm
            <input
              type="password"
              autoComplete="current-password"
              disabled={deleting}
              value={reauthPassword}
              onChange={(e) => setReauthPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          {deleteError && <p role="alert" className="text-sm text-red-600">{deleteError}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeDeleteDialog} disabled={deleting} className="rounded-xl border border-neutral-300 px-4 py-2.5 font-medium text-neutral-700 disabled:cursor-not-allowed disabled:opacity-60">
              Keep My Account
            </button>
            <button
              type="button"
              onClick={() => void confirmDeleteAccount()}
              disabled={!reauthPassword || deleting}
              className="rounded-xl bg-red-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deleting ? "Deleting…" : "Delete My Account"}
            </button>
          </div>
        </div>
      </div>
    )}
  </>;
}
