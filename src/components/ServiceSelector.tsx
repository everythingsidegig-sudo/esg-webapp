"use client";

import { useEffect, useState } from "react";
import { CATALOG, CATEGORY_BY_ID, SERVICE_BY_ID } from "@/lib/service-catalog";
import {
  BRANCHES, BRANCH_LABEL, MAX_CUSTOM_LENGTH, allState, countForCategory, countForService, customError, pathLabel, sameSelection, searchCatalog,
  selectionProblems, setAll, setCustomChecked, setCustomText, summarize, toggleSubservice, totalSelected,
  type Branch, type SearchHit, type SelectionState,
} from "@/lib/service-selection";

// Registration "Services Selection" (spec v2.0): two INDEPENDENT lists on one screen -- "Services to Make
// Money" (OFFER) and "Services I Need Help" (NEED) -- over the SAME catalog, each with its own search and
// its own drill-down: Category > Service > Subservice. Edits are kept as a local draft per list, so
// moving between levels or tabs never loses anything; a list is only written when it is saved.
// The page (app/services/page.tsx) loads and saves; this component holds the screen's behaviour.

export type SaveResult = { ok: true; revision: number } | { ok: false; error: string };

type Path = { categoryId: string | null; serviceId: string | null };
const rootPath: Path = { categoryId: null, serviceId: null };
const perBranch = <T,>(make: (branch: Branch) => T): Record<Branch, T> => ({ OFFER: make("OFFER"), NEED: make("NEED") });

