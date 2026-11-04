-- Find Help, Gig Saving & Provider Profile Swiping v1.0.
--
-- "Save & Find Helpers Nearby" validates and saves a gig as non-public (status
-- 'saved_non_public', added in 20240101000028) instead of publishing it, then the poster
-- swipes through matching provider profiles. A right swipe sends that same saved gig to the
-- provider as a direct_requests row -- a NEW junction table, not an extension of the existing
-- gigs.requested_helper_id column (20240101000019), because that column only ever addresses a
-- gig to ONE helper and this spec explicitly wants one gig fanned out to many providers.
--
-- Everything downstream of acceptance is untouched: accept_direct_request only ever sets
-- gigs.status/selected_provider_id/agreed_amount, exactly what select_provider already does, and
-- every lifecycle RPC after that point (request_start, approve_start, submit_completion, ...)
-- keys off those same gigs columns, never off claims -- so a direct-request-accepted gig needs no
-- claims row and behaves as an ordinary accepted gig from that point on (chat, start approval,
-- completion, WOM feedback, My Gigs sections, StatusBadge all already read gigs.status/
-- selected_provider_id, not how the provider was selected).
--
-- Remaining pending/interested requests on a gig are NOT closed out the moment the poster
-- accepts one (matching the fallback convention 20240101000024 established for claims, and
-- matching this spec's own status table in section 11, which ties request status CLOSED to the
-- Completion event, not to "poster accepts one"): a parallel trigger closes them when the gig
-- finally resolves, mirroring close_pending_claims exactly.
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
-- 1. direct_requests: one row per (gig, provider) a saved gig was sent to.
--    "Prevent duplicate ACTIVE requests" (spec section 8) is looser than claims' permanent
--    unique(gig_id, provider_id): the unique index only covers pending/interested, so a
--    declined request can be re-sent later (a new row), which the spec's own wording allows
--    and claims' one-row-ever rule does not.
-- ---------------------------------------------------------------------------
create type public.direct_request_state as enum ('pending', 'interested', 'declined', 'accepted', 'closed');

create table public.direct_requests (
  id uuid primary key default gen_random_uuid(),
  gig_id uuid not null references public.gigs(id) on delete cascade,
  poster_id uuid not null references public.profiles(id),
  provider_id uuid not null references public.profiles(id),
  state public.direct_request_state not null default 'pending',
  created_at timestamptz not null default now()
);
create unique index direct_requests_active_unique on public.direct_requests (gig_id, provider_id)
  where state in ('pending', 'interested');
create index on public.direct_requests (gig_id);
create index on public.direct_requests (provider_id);

alter table public.direct_requests enable row level security;
create policy "direct_requests_select" on public.direct_requests for select to authenticated using (
  poster_id = auth.uid() or provider_id = auth.uid()
);
revoke all on table public.direct_requests from public, anon, authenticated;
grant select on table public.direct_requests to authenticated;

alter publication supabase_realtime add table public.direct_requests;

