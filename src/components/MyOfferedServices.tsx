"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth-context";
import OfferedServices, { type OfferedRow } from "@/components/OfferedServices";

// Home page: the services this member chose under "Services to Make Money", so they see what people
// can find them for, with a way to change it. Nothing is shown when signed out; a failed load just
// hides the card (the Services screen itself reports errors).
export default function MyOfferedServices() {
  const { user } = useAuth();
  const supabase = createClient();
  const [rows, setRows] = useState<OfferedRow[] | null>(null);

  useEffect(() => {
    if (!user) return;
    let active = true;
    supabase
      .from("user_service_selections")
      .select("service_id,subservice_id,custom_text")
      .eq("user_id", user.id)
      .eq("selection_type", "OFFER")
      .then(({ data, error }) => {
        if (active) setRows(error ? null : ((data as OfferedRow[]) ?? []));
      });
    return () => { active = false; };
  }, [user, supabase]);

  if (!user || rows === null) return null;
  return (
    <section aria-label="Your services" className="w-full max-w-md space-y-3 rounded-xl border border-neutral-200 bg-white p-4 text-left shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Services you offer</h2>
        <Link href="/services" className="touch-link text-sm font-medium text-emerald-700">{rows.length > 0 ? "Edit" : "Choose services"}</Link>
      </div>
      {rows.length > 0
        ? <OfferedServices rows={rows} />
        : <p className="text-sm text-neutral-500">Choose the services you offer so people can find you.</p>}
    </section>
  );
}
