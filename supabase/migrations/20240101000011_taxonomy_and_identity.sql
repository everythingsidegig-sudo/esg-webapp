-- Consolidates the services/skills taxonomy onto the single 13-category list
-- approved in ESG-AUTH-002 v0.5 §11 (previously an 8-category list duplicated
-- across services.ts, save_onboarding(), create_gig(), validate_profile_edit(),
-- and the tags table's CHECK constraint -- all four SQL copies updated here).
-- Also locks username after onboarding completes (ESG-AUTH-002 v0.5 §6/BR-REG-007:
-- "fixed after account creation"), and tightens the gig description bound to
-- ~50 characters (ESG-POST-001 target) in create_gig() only -- the client-side
-- max in post/page.tsx and journey.ts is updated in the same app commit.
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
-- 1. tags.service_type CHECK constraint: expand -> migrate -> contract.
--    ADD CONSTRAINT validates every existing row immediately, so a straight
--    swap to the final 13(+Other) list fails on rows still saying 'Delivery'.
--    Widen to a temporary superset (old 8 + new 13 + Other) first, rename the
--    data, then narrow to the real final list once no row says 'Delivery'.
--    Constraint name is Postgres's default for an unnamed single-column
--    CHECK; if this errors with "constraint does not exist", find the real
--    name via \d tags in the SQL Editor.
-- ---------------------------------------------------------------------------
alter table public.tags drop constraint if exists tags_service_type_check;
alter table public.tags add constraint tags_service_type_check check (
  service_type = any(array[
    'Yard Work','Moving Help','Cleaning','Handyman','Delivery','Pet Care','Tech Help',
    'Furniture Assembly','Delivery / Pickup','Errands','Auto Help','Cooking / Catering','Tutoring','Event Help','Other'
  ])
);

-- ---------------------------------------------------------------------------
-- 2. Rename the one category whose approved name changed ("Delivery" ->
--    "Delivery / Pickup"); every other existing category name is unchanged.
--    Covers gigs.service_type, tags.service_type, and any profiles.skills/
--    services jsonb array already containing the old string.
-- ---------------------------------------------------------------------------
update public.gigs set service_type = 'Delivery / Pickup' where service_type = 'Delivery';
update public.tags set service_type = 'Delivery / Pickup' where service_type = 'Delivery';

update public.profiles
set skills = (
  select coalesce(pg_catalog.jsonb_agg(case when value = 'Delivery' then 'Delivery / Pickup' else value end), '[]'::jsonb)
  from pg_catalog.jsonb_array_elements_text(skills) as value
)
where skills @> '["Delivery"]'::jsonb;

update public.profiles
set services = (
  select coalesce(pg_catalog.jsonb_agg(case when value = 'Delivery' then 'Delivery / Pickup' else value end), '[]'::jsonb)
  from pg_catalog.jsonb_array_elements_text(services) as value
)
where services @> '["Delivery"]'::jsonb;

-- Now safe to contract to the real final list (no row can say 'Delivery' anymore).
alter table public.tags drop constraint tags_service_type_check;
alter table public.tags add constraint tags_service_type_check check (
  service_type = any(array[
    'Moving Help','Cleaning','Handyman','Furniture Assembly','Yard Work','Delivery / Pickup',
    'Errands','Auto Help','Tech Help','Pet Care','Cooking / Catering','Tutoring','Event Help','Other'
  ])
);

-- ---------------------------------------------------------------------------
-- 3. create_gig(): same signature as 0010, approved category list, ~50-char
--    description bound.
-- ---------------------------------------------------------------------------
create or replace function public.create_gig(p_request_id uuid,p_service_type text,p_title text,
  p_description text,p_amount numeric,p_price_type text,p_scheduled_at timestamptz,
  p_location_text text,p_lat double precision,p_lng double precision,
  p_photo_url text default null,p_publish boolean default true,p_tag_ids uuid[] default '{}'::uuid[],
  p_private_address text default null)
returns public.gigs language plpgsql security definer set search_path = '' as $$
declare v_gig public.gigs; v_tag_ids uuid[]; v_address text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_request_id is null then raise exception 'Missing creation request.' using errcode='22023'; end if;
  perform 1 from public.profiles where id=auth.uid() and onboarding_completed_at is not null for update;
  if not found then raise exception 'Finish your profile setup before posting.' using errcode='22023'; end if;
  select * into v_gig from public.gigs where poster_id=auth.uid() and creation_request_id=p_request_id;
  if found then return v_gig; end if;
  if p_service_type is null or p_service_type <> all(array[
      'Moving Help','Cleaning','Handyman','Furniture Assembly','Yard Work','Delivery / Pickup',
      'Errands','Auto Help','Tech Help','Pet Care','Cooking / Catering','Tutoring','Event Help','Other'
    ]) then
    raise exception 'Choose a valid service type.' using errcode='22023'; end if;
  if p_title is null or pg_catalog.length(pg_catalog.btrim(p_title)) not between 1 and 120 then
    raise exception 'Enter a title of 1–120 characters.' using errcode='22023'; end if;
  if p_description is null or pg_catalog.length(pg_catalog.btrim(p_description)) not between 1 and 50 then
    raise exception 'Enter a description of 1–50 characters.' using errcode='22023'; end if;
  if p_amount is null or not (p_amount>0 and p_amount<=9999999999.99) or p_amount<>pg_catalog.round(p_amount,2) then
    raise exception 'Enter a positive amount with at most two decimal places.' using errcode='22023'; end if;
  if p_price_type is distinct from 'fixed' then
    raise exception 'This POC supports fixed-price gigs only.' using errcode='22023'; end if;
  if p_publish is null or (p_publish and p_scheduled_at is null)
    or (p_scheduled_at is not null and (not pg_catalog.isfinite(p_scheduled_at) or p_scheduled_at<=pg_catalog.now())) then
    raise exception 'Pick a future date/time before posting.' using errcode='22023'; end if;
  if p_location_text is null or pg_catalog.length(pg_catalog.btrim(p_location_text)) not between 1 and 200 then
    raise exception 'Enter a general area of 1–200 characters.' using errcode='22023'; end if;
  if (p_lat is null) <> (p_lng is null) or (p_lat is not null and
    (not (p_lat between -90 and 90) or not (p_lng between -180 and 180))) then
    raise exception 'Invalid location coordinates.' using errcode='22023'; end if;
  if p_photo_url is not null and (pg_catalog.length(p_photo_url)>2048 or p_photo_url !~ '^https?://') then
    raise exception 'Invalid photo URL.' using errcode='22023'; end if;
  v_address := nullif(pg_catalog.btrim(p_private_address), '');
  if v_address is not null and pg_catalog.length(v_address) > 300 then
    raise exception 'Enter a private address of at most 300 characters.' using errcode='22023'; end if;
  v_tag_ids := coalesce(
    (select pg_catalog.array_agg(distinct picked) from pg_catalog.unnest(p_tag_ids) as picked),
    array[]::uuid[]
  );
  if pg_catalog.array_length(v_tag_ids,1) > 8 then
    raise exception 'Choose at most 8 tags.' using errcode='22023'; end if;
  if exists (
    select 1 from pg_catalog.unnest(v_tag_ids) as picked
    where not exists (select 1 from public.tags tg where tg.id = picked and tg.service_type = p_service_type)
  ) then
    raise exception 'Choose tags that exist and match the selected category.' using errcode='22023'; end if;
  insert into public.gigs(poster_id,creation_request_id,service_type,title,description,
    amount,price_type,scheduled_at,location_text,lat,lng,photo_url,status)
  values(auth.uid(),p_request_id,p_service_type,pg_catalog.btrim(p_title),pg_catalog.btrim(p_description),
    p_amount,'fixed',p_scheduled_at,pg_catalog.btrim(p_location_text),
    pg_catalog.round(p_lat::numeric,2)::double precision,pg_catalog.round(p_lng::numeric,2)::double precision,
    p_photo_url,case when p_publish then 'active'::public.gig_status else 'draft'::public.gig_status end)
  returning * into v_gig;
  insert into public.gig_tags (gig_id, tag_id)
  select v_gig.id, picked from pg_catalog.unnest(v_tag_ids) as picked
  on conflict do nothing;
  if v_address is not null then
    insert into public.gig_private_locations (gig_id, address_text) values (v_gig.id, v_address);
  end if;
  return v_gig;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. save_onboarding(): same signature as 0004, approved category list only.
-- ---------------------------------------------------------------------------
create or replace function public.save_onboarding(p_username text,p_photo_url text,p_location_text text,
  p_lat double precision,p_lng double precision,p_skills jsonb,p_services jsonb)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare v_profile public.profiles; v_item text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform public.ensure_profile();
  select * into v_profile from public.profiles where id=auth.uid() for update;
  if p_username is null or p_username !~ '^[A-Za-z0-9]{6,40}$' then
    raise exception 'Username must be 6–40 letters/numbers.' using errcode='22023'; end if;
  if p_location_text is null or pg_catalog.length(pg_catalog.btrim(p_location_text)) not between 1 and 200 then
    raise exception 'Enter an address or general area of 1–200 characters.' using errcode='22023'; end if;
  if (p_lat is null) <> (p_lng is null) or (p_lat is not null and
    (not (p_lat between -90 and 90) or not (p_lng between -180 and 180))) then
    raise exception 'Invalid location coordinates.' using errcode='22023'; end if;
  if p_photo_url is not null and (pg_catalog.length(p_photo_url)>2048 or p_photo_url !~ '^https?://') then
    raise exception 'Invalid photo URL.' using errcode='22023'; end if;
  if p_skills is null or p_services is null or pg_catalog.jsonb_typeof(p_skills)<>'array'
    or pg_catalog.jsonb_typeof(p_services)<>'array' then
    raise exception 'Choose skills and services from the available categories.' using errcode='22023'; end if;
  for v_item in select pg_catalog.jsonb_array_elements_text(p_skills || p_services) loop
    if v_item is null or (v_item <> all(array[
        'Moving Help','Cleaning','Handyman','Furniture Assembly','Yard Work','Delivery / Pickup',
        'Errands','Auto Help','Tech Help','Pet Care','Cooking / Catering','Tutoring','Event Help','Other'
      ])
      and not (v_profile.skills ? v_item or v_profile.services ? v_item)) then
      raise exception 'Choose skills and services from the available categories.' using errcode='22023'; end if;
  end loop;
  if pg_catalog.jsonb_array_length(p_skills)>40 or pg_catalog.jsonb_array_length(p_services)>40
    or pg_catalog.jsonb_array_length(p_skills)<>(select count(distinct item) from pg_catalog.jsonb_array_elements_text(p_skills) as entries(item))
    or pg_catalog.jsonb_array_length(p_services)<>(select count(distinct item) from pg_catalog.jsonb_array_elements_text(p_services) as entries(item)) then
    raise exception 'Choose each category at most once.' using errcode='22023'; end if;
  update public.profiles set username=p_username,photo_url=p_photo_url,
    private_location_text=pg_catalog.btrim(p_location_text),private_lat=p_lat,private_lng=p_lng,
    skills=p_skills,services=p_services,
    onboarding_completed_at=coalesce(onboarding_completed_at,pg_catalog.now())
    where id=auth.uid() returning * into v_profile;
  return v_profile;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. validate_profile_edit(): approved category list, plus the username lock.
--    Username may still change freely before onboarding completes (the
--    wizard calls save_onboarding, which goes through this same trigger);
--    once onboarding_completed_at is set, a username change is rejected
--    outright, matching ESG-AUTH-002 v0.5's "fixed after account creation".
-- ---------------------------------------------------------------------------
create or replace function esg_private.validate_profile_edit() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_item text;
begin
  if new.username is distinct from old.username then
    if old.onboarding_completed_at is not null then
      raise exception 'Username cannot be changed after account creation.' using errcode = '22023';
    end if;
    if new.username is null or new.username !~ '^[A-Za-z0-9]{6,40}$' then
      raise exception 'Username must be 6–40 letters/numbers.' using errcode = '22023';
    end if;
  end if;

  if new.photo_url is distinct from old.photo_url then
    if new.photo_url is not null and (pg_catalog.length(new.photo_url) > 2048 or new.photo_url !~ '^https?://') then
      raise exception 'Invalid photo URL.' using errcode = '22023';
    end if;
  end if;

  if new.skills is distinct from old.skills or new.services is distinct from old.services then
    if new.skills is null or new.services is null
        or pg_catalog.jsonb_typeof(new.skills) <> 'array' or pg_catalog.jsonb_typeof(new.services) <> 'array' then
      raise exception 'Choose skills and services from the available categories.' using errcode = '22023';
    end if;
    for v_item in select pg_catalog.jsonb_array_elements_text(new.skills || new.services) loop
      if v_item is null or (v_item <> all(array[
          'Moving Help','Cleaning','Handyman','Furniture Assembly','Yard Work','Delivery / Pickup',
          'Errands','Auto Help','Tech Help','Pet Care','Cooking / Catering','Tutoring','Event Help','Other'
        ])
        and not (old.skills ? v_item or old.services ? v_item)) then
        raise exception 'Choose skills and services from the available categories.' using errcode = '22023';
      end if;
    end loop;
    if pg_catalog.jsonb_array_length(new.skills) > 40 or pg_catalog.jsonb_array_length(new.services) > 40
        or pg_catalog.jsonb_array_length(new.skills) <> (select count(distinct item) from pg_catalog.jsonb_array_elements_text(new.skills) as entries(item))
        or pg_catalog.jsonb_array_length(new.services) <> (select count(distinct item) from pg_catalog.jsonb_array_elements_text(new.services) as entries(item)) then
      raise exception 'Choose each category at most once.' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

commit;
