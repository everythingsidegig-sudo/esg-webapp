// Approved 13-category list (ESG-AUTH-002 v0.5 §11), shared by posting,
// browsing, and profile/onboarding skill & service selection. "Other" is
// kept as a plain category here; the ALL/OTHER special selection behavior
// (§5) is implemented at the registration-screen level, not in this list.
export const SERVICE_TYPES = [
  "Moving Help", "Cleaning", "Handyman", "Furniture Assembly", "Yard Work", "Delivery / Pickup",
  "Errands", "Auto Help", "Tech Help", "Pet Care", "Cooking / Catering", "Tutoring", "Event Help", "Other",
] as const;

// User-facing prompt for a category's optional specialization picker. Never
// say "tags" or "profile_tags" — this is internal plumbing, not UI wording.
export const SPECIALIZATION_PROMPTS: Record<string, string> = {
  "Moving Help": "What kind of moving help?",
  "Cleaning": "What kind of cleaning?",
  "Handyman": "What kind of handyman work?",
  "Furniture Assembly": "What kind of furniture assembly?",
  "Yard Work": "What kind of yard work?",
  "Delivery / Pickup": "What kind of delivery or pickup?",
  "Errands": "What kind of errands?",
  "Auto Help": "What kind of auto help?",
  "Tech Help": "What kind of tech help?",
  "Pet Care": "What kind of pet care?",
  "Cooking / Catering": "What kind of cooking or catering?",
  "Tutoring": "What kind of tutoring?",
  "Event Help": "What kind of event help?",
  "Other": "What kind of help?",
};