-- ---------------------------------------------------------------------------
-- 2. send_direct_request(): the poster swipes right on a provider. Reuses
--    esg_private.assert_requestable_helper (0019) for eligibility (not self, onboarding
--    complete, not banned/deleted, offers the service) and esg_private.is_blocked (0027) --
--    closing the exact gap 0027's own header comment flagged for the old single-recipient
--    feature, which this new table must not repeat.
-- ---------------------------------------------------------------------------
create function public.send_direct_request(p_gig_id uuid, p_provider_id uuid) returns public.direct_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_row public.direct_requests;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'saved_non_public' or v_gig.selected_provider_id is not null then
    raise exception 'This gig is no longer open for new requests.';
  end if;
  if esg_private.is_blocked(auth.uid(), p_provider_id) then
    raise exception 'That provider isn''t available for requests.' using errcode = '22023';
  end if;
  perform esg_private.assert_requestable_helper(p_provider_id, auth.uid(), v_gig.service_type);

  insert into public.direct_requests (gig_id, poster_id, provider_id, state)
  values (p_gig_id, auth.uid(), p_provider_id, 'pending')
  on conflict (gig_id, provider_id) where state in ('pending', 'interested') do nothing
  returning * into v_row;
  if not found then
    -- Retry-safe, same shape as create_claim: a resend while one is already active just
    -- returns the existing row instead of erroring or creating a second one.
    select * into v_row from public.direct_requests
    where gig_id = p_gig_id and provider_id = p_provider_id and state in ('pending', 'interested')
    order by created_at desc limit 1;
    return v_row;
  end if;

  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(p_provider_id, p_gig_id, 'direct_request',
    '@' || coalesce(v_name, 'Someone') || ' sent you a gig: "' || v_gig.title || '".');
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. respond_direct_request(): the provider marks Interested or Declined. Mirrors
--    decline_gig_request's "tell the poster either way" convention; does not touch the gig
--    itself -- only the poster's explicit accept_direct_request call can select a provider.
-- ---------------------------------------------------------------------------
create function public.respond_direct_request(p_request_id uuid, p_interested boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.direct_requests;
  v_gig public.gigs;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_row from public.direct_requests where id = p_request_id for update;
  if not found or v_row.provider_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_row.state <> 'pending' then
    raise exception 'This request has already been answered.';
  end if;

  update public.direct_requests set state = (case when p_interested then 'interested' else 'declined' end)::public.direct_request_state
  where id = p_request_id;

  select * into v_gig from public.gigs where id = v_row.gig_id;
  select username into v_name from public.public_profiles where id = auth.uid();
  if p_interested then
    perform public.notify(v_row.poster_id, v_row.gig_id, 'direct_request_interested',
      '@' || coalesce(v_name, 'A helper') || ' is interested in "' || v_gig.title || '".');
  else
    perform public.notify(v_row.poster_id, v_row.gig_id, 'direct_request_declined',
      '@' || coalesce(v_name, 'A helper') || ' declined "' || v_gig.title || '".');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. accept_direct_request(): the poster picks exactly one provider. Only ever writes
--    gigs.status/selected_provider_id/agreed_amount -- no claims row -- because every
--    lifecycle RPC after selection already keys off those gigs columns alone.
-- ---------------------------------------------------------------------------
create function public.accept_direct_request(p_request_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.direct_requests;
  v_gig public.gigs;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_row from public.direct_requests where id = p_request_id for update;
  if not found or v_row.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_row.state not in ('pending', 'interested') then
    raise exception 'This request can no longer be accepted.';
  end if;

  select * into v_gig from public.gigs where id = v_row.gig_id for update;
  if not found or v_gig.status <> 'saved_non_public' or v_gig.selected_provider_id is not null then
    raise exception 'This gig is no longer open for selection.';
  end if;

  update public.direct_requests set state = 'accepted' where id = p_request_id;
  update public.gigs set status = 'active', selected_provider_id = v_row.provider_id, agreed_amount = v_gig.amount
  where id = v_gig.id;

  perform public.notify(v_row.provider_id, v_gig.id, 'selected',
    'You were selected for "' || v_gig.title || '". Chat is now open.');
end;
$$;

revoke execute on function
  public.send_direct_request(uuid, uuid),
  public.respond_direct_request(uuid, boolean),
  public.accept_direct_request(uuid)
  from public, anon, authenticated;
grant execute on function
  public.send_direct_request(uuid, uuid),
  public.respond_direct_request(uuid, boolean),
  public.accept_direct_request(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. close_pending_direct_requests(): same shape and trigger event as close_pending_claims
--    (20240101000024) -- fires once per gig, when it finally resolves.
-- ---------------------------------------------------------------------------
create function public.close_pending_direct_requests() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.direct_requests set state = 'closed' where gig_id = new.id and state in ('pending', 'interested');
  return new;
end;
$$;
revoke execute on function public.close_pending_direct_requests() from public, anon, authenticated;

create trigger gigs_close_pending_direct_requests
after update of status on public.gigs
for each row
when (new.status in ('completed', 'incomplete', 'cancelled') and old.status is distinct from new.status)
execute function public.close_pending_direct_requests();

-- ---------------------------------------------------------------------------
-- 6. cancel_gig(): a saved-non-public gig can now be cancelled too (My Gigs: "cancel as
--    allowed"); the trigger above then closes its outstanding direct requests. Same single-arg
--    signature as 0019's version, so CREATE OR REPLACE keeps its existing grants.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_gig(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_notify_helper boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status not in ('active', 'saved_non_public') or v_gig.selected_provider_id is not null then
    raise exception 'Gig cannot be cancelled in its current state';
  end if;
  v_notify_helper := v_gig.requested_helper_id is not null and not exists (
    select 1 from public.claims
    where gig_id = p_gig_id and provider_id = v_gig.requested_helper_id and state in ('withdrawn', 'rejected')
  );
  update public.gigs set status = 'cancelled' where id = p_gig_id;
  update public.claims set state = 'rejected' where gig_id = p_gig_id and state = 'pending';
  if v_notify_helper then
    perform public.notify(v_gig.requested_helper_id, p_gig_id, 'request_withdrawn',
      'The request "' || v_gig.title || '" was cancelled.');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. gigs_update_own_draft_or_active_edit: a poster can edit a saved-non-public gig's own
--    fields directly, the same pre-selection client-write path drafts/actives already use.
-- ---------------------------------------------------------------------------
drop policy "gigs_update_own_draft_or_active_edit" on public.gigs;
create policy "gigs_update_own_draft_or_active_edit" on public.gigs for update using (
  poster_id = auth.uid() and status in ('draft', 'active', 'saved_non_public') and selected_provider_id is null
) with check (
  poster_id = auth.uid() and status in ('draft', 'active', 'saved_non_public') and selected_provider_id is null
);

-- ---------------------------------------------------------------------------
-- 8. gigs_select_participants / gig_tags_select_participants: a provider with a direct
--    request can read the gig it's attached to -- required for My Gigs' own
--    direct_requests.select("*, gig:gigs(*)") embed to return anything at all (PostgREST
--    embeds are RLS-gated on the embedded table too), and incidentally lets them open the
--    gig page directly as well, the same way a claimant already can on a public gig.
-- ---------------------------------------------------------------------------
drop policy gigs_select_participants on public.gigs;
create policy gigs_select_participants on public.gigs for select to authenticated using (
  poster_id = auth.uid()
  or selected_provider_id = auth.uid()
  or esg_private.has_own_claim(id)
  or (requested_helper_id = auth.uid() and status <> 'draft')
  or exists (select 1 from public.direct_requests dr where dr.gig_id = gigs.id and dr.provider_id = auth.uid())
);

drop policy gig_tags_select_participants on public.gig_tags;
create policy gig_tags_select_participants on public.gig_tags for select to authenticated using (
  exists (
    select 1 from public.gigs g
    where g.id = gig_tags.gig_id
      and (g.poster_id = auth.uid() or g.selected_provider_id = auth.uid() or esg_private.has_own_claim(g.id)
           or (g.requested_helper_id = auth.uid() and g.status <> 'draft')
           or exists (select 1 from public.direct_requests dr where dr.gig_id = g.id and dr.provider_id = auth.uid()))
  )
);

-- ---------------------------------------------------------------------------
-- 9. create_gig(): one more trailing default argument changes the function's identity
--    (same reason 0019 dropped the 14-argument overload rather than leaving it callable), so
--    the 15-argument version is dropped here, not left behind.
-- ---------------------------------------------------------------------------
drop function public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[],text,uuid);

create function public.create_gig(p_request_id uuid,p_service_type text,p_title text,
  p_description text,p_amount numeric,p_price_type text,p_scheduled_at timestamptz,
  p_location_text text,p_lat double precision,p_lng double precision,
  p_photo_url text default null,p_publish boolean default true,p_tag_ids uuid[] default '{}'::uuid[],
  p_private_address text default null,p_requested_helper_id uuid default null,p_find_helpers boolean default false)
returns public.gigs language plpgsql security definer set search_path = '' as $$
declare v_gig public.gigs; v_tag_ids uuid[]; v_address text; v_name text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_request_id is null then raise exception 'Missing creation request.' using errcode='22023'; end if;
  perform 1 from public.profiles where id=auth.uid() and onboarding_completed_at is not null for update;
  if not found then raise exception 'Finish your profile setup before posting.' using errcode='22023'; end if;
  select * into v_gig from public.gigs where poster_id=auth.uid() and creation_request_id=p_request_id;
  if found then return v_gig; end if;
  if p_service_type is null or p_service_type <> all(array[
      'Moving Help','Cleaning','Handyman','Furniture Assembly','Yard Work','Delivery / Pickup',
      'Errands','Auto Help','Tech Help','Pet Care','Cooking / Catering','Tutoring','Event Help','Other'
    ]) then
    raise exception 'Choose a valid service type.' using errcode='22023'; end if;
  if p_title is null or pg_catalog.length(pg_catalog.btrim(p_title)) not between 1 and 120 then
    raise exception 'Enter a title of 1–120 characters.' using errcode='22023'; end if;
  if p_description is null or pg_catalog.length(pg_catalog.btrim(p_description)) not between 1 and 50 then
    raise exception 'Enter a description of 1–50 characters.' using errcode='22023'; end if;
  if p_amount is null or not (p_amount>0 and p_amount<=9999999999.99) or p_amount<>pg_catalog.round(p_amount,2) then
    raise exception 'Enter a positive amount with at most two decimal places.' using errcode='22023'; end if;
  if p_price_type is distinct from 'fixed'
     and (p_requested_helper_id is null or p_price_type is distinct from 'negotiable') then
    raise exception 'This POC supports fixed-price gigs only.' using errcode='22023'; end if;
  if p_publish is null or p_find_helpers is null or ((p_publish or p_find_helpers) and p_scheduled_at is null)
    or (p_scheduled_at is not null and (not pg_catalog.isfinite(p_scheduled_at) or p_scheduled_at<=pg_catalog.now())) then
    raise exception 'Pick a future date/time before posting.' using errcode='22023'; end if;
  if p_location_text is null or pg_catalog.length(pg_catalog.btrim(p_location_text)) not between 1 and 200 then
    raise exception 'Enter a general area of 1–200 characters.' using errcode='22023'; end if;
  if (p_lat is null) <> (p_lng is null) or (p_lat is not null and
    (not (p_lat between -90 and 90) or not (p_lng between -180 and 180))) then
    raise exception 'Invalid location coordinates.' using errcode='22023'; end if;
  if p_photo_url is not null and (pg_catalog.length(p_photo_url)>2048 or p_photo_url !~ '^https?://') then
    raise exception 'Invalid photo URL.' using errcode='22023'; end if;
  v_address := nullif(pg_catalog.btrim(p_private_address), '');
  if v_address is not null and pg_catalog.length(v_address) > 300 then
    raise exception 'Enter a private address of at most 300 characters.' using errcode='22023'; end if;
  v_tag_ids := coalesce(
    (select pg_catalog.array_agg(distinct picked) from pg_catalog.unnest(p_tag_ids) as picked),
    array[]::uuid[]
  );
  if pg_catalog.array_length(v_tag_ids,1) > 8 then
    raise exception 'Choose at most 8 tags.' using errcode='22023'; end if;
  if exists (
    select 1 from pg_catalog.unnest(v_tag_ids) as picked
    where not exists (select 1 from public.tags tg where tg.id = picked and tg.service_type = p_service_type)
  ) then
    raise exception 'Choose tags that exist and match the selected category.' using errcode='22023'; end if;
  if p_requested_helper_id is not null then
    perform esg_private.assert_requestable_helper(p_requested_helper_id, auth.uid(), p_service_type);
  end if;
  insert into public.gigs(poster_id,creation_request_id,service_type,title,description,
    amount,price_type,scheduled_at,location_text,lat,lng,photo_url,status,requested_helper_id)
  values(auth.uid(),p_request_id,p_service_type,pg_catalog.btrim(p_title),pg_catalog.btrim(p_description),
    p_amount,p_price_type::public.price_type,p_scheduled_at,pg_catalog.btrim(p_location_text),
    pg_catalog.round(p_lat::numeric,2)::double precision,pg_catalog.round(p_lng::numeric,2)::double precision,
    p_photo_url,
    case when p_find_helpers then 'saved_non_public'::public.gig_status
         when p_publish then 'active'::public.gig_status
         else 'draft'::public.gig_status end,
    p_requested_helper_id)
  returning * into v_gig;
  insert into public.gig_tags (gig_id, tag_id)
  select v_gig.id, picked from pg_catalog.unnest(v_tag_ids) as picked
  on conflict do nothing;
  if v_address is not null then
    insert into public.gig_private_locations (gig_id, address_text) values (v_gig.id, v_address);
  end if;
  if p_requested_helper_id is not null and v_gig.status = 'active' then
    select username into v_name from public.public_profiles where id = auth.uid();
    perform public.notify(p_requested_helper_id, v_gig.id, 'gig_request',
      '@' || coalesce(v_name, 'Someone') || ' sent you a request: "' || v_gig.title || '".');
  end if;
  return v_gig;
end;
$$;

revoke execute on function
  public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[],text,uuid,boolean)
  from public, anon, authenticated;
grant execute on function
  public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[],text,uuid,boolean)
  to authenticated;

commit;
