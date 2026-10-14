-- ESG-AUTH-002 v0.5: rebuild Registration around its approved screen
-- sequence (email verification link FIRST, then Username, Password,
-- mandatory Photo, optional Phone, Skills/Services with ALL+OTHER, Terms,
-- Account Created -> Home). The app's existing /onboarding + ProfileSetup
-- wizard (save_onboarding()) is left untouched as a fallback recovery path
-- for an account that was created but never finished this new flow (see the
-- plan notes on BR-REG-006's "abandoned registration" gap) -- it is not
-- deleted, just no longer the primary path for a new signup.
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

alter table public.profiles add column terms_accepted_at timestamptz;
-- AUTH-002 v0.5 §5/§11: OTHER's mandatory "please specify" text has no home
-- in the existing schema (skills/services only ever stored approved category
-- names). Independent per list, since the two lists operate independently.
alter table public.profiles add column skills_other_text text;
alter table public.profiles add column services_other_text text;

-- ---------------------------------------------------------------------------
-- email_registered(): lets the Registration Email screen show "This email is
-- already registered" (BR-REG-002) before sending anything, without a
-- service-role key or admin API call -- a SECURITY DEFINER function owned by
-- the migration role can read auth.users directly; anon/authenticated never
-- gets a grant on that table otherwise.
-- ---------------------------------------------------------------------------
create function public.email_registered(p_email text) returns boolean
language sql security definer set search_path = '' stable as $$
  select exists (select 1 from auth.users where lower(email) = lower(p_email));
$$;
revoke execute on function public.email_registered(text) from public, authenticated;
grant execute on function public.email_registered(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- complete_registration(): the single commit at CREATE ACCOUNT (screen 10).
-- Password is set separately via supabase.auth.updateUser() (Auth-side, not
-- this schema's concern) at the Password screen, before this runs. Email
-- verification already happened (this function requires an authenticated
-- caller, which only exists post-verification). Profile Photo is mandatory
-- here (BR-REG-009); Phone and Skills/Services remain optional (BR-REG-010,
-- BR-REG-011). Reuses ensure_profile()'s placeholder-row bootstrap and the
-- same approved 14-item category list as save_onboarding()/create_gig().
-- ---------------------------------------------------------------------------
create function public.complete_registration(
  p_username text, p_photo_url text, p_phone text,
  p_skills jsonb, p_services jsonb, p_skills_other text, p_services_other text,
  p_terms_accepted boolean
) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_profile public.profiles;
  v_item text;
  v_phone text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform public.ensure_profile();
  select * into v_profile from public.profiles where id = auth.uid() for update;

  if p_username is null or p_username !~ '^[A-Za-z0-9]{6,40}$' then
    raise exception 'Username must be 6–40 letters/numbers.' using errcode = '22023';
  end if;
  if p_photo_url is null or pg_catalog.length(p_photo_url) > 2048 or p_photo_url !~ '^https?://' then
    raise exception 'Profile Photo is mandatory.' using errcode = '22023';
  end if;

  v_phone := nullif(pg_catalog.btrim(coalesce(p_phone, '')), '');
  if v_phone is not null and v_phone !~ '^[0-9]{10}$' then
    raise exception 'Enter a 10-digit phone number.' using errcode = '22023';
  end if;

  if p_skills is null or p_services is null or pg_catalog.jsonb_typeof(p_skills) <> 'array'
      or pg_catalog.jsonb_typeof(p_services) <> 'array' then
    raise exception 'Choose skills and services from the available categories.' using errcode = '22023';
  end if;
  for v_item in select pg_catalog.jsonb_array_elements_text(p_skills || p_services) loop
    if v_item is null or v_item <> all(array[
        'Moving Help','Cleaning','Handyman','Furniture Assembly','Yard Work','Delivery / Pickup',
        'Errands','Auto Help','Tech Help','Pet Care','Cooking / Catering','Tutoring','Event Help','Other'
      ]) then
      raise exception 'Choose skills and services from the available categories.' using errcode = '22023';
    end if;
  end loop;
  if pg_catalog.jsonb_array_length(p_skills) <> (select count(distinct item) from pg_catalog.jsonb_array_elements_text(p_skills) as entries(item))
      or pg_catalog.jsonb_array_length(p_services) <> (select count(distinct item) from pg_catalog.jsonb_array_elements_text(p_services) as entries(item)) then
    raise exception 'Choose each category at most once.' using errcode = '22023';
  end if;

  -- BR-REG-016/017: OTHER's text field is mandatory exactly while OTHER is selected.
  if (p_skills ? 'Other') <> (p_skills_other is not null and pg_catalog.length(pg_catalog.btrim(p_skills_other)) > 0) then
    raise exception 'Specify your OTHER skill, or remove OTHER from Skills I Can Offer.' using errcode = '22023';
  end if;
  if (p_services ? 'Other') <> (p_services_other is not null and pg_catalog.length(pg_catalog.btrim(p_services_other)) > 0) then
    raise exception 'Specify your OTHER service, or remove OTHER from Services I Am Interested In.' using errcode = '22023';
  end if;

  if p_terms_accepted is not true then
    raise exception 'Terms & Privacy acceptance is required.' using errcode = '22023';
  end if;

  update public.profiles set
    username = p_username,
    photo_url = p_photo_url,
    phone = v_phone,
    skills = p_skills,
    services = p_services,
    skills_other_text = nullif(pg_catalog.btrim(coalesce(p_skills_other, '')), ''),
    services_other_text = nullif(pg_catalog.btrim(coalesce(p_services_other, '')), ''),
    terms_accepted_at = coalesce(terms_accepted_at, pg_catalog.now()),
    onboarding_completed_at = coalesce(onboarding_completed_at, pg_catalog.now())
    where id = auth.uid()
    returning * into v_profile;

  return v_profile;
end;
$$;
revoke execute on function public.complete_registration(text,text,text,jsonb,jsonb,text,text,boolean) from public, anon, authenticated;
grant execute on function public.complete_registration(text,text,text,jsonb,jsonb,text,text,boolean) to authenticated;

commit;
