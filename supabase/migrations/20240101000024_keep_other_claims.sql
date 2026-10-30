-- Keep the other offers when the poster picks a helper.
--
-- Until now select_provider() turned every other pending offer into 'rejected' the moment one helper was
-- chosen. Now the other offers stay 'pending' until the gig is over:
--   * select_provider():       identical to 0019 except it no longer rejects the other pending offers.
--   * close_pending_claims():  when a gig becomes completed, incomplete or cancelled, any offer still
--                              pending is closed as 'rejected' (an AFTER UPDATE OF status trigger).
--   * If the chosen helper leaves before the gig starts (withdraw_from_gig after a delay, withdraw_unanswered
--     after the poster stayed silent, remove_helper), the gig REOPENS (active, no helper) when other offers
--     are still pending, so the poster can pick from them. With none left it closes as cancelled exactly as
--     before. These three functions are replaced here (0022 and 0023 are otherwise unchanged).
--   * A reopened gig starts clean for the next helper: the previous helper's chat messages and price
--     proposals are deleted, because the next helper would otherwise be able to read them (the chat is
--     visible to whoever is the selected helper) and would inherit the used negotiation rounds.
-- Pending offers do not give anyone the private address or the chat: only the selected helper has those.
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
-- select_provider(): as 0019, but the other pending offers are kept.
-- ---------------------------------------------------------------------------
create or replace function public.select_provider(p_gig_id uuid, p_claim_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_claim public.claims;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.selected_provider_id is not null then
    raise exception 'Provider already selected';
  end if;
  if v_gig.status <> 'active' then
    raise exception 'Gig is not in a selectable state';
  end if;

  select * into v_claim from public.claims
  where id = p_claim_id and gig_id = p_gig_id and state = 'pending';
  if not found then
    raise exception 'Claim not found or not actionable';
  end if;
  if v_gig.requested_helper_id is not null and v_claim.provider_id is distinct from v_gig.requested_helper_id then
    raise exception 'Claim not found or not actionable';
  end if;
  if exists (select 1 from public.claims where gig_id = p_gig_id and state = 'selected') then
    raise exception 'Gig has an inconsistent selected claim; review existing data';
  end if;

  update public.claims set state = 'selected' where id = p_claim_id;
  update public.gigs set selected_provider_id = v_claim.provider_id, agreed_amount = v_claim.offer_amount where id = p_gig_id;
  -- The exact address is deliberately NOT part of the notification.
  perform public.notify(v_claim.provider_id, p_gig_id, 'selected',
    'Your offer for "' || v_gig.title || '" was accepted.');
end;
$$;

-- ---------------------------------------------------------------------------
-- close_pending_claims(): the offers that were kept end with the gig.
-- ---------------------------------------------------------------------------
create function public.close_pending_claims() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.claims set state = 'rejected' where gig_id = new.id and state = 'pending';
  return new;
end;
$$;
revoke execute on function public.close_pending_claims() from public, anon, authenticated;

create trigger gigs_close_pending_claims
after update of status on public.gigs
for each row
when (new.status in ('completed', 'incomplete', 'cancelled') and old.status is distinct from new.status)
execute function public.close_pending_claims();

-- ---------------------------------------------------------------------------
-- withdraw_from_gig(): as 0022; reopens the gig when other offers are still pending.
-- ---------------------------------------------------------------------------
create or replace function public.withdraw_from_gig(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_name text;
  v_reopen boolean;
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

  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(v_gig.poster_id, p_gig_id, 'helper_withdrew',
    '@' || coalesce(v_name, 'Your helper') || ' withdrew from "' || v_gig.title || '". ' ||
    case when v_reopen then 'Other offers are still open, so you can choose another helper.' else 'You can post it again for everyone.' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- withdraw_unanswered(): as 0023; reopens the gig when other offers are still pending.
-- The poster still gets the lemon.
-- ---------------------------------------------------------------------------
create or replace function public.withdraw_unanswered(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c_max_waits constant smallint := 2;
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
  if v_gig.status <> 'active' or v_gig.start_requested_at is null or v_gig.start_delayed_at is not null then
    raise exception 'There is no unanswered start request to withdraw from.';
  end if;
  if v_gig.start_wait_count < c_max_waits or v_gig.start_wait_until is null or pg_catalog.now() < v_gig.start_wait_until then
    raise exception 'You can withdraw after you have waited twice and the second wait has ended.';
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
    '@' || coalesce(v_name, 'Your helper') || ' withdrew from "' || v_gig.title || '" because the start request was not answered. You received a lemon.' ||
    case when v_reopen then ' Other offers are still open, so you can choose another helper.' else '' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- remove_helper(): as 0023; reopens the gig when other offers are still pending.
-- ---------------------------------------------------------------------------
create or replace function public.remove_helper(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_helper uuid;
  v_reopen boolean;
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
    'The poster removed you from "' || v_gig.title || '" before it started.');
end;
$$;

commit;
