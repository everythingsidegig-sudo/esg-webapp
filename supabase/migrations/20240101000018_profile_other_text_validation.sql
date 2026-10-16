-- ESG-SVC-001 v1.0 §5: OTHER's "please specify" text is mandatory exactly
-- while OTHER is selected. complete_registration() already enforces this at
-- account creation, but direct profile writes (My Profile's Save) never did
-- -- a client could select OTHER and save with no text, or clear the text
-- while leaving OTHER selected. Extends validate_profile_edit() to the same
-- rule, and watches skills_other_text/services_other_text directly so an
-- edit to just the text (no skills/services change) is still validated.
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

create or replace function esg_private.validate_profile_edit() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_item text;
begin
  if pg_catalog.current_setting('esg.bypass_profile_validation', true) = 'on' then
    return new;
  end if;

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

  if new.phone is distinct from old.phone then
    if new.phone is not null and new.phone !~ '^[0-9]{10}$' then
      raise exception 'Enter a 10-digit phone number.' using errcode = '22023';
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

  if new.skills is distinct from old.skills or new.skills_other_text is distinct from old.skills_other_text then
    if (new.skills ? 'Other') <> (new.skills_other_text is not null and pg_catalog.length(pg_catalog.btrim(new.skills_other_text)) > 0) then
      raise exception 'Specify your OTHER skill, or remove OTHER from Skills I can use to make money.' using errcode = '22023';
    end if;
  end if;
  if new.services is distinct from old.services or new.services_other_text is distinct from old.services_other_text then
    if (new.services ? 'Other') <> (new.services_other_text is not null and pg_catalog.length(pg_catalog.btrim(new.services_other_text)) > 0) then
      raise exception 'Specify your OTHER service, or remove OTHER from Services I might need.' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_profile_edit on public.profiles;
create trigger trg_validate_profile_edit
before update of username, photo_url, phone, skills, services, skills_other_text, services_other_text on public.profiles
for each row execute function esg_private.validate_profile_edit();

-- Deletion's anonymization step should scrub this free text too -- it can
-- contain personal information the same way a username or photo can.
create or replace function public.delete_own_account()
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_has_history boolean;
  v_blocked boolean;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;

  select not eligible into v_blocked from public.check_deletion_eligibility();
  if v_blocked then
    raise exception 'You have Gigs that need attention. Resolve any active Gigs, incomplete Gig activity, or open Disputes before deleting your account.'
      using errcode = '22023';
  end if;

  select exists (
    select 1 from public.gigs where poster_id = v_uid or selected_provider_id = v_uid
    union all
    select 1 from public.claims where provider_id = v_uid
    union all
    select 1 from public.chat_messages where sender_id = v_uid
    union all
    select 1 from public.gig_completions where user_id = v_uid
    union all
    select 1 from public.gig_incomplete_choices where user_id = v_uid
    union all
    select 1 from public.feedback where from_id = v_uid or to_id = v_uid
    union all
    select 1 from public.notifications where recipient_id = v_uid
  ) into v_has_history;

  if v_has_history then
    perform pg_catalog.set_config('esg.bypass_profile_validation', 'on', true);
    update public.profiles set
      username = 'deleted' || pg_catalog.substr(v_uid::text, 1, 8),
      photo_url = null,
      skills = '[]'::jsonb,
      services = '[]'::jsonb,
      skills_other_text = null,
      services_other_text = null,
      private_location_text = null,
      private_lat = null,
      private_lng = null,
      public_location_text = null,
      public_lat = null,
      public_lng = null
      where id = v_uid;
    delete from public.profile_tags where profile_id = v_uid;
  end if;

  return v_has_history;
end;
$$;

commit;
