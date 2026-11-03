-- ESG-CAN-001 v1.0 (Provider Withdraw/Exit) and ESG-CAN-002 v1.0 (Poster Remove Provider).
--
-- Three gaps against the existing lifecycle, confirmed by reading 0019/0022/0023/0024 in full:
--   * withdraw_before_start(): the provider could already withdraw once the poster had delayed the
--     start (withdraw_from_gig, 0022) or once a start request had gone fully unanswered through both
--     waits (withdraw_unanswered, 0023 -- that path alone carries the poster's Lemon and must stay the
--     only way to withdraw once that silence threshold is reached). There was no way to withdraw in
--     between: right after being selected, before ever requesting a start, or while the poster still has
--     time to answer. This fills exactly that gap, reusing the same reopen-if-other-offers-pending /
--     cancel-otherwise shape as its siblings, and is blocked the moment the unanswered-silence window
--     opens so it can never be used to dodge the Lemon.
--   * exit_gig(): did not exist at all. The provider had COMPLETE/INCOMPLETE once In Progress, but no way
--     to leave an engagement outright without pretending the work was finished or claiming it was not
--     completed. Requires a reason first (unable to locate the poster, a safety concern, or another
--     reason with a mandatory comment) -- "the poster asked me to leave" and "I can't finish the work"
--     are deliberately not options; the first isn't an approved reason and the second is INCOMPLETE's job.
--     Always reopens the gig to 'active' (never cancels it outright, per spec, even with no other offers
--     left -- the poster already has a working Cancel Gig for that). No Lemon/Rotten Tomato.
--   * remove_helper(): already covered every poster-side pre-start state (selected, start-requested,
--     delayed) and reopened/cancelled correctly, but took no reason at all. Now requires one.
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

create type public.exit_reason as enum ('unable_to_locate_poster', 'safety_concern', 'other');

-- ---------------------------------------------------------------------------
-- withdraw_before_start(): the provider withdraws before a start request has
-- gone unanswered long enough to carry a Lemon, and before the poster has
-- delayed it (withdraw_from_gig already covers that case).
-- ---------------------------------------------------------------------------
create function public.withdraw_before_start(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c_wait constant interval := interval '24 hours';
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
  if v_gig.status <> 'active' or v_gig.start_delayed_at is not null then
    raise exception 'You can only withdraw here before the start is requested or while the poster still has time to answer.';
  end if;
  if v_gig.start_requested_at is not null and pg_catalog.now() >= v_gig.start_requested_at + c_wait then
    raise exception 'The poster has had a while to answer; wait or withdraw from the start request screen instead.';
  end if;

  -- Closed for good: a withdrawn claim is never reopened, so this provider cannot claim the gig again.
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
-- exit_gig(): the selected provider leaves an In Progress engagement outright,
-- separate from COMPLETE/INCOMPLETE. Always returns the gig to 'active'.
-- ---------------------------------------------------------------------------
create function public.exit_gig(p_gig_id uuid, p_reason public.exit_reason, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_name text;
  v_comment text;
  v_reason_text text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.selected_provider_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'in_progress' then
    raise exception 'You can only exit a gig that is in progress.';
  end if;

  v_comment := nullif(pg_catalog.btrim(p_comment), '');
  if p_reason = 'other' and v_comment is null then
    raise exception 'Enter a reason to exit.' using errcode = '22023';
  end if;
  if v_comment is not null and pg_catalog.char_length(v_comment) > 500 then
    raise exception 'Keep your reason to 500 characters or fewer.' using errcode = '22023';
  end if;

  update public.claims set state = 'withdrawn' where gig_id = p_gig_id and provider_id = auth.uid() and state = 'selected';

  -- Chat and proposals are cleared the same way a pre-start reopen already clears them: the gig is
  -- open to a new provider again, who should never inherit the previous one's conversation.
  delete from public.chat_messages where gig_id = p_gig_id;
  delete from public.price_proposals where gig_id = p_gig_id;
  update public.gigs set
    status = 'active',
    selected_provider_id = null,
    agreed_amount = null,
    start_requested_at = null,
    start_delayed_at = null,
    start_wait_count = 0,
    start_wait_until = null,
    helper_withdrawn_at = pg_catalog.now()
  where id = p_gig_id;

  v_reason_text := case p_reason
    when 'unable_to_locate_poster' then 'couldn''t locate you'
    when 'safety_concern' then 'had a safety concern'
    else 'exited'
  end;
  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(v_gig.poster_id, p_gig_id, 'helper_exited',
    '@' || coalesce(v_name, 'Your helper') || ' ' || v_reason_text || ' and exited "' || v_gig.title || '".' ||
    case when v_comment is not null then ' "' || v_comment || '"' else '' end ||
    ' The gig is open to new offers again.');
end;
$$;

-- ---------------------------------------------------------------------------
-- remove_helper(): as 0024, now with a mandatory reason.
-- ---------------------------------------------------------------------------
drop function if exists public.remove_helper(uuid);

create function public.remove_helper(p_gig_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_helper uuid;
  v_reopen boolean;
  v_reason text;
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

-- Authenticated users only; never anon or PUBLIC.
revoke execute on function public.withdraw_before_start(uuid), public.exit_gig(uuid, public.exit_reason, text),
  public.remove_helper(uuid, text) from public, anon, authenticated;
grant execute on function public.withdraw_before_start(uuid), public.exit_gig(uuid, public.exit_reason, text),
  public.remove_helper(uuid, text) to authenticated;

commit;
