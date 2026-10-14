"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { friendlyError } from "@/lib/journey";

// ESG-AUTH-002 v0.5 screens 2-3: Registration Email -> Check Your Email.
// Email verification is link-based (BR-REG-003) -- no OTP here. A verified
// click lands on /auth/callback?flow=register, which continues at
// /auth/register (Username onward). No `next` is threaded through
// registration: §13 is explicit that Registration never restores a prior
// protected journey, it always ends at Home.
function SignUpInner() {
  const supabase = createClient();
  const router = useRouter();
  const { user, profile, loading } = useAuth();
  const pending = useRef(false);

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Already signed in: a finished account goes Home; an account that
  // verified its email but never finished Username-onward resumes there.
  useEffect(() => {
    if (loading || !user) return;
    router.replace(profile?.onboarding_completed_at ? "/" : "/auth/register");
  }, [loading, user, profile, router]);

  if (loading || user) return <p className="text-center text-neutral-500">Loading…</p>;

  async function sendLink() {
    const { error: linkError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?flow=register`, shouldCreateUser: true },
    });
    if (linkError) throw linkError;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current) return;
    setError(null); setAlreadyRegistered(false);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Enter a valid email address."); return; }

    pending.current = true; setSubmitting(true);
    try {
      const { data: registered, error: checkError } = await supabase.rpc("email_registered", { p_email: email.trim() });
      if (checkError) throw checkError;
      if (registered) { setAlreadyRegistered(true); setError("This email is already registered."); return; }
      await sendLink();
      setSent(true);
    } catch (error) {
      setError(friendlyError(error, "Couldn't send a verification link. Check your connection and try again."));
    } finally {
      pending.current = false; setSubmitting(false);
    }
  }

  async function resend() {
    if (pending.current) return;
    pending.current = true; setSubmitting(true); setError(null); setNotice(null);
    try {
      await sendLink();
      setNotice("Another verification link is on its way. Check spam too.");
    } catch (error) {
      setError(friendlyError(error, "Couldn't resend the link. Wait a few minutes, then try again."));
    } finally {
      pending.current = false; setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="mx-auto max-w-md space-y-3 text-center">
        <h1 className="text-xl font-semibold">Check Your Email</h1>
        <p className="text-sm text-neutral-600">Verification link sent to {email.trim()}.</p>
        <p className="text-sm text-neutral-600">Click the link to verify your email, then continue registration at Username.</p>
        <button disabled={submitting} onClick={() => void resend()} className="block w-full text-emerald-700">
          {submitting ? "Sending…" : "Resend Verification Link"}
        </button>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {notice && <p role="status" className="text-sm text-neutral-600">{notice}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold">Create Account</h1>
      <div>
        <label htmlFor="signup-email" className="mb-1 block text-sm font-medium">Email Address</label>
        <input
          id="signup-email"
          autoComplete="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {alreadyRegistered && (
        <p className="text-sm text-neutral-600">
          <Link href="/auth/sign-in" className="touch-link font-medium text-emerald-700">Sign In</Link>
          {" or "}
          <button type="button" onClick={() => { setEmail(""); setError(null); setAlreadyRegistered(false); }} className="touch-link font-medium text-emerald-700">
            Use Another Email
          </button>
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {submitting ? "Sending…" : "Send Verification Link"}
      </button>

      <p className="flex flex-wrap items-center justify-center gap-x-1 text-sm text-neutral-500">
        Already have an account?{" "}
        <Link href="/auth/sign-in" className="touch-link font-medium text-emerald-700">Sign In</Link>
      </p>
    </form>
  );
}

export default function SignUp() {
  return <Suspense fallback={<p>Loading registration…</p>}><SignUpInner /></Suspense>;
}
