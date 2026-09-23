-- Find a Helper MVP: optional, category-scoped specialization tags on a
-- profile, reusing the existing public.tags catalog (no second catalog).
-- No location/distance filtering in this phase: profiles.private_lat/lng
-- remain untouched and unexposed. Additive on top of 0001-0006.
begin;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = current_user and (rolsuper or rolbypassrls)
  ) then
    raise exception 'Apply this migration as postgres or another trusted BYPASSRLS migration role';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- profile_tags: a profile's declared specializations. Structurally identical
-- to gig_tags (composite PK prevents duplicates; cascades with its profile).
-- ---------------------------------------------------------------------------
create table public.profile_tags (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  tag_id uuid not null references public.tags(id),
  primary key (profile_id, tag_id)
);

alter table public.profile_tags enable row level security;

-- Public read: a helper's declared capabilities are meant to be discoverable
-- the moment they're set, same posture as public_profiles.skills already has
-- (unlike gig_tags, which had to mirror gig-visibility for draft/private gigs).
create policy profile_tags_select_all on public.profile_tags for select to anon, authenticated using (true);

-- No write policy; RLS already default-denies INSERT/UPDATE/DELETE with none
-- defined. Revoke the underlying grants too, matching 0002/0005/0006's
-- defense-in-depth style.
revoke insert, update, delete on table public.profile_tags from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- set_helper_tags(): the only write path. Replaces (not unions) the caller's
-- specialization tags for exactly one category, leaving their other
-- categories' tags untouched. Mirrors create_gig()'s tag validation:
-- dedupe, max 8, every id must exist and match the category — plus one
-- additional rule specific to profiles: the category must already be in the
-- caller's own skills (you can't specialize in something you don't offer).
-- ---------------------------------------------------------------------------
create function public.set_helper_tags(p_service_type text, p_tag_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_tag_ids uuid[];
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_service_type is null or p_service_type <> all(array['Yard Work','Moving Help','Cleaning','Handyman','Delivery','Pet Care','Tech Help','Other']) then
    raise exception 'Choose a valid service type.' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and skills ? p_service_type) then
    raise exception 'Add this category to your skills before choosing specialization tags.' using errcode = '22023'; end if;

  v_tag_ids := coalesce(
    (select pg_catalog.array_agg(distinct picked) from pg_catalog.unnest(p_tag_ids) as picked),
    array[]::uuid[]
  );
  if pg_catalog.array_length(v_tag_ids, 1) > 8 then
    raise exception 'Choose at most 8 tags.' using errcode = '22023'; end if;
  if exists (
    select 1 from pg_catalog.unnest(v_tag_ids) as picked
    where not exists (select 1 from public.tags tg where tg.id = picked and tg.service_type = p_service_type)
  ) then
    raise exception 'Choose tags that exist and match the selected category.' using errcode = '22023'; end if;

  delete from public.profile_tags pt
  using public.tags tg
  where pt.profile_id = auth.uid() and pt.tag_id = tg.id and tg.service_type = p_service_type;

  insert into public.profile_tags (profile_id, tag_id)
  select auth.uid(), picked from pg_catalog.unnest(v_tag_ids) as picked
  on conflict do nothing;
end;
$$;

revoke execute on function public.set_helper_tags(text, uuid[]) from public, anon, authenticated;
grant execute on function public.set_helper_tags(text, uuid[]) to authenticated;

commit;
