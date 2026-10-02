"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { passwordError } from "@/lib/journey";

// Explicit allow-list: only these known password-update failures get a specific
// message. Anything else -- including raw provider text -- gets the generic one.
function passwordUpdateError(error: unknown) {
  const { code, message } = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  if (code === "same_password" || message === "New password should be different from the old password.") {
    return "Your new password must be different from your current password.";
  }
  if (code === "weak_password") return "Choose a stronger password. Your account's password rules may require more characters.";
  if (code === "over_request_rate_limit" || code === "429") return "Too many requests. Please wait a few minutes and try again.";
  if (code === "session_expired" || code === "session_not_found") return "Your reset session has expired. Request a new link and try again.";
  return "Couldn't update your password. Please try again.";
}

// One verification per token across React Strict Mode remounts: the token is single-use.
let recoveryVerification: { tokenHash: string; promise: Promise<unknown> } | null = null;

export default function ResetPassword() {
  const supabase = createClient();
  const router = useRouter();
  const pending = useRef(false);
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function establishRecoverySession() {
      const url = new URL(window.location.href);
      const hash = new URLSearchParams(url.hash.slice(1));
      if (url.searchParams.has("error") || url.searchParams.has("error_code") || hash.has("error") || hash.has("error_code")) {
        throw new Error("This password-reset link is invalid or expired. Request another link.");
      }
      const tokenHash = url.searchParams.get("token_hash");
      if (tokenHash) {
        // Verified server-side by the one-time token alone, so the link works
        // in any browser/device (no PKCE verifier needed). The type is fixed
        // here and never read from the URL.
        if (recoveryVerification?.tokenHash !== tokenHash) recoveryVerification = { tokenHash, promise: supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" }).then(({ error }) => {
          if (error) throw new Error("This password-reset link is invalid, expired, or has already been used. Request another link.");
        }) };
        await recoveryVerification.promise;
      } else if (hash.has("access_token") && hash.has("refresh_token")) {
        const { error } = await supabase.auth.setSession({ access_token: hash.get("access_token")!, refresh_token: hash.get("refresh_token")! });
        if (error) throw new Error("This password-reset link is invalid or expired. Request another link.");
      }
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) throw new Error("Open the password-reset link from your email before choosing a new password.");
      if (alive) {
        window.history.replaceState(null, "", "/auth/reset-password");
        setReady(true);
      }
    }
    void establishRecoverySession().catch((error: Error) => {
      if (alive) {
        window.history.replaceState(null, "", "/auth/reset-password");
        setError(error.message);
      }
    });
    return () => { alive = false; };
  }, [supabase]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current) return;
    setError(null);
    const validationError = passwordError(password, confirm);
    if (validationError) { setError(validationError); return; }
    pending.current = true; setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      router.replace("/");
    } catch (error) {
      setError(passwordUpdateError(error));
    } finally {
      pending.current = false; setSaving(false);
    }
  }

  if (!ready) return <div className="mx-auto max-w-md space-y-3 text-center">
    <h1 className="text-xl font-semibold">Reset your password</h1>
    {error ? <><p role="alert" className="text-sm text-red-600">{error}</p><Link href="/auth/forgot-password" className="font-medium text-emerald-700">Request another link</Link></> : <p>Checking your reset link…</p>}
  </div>;

  return <form onSubmit={submit} className="mx-auto max-w-md space-y-4">
    <h1 className="text-xl font-semibold">Choose a new password</h1>
    <label className="block text-sm font-medium" htmlFor="new-password">New password</label>
    <input id="new-password" type="password" autoComplete="new-password" required value={password}
      onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg border border-neutral-300 px-3 py-2" />
    <label className="block text-sm font-medium" htmlFor="confirm-password">Confirm new password</label>
    <input id="confirm-password" type="password" autoComplete="new-password" required value={confirm}
      onChange={(e) => setConfirm(e.target.value)} className="w-full rounded-lg border border-neutral-300 px-3 py-2" />
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <button type="submit" disabled={saving} className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
      {saving ? "Updating…" : "Update password"}
    </button>
  </form>;
}
