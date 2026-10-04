"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { clearGeneralAreaState } from "@/lib/location";

export default function LogoutButton({ className }: { className?: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  async function signOut() {
    if (pending.current) return;
    pending.current = true; setSigningOut(true); setError(null);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      clearGeneralAreaState();
      router.replace("/");
    } catch { setError("Couldn't log out. Check your connection and retry."); }
    finally { pending.current = false; setSigningOut(false); }
  }

  return <>
    <button type="button" disabled={signingOut} onClick={signOut} className={className}>
      {signingOut ? "Logging out…" : "Log out"}
    </button>
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
  </>;
}
