"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import ServiceSelector, { type SaveResult } from "@/components/ServiceSelector";
import { useAuth } from "@/lib/auth-context";
import { friendlyError, safeNext } from "@/lib/journey";
import { emptySelection, fromRows, toPayload, type Branch, type SelectionRow, type SelectionState } from "@/lib/service-selection";
import { createClient } from "@/lib/supabase/client";

type Loaded = { selections: Record<Branch, SelectionState>; revisions: Record<Branch, number> };
type RevisionRow = { selection_type: Branch; revision: number };
type StoredRow = SelectionRow & { selection_type: Branch };

// Registration step after the profile ("?onboarding=1": Skip / Save & Complete, then on to where the
// member was heading) and, without it, the place to edit the two lists later. Both lists are saved
// independently through save_service_selections(); this page only loads and saves.
function ServicesInner() {
  const supabase = createClient();
  const router = useRouter();
  const { user } = useAuth();
  const params = useSearchParams();
  const onboarding = params.get("onboarding") === "1";
  const next = safeNext(params.get("next"));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!user) return;
    let active = true;
    Promise.all([
      supabase.from("user_service_selections").select("subservice_id,service_id,is_custom,custom_text,selection_type").eq("user_id", user.id),
      supabase.from("service_selection_revisions").select("selection_type,revision").eq("user_id", user.id),
    ]).then(([rows, revs]) => {
      if (!active) return;
      if (rows.error || revs.error) { setError("Couldn't load your services. Check your connection and try again."); return; }
      const stored = (rows.data as StoredRow[] | null) ?? [];
      const revisions: Record<Branch, number> = { OFFER: 0, NEED: 0 };
      for (const row of (revs.data as RevisionRow[] | null) ?? []) revisions[row.selection_type] = row.revision;
      setLoaded({
        selections: { OFFER: fromRows(stored.filter((row) => row.selection_type === "OFFER")), NEED: fromRows(stored.filter((row) => row.selection_type === "NEED")) },
        revisions,
      });
    }, () => { if (active) setError("Couldn't load your services. Check your connection and try again."); });
    return () => { active = false; };
  }, [supabase, user, reload]);

  async function save(branch: Branch, state: SelectionState, expectedRevision: number): Promise<SaveResult> {
    const payload = toPayload(state);
    const { data, error: saveError } = await supabase.rpc("save_service_selections", {
      p_type: branch, p_subservice_ids: payload.subserviceIds, p_custom: payload.custom, p_expected_revision: expectedRevision,
    });
    if (saveError || typeof data !== "number") return { ok: false, error: friendlyError(saveError, "Couldn't save your services. Check your connection and try again.") };
    return { ok: true, revision: data };
  }

  if (error) {
    return <div className="mx-auto max-w-lg space-y-3"><p role="alert" className="text-red-600">{error}</p>
      <button type="button" onClick={() => { setError(null); setReload((value) => value + 1); }} className="touch-link font-medium text-emerald-700">Retry</button></div>;
  }
  if (!loaded) return <p className="text-neutral-500">Loading your services…</p>;
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-semibold">{onboarding ? "Choose your services" : "Your services"}</h1>
      <ServiceSelector initial={loaded.selections} revisions={loaded.revisions} mode={onboarding ? "onboarding" : "profile"} onSave={save}
        onFinish={() => (onboarding ? router.replace(next) : router.push("/profile"))} />
    </div>
  );
}

export default function ServicesPage() {
  return <AuthGuard><Suspense fallback={<p>Loading…</p>}><ServicesInner /></Suspense></AuthGuard>;
}
