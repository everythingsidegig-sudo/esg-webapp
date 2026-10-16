"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// ESG-AUTH-003 v1.0: email -> code (10-min expiry, set in Supabase Auth settings)
// -> new password on /auth/reset-password. No reset link, no OTP screen skipped,
// and the privacy response never reveals whether the email is registered.
// The spec calls for a 6-digit code, but this Supabase project's OTP length
// isn't exposed as a dashboard setting and sends 8 digits -- matched here
// rather than silently rejecting every real code the user receives.
function recoveryError(error: unknown) {
  const { code, message } = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || code === "429") {
    return "Too many requests. Please wait a few minutes and try again.";
  }
  if (code === "otp_expired" || message === "Token has expired or is invalid") return "Verification code expired.";
  if (code === "invalid_credentials" || code === "otp_disabled") return "Invalid verification code.";
  return null;
}

export default function ForgotPassword() {
  const supabase = createClient();
  const router = useRouter();
  const pending = useRef(false);

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current) return;
    setError(null); setNotice(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Enter a valid email address."); return; }
    pending.current = true; setSubmitting(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
      if (error && error.code !== "over_email_send_rate_limit") throw error;
      setNotice("If an ESG account exists for this email, we've sent a verification code.");
      setStep("code");
    } catch (error) {
      setError(recoveryError(error) ?? "Couldn't send a verification code. Check your connection and try again.");
    } finally {
      pending.current = false; setSubmitting(false);
    }
  }

  async function resend() {
    if (pending.current) return;
    pending.current = true; setSubmitting(true); setError(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
      if (error && error.code !== "over_email_send_rate_limit") throw error;
      setNotice("If an ESG account exists for this email, we've sent a new verification code.");
    } catch (error) {
      setError(recoveryError(error) ?? "Couldn't resend the code. Please try again.");
    } finally {
      pending.current = false; setSubmitting(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current) return;
    setError(null);
    if (!/^\d{8}$/.test(code.trim())) { setError("Enter the 8-digit verification code."); return; }
    pending.current = true; setSubmitting(true);
    try {
      const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "recovery" });
      if (error) throw error;
      router.replace("/auth/reset-password");
    } catch (error) {
      setError(recoveryError(error) ?? "Invalid verification code.");
    } finally {
      pending.current = false; setSubmitting(false);
    }
  }

  if (step === "code") {
    return (
      <form onSubmit={verify} className="mx-auto max-w-md space-y-4">
        <h1 className="text-xl font-semibold">Check your email</h1>
        {notice && <p role="status" className="text-sm text-neutral-600">{notice}</p>}
        <p className="text-sm text-neutral-500">Sent to {email.replace(/^(.{1,2}).*(@.*)$/, "$1***$2")}</p>
        <label className="block text-sm font-medium" htmlFor="recovery-code">8-digit code</label>
        <input id="recovery-code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="w-full rounded-lg border border-neutral-300 px-3 py-2 tracking-widest" />
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={submitting} className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
          {submitting ? "Verifying…" : "Verify"}
        </button>
        <button type="button" disabled={submitting} onClick={() => void resend()} className="block w-full text-center text-sm text-emerald-700">
          Resend code
        </button>
        <p className="text-center text-sm"><Link href="/auth/sign-in" className="touch-link font-medium text-emerald-700">Back to Sign In</Link></p>
      </form>
    );
  }

  return <form onSubmit={sendCode} className="mx-auto max-w-md space-y-4">
    <h1 className="text-xl font-semibold">Reset your password</h1>
    <p className="text-sm text-neutral-600">Enter your account email and we&apos;ll send you a verification code.</p>
    <label className="block text-sm font-medium" htmlFor="recovery-email">Email</label>
    <input id="recovery-email" type="email" autoComplete="email" required value={email}
      onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg border border-neutral-300 px-3 py-2" />
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <button type="submit" disabled={submitting} className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
      {submitting ? "Sending…" : "Send code"}
    </button>
    <p className="text-center text-sm"><Link href="/auth/sign-in" className="touch-link font-medium text-emerald-700">Back to Sign In</Link></p>
  </form>;
}
