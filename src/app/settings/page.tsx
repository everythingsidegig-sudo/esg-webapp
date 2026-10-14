"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AuthGuard from "@/components/AuthGuard";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/journey";

// ESG-SET-002 v1.0: Account Information. Identity/contact data only -- no
// Gig stats, WOM/Lemon/Rotten Tomato, Money Made, or Skills & Services (My
// Profile owns those). Username is NOT editable here: AUTH-002 v0.5 fixes it
// after account creation, which this app follows over SET-002's own
// (apparently stale) "Username Change" section -- see the plan notes.
function passwordUpdateError(error: unknown) {
  const { code, message } = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  if (code === "same_password" || message === "New password should be different from the old password.") {
    return "Your new password must be different from your current password.";
  }
  if (code === "weak_password") return "Choose a stronger password. Your account's password rules may require more characters.";
  if (code === "over_request_rate_limit" || code === "429") return "Too many requests. Please wait a few minutes and try again.";
  if (code === "session_expired" || code === "session_not_found") return "Your session has expired. Please sign in again.";
  return "Couldn't update your password. Please try again.";
}

function phoneDigits(value: string) {
  return value.replace(/\D/g, "");
}

function SettingsInner() {
  const supabase = createClient();
  const { user, profile, refreshProfile } = useAuth();
  const pending = useRef(false);

  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [emailEditing, setEmailEditing] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMessage, setEmailMessage] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [phoneEditing, setPhoneEditing] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneMessage, setPhoneMessage] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  if (!profile || !user) return <p className="text-neutral-500">Loading your account…</p>;
  // Narrowed once here: TS control-flow narrowing doesn't cross into the
  // closures defined below, even though they only ever run after this guard.
  const safeUser = user;
  const safeProfile = profile;

  async function uploadPhoto(file: File) {
    if (pending.current) return;
    setPhotoError(null); setPhotoMessage(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setPhotoError("Choose a JPG, PNG or WebP image smaller than 5 MB."); return;
    }
    pending.current = true; setPhotoBusy(true);
    try {
      const path = `${safeUser.id}/${crypto.randomUUID()}`;
      const { error: uploadError } = await supabase.storage.from("profile-photos").upload(path, file);
      if (uploadError) throw uploadError;
      const url = supabase.storage.from("profile-photos").getPublicUrl(path).data.publicUrl;
      const { error: saveError } = await supabase.from("profiles").update({ photo_url: url }).eq("id", safeUser.id).select("id").single();
      if (saveError) throw saveError;
      await refreshProfile();
      setPhotoMessage("Profile photo updated.");
    } catch (error) {
      setPhotoError(friendlyError(error, "Couldn't update your photo. Please try again."));
    } finally {
      pending.current = false; setPhotoBusy(false);
    }
  }

  function startEmailEdit() {
    setEmail(safeUser.email ?? "");
    setEmailError(null); setEmailMessage(null);
    setEmailEditing(true);
  }

  async function saveEmail() {
    if (pending.current) return;
    setEmailError(null); setEmailMessage(null);
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) { setEmailError("Enter a valid email address."); return; }
    pending.current = true; setEmailBusy(true);
    try {
      // Supabase's own secure-email-change flow sends a confirmation (OTP-verified)
      // to the new address before it replaces the current verified email -- the
      // existing verified email stays active until that happens (ESG-SET-002 §9).
      const { error } = await supabase.auth.updateUser({ email: trimmed });
      if (error) throw error;
      setEmailMessage("Check your new email to confirm the change. Your current email stays active until then.");
      setEmailEditing(false);
    } catch (error) {
      setEmailError(friendlyError(error, "Couldn't start the email change. Please try again."));
    } finally {
      pending.current = false; setEmailBusy(false);
    }
  }

  function startPhoneEdit() {
    setPhone(safeProfile.phone ?? "");
    setPhoneError(null); setPhoneMessage(null);
    setPhoneEditing(true);
  }

  async function savePhone() {
    if (pending.current) return;
    setPhoneError(null); setPhoneMessage(null);
    const digits = phoneDigits(phone);
    if (digits && digits.length !== 10) { setPhoneError("Enter a 10-digit phone number."); return; }
    pending.current = true; setPhoneBusy(true);
    try {
      const { error } = await supabase.from("profiles").update({ phone: digits || null }).eq("id", safeUser.id).select("id").single();
      if (error) throw error;
      await refreshProfile();
      setPhoneMessage("Mobile number updated.");
      setPhoneEditing(false);
    } catch (error) {
      setPhoneError(friendlyError(error, "Couldn't update your mobile number. Please try again."));
    } finally {
      pending.current = false; setPhoneBusy(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pending.current) return;
    setPasswordError(null); setPasswordMessage(null);
    if (newPassword.length < 10 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
      setPasswordError("Password must be at least 10 characters with a letter, a number, and a symbol."); return;
    }
    if (newPassword !== confirmPassword) { setPasswordError("Passwords don't match."); return; }
    pending.current = true; setPasswordBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setPasswordMessage("Password updated.");
      setNewPassword(""); setConfirmPassword("");
    } catch (error) {
      setPasswordError(passwordUpdateError(error));
    } finally {
      pending.current = false; setPasswordBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/profile" aria-label="Back to Profile" className="flex h-11 w-11 items-center justify-center rounded-full text-xl text-neutral-500 hover:bg-neutral-100">←</Link>
        <h1 className="text-xl font-semibold">Account Settings</h1>
      </div>

      <section className="space-y-4 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-700">Account Information</h2>

        <div className="flex items-center gap-4">
          {profile.photo_url ? <img src={profile.photo_url} alt="Profile photo" className="h-14 w-14 rounded-full object-cover" />
            : <div className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-200 text-lg">👤</div>}
          <label className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-emerald-700">
            {photoBusy ? "Uploading…" : "Change photo"}
            <input type="file" accept="image/jpeg,image/png,image/webp" disabled={photoBusy} className="hidden" onChange={(e) => { if (e.target.files?.[0]) void uploadPhoto(e.target.files[0]); }} />
          </label>
        </div>
        {photoMessage && <p role="status" className="text-sm text-emerald-700">{photoMessage}</p>}
        {photoError && <p role="alert" className="text-sm text-red-600">{photoError}</p>}

        <div>
          <p className="text-sm font-medium text-neutral-700">Username</p>
          <p className="text-sm text-neutral-500">@{profile.username} — cannot be changed after account creation.</p>
        </div>

        <div>
          <p className="text-sm font-medium text-neutral-700">Email</p>
          {emailEditing ? (
            <div className="mt-1 flex gap-2">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={emailBusy}
                className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 disabled:opacity-60" />
              <button type="button" disabled={emailBusy} onClick={() => void saveEmail()} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
                {emailBusy ? "Saving…" : "Save"}
              </button>
              <button type="button" disabled={emailBusy} onClick={() => setEmailEditing(false)} className="rounded-lg border px-3 py-2 text-sm">Cancel</button>
            </div>
          ) : (
            <div className="mt-1 flex items-center justify-between">
              <p className="text-sm text-neutral-500">{user.email}</p>
              <button type="button" onClick={startEmailEdit} className="text-sm font-medium text-emerald-700">Edit</button>
            </div>
          )}
          {emailMessage && <p role="status" className="mt-1 text-sm text-emerald-700">{emailMessage}</p>}
          {emailError && <p role="alert" className="mt-1 text-sm text-red-600">{emailError}</p>}
        </div>

        <div>
          <p className="text-sm font-medium text-neutral-700">Mobile Number (optional)</p>
          {phoneEditing ? (
            <div className="mt-1 flex gap-2">
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={phoneBusy} placeholder="10-digit U.S. number"
                className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 disabled:opacity-60" />
              <button type="button" disabled={phoneBusy} onClick={() => void savePhone()} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
                {phoneBusy ? "Saving…" : "Save"}
              </button>
              <button type="button" disabled={phoneBusy} onClick={() => setPhoneEditing(false)} className="rounded-lg border px-3 py-2 text-sm">Cancel</button>
            </div>
          ) : (
            <div className="mt-1 flex items-center justify-between">
              <p className="text-sm text-neutral-500">{profile.phone || "Not provided"}</p>
              <button type="button" onClick={startPhoneEdit} className="text-sm font-medium text-emerald-700">Edit</button>
            </div>
          )}
          {phoneMessage && <p role="status" className="mt-1 text-sm text-emerald-700">{phoneMessage}</p>}
          {phoneError && <p role="alert" className="mt-1 text-sm text-red-600">{phoneError}</p>}
        </div>
      </section>

      <form onSubmit={changePassword} className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-700">Change Password</h2>
        <label className="block text-sm font-medium">New password
          <input type="password" autoComplete="new-password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
            disabled={passwordBusy} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 disabled:opacity-60" />
        </label>
        <label className="block text-sm font-medium">Confirm new password
          <input type="password" autoComplete="new-password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={passwordBusy} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 disabled:opacity-60" />
        </label>
        {passwordMessage && <p role="status" className="text-sm text-emerald-700">{passwordMessage}</p>}
        {passwordError && <p role="alert" className="text-sm text-red-600">{passwordError}</p>}
        <button type="submit" disabled={passwordBusy} className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
          {passwordBusy ? "Updating…" : "Update Password"}
        </button>
      </form>
    </div>
  );
}

export default function Settings() {
  return <AuthGuard><SettingsInner /></AuthGuard>;
}
