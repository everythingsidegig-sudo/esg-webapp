-- Limit delaying a start to two, with a lemon for a poster who keeps the helper waiting after that.
--
-- Product decision. Until now a poster could delay a start once and (since migration 0031) again each
-- time the helper asked to start again, with no end. Now:
--   * The poster can delay a start at most TWICE (gigs.start_delay_count). After the first delay the
--     helper can still ask to start again; after the second they cannot (resubmit_start).
--   * After the second delay the poster owes an answer. The poster receives a LEMON -- the same feedback
--     row and counter withdraw_unanswered() already uses for a silent poster, one per gig and giver --
--     if they REMOVE the helper (remove_helper), or if 24 hours pass without an answer and the helper
--     withdraws for that reason (withdraw_after_second_delay). The helper can still withdraw at any time
--     with withdraw_from_gig(), which carries no lemon.
--   * The count resets whenever the selected helper changes, so a new helper starts at zero.
-- "Rotten Tomato" in the product notes is not a separate score anywhere in the app; the lemon is the
-- existing penalty, so it is what is used here.
-- delay_start, resubmit_start and remove_helper are redefined from their current bodies with only the
-- additions above; their signatures and grants are unchanged.
begin;

alter table public.gigs
  add column start_delay_count smallint not null default 0 check (start_delay_count between 0 and 2);
-- A start that is already delayed has used one delay.
update public.gigs set start_delay_count = 1 where start_delayed_at is not null;

create function public.reset_start_delay_count() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.selected_provider_id is distinct from old.selected_provider_id then
    new.start_delay_count := 0;
  end if;
  return new;
end;
$$;
revoke execute on function public.reset_start_delay_count() from public, anon, authenticated;
create trigger gigs_reset_start_delay_count before update of selected_provider_id on public.gigs
  for each row execute function public.reset_start_delay_count();

create or replace function public.delay_start(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c_max_delays constant smallint := 2;
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
  if v_gig.start_delay_count >= c_max_delays then
    raise exception 'You have already delayed this start twice. Accept it or remove your helper.' using errcode = '22023';
  end if;

  update public.gigs set start_delayed_at = pg_catalog.now(), start_delay_count = start_delay_count + 1 where id = p_gig_id;
  perform public.notify(v_gig.selected_provider_id, p_gig_id, 'start_delayed',
    'The start of "' || v_gig.title || '" was delayed. You can wait or withdraw.');
end;
$$;

create or replace function public.resubmit_start(p_gig_id uuid) returns void
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
  if v_gig.status <> 'active' or v_gig.start_requested_at is null or v_gig.start_delayed_at is null then
    raise exception 'There is no delayed start to ask for again.';
  end if;
  if v_gig.start_delay_count >= 2 then
    raise exception 'The start was delayed twice, so it cannot be requested again. You can wait or withdraw.' using errcode = '22023';
  end if;

  update public.gigs set
    start_requested_at = pg_catalog.now(),
    start_delayed_at = null,
    start_wait_count = 0,
    start_wait_until = null
  where id = p_gig_id;

  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(v_gig.poster_id, p_gig_id, 'start_requested',
    '@' || coalesce(v_name, 'Your helper') || ' asked to start "' || v_gig.title || '" again.');
end;
$$;

create or replace function public.remove_helper(p_gig_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_helper uuid;
  v_reopen boolean;
  v_reason text;
  v_feedback uuid;
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

  v_reason := nullif(pg_catalog.btrim(p_reason), '');
  if v_reason is null then
    raise exception 'Enter a reason to remove this helper.' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_reason) > 500 then
    raise exception 'Keep your reason to 500 characters or fewer.' using errcode = '22023';
  end if;

  v_helper := v_gig.selected_provider_id;
  -- Rejected, not withdrawn: the helper did not choose this, and it is never reopened for them.
  update public.claims set state = 'rejected' where gig_id = p_gig_id and provider_id = v_helper and state = 'selected';
  -- Removing the helper after delaying the start twice carries the poster's lemon: the same feedback
  -- row and counter withdraw_unanswered() uses, one per gig and giver, so it is never counted twice.
  if v_gig.start_delayed_at is not null and v_gig.start_delay_count >= 2 then
    insert into public.feedback (gig_id, from_id, to_id, type)
    values (p_gig_id, v_helper, v_gig.poster_id, 'lemon')
    on conflict (gig_id, from_id) do nothing
    returning id into v_feedback;
    if found then
      update public.profiles set lemon_count = lemon_count + 1 where id = v_gig.poster_id;
    end if;
  end if;
  v_reopen := exists (select 1 from public.claims where gig_id = p_gig_id and state = 'pending');
  if v_reopen then
    delete from public.chat_messages where gig_id = p_gig_id;
    delete from public.price_proposals where gig_id = p_gig_id;
  end if;
  update public.gigs set
    status = (case when v_reopen then 'active' else 'cancelled' end)::public.gig_status,
    selected_provider_id = null,
    agreed_amount = null,
    start_requested_at = null,
    start_delayed_at = null,
    start_wait_count = 0,
    start_wait_until = null,
    helper_removed_at = case when v_reopen then null else pg_catalog.now() end
  where id = p_gig_id;

  perform public.notify(v_helper, p_gig_id, 'helper_removed',
    'The poster removed you from "' || v_gig.title || '": ' || v_reason);
end;
$$;

create function public.withdraw_after_second_delay(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c_wait constant interval := interval '24 hours';
  v_gig public.gigs;
  v_name text;
  v_feedback uuid;
  v_reopen boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.selected_provider_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' or v_gig.start_delayed_at is null or v_gig.start_delay_count < 2 then
    raise exception 'This only applies after the poster has delayed the start twice.';
  end if;
  if pg_catalog.now() < v_gig.start_delayed_at + c_wait then
    raise exception 'The poster still has time to answer the second delay.';
  end if;

  update public.claims set state = 'withdrawn' where gig_id = p_gig_id and provider_id = auth.uid() and state = 'selected';
  v_reopen := exists (select 1 from public.claims where gig_id = p_gig_id and state = 'pending');
  if v_reopen then
    delete from public.chat_messages where gig_id = p_gig_id;
    delete from public.price_proposals where gig_id = p_gig_id;
  end if;
  update public.gigs set
    status = (case when v_reopen then 'active' else 'cancelled' end)::public.gig_status,
    selected_provider_id = null,
    agreed_amount = null,
    start_requested_at = null,
    start_delayed_at = null,
    start_wait_count = 0,
    start_wait_until = null,
    helper_withdrawn_at = case when v_reopen then null else pg_catalog.now() end
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
    '@' || coalesce(v_name, 'Your helper') || ' withdrew from "' || v_gig.title || '" because you did not answer after the second delay. You received a lemon.' ||
    case when v_reopen then ' Other offers are still open, so you can choose another helper.' else '' end);
end;
$$;

-- Authenticated users only; never anon or PUBLIC.
revoke execute on function public.withdraw_after_second_delay(uuid) from public, anon, authenticated;
grant execute on function public.withdraw_after_second_delay(uuid) to authenticated;

commit;
