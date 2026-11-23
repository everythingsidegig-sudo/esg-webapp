"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { BRANCH_LABEL, BRANCHES, fromRows, summarize, type Branch, type SelectionRow, type SummaryCategory } from "@/lib/service-selection";

type StoredRow = SelectionRow & { selection_type: Branch };

// What the member has actually saved on the categorized services screen (the only services list):
// "Services to Make Money" and "Services I Need Help", read live from the database so My Profile
// never shows anything that was not saved there. Both lists stay private to the member here; only
// the offered list reaches the public profile.
export default function SavedServices({ userId }: { userId: string }) {
  const [groups, setGroups] = useState<Record<Branch, SummaryCategory[]> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const supabase = createClient();
        const { data, error } = await supabase.from("user_service_selections")
          .select("subservice_id,service_id,is_custom,custom_text,selection_type").eq("user_id", userId);
        if (!active) return;
        if (error) { setFailed(true); return; }
        const rows = (data as StoredRow[] | null) ?? [];
        setGroups({
          OFFER: summarize(fromRows(rows.filter((row) => row.selection_type === "OFFER"))),
          NEED: summarize(fromRows(rows.filter((row) => row.selection_type === "NEED"))),
        });
      } catch { if (active) setFailed(true); }
    }
    void load();
    return () => { active = false; };
  }, [userId]);

  if (failed) return <p className="text-sm text-neutral-500">Couldn&apos;t load your saved services right now.</p>;
  if (!groups) return <p className="text-sm text-neutral-500">Loading your services…</p>;
  return (
    <div className="space-y-3">
      {BRANCHES.map((branch) => (
        <section key={branch} aria-label={BRANCH_LABEL[branch]} className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-brand-700">{BRANCH_LABEL[branch]}</h3>
          {groups[branch].length === 0
            ? <p className="text-sm text-neutral-500">None chosen yet.</p>
            : <ul className="space-y-1">
                {groups[branch].flatMap(({ category, services }) => services.map(({ service, subservices, other }) => {
                  const detail = [...subservices.map((sub) => sub.name), ...(other ? [`Other: ${other}`] : [])];
                  return <li key={`${category.id}-${service.id}`} className="text-sm text-neutral-800">
                    <span className="text-neutral-500">{category.name} · </span><span className="font-medium">{service.name}</span>
                    {detail.length > 0 && <span className="text-neutral-500">: {detail.join(" · ")}</span>}
                  </li>;
                }))}
              </ul>}
        </section>
      ))}
    </div>
  );
}
