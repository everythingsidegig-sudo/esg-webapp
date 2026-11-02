-- ESG-FDBK-001 v1.0 / ESG-COMP-002 v1.2: an optional comment alongside WOM/Lemon/Skip.
--
-- Everything else about submit_feedback (one submission per gig per participant, first
-- submission wins including over an opposite retry, WOM/Lemon counters, Rotten Tomato never
-- user-selectable) is unchanged from 0003_lifecycle_integrity.sql; this only adds the comment.
begin;

alter table public.feedback add column comment text;

drop function if exists public.submit_feedback(uuid, public.feedback_type);

create function public.submit_feedback(p_gig_id uuid, p_type public.feedback_type, p_comment text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_to_id uuid;
  v_feedback_id uuid;
  v_comment text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or (auth.uid() is distinct from v_gig.poster_id
    and auth.uid() is distinct from v_gig.selected_provider_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status not in ('completed', 'incomplete') then
    raise exception 'Gig is not resolved yet';
  end if;

  v_comment := nullif(pg_catalog.btrim(p_comment), '');
  if v_comment is not null and pg_catalog.char_length(v_comment) > 500 then
    raise exception 'Keep your comment to 500 characters or fewer.' using errcode = '22023';
  end if;

  v_to_id := case when auth.uid() = v_gig.poster_id
    then v_gig.selected_provider_id else v_gig.poster_id end;
  insert into public.feedback (gig_id, from_id, to_id, type, comment)
  values (p_gig_id, auth.uid(), v_to_id, p_type, v_comment)
  on conflict (gig_id, from_id) do nothing
  returning id into v_feedback_id;
  if not found then
    -- First submission wins, including skip; opposite retries are no-op success.
    return;
  end if;

  if p_type = 'wom' then
    update public.profiles set wom_count = wom_count + 1 where id = v_to_id;
  elsif p_type = 'lemon' then
    update public.profiles set lemon_count = lemon_count + 1 where id = v_to_id;
  end if;
end;
$$;

revoke execute on function public.submit_feedback(uuid, public.feedback_type, text) from public, anon, authenticated;
grant execute on function public.submit_feedback(uuid, public.feedback_type, text) to authenticated;

commit;
