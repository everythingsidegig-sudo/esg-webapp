"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function AuthCallback() {
  const supabase = createClient();
  const router = useRouter();
  const [message, setMessage] = useState("Confirming your account…");

  useEffect(() => {
    async function run() {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          setMessage("That confirmation link is invalid or expired. Please sign in.");
          setTimeout(() => router.replace("/auth/sign-in"), 1500);
          return;
        }
      }

      const { data } = await supabase.auth.getSession();
      if (data.session) {
        router.replace("/");
      } else {
        setMessage("Account confirmed. Please sign in.");
        setTimeout(() => router.replace("/auth/sign-in"), 1500);
      }
    }
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="p-8 text-center text-neutral-600">{message}</div>;
}
