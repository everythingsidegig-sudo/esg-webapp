"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/journey";

export default function ForgotPassword() {
  const supabase = createClient();
  const pending = useRef(false);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current) return;
    pending.current = true; setSubmitting(true); setError(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });
      if (error) throw error;
      setSent(true);
    } catch (error) {
      setError(friendlyError(error, "Couldn't send a password-reset email. Check your connection and try again."));
    } finally {
      pending.current = false; setSubmitting(false);
    }
  }

  if (sent) return <div className="mx-auto max-w-md space-y-3 text-center">
    <h1 className="text-xl font-semibold">Check your email</h1>
    <p className="text-sm text-neutral-600">If an ESG account uses that email, a password-reset link will arrive shortly.</p>
    <Link href="/auth/sign-in" className="font-medium text-emerald-700">Back to Sign In</Link>
  </div>;

  return <form onSubmit={submit} className="mx-auto max-w-md space-y-4">
    <h1 className="text-xl font-semibold">Reset your password</h1>
    <p className="text-sm text-neutral-600">Enter your account email and we’ll send you a reset link.</p>
    <label className="block text-sm font-medium" htmlFor="recovery-email">Email</label>
    <input id="recovery-email" type="email" autoComplete="email" required value={email}
      onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg border border-neutral-300 px-3 py-2" />
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <button type="submit" disabled={submitting} className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
      {submitting ? "Sending…" : "Send reset link"}
    </button>
    <p className="text-center text-sm"><Link href="/auth/sign-in" className="font-medium text-emerald-700">Back to Sign In</Link></p>
  </form>;
}
