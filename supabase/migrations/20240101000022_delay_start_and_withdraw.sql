-- Delay a start request, and let the helper withdraw while it is delayed.
--
-- Today the helper asks to start (request_start) and the poster approves (approve_start). This adds a
-- third answer for the poster and a way out for the helper:
--   * delay_start():       the poster answers a start request with "not yet". Only the poster, only
--                          while a start request is waiting and has not been delayed already. The gig
--                          stays active with the same helper; the poster can still approve the start
--                          afterwards with the existing approve_start().
--   * withdraw_from_gig(): while the start is delayed, the helper may withdraw. The helper's claim is
--                          closed (withdrawn, so they cannot claim the same gig again), the helper is
--                          removed from the gig (so they lose access to its private address) and the
--                          gig ends as 'cancelled' with helper_withdrawn_at set. It is NOT reopened
--                          publicly by itself: the poster chooses what happens next, and "post it
--                          publicly" is the existing Repost, which creates a new public gig.
-- No existing function is replaced. The new columns are only ever written by these functions.
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

alter table public.gigs
  add column start_delayed_at timestamptz,
  add column helper_withdrawn_at timestamptz;

-- ---------------------------------------------------------------------------
-- delay_start(): the poster answers a start request with "not yet".
-- ---------------------------------------------------------------------------
create function public.delay_start(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' or v_gig.selected_provider_id is null or v_gig.start_requested_at is null then
    raise exception 'There is no start request to delay.';
  end if;
  if v_gig.start_delayed_at is not null then
    raise exception 'You already delayed this start request.';
  end if;

  update public.gigs set start_delayed_at = pg_catalog.now() where id = p_gig_id;
  perform public.notify(v_gig.selected_provider_id, p_gig_id, 'start_delayed',
    'The start of "' || v_gig.title || '" was delayed. You can wait or withdraw.');
end;
$$;

-- ---------------------------------------------------------------------------
-- withdraw_from_gig(): the helper leaves while the start is delayed.
-- ---------------------------------------------------------------------------
create function public.withdraw_from_gig(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.selected_provider_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' or v_gig.start_delayed_at is null then
    raise exception 'You can only withdraw while the poster has delayed the start.';
  end if;

  -- Closed for good: a withdrawn claim is never reopened, so this helper cannot claim the gig again.
  update public.claims set state = 'withdrawn' where gig_id = p_gig_id and provider_id = auth.uid() and state = 'selected';
  update public.gigs set
    status = 'cancelled',
    selected_provider_id = null,
    agreed_amount = null,
    start_requested_at = null,
    start_delayed_at = null,
    helper_withdrawn_at = pg_catalog.now()
  where id = p_gig_id;

  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(v_gig.poster_id, p_gig_id, 'helper_withdrew',
    '@' || coalesce(v_name, 'Your helper') || ' withdrew from "' || v_gig.title || '". You can post it again for everyone.');
end;
$$;

-- Authenticated users only; never anon or PUBLIC.
revoke execute on function public.delay_start(uuid), public.withdraw_from_gig(uuid) from public, anon, authenticated;
grant execute on function public.delay_start(uuid), public.withdraw_from_gig(uuid) to authenticated;

commit;
