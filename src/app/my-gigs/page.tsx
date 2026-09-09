"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AuthGuard from "@/components/AuthGuard";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import StatusBadge from "@/components/StatusBadge";
import type { Gig, GigStatus } from "@/lib/database.types";

const POSTED_BUCKETS: GigStatus[] = ["draft", "active", "in_progress", "awaiting_payment", "completed", "incomplete", "cancelled", "disputed"];
const WORKED_BUCKETS: GigStatus[] = ["active", "in_progress", "awaiting_payment", "completed", "incomplete", "disputed"];

function GigRow({ gig }: { gig: Gig }) {
  return (
    <Link
      href={`/gigs/${gig.id}`}
      className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-3 hover:shadow-sm"
    >
      <div>
        <div className="font-medium">{gig.title}</div>
        <div className="text-sm text-neutral-500">${gig.amount} · {gig.service_type}</div>
      </div>
      <StatusBadge status={gig.status} />
    </Link>
  );
}

function Bucketed({ gigs, buckets }: { gigs: Gig[]; buckets: GigStatus[] }) {
  return (
    <div className="space-y-5">
      {buckets.map((status) => {
        const items = gigs.filter((g) => g.status === status);
        if (items.length === 0) return null;
        return (
          <div key={status} className="space-y-2">
            <h3 className="text-sm font-semibold text-neutral-500">
              <StatusBadge status={status} /> ({items.length})
            </h3>
            {items.map((g) => (
              <GigRow key={g.id} gig={g} />
            ))}
          </div>
        );
      })}
      {gigs.length === 0 && <p className="text-neutral-500">Nothing here yet.</p>}
    </div>
  );
}

function MyGigsInner() {
  const supabase = createClient();
  const { user } = useAuth();
  const [tab, setTab] = useState<"posted" | "worked">("posted");
  const [posted, setPosted] = useState<Gig[]>([]);
  const [worked, setWorked] = useState<Gig[]>([]);

  useEffect(() => {
    if (!user) return;

    supabase
      .from("gigs")
      .select("*")
      .eq("poster_id", user.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => setPosted((data as Gig[]) ?? []));

    async function loadWorked() {
      const { data: claimRows } = await supabase.from("claims").select("gig_id").eq("provider_id", user!.id);
      const claimedIds = (claimRows ?? []).map((c) => c.gig_id);

      const orParts = [`selected_provider_id.eq.${user!.id}`];
      if (claimedIds.length > 0) orParts.push(`id.in.(${claimedIds.join(",")})`);

      const { data } = await supabase
        .from("gigs")
        .select("*")
        .or(orParts.join(","))
        .order("created_at", { ascending: false });
      setWorked((data as Gig[]) ?? []);
    }
    loadWorked();
  }, [user, supabase]);

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">My Gigs</h1>
      <div className="flex gap-2 border-b border-neutral-200">
        <button
          onClick={() => setTab("posted")}
          className={`px-3 py-2 text-sm font-medium ${tab === "posted" ? "border-b-2 border-emerald-600 text-emerald-700" : "text-neutral-500"}`}
        >
          Gigs Posted
        </button>
        <button
          onClick={() => setTab("worked")}
          className={`px-3 py-2 text-sm font-medium ${tab === "worked" ? "border-b-2 border-emerald-600 text-emerald-700" : "text-neutral-500"}`}
        >
          Gigs Worked
        </button>
      </div>
      {tab === "posted" ? (
        <Bucketed gigs={posted} buckets={POSTED_BUCKETS} />
      ) : (
        <Bucketed gigs={worked} buckets={WORKED_BUCKETS} />
      )}
    </div>
  );
}

export default function MyGigs() {
  return (
    <AuthGuard>
      <MyGigsInner />
    </AuthGuard>
  );
}
