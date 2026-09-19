"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
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
  const [postedLoading, setPostedLoading] = useState(true);
  const [workedLoading, setWorkedLoading] = useState(true);
  const [postedError, setPostedError] = useState<string | null>(null);
  const [workedError, setWorkedError] = useState<string | null>(null);
  const created = useSearchParams().get("created");
  const [postedReload, setPostedReload] = useState(0);
  const [workedReload, setWorkedReload] = useState(0);

  useEffect(() => {
    if (!user) return;

    let alive = true;
    async function loadPosted() {
      try {
        const { data, error } = await supabase.from("gigs").select("*").eq("poster_id", user!.id).order("created_at", { ascending: false });
        if (error) throw error;
        if (alive) setPosted((data as Gig[]) ?? []);
      } catch { if (alive) setPostedError("Couldn't load your posted gigs. Check your connection and retry."); }
      finally { if (alive) setPostedLoading(false); }
    }
    void loadPosted();
    return () => { alive = false; };
  }, [user, supabase, postedReload]);

  useEffect(() => {
    if (!user) return;

    let alive = true;
    async function loadWorked() {
      try {
      const { data: claimRows, error: claimError } = await supabase.from("claims").select("gig_id").eq("provider_id", user!.id);
      if (claimError) throw claimError;
      const claimedIds = (claimRows ?? []).map((c) => c.gig_id);

      const orParts = [`selected_provider_id.eq.${user!.id}`];
      if (claimedIds.length > 0) orParts.push(`id.in.(${claimedIds.join(",")})`);

      const { data, error } = await supabase
        .from("gigs")
        .select("*")
        .or(orParts.join(","))
        .order("created_at", { ascending: false });
      if (error) throw error;
      if (alive) setWorked((data as Gig[]) ?? []);
      } catch { if (alive) setWorkedError("Couldn't load your worked gigs. Check your connection and retry."); }
      finally { if (alive) setWorkedLoading(false); }
    }
    void loadWorked();
    return () => { alive = false; };
  }, [user, supabase, workedReload]);

  const loading = tab === "posted" ? postedLoading : workedLoading;
  const error = tab === "posted" ? postedError : workedError;
  function retry() {
    if (tab === "posted") {
      setPostedLoading(true); setPostedError(null); setPostedReload((value) => value + 1);
    } else {
      setWorkedLoading(true); setWorkedError(null); setWorkedReload((value) => value + 1);
    }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">My Gigs</h1>
      {created && posted.some((gig) => gig.id === created) && <p role="status" className="text-emerald-700">Gig successfully {posted.find((gig) => gig.id === created)?.status === "draft" ? "saved as a draft" : "posted"}. It appears below in Gigs Posted.</p>}
      {error && <p role="alert">{error} <button onClick={retry}>Retry</button></p>}
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
      {loading ? <p>Loading gigs…</p> : error ? null : tab === "posted" ? (
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
      <Suspense fallback={<p>Loading gigs…</p>}><MyGigsInner /></Suspense>
    </AuthGuard>
  );
}
