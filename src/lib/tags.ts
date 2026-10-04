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

// profile_tags references profiles, not the public_profiles table that Find a
// Helper and public profiles read, so PostgREST cannot embed one in the other
// (PGRST200). Fetch the links separately -- profile_tags is publicly readable --
// and attach them in the same shape the embed would have produced.
const TAG_LINK_BATCH = 100;
export async function withProfileTags<T extends { id: string }>(
  supabase: ReturnType<typeof createClient>,
  profiles: T[],
): Promise<(T & Pick<PublicProfileWithTags, "profile_tags">)[]> {
  const byProfile = new Map<string, NonNullable<PublicProfileWithTags["profile_tags"]>>();
  for (let start = 0; start < profiles.length; start += TAG_LINK_BATCH) {
    const ids = profiles.slice(start, start + TAG_LINK_BATCH).map((profile) => profile.id);
    const { data, error } = await supabase.from("profile_tags").select("profile_id, tag:tags(id,name,service_type)").in("profile_id", ids);
    if (error) throw error;
    for (const row of (data ?? []) as unknown as { profile_id: string; tag: { id: string; name: string; service_type: string } | null }[]) {
      if (row.tag) (byProfile.get(row.profile_id) ?? byProfile.set(row.profile_id, []).get(row.profile_id)!).push({ tag: row.tag });
    }
  }
  return profiles.map((profile) => ({ ...profile, profile_tags: byProfile.get(profile.id) ?? [] }));
}
