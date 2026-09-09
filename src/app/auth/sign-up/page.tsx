"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function SignUp() {
  const supabase = createClient();

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);

  function validate(): string | null {
    if (!/^[A-Za-z0-9]{6,}$/.test(username)) {
      return "Username must be at least 6 letters/numbers, no spaces or symbols.";
    }
    if (password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      return "Password must be at least 10 characters with a letter, a number, and a symbol.";
    }
    if (password !== confirm) {
      return "Passwords don't match.";
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);

    const { data: existing } = await supabase
      .from("public_profiles")
      .select("id")
      .eq("username", username)
      .maybeSingle();
    if (existing) {
      setError("That username is already taken.");
      setSubmitting(false);
      return;
    }

    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    setSubmitting(false);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }
    setConfirmationSent(true);
  }

  if (confirmationSent) {
    return (
      <div className="mx-auto max-w-md space-y-3 text-center">
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="text-sm text-neutral-600">
          We sent a confirmation link to <strong>{email}</strong>. Click it to activate your account, then sign in.
        </p>
        <Link href="/auth/sign-in" className="text-emerald-700 font-medium">
          Go to Sign In
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold">Create your ESG account</h1>

      <div>
        <label className="mb-1 block text-sm font-medium">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Username</label>
        <input
          required
          value={username}
          onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))}
          placeholder="at least 6 letters/numbers"
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Password</label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="10+ chars, letter + number + symbol"
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Confirm Password</label>
        <input
          type="password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {submitting ? "Creating account…" : "Create Account"}
      </button>

      <p className="text-center text-sm text-neutral-500">
        Already have an account?{" "}
        <Link href="/auth/sign-in" className="font-medium text-emerald-700">
          Sign In
        </Link>
      </p>
    </form>
  );
}
