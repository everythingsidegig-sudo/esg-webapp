import { CATALOG, CATEGORY_BY_ID, SERVICE_BY_ID, SUBSERVICE_BY_ID, type CatalogCategory, type CatalogService, type CatalogSubservice } from "./service-catalog.ts";

// Selection rules for "Services to Make Money" (OFFER) and "Services I Need Help" (NEED), spec v2.0
// sections 4 and 5. Pure functions over a plain, serializable state so every rule is easy to test; the
// screen (components/ServiceSelector.tsx) and the page (app/services/page.tsx) only wire it up.
//
// What is saved: the checked subservice ids, plus at most one "Other" entry per service. "All" is never
// saved -- it is just every predefined subservice of a service.

export type Branch = "OFFER" | "NEED";
export const BRANCH_LABEL: Record<Branch, string> = { OFFER: "Services to Make Money", NEED: "Services I Need Help" };
export const BRANCHES: Branch[] = ["OFFER", "NEED"];

export type CustomEntry = { checked: boolean; text: string };
export type SelectionState = { subservices: string[]; custom: Record<string, CustomEntry> };

export const MAX_CUSTOM_LENGTH = 100;

export const emptySelection = (): SelectionState => ({ subservices: [], custom: {} });

const withSub = (state: SelectionState, subservices: string[]): SelectionState => ({ ...state, subservices });

// Toggling one subservice touches nothing else: not other services, not the other branch (a separate state).
export function toggleSubservice(state: SelectionState, id: string): SelectionState {
  return withSub(state, state.subservices.includes(id) ? state.subservices.filter((item) => item !== id) : [...state.subservices, id]);
}

export type AllState = "none" | "some" | "all";

// "All" for one service: every predefined subservice (even ones a search is hiding), indeterminate when partial.
export function allState(state: SelectionState, serviceId: string): AllState {
  const subs = SERVICE_BY_ID.get(serviceId)?.service.subservices ?? [];
  if (subs.length === 0) return "none";
  const chosen = subs.filter((sub) => state.subservices.includes(sub.id)).length;
  return chosen === 0 ? "none" : chosen === subs.length ? "all" : "some";
}

// Checking All selects every predefined subservice of THIS service; unchecking clears only those, and a
// separately checked "Other" is left exactly as it was.
export function setAll(state: SelectionState, serviceId: string, checked: boolean): SelectionState {
  const ids = (SERVICE_BY_ID.get(serviceId)?.service.subservices ?? []).map((sub) => sub.id);
  const rest = state.subservices.filter((id) => !ids.includes(id));
  return withSub(state, checked ? [...rest, ...ids] : rest);
}

export function setCustomChecked(state: SelectionState, serviceId: string, checked: boolean): SelectionState {
  const current = state.custom[serviceId] ?? { checked: false, text: "" };
  return { ...state, custom: { ...state.custom, [serviceId]: { ...current, checked } } };
}

// Typing into Other keeps the text even while it is unchecked, so toggling the box does not lose it.
export function setCustomText(state: SelectionState, serviceId: string, text: string): SelectionState {
  const current = state.custom[serviceId] ?? { checked: false, text: "" };
  return { ...state, custom: { ...state.custom, [serviceId]: { ...current, text } } };
}

// Other validation: trim, required when checked, at most 100 characters.
export function customError(entry: CustomEntry | undefined): string | null {
  if (!entry?.checked) return null;
  const text = entry.text.trim();
  if (!text) return "Enter what you mean by Other, or uncheck it.";
  if (text.length > MAX_CUSTOM_LENGTH) return `Keep Other to ${MAX_CUSTOM_LENGTH} characters or fewer.`;
  return null;
}

export type SelectionProblem = { serviceId: string; message: string };

export function selectionProblems(state: SelectionState): SelectionProblem[] {
  return Object.entries(state.custom).flatMap(([serviceId, entry]) => {
    const message = customError(entry);
    return message ? [{ serviceId, message }] : [];
  });
}

export function isEmptySelection(state: SelectionState): boolean {
  return state.subservices.length === 0 && !Object.values(state.custom).some((entry) => entry.checked);
}

export function countForService(state: SelectionState, serviceId: string): number {
  const subs = SERVICE_BY_ID.get(serviceId)?.service.subservices ?? [];
  return subs.filter((sub) => state.subservices.includes(sub.id)).length + (state.custom[serviceId]?.checked ? 1 : 0);
}

