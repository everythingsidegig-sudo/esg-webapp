-- Phase 2C: direct-write hardening. Closes two grant-level bypasses found in
-- the Phase 1/2A/2B security audit. No RLS policy, RPC, storage policy, or
-- frontend change; existing lifecycle RPCs are SECURITY DEFINER and run as
-- their trusted owner, so neither change below affects them.
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
-- 1. profiles: username/photo_url/skills/services stay directly writable by
--    `authenticated` (src/app/profile/page.tsx genuinely needs this for
--    routine profile editing, separate from the onboarding wizard), but a
--    direct write previously skipped save_onboarding()'s validation entirely.
--    Enforce the same rules at the table level so no path — client or RPC —
--    can store an invalid value. The trigger only inspects a column when that
--    column is actually changing, so unrelated writes (wom_count/lemon_count/
--    money_made by trusted RPCs, or ensure_profile()'s no-op
--    `username = username` repair touch) are never affected.
-- ---------------------------------------------------------------------------
create function esg_private.validate_profile_edit() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_item text;
begin
  if new.username is distinct from old.username then
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
      if v_item is null or (v_item <> all(array['Yard Work','Moving Help','Cleaning','Handyman','Delivery','Pet Care','Tech Help','Other'])
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
revoke execute on function esg_private.validate_profile_edit() from public, anon, authenticated;

create trigger trg_validate_profile_edit
before update of username, photo_url, skills, services on public.profiles
for each row execute function esg_private.validate_profile_edit();

-- ---------------------------------------------------------------------------
-- 2. gigs: 0002 narrowed profiles/chat_messages/notifications' UPDATE grants
--    but never touched gigs, leaving the platform-default table-level UPDATE
--    grant in place. No frontend code issues a direct `.update()` on gigs —
--    every mutation (create_gig, publish_gig, cancel_gig, select_provider,
--    request_start, approve_start, submit_completion, submit_incomplete_choice,
--    submit_payment_amount, submit_feedback) goes through a SECURITY DEFINER
--    RPC that validates input and runs as its trusted owner. Revoke both the
--    table-level grant and any pre-existing column-level UPDATE grants
--    entirely: zero columns are genuinely needed for direct client writes
--    today. The existing gigs_update_own_draft_or_active_edit RLS policy is
--    left in place, unchanged, for a future "edit draft" feature — at that
--    point a later migration would grant back only the specific columns it
--    needs, the same way this one is scoped.
-- ---------------------------------------------------------------------------
do $$
declare
  v_columns text;
begin
  select pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' order by a.attnum)
  into v_columns
  from pg_catalog.pg_attribute a
  where a.attrelid = pg_catalog.to_regclass('public.gigs')
    and a.attnum > 0 and not a.attisdropped;
  execute 'revoke update on table public.gigs from public, anon, authenticated';
  execute pg_catalog.format(
    'revoke update (%s) on table public.gigs from public, anon, authenticated', v_columns
  );
end;
$$;

commit;
