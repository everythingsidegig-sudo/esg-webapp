-- Let the helper ask to start again after the poster delayed the start.
--
-- Until now a delayed start was a dead end for the helper: wait, or withdraw. This adds
--   * resubmit_start(): only the selected helper, only while the start is delayed. It clears the delay
--                       and opens a fresh start request, so the poster again sees "Accept start" and
--                       "Delay start" (delay_start() works again because start_delayed_at is null).
-- The unanswered-request clock is restarted with the new request (the same reset every other
-- start-flow function performs). No existing function is replaced, and no limit or penalty on the
-- number of delays is added here: that is an open product decision.
begin;

create function public.resubmit_start(p_gig_id uuid) returns void
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

-- Authenticated users only; never anon or PUBLIC.
revoke execute on function public.resubmit_start(uuid) from public, anon, authenticated;
grant execute on function public.resubmit_start(uuid) to authenticated;

commit;
