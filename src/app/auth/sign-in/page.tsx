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

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
      const login = identifier.trim();
      if (login.includes("@")) {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: login, password });
        if (signInError) throw signInError;
      } else {
        const response = await fetch("/api/auth/sign-in", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: login, password }),
          signal: AbortSignal.timeout(20000),
        });
        const result = await response.json();
        if (!response.ok) {
          if (result.code === "username_signin_unavailable") {
            setError("Username sign-in is temporarily unavailable. Please use your email to sign in.");
            return;
          }
          throw { code: result.code };
        }
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: result.access_token,
          refresh_token: result.refresh_token,
        });
        if (sessionError) throw sessionError;
      }
      router.replace(setupDestination(next));
    } catch (error) {
      setError((error as { code?: string })?.code === "invalid_credentials"
        ? "That email, username, or password isn't right."
        : friendlyError(error, "Couldn't sign in. Check your connection and try again."));
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold">Sign In</h1>

      <div>
        <label htmlFor="signin-identifier" className="mb-1 block text-sm font-medium">Email or username</label>
        <input
          id="signin-identifier"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          type="text"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-3">
          <label htmlFor="signin-password" className="text-sm font-medium">Password</label>
          <Link href="/auth/forgot-password" className="touch-link text-sm font-medium text-emerald-700">Forgot password?</Link>
        </div>
        <div className="relative">
          <input
            id="signin-password"
            autoComplete="current-password"
            type={showPassword ? "text" : "password"}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 pr-16"
          />
          <button
            type="button"
            onClick={() => setShowPassword((current) => !current)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 px-3 text-sm font-medium text-emerald-700"
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {submitting ? "Signing in…" : "Sign In"}
      </button>

      <p className="flex flex-wrap items-center justify-center gap-x-1 text-sm text-neutral-500">
        New user?{" "}
        <Link href={`/auth/sign-up?next=${encodeURIComponent(next)}`} className="touch-link font-medium text-emerald-700">
          Register
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