export function countForCategory(state: SelectionState, categoryId: string): number {
  return (CATEGORY_BY_ID.get(categoryId)?.services ?? []).reduce((total, service) => total + countForService(state, service.id), 0);
}

export function totalSelected(state: SelectionState): number {
  return CATALOG.reduce((total, category) => total + countForCategory(state, category.id), 0);
}

// What gets sent to save_service_selections: only ids that exist, and only checked, non-blank Other text.
export function toPayload(state: SelectionState): { subserviceIds: string[]; custom: { service_id: string; text: string }[] } {
  return {
    subserviceIds: [...new Set(state.subservices)].filter((id) => SUBSERVICE_BY_ID.has(id)),
    custom: Object.entries(state.custom)
      .filter(([serviceId, entry]) => entry.checked && entry.text.trim() && SERVICE_BY_ID.has(serviceId))
      .map(([service_id, entry]) => ({ service_id, text: entry.text.trim() })),
  };
}

export type SelectionRow = { subservice_id: string | null; service_id: string; is_custom: boolean; custom_text: string | null };

export function fromRows(rows: SelectionRow[]): SelectionState {
  const state = emptySelection();
  for (const row of rows) {
    if (row.is_custom && row.custom_text) state.custom[row.service_id] = { checked: true, text: row.custom_text };
    else if (row.subservice_id) state.subservices.push(row.subservice_id);
  }
  return state;
}

// Same saved set? (order and untouched blank Other text don't matter)
export function sameSelection(a: SelectionState, b: SelectionState): boolean {
  const pa = toPayload(a), pb = toPayload(b);
  const ids = (payload: typeof pa) => [...payload.subserviceIds].sort().join("|");
  const custom = (payload: typeof pa) => payload.custom.map((item) => `${item.service_id}=${item.text}`).sort().join("|");
  return ids(pa) === ids(pb) && custom(pa) === custom(pb);
}

// Review summary: Category > Service > Subservice, for what is checked.
export type SummaryService = { service: CatalogService; subservices: CatalogSubservice[]; other: string | null };
export type SummaryCategory = { category: CatalogCategory; services: SummaryService[] };

export function summarize(state: SelectionState): SummaryCategory[] {
  const result: SummaryCategory[] = [];
  for (const category of CATALOG) {
    const services: SummaryService[] = [];
    for (const service of category.services) {
      const subservices = service.subservices.filter((sub) => state.subservices.includes(sub.id));
      const entry = state.custom[service.id];
      const other = entry?.checked && entry.text.trim() ? entry.text.trim() : null;
      if (subservices.length > 0 || other) services.push({ service, subservices, other });
    }
    if (services.length > 0) result.push({ category, services });
  }
  return result;
}

// ---- Search (spec section 5) ----------------------------------------------------------------------------

export type SearchHit = {
  level: "category" | "service" | "subservice";
  id: string;
  categoryId: string;
  serviceId: string | null;
  path: string[];
};

const norm = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

// Case-insensitive partial match against category, service and subservice names. Names that start with
// the query, or a word that does, come first; within that the catalog order is kept. A matching
// subservice is always shown with its parent service (never a free-floating checkbox).
export function searchCatalog(query: string, limit = 30): SearchHit[] {
  const q = norm(query);
  if (!q) return [];
  const hits: { hit: SearchHit; rank: number }[] = [];
  const rank = (name: string) => {
    const n = norm(name);
    const at = n.indexOf(q);
    if (at < 0) return -1;
    return at === 0 ? 0 : n[at - 1] === " " ? 1 : 2;
  };
  for (const category of CATALOG) {
    const categoryRank = rank(category.name);
    if (categoryRank >= 0) hits.push({ rank: categoryRank, hit: { level: "category", id: category.id, categoryId: category.id, serviceId: null, path: [category.name] } });
    for (const service of category.services) {
      const serviceRank = rank(service.name);
      if (serviceRank >= 0) hits.push({ rank: serviceRank, hit: { level: "service", id: service.id, categoryId: category.id, serviceId: service.id, path: [category.name, service.name] } });
      for (const sub of service.subservices) {
        const subRank = rank(sub.name);
        if (subRank >= 0) hits.push({ rank: subRank, hit: { level: "subservice", id: sub.id, categoryId: category.id, serviceId: service.id, path: [category.name, service.name, sub.name] } });
      }
    }
  }
  return hits.map((item, index) => ({ ...item, index })).sort((a, b) => a.rank - b.rank || a.index - b.index).slice(0, limit).map((item) => item.hit);
}

export const pathLabel = (hit: SearchHit) => hit.path.join(" > ");
