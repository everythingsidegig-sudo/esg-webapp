-- Bug: 20240101000011 updated the approved-category list everywhere else
-- (tags.service_type CHECK, validate_profile_edit(), create_gig(),
-- save_onboarding()) but missed set_helper_tags() (0007), which still checked
-- p_service_type against the old 8-item list (and the old 'Delivery' name).
-- Saving specialization tags for any of the 6 categories added in 0011, or
-- for 'Delivery / Pickup', failed with "Choose a valid service type." even
-- though the profile's skills/services update itself succeeded.
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

create or replace function public.set_helper_tags(p_service_type text, p_tag_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_tag_ids uuid[];
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_service_type is null or p_service_type <> all(array[
      'Moving Help','Cleaning','Handyman','Furniture Assembly','Yard Work','Delivery / Pickup',
      'Errands','Auto Help','Tech Help','Pet Care','Cooking / Catering','Tutoring','Event Help','Other'
    ]) then
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

commit;
