// What My Profile's Update profile sends to public.profiles, and when it counts as "unsaved".
//
// The database only lets a signed-in user write the columns it has granted (skills, services and,
// since migration 0020, the two OTHER text columns). The OTHER text is also validated against the
// selection by a trigger (OTHER selected <=> text present), so it is sent exactly when it changes:
// an ordinary save never touches those columns, and an edit to either of them is never dropped.

type OtherSaved = { skills_other_text: string | null; services_other_text: string | null };

export type ProfileDraft = {
  skills: string[];
  services: string[];
  skillsOtherText: string;
  servicesOtherText: string;
};

export type ProfileUpdate = {
  skills: string[];
  services: string[];
  skills_other_text?: string | null;
  services_other_text?: string | null;
};

// The text that belongs with a selection: the typed text while OTHER is selected, otherwise nothing
// (a stale draft left over from an unticked OTHER is not a change). Empty and missing are the same thing.
export function otherTextFor(selected: string[], text: string): string | null {
  return selected.includes("Other") ? text.trim() || null : null;
}

const stored = (value: string | null | undefined) => value || null;

export function otherTextsChanged(draft: ProfileDraft, saved: OtherSaved) {
  return {
    skills: otherTextFor(draft.skills, draft.skillsOtherText) !== stored(saved.skills_other_text),
    services: otherTextFor(draft.services, draft.servicesOtherText) !== stored(saved.services_other_text),
  };
}

export function profileUpdate(draft: ProfileDraft, saved: OtherSaved): ProfileUpdate {
  const changed = otherTextsChanged(draft, saved);
  const update: ProfileUpdate = { skills: draft.skills, services: draft.services };
  if (changed.skills) update.skills_other_text = otherTextFor(draft.skills, draft.skillsOtherText);
  if (changed.services) update.services_other_text = otherTextFor(draft.services, draft.servicesOtherText);
  return update;
}
