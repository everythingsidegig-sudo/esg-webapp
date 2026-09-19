"use client";

import { Suspense, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { friendlyError, registrationError, safeNext, setupDestination } from "@/lib/journey";

function SignUpInner() {
  const supabase = createClient();
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const pending = useRef(false);

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function resend() {
    if (pending.current) return;
    pending.current = true; setSubmitting(true); setError(null); setNotice(null);
    try {
      const { error } = await supabase.auth.resend({ type: "signup", email: email.trim(), options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      } });
      if (error) throw error;
      setNotice("If confirmation is needed, another link will arrive shortly. Check spam too.");
    } catch (error) { setError(friendlyError(error, "Couldn't resend the link. Wait a few minutes, then try again.")); }
    finally { pending.current = false; setSubmitting(false); }
  }

  function validate(): string | null {
    return registrationError(username, password, confirm);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current) return;
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    pending.current = true;
    setSubmitting(true);
    try {
    const { data: existing, error: lookupError } = await supabase
      .from("public_profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) {
      setError("That username is already taken.");
      return;
    }

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { username },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });

    if (signUpError) throw signUpError;
    if (data.session) router.replace(setupDestination(next));
    else setConfirmationSent(true);
    } catch (error) {
      setError(friendlyError(error, "Couldn't create your account. Check your connection, or try signing in if you already registered."));
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  if (confirmationSent) {
    return (
      <div className="mx-auto max-w-md space-y-3 text-center">
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="text-sm text-neutral-600">
          If this email can be registered, a confirmation link will be sent to <strong>{email}</strong>.
          Open it in this browser to finish setup. Already registered? Try signing in.
        </p>
        <Link href={`/auth/sign-in?next=${encodeURIComponent(next)}`} className="text-emerald-700 font-medium">
          Go to Sign In
        </Link>
        <button disabled={submitting} onClick={() => void resend()} className="block w-full text-emerald-700">{submitting ? "Sending…" : "Resend confirmation link"}</button>
        {error && <p role="alert" className="text-red-600">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold">Create your ESG account</h1>

      <div>
        <label htmlFor="signup-email" className="mb-1 block text-sm font-medium">Email</label>
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

      <div>
        <label htmlFor="signup-username" className="mb-1 block text-sm font-medium">Username</label>
        <input
          id="signup-username"
          autoComplete="username"
          maxLength={40}
          required
          value={username}
          onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))}
          placeholder="at least 6 letters/numbers"
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      <div>
        <label htmlFor="signup-password" className="mb-1 block text-sm font-medium">Password</label>
        <input
          id="signup-password"
          autoComplete="new-password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="10+ chars, letter + number + symbol"
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      <div>
        <label htmlFor="signup-confirm" className="mb-1 block text-sm font-medium">Confirm Password</label>
        <input
          id="signup-confirm"
          autoComplete="new-password"
          type="password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {submitting ? "Creating account…" : "Create Account"}
      </button>

      <p className="text-center text-sm text-neutral-500">
        Already have an account?{" "}
        <Link href={`/auth/sign-in?next=${encodeURIComponent(next)}`} className="font-medium text-emerald-700">
          Sign In
        </Link>
      </p>
    </form>
  );
}

export default function SignUp() {
  return <Suspense fallback={<p>Loading registration…</p>}><SignUpInner /></Suspense>;
}
