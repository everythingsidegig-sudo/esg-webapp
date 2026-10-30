-- When the poster does not answer a start request, and removing a helper before the start.
--
-- Unanswered start request (the helper asked to start; the poster neither approved nor delayed):
--   * wait_for_start():       the app suggests waiting. After 24 hours of silence the helper may "wait
--                             again" for another 24 hours, at most twice. Each wait tells the poster.
--   * withdraw_unanswered():  once both waits have run out and the poster still has not answered, the
--                             helper may withdraw. The helper's claim is closed for good, the helper is
--                             removed (and loses the private address), the gig closes as cancelled and
--                             the POSTER GETS A LEMON (one feedback row, counted in profiles.lemon_count,
--                             exactly as a lemon given after a finished gig is).
--   Withdrawing after the poster DELAYED the start (migration 0022) is a different path: the poster did
--   answer, so that withdrawal costs the poster nothing.
-- Removing a helper:
--   * remove_helper():        the poster may remove the selected helper any time before the gig starts
--                             (active, helper selected; also while a start request is waiting). The
--                             helper's claim is closed, the helper is removed and told, and the gig
--                             closes as cancelled with helper_removed_at set; the poster can then post it
--                             again for everyone (Repost). Removing costs the poster nothing.
-- The wait length (24 hours) and number of waits (2) are the constants c_wait and c_max_waits below.
-- No existing function is replaced.
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
  add column start_wait_count smallint not null default 0 check (start_wait_count between 0 and 2),
  add column start_wait_until timestamptz,
  add column helper_removed_at timestamptz;

-- ---------------------------------------------------------------------------
-- wait_for_start(): the helper chooses to keep waiting for an unanswered start request.
-- ---------------------------------------------------------------------------
create function public.wait_for_start(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c_wait constant interval := interval '24 hours';
  c_max_waits constant smallint := 2;
  v_gig public.gigs;
  v_ready timestamptz;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.selected_provider_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' or v_gig.start_requested_at is null or v_gig.start_delayed_at is not null then
    raise exception 'There is no unanswered start request to wait for.';
  end if;
  if v_gig.start_wait_count >= c_max_waits then
    raise exception 'You have already waited twice. You can withdraw when the second wait ends.';
  end if;
  v_ready := coalesce(v_gig.start_wait_until, v_gig.start_requested_at + c_wait);
  if pg_catalog.now() < v_ready then
    raise exception 'The poster still has time to answer. You can wait again later.';
  end if;

  update public.gigs set start_wait_count = start_wait_count + 1, start_wait_until = pg_catalog.now() + c_wait where id = p_gig_id;
  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(v_gig.poster_id, p_gig_id, 'start_reminder',
    '@' || coalesce(v_name, 'Your helper') || ' is still waiting for you to answer the start request for "' || v_gig.title || '".');
end;
$$;

-- ---------------------------------------------------------------------------
-- withdraw_unanswered(): the helper leaves after the poster stayed silent through both waits.
-- ---------------------------------------------------------------------------
create function public.withdraw_unanswered(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c_max_waits constant smallint := 2;
  v_gig public.gigs;
  v_name text;
  v_feedback uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.selected_provider_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' or v_gig.start_requested_at is null or v_gig.start_delayed_at is not null then
    raise exception 'There is no unanswered start request to withdraw from.';
  end if;
  if v_gig.start_wait_count < c_max_waits or v_gig.start_wait_until is null or pg_catalog.now() < v_gig.start_wait_until then
    raise exception 'You can withdraw after you have waited twice and the second wait has ended.';
  end if;

  update public.claims set state = 'withdrawn' where gig_id = p_gig_id and provider_id = auth.uid() and state = 'selected';
  update public.gigs set
    status = 'cancelled',
    selected_provider_id = null,
    agreed_amount = null,
    start_requested_at = null,
    start_delayed_at = null,
    start_wait_count = 0,
    start_wait_until = null,
    helper_withdrawn_at = pg_catalog.now()
  where id = p_gig_id;

  -- The poster's lemon: the same feedback row and counter a lemon after a finished gig uses. One per
  -- gig and giver (the table's unique key), so it can never be counted twice.
  insert into public.feedback (gig_id, from_id, to_id, type)
  values (p_gig_id, auth.uid(), v_gig.poster_id, 'lemon')
  on conflict (gig_id, from_id) do nothing
  returning id into v_feedback;
  if found then
    update public.profiles set lemon_count = lemon_count + 1 where id = v_gig.poster_id;
  end if;

  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(v_gig.poster_id, p_gig_id, 'helper_withdrew',
    '@' || coalesce(v_name, 'Your helper') || ' withdrew from "' || v_gig.title || '" because the start request was not answered. You received a lemon.');
end;
$$;

-- ---------------------------------------------------------------------------
-- remove_helper(): the poster removes the selected helper before the gig starts.
-- ---------------------------------------------------------------------------
create function public.remove_helper(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_helper uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' or v_gig.selected_provider_id is null then
    raise exception 'You can only remove a helper before the gig starts.';
  end if;

  v_helper := v_gig.selected_provider_id;
  -- Rejected, not withdrawn: the helper did not choose this, and it is never reopened for them.
  update public.claims set state = 'rejected' where gig_id = p_gig_id and provider_id = v_helper and state = 'selected';
  update public.gigs set
    status = 'cancelled',
    selected_provider_id = null,
    agreed_amount = null,
    start_requested_at = null,
    start_delayed_at = null,
    start_wait_count = 0,
    start_wait_until = null,
    helper_removed_at = pg_catalog.now()
  where id = p_gig_id;

  perform public.notify(v_helper, p_gig_id, 'helper_removed',
    'The poster removed you from "' || v_gig.title || '" before it started.');
end;
$$;

-- Authenticated users only; never anon or PUBLIC.
revoke execute on function public.wait_for_start(uuid), public.withdraw_unanswered(uuid), public.remove_helper(uuid) from public, anon, authenticated;
grant execute on function public.wait_for_start(uuid), public.withdraw_unanswered(uuid), public.remove_helper(uuid) to authenticated;

commit;
