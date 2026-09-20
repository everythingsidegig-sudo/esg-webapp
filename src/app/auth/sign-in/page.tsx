"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { friendlyError, safeNext, setupDestination } from "@/lib/journey";
import { useAuth } from "@/lib/auth-context";

function SignInInner() {
  const supabase = createClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedNext = searchParams.get("next");
  const next = safeNext(requestedNext);
  const authenticatedDestination = requestedNext ? next : "/location";
  const { user, loading } = useAuth();
  const pending = useRef(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace(authenticatedDestination);
  }, [loading, user, router, authenticatedDestination]);

  if (loading || user) return <p className="text-center text-neutral-500">Loading your account…</p>;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) throw signInError;
      router.replace(setupDestination(next));
    } catch (error) {
      setError(friendlyError(error, "Couldn't sign in. Check your connection and try again."));
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold">Sign In</h1>

      <div>
        <label htmlFor="signin-email" className="mb-1 block text-sm font-medium">Email</label>
        <input
          id="signin-email"
          autoComplete="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-3">
          <label htmlFor="signin-password" className="text-sm font-medium">Password</label>
          <Link href="/auth/forgot-password" className="text-sm font-medium text-emerald-700">Forgot password?</Link>
        </div>
        <input
          id="signin-password"
          autoComplete="current-password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {submitting ? "Signing in…" : "Sign In"}
      </button>

      <p className="text-center text-sm text-neutral-500">
        New to ESG?{" "}
        <Link href={`/auth/sign-up?next=${encodeURIComponent(next)}`} className="font-medium text-emerald-700">
          Create Account
        </Link>
      </p>
    </form>
  );
}

export default function SignIn() {
  return (
    <Suspense>
      <SignInInner />
    </Suspense>
  );
}
