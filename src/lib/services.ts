// Existing POC labels, shared by posting, browsing and profile setup.
export const SERVICE_TYPES = ["Yard Work", "Moving Help", "Cleaning", "Handyman", "Delivery", "Pet Care", "Tech Help", "Other"] as const;

// User-facing prompt for a category's optional specialization picker. Never
// say "tags" or "profile_tags" — this is internal plumbing, not UI wording.
export const SPECIALIZATION_PROMPTS: Record<string, string> = {
  "Yard Work": "What kind of yard work?",
  "Moving Help": "What kind of moving help?",
  "Cleaning": "What kind of cleaning?",
  "Handyman": "What kind of handyman work?",
  "Delivery": "What kind of delivery?",
  "Pet Care": "What kind of pet care?",
  "Tech Help": "What kind of tech help?",
  "Other": "What kind of help?",
};
