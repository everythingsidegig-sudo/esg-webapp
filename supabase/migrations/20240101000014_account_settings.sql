-- ESG-SET-002 v1.0: Account Information (the only Account Settings spec that
-- actually exists -- SET-001 itself is still "to be defined", see
-- CONSOLIDATED_SPEC.md / the plan notes). Adds the optional phone number
-- column SET-002 §3/§10 requires, and extends the existing direct-write
-- validation trigger to cover it, reusing the same pattern as username/
-- photo_url/skills/services rather than adding a new RPC. Email changes are
-- NOT handled here -- `supabase.auth.updateUser({ email })` already runs
-- Supabase Auth's own secure-email-change (OTP-verified) flow; there is
-- nothing for this schema to validate or store.
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

alter table public.profiles add column phone text;
alter table public.profiles add constraint profiles_phone_format check (phone is null or phone ~ '^[0-9]{10}$');

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

  -- ESG-SET-002 §10: optional; 10 US digits once formatting characters are
  -- stripped client-side (this column only ever stores the stripped form).
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

  return new;
end;
$$;

-- phone joins the set of directly-writable columns the trigger now guards.
drop trigger if exists trg_validate_profile_edit on public.profiles;
create trigger trg_validate_profile_edit
before update of username, photo_url, phone, skills, services on public.profiles
for each row execute function esg_private.validate_profile_edit();

commit;
