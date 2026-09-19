"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { safeNext, setupDestination } from "@/lib/journey";

// Reuse one exchange across React Strict Mode remounts: confirmation codes are single-use.
let exchange: { code: string; promise: Promise<unknown> } | null = null;
function CallbackInner() {
  const supabase = createClient();
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    async function confirm() {
      const url = new URL(window.location.href);
      const hash = new URLSearchParams(url.hash.slice(1));
      if (url.searchParams.has("error") || url.searchParams.has("error_code") || hash.has("error")) {
        throw new Error("This verification link is invalid or expired. Request a new link by registering again, or sign in if already verified.");
      }
      const code = url.searchParams.get("code");
      if (code) {
        if (exchange?.code !== code) exchange = { code, promise: supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
          if (error) throw new Error("This link could not be verified. It may have expired, already been used, or been opened in a different browser. Try signing in or request a new confirmation link.");
        }) };
        await exchange.promise;
      } else if (hash.has("access_token") && hash.has("refresh_token")) {
        // Compatibility with existing Supabase implicit confirmation-link templates.
        const { error } = await supabase.auth.setSession({ access_token: hash.get("access_token")!, refresh_token: hash.get("refresh_token")! });
        if (error) throw new Error("This verification link is invalid or expired. Please sign in or request another link.");
      }
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) throw new Error("No verified session was established. Please sign in with your verified account.");
      if (alive) {
        window.history.replaceState(null, "", `/auth/callback?next=${encodeURIComponent(next)}`);
        router.replace(setupDestination(next));
      }
    }
    void confirm().catch((error: Error) => {
      if (alive) {
        window.history.replaceState(null, "", `/auth/callback?next=${encodeURIComponent(next)}`);
        setError(error.message);
      }
    });
    return () => { alive = false; };
  }, [supabase, router, next]);
  return <div className="space-y-3 p-8 text-center">
    {error ? <><p role="alert">{error}</p><Link className="text-emerald-700" href={`/auth/sign-in?next=${encodeURIComponent(next)}`}>Sign In</Link>{" · "}<Link href={`/auth/sign-up?next=${encodeURIComponent(next)}`}>Register / request confirmation</Link></> : <p>Confirming your account…</p>}
  </div>;
}
export default function AuthCallback() { return <Suspense fallback={<p>Loading verification…</p>}><CallbackInner /></Suspense>; }