export default function ServiceSelector({ initial, revisions, mode, onSave, onFinish, onSkip }: {
  initial: Record<Branch, SelectionState>;
  revisions: Record<Branch, number>;
  mode: "onboarding" | "profile";
  onSave: (branch: Branch, state: SelectionState, expectedRevision: number) => Promise<SaveResult>;
  onFinish: () => void;
  onSkip?: () => void;
}) {
  const [branch, setBranch] = useState<Branch>("OFFER");
  const [drafts, setDrafts] = useState<Record<Branch, SelectionState>>(initial);
  const [saved, setSaved] = useState<Record<Branch, SelectionState>>(initial);
  const [revs, setRevs] = useState<Record<Branch, number>>(revisions);
  const [queries, setQueries] = useState<Record<Branch, string>>(perBranch(() => ""));
  const [paths, setPaths] = useState<Record<Branch, Path>>(perBranch(() => rootPath));
  const [highlight, setHighlight] = useState<string | null>(null);
  const [view, setView] = useState<"browse" | "review">("browse");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [showProblems, setShowProblems] = useState(false);

  const dirty = perBranch((b) => !sameSelection(drafts[b], saved[b]));
  const anyDirty = dirty.OFFER || dirty.NEED;

  // Leaving the page with unsaved edits asks first (the drafts live only in this screen).
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  const path = paths[branch];
  const query = queries[branch];
  const edit = (change: (state: SelectionState) => SelectionState) => {
    setDrafts((current) => ({ ...current, [branch]: change(current[branch]) }));
    setMessage(null);
  };
  const go = (next: Path) => { setPaths((current) => ({ ...current, [branch]: next })); setHighlight(null); };
  const setQuery = (text: string) => setQueries((current) => ({ ...current, [branch]: text }));

  function openHit(hit: SearchHit) {
    go({ categoryId: hit.categoryId, serviceId: hit.level === "category" ? null : hit.serviceId });
    setHighlight(hit.level === "subservice" ? hit.id : null);
    setQuery("");
  }

  async function saveBranch(target: Branch): Promise<boolean> {
    const problems = selectionProblems(drafts[target]);
    if (problems.length > 0) {
      setShowProblems(true);
      setMessage({ kind: "error", text: `${BRANCH_LABEL[target]}: ${problems[0].message}` });
      return false;
    }
    setSaving(true);
    setMessage(null);
    const result = await onSave(target, drafts[target], revs[target]);
    setSaving(false);
    if (!result.ok) { setMessage({ kind: "error", text: result.error }); return false; }
    setSaved((current) => ({ ...current, [target]: drafts[target] }));
    setRevs((current) => ({ ...current, [target]: result.revision }));
    setMessage({ kind: "ok", text: `Saved ${BRANCH_LABEL[target]}.` });
    return true;
  }

  async function finish() {
    for (const target of BRANCHES) {
      if (dirty[target] && !(await saveBranch(target))) return;
    }
    onFinish();
  }

  function skip() {
    if (anyDirty && !window.confirm("Skip without saving the changes you just made?")) return;
    (onSkip ?? onFinish)();
  }

  const tab = (target: Branch) => (
    <button key={target} role="tab" type="button" aria-selected={branch === target} onClick={() => { setBranch(target); setMessage(null); }}
      className={`min-h-11 flex-1 rounded-lg px-2 py-1.5 text-center text-sm font-semibold transition-colors ${branch === target ? "bg-white text-emerald-700 shadow-sm" : "text-neutral-500 hover:text-neutral-900"}`}>
      {BRANCH_LABEL[target]}
      <span className="block text-xs font-normal">{totalSelected(drafts[target])} selected{dirty[target] ? " · unsaved" : ""}</span>
    </button>
  );

  const tabs = (
    <div role="tablist" aria-label="Service lists" className="flex gap-1 rounded-xl bg-neutral-100 p-1">{BRANCHES.map(tab)}</div>
  );
  const status = message && (
    <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-red-600" : "text-emerald-700"}`}>{message.text}</p>
  );

  // ---- Review & finish ----
  if (view === "review") {
    return (
      <div className="space-y-5">
        {tabs}
        <h2 className="text-lg font-semibold">Review your services</h2>
        {BRANCHES.map((target) => {
          const summary = summarize(drafts[target]);
          return (
            <section key={target} aria-label={BRANCH_LABEL[target]} className="space-y-2 rounded-xl border border-neutral-200 bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-medium">{BRANCH_LABEL[target]}{dirty[target] ? " (unsaved)" : ""}</h3>
                <button type="button" onClick={() => { setBranch(target); setView("browse"); }} className="touch-link text-sm font-medium text-emerald-700">Edit</button>
              </div>
              {summary.length === 0 ? <p className="text-sm text-neutral-500">Nothing selected.</p> : summary.map(({ category, services }) => (
                <div key={category.id}>
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-neutral-700">{category.name}</h4>
                    <button type="button" aria-label={`Edit ${category.name} in ${BRANCH_LABEL[target]}`}
                      onClick={() => { setBranch(target); setPaths((current) => ({ ...current, [target]: { categoryId: category.id, serviceId: null } })); setView("browse"); }}
                      className="text-xs font-medium text-emerald-700">Edit</button>
                  </div>
                  <ul className="ml-3 mt-1 space-y-1 text-sm text-neutral-700">
                    {services.map(({ service, subservices, other }) => (
                      <li key={service.id}>
                        <span className="font-medium">{service.name}</span>
                        <ul className="ml-3 list-disc pl-3 text-neutral-600">
                          {subservices.map((sub) => <li key={sub.id}>{sub.name}</li>)}
                          {other && <li>Other: {other}</li>}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          );
        })}
        {status}
        <div className="space-y-2">
          <button type="button" disabled={saving} onClick={() => void finish()}
            className="flex min-h-11 w-full items-center justify-center rounded-lg bg-emerald-600 px-4 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60">
            {saving ? "Saving…" : mode === "onboarding" ? "Save & Complete Registration" : "Save changes"}
          </button>
          {message?.kind === "error" && !saving && (
            <button type="button" onClick={() => void finish()} className="touch-link block w-full text-center text-sm font-medium text-emerald-700">Retry</button>
          )}
          <button type="button" onClick={() => setView("browse")} className="flex min-h-11 w-full items-center justify-center rounded-lg border border-neutral-300 bg-white px-4 py-2.5 font-medium text-neutral-700 hover:bg-neutral-50">Keep editing</button>
          {mode === "onboarding" && <button type="button" onClick={skip} className="touch-link block w-full text-center text-sm font-medium text-neutral-500">Skip for now</button>}
        </div>
      </div>
    );
  }

  // ---- Browse: search, then Category > Service > Subservice ----
  const trimmed = query.trim();
  const hits = trimmed ? searchCatalog(trimmed) : [];
  const category = path.categoryId ? CATEGORY_BY_ID.get(path.categoryId) : undefined;
  const found = path.serviceId ? SERVICE_BY_ID.get(path.serviceId) : undefined;
  const draft = drafts[branch];

  const crumbs = (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
      <button type="button" onClick={() => go(rootPath)} className="touch-link font-medium text-emerald-700">Catalog</button>
      {category && <>
        <span aria-hidden="true" className="text-neutral-400">&gt;</span>
        <button type="button" onClick={() => go({ categoryId: category.id, serviceId: null })} className={`touch-link ${found ? "font-medium text-emerald-700" : "text-neutral-700"}`}>{category.name}</button>
      </>}
      {found && <>
        <span aria-hidden="true" className="text-neutral-400">&gt;</span>
        <span className="text-neutral-700">{found.service.name}</span>
      </>}
    </nav>
  );

  const row = "flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left hover:bg-neutral-50";
  const count = (n: number) => (n > 0 ? <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">✓ {n} selected</span> : null);

  let body;
  if (trimmed) {
    body = hits.length === 0 ? (
      <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-4 text-sm">
        <p className="font-medium">No matching services</p>
        <div className="flex gap-3">
          <button type="button" onClick={() => setQuery("")} className="touch-link font-medium text-emerald-700">Clear search</button>
          <button type="button" onClick={() => { setQuery(""); go(rootPath); }} className="touch-link font-medium text-emerald-700">Back to the catalog</button>
        </div>
      </div>
    ) : (
      <ul aria-label="Search results" className="space-y-1.5">
        {hits.map((hit) => (
          <li key={hit.id}><button type="button" onClick={() => openHit(hit)} className={row}><span className="text-sm">{pathLabel(hit)}</span><span aria-hidden="true">›</span></button></li>
        ))}
      </ul>
    );
  } else if (!category) {
    body = (
      <ul aria-label="Categories" className="space-y-1.5">
        {CATALOG.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => go({ categoryId: item.id, serviceId: null })} className={row}>
              <span className="font-medium">{item.name}</span>
              <span className="flex items-center gap-2">{count(countForCategory(draft, item.id))}<span aria-hidden="true">›</span></span>
            </button>
          </li>
        ))}
      </ul>
    );
  } else if (!found) {
    body = (
      <ul aria-label={`Services in ${category.name}`} className="space-y-1.5">
        {category.services.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => go({ categoryId: category.id, serviceId: item.id })} className={row}>
              <span className="font-medium">{item.name}</span>
              <span className="flex items-center gap-2">{count(countForService(draft, item.id))}<span aria-hidden="true">›</span></span>
            </button>
          </li>
        ))}
      </ul>
    );
  } else {
    const { service } = found;
    const all = allState(draft, service.id);
    const other = draft.custom[service.id] ?? { checked: false, text: "" };
    const otherProblem = showProblems ? customError(other) : null;
    const box = "flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2";
    body = (
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-base font-semibold">{service.name}</legend>
        {service.regulated && <p role="note" className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">This kind of work usually needs a licence. You can add it, but it won&apos;t show up in helper search until it is verified.</p>}
        <label className={`${box} border-neutral-300 bg-neutral-50 font-medium`}>
          <input type="checkbox" checked={all === "all"} aria-checked={all === "some" ? "mixed" : all === "all"}
            ref={(el: HTMLInputElement | null) => { if (el) el.indeterminate = all === "some"; }}
            onChange={(event) => edit((state) => setAll(state, service.id, event.target.checked))} className="h-5 w-5" />
          All
        </label>
        {service.subservices.map((sub) => (
          <label key={sub.id} className={`${box} ${highlight === sub.id ? "border-emerald-500 bg-emerald-50" : "border-neutral-200 bg-white"}`}>
            <input type="checkbox" checked={draft.subservices.includes(sub.id)} onChange={() => edit((state) => toggleSubservice(state, sub.id))} className="h-5 w-5" />
            {sub.name}
          </label>
        ))}
        <div className={`${box} flex-wrap border-neutral-200 bg-white`}>
          <label className="flex min-h-11 items-center gap-3">
            <input type="checkbox" checked={other.checked} onChange={(event) => edit((state) => setCustomChecked(state, service.id, event.target.checked))} className="h-5 w-5" />
            Other
          </label>
          {other.checked && (
            <input type="text" aria-label={`Other ${service.name}`} aria-invalid={otherProblem ? true : undefined} maxLength={MAX_CUSTOM_LENGTH + 20} value={other.text} placeholder="Enter your own"
              onChange={(event) => edit((state) => setCustomText(state, service.id, event.target.value))}
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2" />
          )}
          {otherProblem && <p role="alert" className="w-full text-sm text-red-600">{otherProblem}</p>}
        </div>
      </fieldset>
    );
  }

  return (
    <div className="space-y-4">
      {tabs}
      <input type="search" aria-label={`Search ${BRANCH_LABEL[branch]}`} placeholder="Search categories, services, subservices" value={query}
        onChange={(event) => setQuery(event.target.value)} className="min-h-11 w-full rounded-lg border border-neutral-300 px-3 py-2" />
      {!trimmed && <p className="text-xs text-neutral-500">All categories are available under both lists. What you choose here is saved only under {BRANCH_LABEL[branch]}.</p>}
      {!trimmed && crumbs}
      {body}
      {status}
      <div className="space-y-2 border-t border-neutral-200 pt-3">
        <button type="button" disabled={saving || !dirty[branch]} onClick={() => void saveBranch(branch)}
          className="flex min-h-11 w-full items-center justify-center rounded-lg bg-emerald-600 px-4 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60">
          {saving ? "Saving…" : `Save to ${BRANCH_LABEL[branch]}`}
        </button>
        {message?.kind === "error" && !saving && (
          <button type="button" onClick={() => void saveBranch(branch)} className="touch-link block w-full text-center text-sm font-medium text-emerald-700">Retry</button>
        )}
        <button type="button" onClick={() => { setView("review"); setMessage(null); }} className="flex min-h-11 w-full items-center justify-center rounded-lg border border-neutral-300 bg-white px-4 py-2.5 font-medium text-neutral-700 hover:bg-neutral-50">
          Review &amp; finish
        </button>
        {mode === "onboarding" && <button type="button" onClick={skip} className="touch-link block w-full text-center text-sm font-medium text-neutral-500">Skip for now</button>}
      </div>
    </div>
  );
}
