"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
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
  if (code === "session_expired" || code === "session_not_found") return "Your reset session has expired. Request a new code and try again.";
  return "Couldn't update your password. Please try again.";
}

// This page only follows a successful code verification on /auth/forgot-password
// (ESG-AUTH-003 v1.0) -- no link/token parsing here, that session already exists.
export default function ResetPassword() {
  const supabase = createClient();
  const pending = useRef(false);
  const [ready, setReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      if (error || !data.session) setSessionError("Verify your email code again before choosing a new password.");
      else setReady(true);
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
      // BR-AUTH3-008: reset does not sign the user in -- they authenticate fresh.
      await supabase.auth.signOut();
      setDone(true);
    } catch (error) {
      setError(passwordUpdateError(error));
    } finally {
      pending.current = false; setSaving(false);
    }
  }

  if (done) return <div className="mx-auto max-w-md space-y-3 text-center">
    <h1 className="text-xl font-semibold">Password reset</h1>
    <p className="text-sm text-neutral-600">Your password was successfully reset.</p>
    <Link href="/auth/sign-in" className="touch-link font-medium text-emerald-700">Sign In</Link>
  </div>;

  if (!ready) return <div className="mx-auto max-w-md space-y-3 text-center">
    <h1 className="text-xl font-semibold">Reset your password</h1>
    {sessionError ? <><p role="alert" className="text-sm text-red-600">{sessionError}</p><Link href="/auth/forgot-password" className="touch-link font-medium text-emerald-700">Request another code</Link></> : <p>Checking your session…</p>}
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
      {saving ? "Updating…" : "Reset Password"}
    </button>
  </form>;
}
