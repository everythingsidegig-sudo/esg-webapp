"use client";

import SelectionChip from "@/components/SelectionChip";
import { SERVICE_TYPES } from "@/lib/services";

// ESG-SVC-001 v1.0 §4/§5: one shared ALL/OTHER selection control for the
// master category list, used by both Registration (Skills I Can Offer /
// Services I Am Interested In) and My Profile editing -- previously
// duplicated per-screen, which is exactly the kind of split the spec's
// "no module may hard-code a separate list" rule exists to prevent.
export const CATEGORIES = SERVICE_TYPES.filter((c) => c !== "Other");
export const isAllSelected = (selected: string[]) => CATEGORIES.every((c) => selected.includes(c)) && selected.includes("Other");
export const toggleAllCategories = (selected: string[]) => (isAllSelected(selected) ? [] : [...CATEGORIES, "Other"]);
export const toggleOneCategory = (selected: string[], item: string) => (selected.includes(item) ? selected.filter((c) => c !== item) : [...selected, item]);

export function CategoryList({ title, selected, setSelected, otherText, setOtherText }: {
  title: string; selected: string[]; setSelected: (next: string[]) => void;
  otherText: string; setOtherText: (next: string) => void;
}) {
  const input = "w-full rounded-lg border border-neutral-300 px-3 py-2";
  return (
    <fieldset className="space-y-2">
      {title && <legend className="mb-1 font-medium">{title}</legend>}
      <div className="flex flex-wrap gap-2">
        <SelectionChip selected={isAllSelected(selected)} onClick={() => setSelected(toggleAllCategories(selected))}>ALL</SelectionChip>
        {CATEGORIES.map((item) => (
          <SelectionChip key={item} selected={selected.includes(item)} onClick={() => setSelected(toggleOneCategory(selected, item))}>{item}</SelectionChip>
        ))}
        <SelectionChip selected={selected.includes("Other")} onClick={() => { setSelected(toggleOneCategory(selected, "Other")); if (selected.includes("Other")) setOtherText(""); }}>OTHER</SelectionChip>
      </div>
      {selected.includes("Other") && (
        <label className="block text-sm">Please specify
          <input required value={otherText} onChange={(e) => setOtherText(e.target.value)} className={`mt-1 ${input}`} />
        </label>
      )}
    </fieldset>
  );
}
