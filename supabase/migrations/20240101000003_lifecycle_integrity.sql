-- Phase 2A only: one-time provider selection, claim retries, feedback retries.
-- Apply after 0002. No historical rows/counters are silently repaired.
begin;

do $$
begin
  if exists (
    select 1 from public.claims where state = 'selected'
    group by gig_id having count(*) > 1
  ) then
    raise exception 'Multiple selected claims exist: review affected gigs before applying 0003';
  end if;
end;
$$;

-- Enforce the invariant even for writers outside the RPC path. The preflight
-- above reports incompatible historical data instead of choosing a winner.
create unique index claims_one_selected_per_gig
  on public.claims (gig_id) where state = 'selected';

create or replace function public.create_claim(p_gig_id uuid) returns public.claims
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_claim public.claims;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- All three commands lock the same parent row before touching child rows.
  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found then
    raise exception 'Gig not found';
  end if;
  if v_gig.poster_id is not distinct from auth.uid() then
    raise exception 'You cannot claim your own gig';
  end if;

  select * into v_claim from public.claims
  where gig_id = p_gig_id and provider_id = auth.uid();
  if found then
    -- Includes selected/rejected/withdrawn and closed-gig retries. Returning an
    -- existing record never reopens a claim or changes its state/timestamp.
    return v_claim;
  end if;

  if v_gig.status <> 'active' or v_gig.selected_provider_id is not null then
    raise exception 'Gig is not open for claims';
  end if;

  insert into public.claims (gig_id, provider_id, state)
  values (p_gig_id, auth.uid(), 'pending')
  on conflict (gig_id, provider_id) do nothing
  returning * into v_claim;
  if not found then
    -- Defense against an insert by another trusted writer: no duplicate event.
    select * into v_claim from public.claims
    where gig_id = p_gig_id and provider_id = auth.uid();
    return v_claim;
  end if;

  perform public.notify(v_gig.poster_id, p_gig_id, 'claim_received',
    'You have a new claim on "' || v_gig.title || '"');
  return v_claim;
end;
$$;

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
  -- Deliberately a controlled error for both identical and different retries.
  -- The frontend's existing error handler accepts this unchanged void contract.
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
  if exists (select 1 from public.claims where gig_id = p_gig_id and state = 'selected') then
    raise exception 'Gig has an inconsistent selected claim; review existing data';
  end if;

  update public.claims set state = 'selected' where id = p_claim_id;
  update public.gigs set selected_provider_id = v_claim.provider_id where id = p_gig_id;
  perform public.notify(v_claim.provider_id, p_gig_id, 'selected',
    'You were selected for "' || v_gig.title || '". Chat is now open.');
end;
$$;

create or replace function public.submit_feedback(p_gig_id uuid, p_type public.feedback_type) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_to_id uuid;
  v_feedback_id uuid;
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

  v_to_id := case when auth.uid() = v_gig.poster_id
    then v_gig.selected_provider_id else v_gig.poster_id end;
  insert into public.feedback (gig_id, from_id, to_id, type)
  values (p_gig_id, auth.uid(), v_to_id, p_type)
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

-- CREATE OR REPLACE preserves ACLs, but state the Phase 1 boundary explicitly.
revoke execute on function public.create_claim(uuid), public.select_provider(uuid, uuid),
  public.submit_feedback(uuid, public.feedback_type) from public, anon, authenticated;
grant execute on function public.create_claim(uuid), public.select_provider(uuid, uuid),
  public.submit_feedback(uuid, public.feedback_type) to authenticated;

commit;
