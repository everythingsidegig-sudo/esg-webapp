-- Put a gig back on the public list after its helper left, without re-entering it.
--
-- When the helper withdraws or is removed and nobody else has a waiting offer, the gig ends as
-- 'cancelled' and the poster's only way forward was to re-create it through the whole posting form.
-- When other offers are waiting the same gig is already reopened as 'active' (migrations 0024/0026);
-- this gives the remaining case the same outcome on request:
--   * reopen_gig_publicly(): poster only, only a cancelled gig whose helper withdrew or was removed
--     and whose date is still in the future (a past date must be re-entered through the form).
--     It does exactly what the automatic reopen does -- clears the helper, the agreed price and the
--     start state, deletes the old conversation and price proposals -- and also drops any private
--     request address so the gig is visible to everyone. The helper who left keeps their closed claim,
--     so they cannot claim it again.
-- No existing function is replaced.
begin;

create function public.reopen_gig_publicly(p_gig_id uuid) returns void
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
  if v_gig.status <> 'cancelled' or v_gig.selected_provider_id is not null
     or (v_gig.helper_removed_at is null and v_gig.helper_withdrawn_at is null) then
    raise exception 'Only a gig whose helper left can be posted again this way.';
  end if;
  if v_gig.scheduled_at is null or not pg_catalog.isfinite(v_gig.scheduled_at) or v_gig.scheduled_at <= pg_catalog.now() then
    raise exception 'Pick a future date/time before posting.' using errcode = '22023';
  end if;

  delete from public.chat_messages where gig_id = p_gig_id;
  delete from public.price_proposals where gig_id = p_gig_id;
  update public.gigs set
    status = 'active',
    requested_helper_id = null,
    selected_provider_id = null,
    agreed_amount = null,
    start_requested_at = null,
    start_delayed_at = null,
    start_wait_count = 0,
    start_wait_until = null,
    helper_removed_at = null,
    helper_withdrawn_at = null
  where id = p_gig_id;
end;
$$;

-- Authenticated users only; never anon or PUBLIC.
revoke execute on function public.reopen_gig_publicly(uuid) from public, anon, authenticated;
grant execute on function public.reopen_gig_publicly(uuid) to authenticated;

commit;
