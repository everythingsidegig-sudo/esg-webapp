-- Onboarding and initial creation only. Existing lifecycle RPCs are unchanged.
begin;
alter table public.profiles
  add column private_location_text text,
  add column private_lat double precision,
  add column private_lng double precision,
  add column onboarding_completed_at timestamptz;
alter table public.gigs add column creation_request_id uuid;
create unique index gigs_creation_request on public.gigs(poster_id, creation_request_id)
  where creation_request_id is not null;

-- Existing pre-selection edit grants must not allow an idempotency key to change.
create function esg_private.keep_creation_request() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.creation_request_id is distinct from old.creation_request_id then
    raise exception 'Creation request cannot be changed.' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke execute on function esg_private.keep_creation_request() from public,anon,authenticated;
create trigger trg_keep_creation_request before update of creation_request_id on public.gigs
for each row execute function esg_private.keep_creation_request();

-- Legacy/missing profile recovery uses auth.uid(), never a supplied user ID.
create function public.ensure_profile() returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare v_profile public.profiles; v_username text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform 1 from auth.users where id=auth.uid() for update;
  if not found then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into v_profile from public.profiles where id=auth.uid();
  if found then
    if not exists(select 1 from public.public_profiles where id=auth.uid()) then
      -- Invoke the existing trusted synchronization trigger; no extra public fields.
      update public.profiles set username=username where id=auth.uid() returning * into v_profile;
    end if;
    return v_profile;
  end if;
  -- Recovery has a collision-resistant placeholder; setup asks for a valid username.
  v_username := 'user_' || pg_catalog.replace(auth.uid()::text,'-','');
  insert into public.profiles(id,username) values(auth.uid(),v_username) returning * into v_profile;
  return v_profile;
end;
$$;

create function public.save_onboarding(p_username text,p_photo_url text,p_location_text text,
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
    if v_item is null or (v_item <> all(array['Yard Work','Moving Help','Cleaning','Handyman','Delivery','Pet Care','Tech Help','Other'])
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

create function public.create_gig(p_request_id uuid,p_service_type text,p_title text,
  p_description text,p_amount numeric,p_price_type text,p_scheduled_at timestamptz,
  p_location_text text,p_lat double precision,p_lng double precision,
  p_photo_url text default null,p_publish boolean default true)
returns public.gigs language plpgsql security definer set search_path = '' as $$
declare v_gig public.gigs;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_request_id is null then raise exception 'Missing creation request.' using errcode='22023'; end if;
  -- Serializes retries per account and orders creation after profile setup.
  perform 1 from public.profiles where id=auth.uid() and onboarding_completed_at is not null for update;
  if not found then raise exception 'Finish your profile setup before posting.' using errcode='22023'; end if;
  select * into v_gig from public.gigs where poster_id=auth.uid() and creation_request_id=p_request_id;
  if found then return v_gig; end if;
  if p_service_type is null or p_service_type <> all(array['Yard Work','Moving Help','Cleaning','Handyman','Delivery','Pet Care','Tech Help','Other']) then
    raise exception 'Choose a valid service type.' using errcode='22023'; end if;
  if p_title is null or pg_catalog.length(pg_catalog.btrim(p_title)) not between 1 and 120 then
    raise exception 'Enter a title of 1–120 characters.' using errcode='22023'; end if;
  if p_description is null or pg_catalog.length(pg_catalog.btrim(p_description)) not between 1 and 280 then
    raise exception 'Enter a description of 1–280 characters.' using errcode='22023'; end if;
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
  insert into public.gigs(poster_id,creation_request_id,service_type,title,description,
    amount,price_type,scheduled_at,location_text,lat,lng,photo_url,status)
  values(auth.uid(),p_request_id,p_service_type,pg_catalog.btrim(p_title),pg_catalog.btrim(p_description),
    p_amount,'fixed',p_scheduled_at,pg_catalog.btrim(p_location_text),
    pg_catalog.round(p_lat::numeric,2)::double precision,pg_catalog.round(p_lng::numeric,2)::double precision,
    p_photo_url,case when p_publish then 'active'::public.gig_status else 'draft'::public.gig_status end)
  returning * into v_gig;
  return v_gig;
end;
$$;

-- Make creation authoritative without loosening any existing RLS policy.
revoke insert on public.gigs from public,anon,authenticated;
-- New private/setup fields receive no client UPDATE grants. save_onboarding owns them.
revoke execute on function public.ensure_profile(),
  public.save_onboarding(text,text,text,double precision,double precision,jsonb,jsonb),
  public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean)
  from public,anon,authenticated;
grant execute on function public.ensure_profile(),
  public.save_onboarding(text,text,text,double precision,double precision,jsonb,jsonb),
  public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean)
  to authenticated;
commit;
