"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { friendlyError, passwordError, takeAuthDestination } from "@/lib/journey";
import { CategoryList } from "@/components/CategoryList";

// ESG-AUTH-002 v0.5 screens 4-11: Username -> Password -> Profile Photo
// (mandatory) -> Phone (optional) -> Skills I Can Offer (optional) ->
// Services I Am Interested In (optional) -> Terms & Privacy -> Account
// Created -> CONTINUE -> Home. Reached only via a verified Registration
// email link (/auth/callback?flow=register); the session already exists,
// password/photo/skills/services/terms are the only things left to collect.
// Specializations (My Profile's separate tag picker) are not part of this
// spec and are left for the user to add afterward on My Profile.
type Step = "username" | "password" | "photo" | "phone" | "skills" | "services" | "terms" | "created";
const STEP_ORDER: Step[] = ["username", "password", "photo", "phone", "skills", "services", "terms", "created"];

function RegisterInner() {
  const supabase = createClient();
  const router = useRouter();
  const { user, profile, loading, refreshProfile } = useAuth();
  const pending = useRef(false);
  // Registration still ends at Home -- unless the visitor started from a helper profile and chose
  // Create account there. That one validated destination (see rememberAuthDestination) is taken
  // once, here, so the effect re-running cannot lose it.
  const destination = useRef<string | null | undefined>(undefined);
  const afterRegistration = () => (destination.current ??= takeAuthDestination()) ?? "/";
  const input = "w-full rounded-lg border border-neutral-300 px-3 py-2";

  const [step, setStep] = useState<Step>("username");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [services, setServices] = useState<string[]>([]);
  const [skillsOther, setSkillsOther] = useState("");
  const [servicesOther, setServicesOther] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/auth/sign-up");
    else if (profile?.onboarding_completed_at) router.replace(afterRegistration());
  }, [loading, user, profile, router]);

  if (loading || !user || profile?.onboarding_completed_at) return <p className="text-center text-neutral-500">Loading…</p>;
  // Narrowed once here: TS control-flow narrowing doesn't cross into the
  // closures defined below, even though they only ever run after this guard.
  const safeUser = user;

  function goTo(next: Step) { setError(null); setStep(next); }
  function back() {
    const index = STEP_ORDER.indexOf(step);
    if (index > 0) goTo(STEP_ORDER[index - 1]);
  }

  async function continueUsername() {
    if (pending.current) return;
    setError(null);
    if (!/^[A-Za-z0-9]{6,40}$/.test(username)) { setError("Username must be 6–40 letters/numbers."); return; }
    pending.current = true; setBusy(true);
    try {
      const { data: existing, error: lookupError } = await supabase.from("public_profiles").select("id").eq("username", username).maybeSingle();
      if (lookupError) throw lookupError;
      if (existing) { setError("That username is already taken."); return; }
      goTo("password");
    } catch (error) {
      setError(friendlyError(error, "Couldn't check that username. Please try again."));
    } finally {
      pending.current = false; setBusy(false);
    }
  }

  async function continuePassword() {
    if (pending.current) return;
    setError(null);
    const validationError = passwordError(password, confirm);
    if (validationError) { setError(validationError); return; }
    pending.current = true; setBusy(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      goTo("photo");
    } catch (error) {
      setError(friendlyError(error, "Couldn't set your password. Please try again."));
    } finally {
      pending.current = false; setBusy(false);
    }
  }

  async function uploadPhoto(file: File) {
    if (pending.current) return;
    setError(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError("Choose a JPG, PNG or WebP image smaller than 5 MB."); return;
    }
    pending.current = true; setBusy(true);
    try {
      const path = `${safeUser.id}/${crypto.randomUUID()}`;
      const { error: uploadError } = await supabase.storage.from("profile-photos").upload(path, file);
      if (uploadError) throw uploadError;
      setPhotoUrl(supabase.storage.from("profile-photos").getPublicUrl(path).data.publicUrl);
    } catch (error) {
      setError(friendlyError(error, "Photo upload failed. Please try again."));
    } finally {
      pending.current = false; setBusy(false);
    }
  }

  async function createAccount() {
    if (pending.current) return;
    setError(null);
    if (!termsAccepted) { setError("Accept the Terms of Service and Privacy Policy to continue."); return; }
    pending.current = true; setBusy(true);
    try {
      const { error: completeError } = await supabase.rpc("complete_registration", {
        p_username: username, p_photo_url: photoUrl,
        p_phone: phone.replace(/\D/g, "") || null,
        p_skills: skills, p_services: services,
        p_skills_other: skillsOther || null, p_services_other: servicesOther || null,
        p_terms_accepted: termsAccepted,
      });
      if (completeError) throw completeError;
      await refreshProfile();
      goTo("created");
    } catch (error) {
      setError(friendlyError(error, "Couldn't create your account. Please try again."));
    } finally {
      pending.current = false; setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      {step === "username" && <>
        <h1 className="text-xl font-semibold">Username</h1>
        <label className="block text-sm font-medium">Username
          <input autoComplete="username" required maxLength={40} value={username}
            onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} className={`mt-1 ${input}`} />
        </label>
        <p className="text-xs text-neutral-500">After account creation Username cannot be changed.</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} onClick={() => void continueUsername()} className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
          {busy ? "Checking…" : "Continue"}
        </button>
      </>}

      {step === "password" && <>
        <h1 className="text-xl font-semibold">Password</h1>
        <label className="block text-sm font-medium">Password
          <input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={`mt-1 ${input}`} />
        </label>
        <label className="block text-sm font-medium">Confirm Password
          <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className={`mt-1 ${input}`} />
        </label>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button disabled={busy} onClick={back} className="rounded-lg border px-4 py-2.5 font-medium">Back</button>
          <button disabled={busy} onClick={() => void continuePassword()} className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
            {busy ? "Saving…" : "Continue"}
          </button>
        </div>
      </>}

      {step === "photo" && <>
        <h1 className="text-xl font-semibold">Profile Photo</h1>
        {photoUrl ? <img src={photoUrl} alt="Profile photo" className="h-24 w-24 rounded-full object-cover" />
          : <div className="flex h-24 w-24 items-center justify-center rounded-full bg-neutral-200 text-2xl">👤</div>}
        <label className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-emerald-700">
          {busy ? "Uploading…" : "Add / Choose Photo"}
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} className="hidden" onChange={(e) => { if (e.target.files?.[0]) void uploadPhoto(e.target.files[0]); }} />
        </label>
        <p className="text-xs text-neutral-500">Profile Photo is mandatory.</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button disabled={busy} onClick={back} className="rounded-lg border px-4 py-2.5 font-medium">Back</button>
          <button disabled={busy || !photoUrl} onClick={() => goTo("phone")} className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
            Continue
          </button>
        </div>
      </>}

      {step === "phone" && <>
        <h1 className="text-xl font-semibold">Phone Number (Optional)</h1>
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit U.S. number" className={input} />
        <p className="text-xs text-neutral-500">No SMS verification for MVP.</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button disabled={busy} onClick={back} className="rounded-lg border px-4 py-2.5 font-medium">Back</button>
          <button disabled={busy} onClick={() => { setPhone(""); goTo("skills"); }} className="rounded-lg border px-4 py-2.5 font-medium">Skip</button>
          <button disabled={busy} onClick={() => {
            const digits = phone.replace(/\D/g, "");
            if (digits && digits.length !== 10) { setError("Enter a 10-digit phone number."); return; }
            goTo("skills");
          }} className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
            Continue
          </button>
        </div>
      </>}

      {step === "skills" && <>
        <h1 className="text-xl font-semibold">Skills I Can Offer (Optional)</h1>
        <CategoryList title="" selected={skills} setSelected={setSkills} otherText={skillsOther} setOtherText={setSkillsOther} />
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button disabled={busy} onClick={back} className="rounded-lg border px-4 py-2.5 font-medium">Back</button>
          <button disabled={busy} onClick={() => { setSkills([]); setSkillsOther(""); goTo("services"); }} className="rounded-lg border px-4 py-2.5 font-medium">Skip</button>
          <button disabled={busy} onClick={() => {
            if (skills.includes("Other") && !skillsOther.trim()) { setError("Specify your OTHER skill, or remove OTHER."); return; }
            goTo("services");
          }} className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
            Continue
          </button>
        </div>
      </>}

      {step === "services" && <>
        <h1 className="text-xl font-semibold">Services I Am Interested In (Optional)</h1>
        <CategoryList title="" selected={services} setSelected={setServices} otherText={servicesOther} setOtherText={setServicesOther} />
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button disabled={busy} onClick={back} className="rounded-lg border px-4 py-2.5 font-medium">Back</button>
          <button disabled={busy} onClick={() => { setServices([]); setServicesOther(""); goTo("terms"); }} className="rounded-lg border px-4 py-2.5 font-medium">Skip</button>
          <button disabled={busy} onClick={() => {
            if (services.includes("Other") && !servicesOther.trim()) { setError("Specify your OTHER service, or remove OTHER."); return; }
            goTo("terms");
          }} className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
            Continue
          </button>
        </div>
      </>}

      {step === "terms" && <>
        <h1 className="text-xl font-semibold">Terms &amp; Privacy</h1>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} className="mt-1" />
          I accept the Terms of Service and Privacy Policy.
        </label>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button disabled={busy} onClick={back} className="rounded-lg border px-4 py-2.5 font-medium">Back</button>
          <button disabled={busy || !termsAccepted} onClick={() => void createAccount()} className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-medium text-white disabled:opacity-60">
            {busy ? "Creating account…" : "Create Account"}
          </button>
        </div>
      </>}

      {step === "created" && <div className="space-y-4 text-center">
        <h1 className="text-xl font-semibold">Account Created</h1>
        <p className="text-sm text-neutral-600">You&apos;re signed in.</p>
        <button onClick={() => router.replace(afterRegistration())} className="w-full rounded-lg bg-emerald-600 py-2.5 font-medium text-white">Continue</button>
      </div>}
    </div>
  );
}

export default function Register() {
  return <RegisterInner />;
}
