-- Let a saved draft be sent to "Find Helpers Nearby", not only published.
--
-- A draft could only go one way: publish_gig() makes it public. "Save & Find Helpers Nearby" only
-- existed at creation time (create_gig(p_find_helpers => true)). This adds the same step for an
-- existing draft, so its owner is offered both options:
--   * find_helpers_for_gig(): draft -> saved_non_public. Only the poster, only a draft with no helper
--     selected, and only an ordinary public gig (a private request to one named helper already has
--     its own addressed flow). It needs a future date, exactly like create_gig() does before it
--     publishes or starts finding helpers.
-- No existing function is replaced.
begin;

create function public.find_helpers_for_gig(p_gig_id uuid) returns void
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
  if v_gig.status <> 'draft' or v_gig.selected_provider_id is not null then
    raise exception 'Gig is not a draft';
  end if;
  if v_gig.requested_helper_id is not null then
    raise exception 'A private request is sent to its helper, not searched for.' using errcode = '22023';
  end if;
  if v_gig.scheduled_at is null or not pg_catalog.isfinite(v_gig.scheduled_at) or v_gig.scheduled_at <= pg_catalog.now() then
    raise exception 'Pick a future date/time before finding helpers.' using errcode = '22023';
  end if;

  update public.gigs set status = 'saved_non_public' where id = p_gig_id;
end;
$$;

-- Authenticated users only; never anon or PUBLIC.
revoke execute on function public.find_helpers_for_gig(uuid) from public, anon, authenticated;
grant execute on function public.find_helpers_for_gig(uuid) to authenticated;

commit;
