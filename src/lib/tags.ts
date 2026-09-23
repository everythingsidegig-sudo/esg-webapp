import { createClient } from "@/lib/supabase/client";
import type { Tag, GigWithTags, PublicProfileWithTags } from "@/lib/database.types";

// public.tags is the single source of truth (Option A); no parallel static list here.
export const MAX_GIG_TAGS = 8;
export const MAX_PROFILE_TAGS = 8;

export async function loadTagCatalog(supabase: ReturnType<typeof createClient>): Promise<Record<string, Tag[]>> {
  const { data, error } = await supabase.from("tags").select("id,service_type,name,created_at").order("name");
  if (error) throw error;
  const byCategory: Record<string, Tag[]> = {};
  for (const tag of (data as Tag[] | null) ?? []) {
    (byCategory[tag.service_type] ??= []).push(tag);
  }
  return byCategory;
}

export function gigTagNames(gig: GigWithTags): string[] {
  return (gig.gig_tags ?? []).map((link) => link.tag.name);
}

// A profile's tags can span every category in its skills; scope to one category.
export function profileTagsForCategory(profile: PublicProfileWithTags, serviceType: string): { id: string; name: string }[] {
  return (profile.profile_tags ?? [])
    .map((link) => link.tag)
    .filter((tag) => tag.service_type === serviceType);
}
