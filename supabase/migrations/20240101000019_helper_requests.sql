-- Helper-targeted gig requests ("Post a gig for this helper").
--
-- A request is an ordinary gig that is addressed to ONE helper instead of being
-- public. No new status, table or messaging/notification system is added:
--
--   request pending ........ gig active, unassigned, requested_helper_id = H,
--                            and H has NO claim yet
--   H counteroffers ........ H's claim is 'pending' with its own offer_amount
--                            (the existing offer; the poster accepts it with
--                            select_provider, exactly like a public offer)
--   H accepts the price .... accept_gig_request(): claim 'selected',
--                            selected_provider_id = H, agreed_amount = budget
--   H declines ............. H's claim is 'withdrawn' (a closed-out request);
--                            the gig stays active and private
--   poster reposts / moves . reassign_gig_request(): publicly (target cleared)
--                            or to another helper; H's pending offer is
--                            'rejected'
--   poster cancels ......... cancel_gig() as before
--
-- A claim can never be reopened (create_claim returns an existing row
-- unchanged, 0010), so a helper who declined cannot offer on that gig again.
-- Public gigs and the public offer flow are unchanged: every new rule below is
-- guarded by requested_helper_id IS NOT NULL.
--
-- The exact address needs no change: gig_private_locations (0010) is readable
-- only by the poster and by selected_provider_id, which stays NULL until
-- accept_gig_request() or select_provider() assigns the helper.
--
-- BASELINE: this migration is written against origin/main's schema, i.e.
-- 0001-0018 (0011 approved 13-category taxonomy + 50-character description
-- limit, 0012/0016 deletion eligibility + username-lock bypass, 0014/0015
-- profile validation, 0018 free-text scrubbing on deletion). The two functions
-- it has to restate from that baseline, create_gig() and delete_own_account(),
-- are copies of the CURRENT bodies from 0011 and 0018 plus only the request
-- additions. The other replaced functions
-- (publish_gig, create_claim, withdraw_claim, select_provider, cancel_gig) were
-- last changed in 0002/0003/0010 and are identical on the hosted project.
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
-- 1. gigs.requested_helper_id. The foreign key keeps its default NO ACTION on
--    purpose: deleting a requested helper must never silently turn a private
--    request public (delete_own_account is updated below to anonymize instead).
-- ---------------------------------------------------------------------------
alter table public.gigs add column requested_helper_id uuid references public.profiles(id);
alter table public.gigs
  add constraint gigs_requested_helper_not_poster check (requested_helper_id is null or requested_helper_id <> poster_id);
-- A request can only ever be assigned to the helper it is addressed to. Public gigs
-- (requested_helper_id null) and requests that were made public again are unaffected.
alter table public.gigs
  add constraint gigs_selected_matches_requested check (
    selected_provider_id is null or requested_helper_id is null or selected_provider_id = requested_helper_id
  );
create index gigs_requested_helper_idx on public.gigs (requested_helper_id) where requested_helper_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Helper eligibility, enforced in the database (never in the UI alone).
--    Callers are SECURITY DEFINER RPCs; clients cannot execute this directly.
-- ---------------------------------------------------------------------------
create function esg_private.assert_requestable_helper(p_helper uuid, p_poster uuid, p_service text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_profile public.profiles;
  v_banned timestamptz;
begin
  if p_helper is not distinct from p_poster then
    raise exception 'You cannot send a request to yourself.' using errcode = '22023';
  end if;
  select * into v_profile from public.profiles where id = p_helper;
  if not found or v_profile.onboarding_completed_at is null or v_profile.username ~ '^deleted[0-9a-f]{8}$' then
    raise exception 'That helper isn''t available for requests.' using errcode = '22023';
  end if;
  select u.banned_until into v_banned from auth.users u where u.id = p_helper;
  if v_banned is not null and v_banned > pg_catalog.now() then
    raise exception 'That helper isn''t available for requests.' using errcode = '22023';
  end if;
  if not (v_profile.skills @> pg_catalog.jsonb_build_array(p_service)) then
    raise exception 'That helper doesn''t offer this category.' using errcode = '22023';
  end if;
end;
$$;
revoke all on function esg_private.assert_requestable_helper(uuid, uuid, text) from public, anon, authenticated;

-- True when an account can no longer take part in a gig: anonymized by
-- delete_own_account() or locked (banned). Missing accounts count as unavailable.
create function esg_private.account_unavailable(p_uid uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_username text;
  v_banned timestamptz;
begin
  select username into v_username from public.profiles where id = p_uid;
  if not found or v_username ~ '^deleted[0-9a-f]{8}$' then
    return true;
  end if;
  select u.banned_until into v_banned from auth.users u where u.id = p_uid;
  return v_banned is not null and v_banned > pg_catalog.now();
end;
$$;
revoke all on function esg_private.account_unavailable(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Visibility. A requested gig is never public: not in Browse, not to other
--    helpers, and its tags follow the gig. The requested helper sees it once it
--    is live (not while it is still the poster's draft). While tightening the
--    tag policies, also stop exposing tags of already-assigned gigs, matching
--    what gigs_select has hidden since 0010.
-- ---------------------------------------------------------------------------
drop policy gigs_select on public.gigs;
create policy gigs_select on public.gigs for select to anon, authenticated using (
  status = 'active' and selected_provider_id is null and requested_helper_id is null
);
drop policy gigs_select_participants on public.gigs;
create policy gigs_select_participants on public.gigs for select to authenticated using (
  poster_id = auth.uid()
  or selected_provider_id = auth.uid()
  or esg_private.has_own_claim(id)
  or (requested_helper_id = auth.uid() and status <> 'draft')
);

drop policy gig_tags_select_public on public.gig_tags;
create policy gig_tags_select_public on public.gig_tags for select to anon, authenticated using (
  exists (
    select 1 from public.gigs g
    where g.id = gig_tags.gig_id and g.status = 'active' and g.selected_provider_id is null and g.requested_helper_id is null
  )
);
drop policy gig_tags_select_participants on public.gig_tags;
create policy gig_tags_select_participants on public.gig_tags for select to authenticated using (
  exists (
    select 1 from public.gigs g
    where g.id = gig_tags.gig_id
      and (g.poster_id = auth.uid() or g.selected_provider_id = auth.uid() or esg_private.has_own_claim(g.id)
           or (g.requested_helper_id = auth.uid() and g.status <> 'draft'))
  )
);

-- ---------------------------------------------------------------------------
-- 4. create_gig(): optional requested helper. A new argument changes the
--    function identity, so the 14-argument overload is dropped, not left
--    callable. Fixed or negotiable pricing is accepted ONLY for a request;
--    public gigs stay fixed-price exactly as before.
-- ---------------------------------------------------------------------------
drop function public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[],text);

create function public.create_gig(p_request_id uuid,p_service_type text,p_title text,
  p_description text,p_amount numeric,p_price_type text,p_scheduled_at timestamptz,
  p_location_text text,p_lat double precision,p_lng double precision,
  p_photo_url text default null,p_publish boolean default true,p_tag_ids uuid[] default '{}'::uuid[],
  p_private_address text default null,p_requested_helper_id uuid default null)
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
  if p_publish is null or (p_publish and p_scheduled_at is null)
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
    p_photo_url,case when p_publish then 'active'::public.gig_status else 'draft'::public.gig_status end,
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

-- ---------------------------------------------------------------------------
-- 5. publish_gig(): a requested draft re-checks its helper and notifies them
--    when it goes live. Public drafts behave exactly as before.
-- ---------------------------------------------------------------------------
create or replace function public.publish_gig(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'draft' then
    raise exception 'Gig is not a draft';
  end if;
  if v_gig.requested_helper_id is not null then
    perform esg_private.assert_requestable_helper(v_gig.requested_helper_id, v_gig.poster_id, v_gig.service_type);
  end if;
  update public.gigs set status = 'active' where id = p_gig_id;
  if v_gig.requested_helper_id is not null then
    select username into v_name from public.public_profiles where id = auth.uid();
    perform public.notify(v_gig.requested_helper_id, p_gig_id, 'gig_request',
      '@' || coalesce(v_name, 'Someone') || ' sent you a request: "' || v_gig.title || '".');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. create_claim(): on a request only the requested helper may offer, and only
--    when the poster allowed negotiation. A fixed-price request is answered
--    with accept_gig_request / decline_gig_request. Everything else (public
--    gigs, retries, withdrawn offers staying closed) is unchanged from 0010.
-- ---------------------------------------------------------------------------
create or replace function public.create_claim(p_gig_id uuid, p_offer_amount numeric default null, p_message text default null)
returns public.claims language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_claim public.claims;
  v_amount numeric;
  v_message text;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

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
    -- Retries return the existing offer unchanged (never reopened or edited).
    return v_claim;
  end if;

  if v_gig.status <> 'active' or v_gig.selected_provider_id is not null then
    raise exception 'Gig is not open for claims';
  end if;
  if v_gig.requested_helper_id is not null then
    if v_gig.requested_helper_id is distinct from auth.uid() then
      -- Same message as any closed gig: other helpers learn nothing about the request.
      raise exception 'Gig is not open for claims';
    end if;
    if v_gig.price_type <> 'negotiable' then
      raise exception 'This request has a fixed price. Accept or decline it instead of making an offer.';
    end if;
  end if;

  v_amount := coalesce(p_offer_amount, v_gig.amount);
  if not (v_amount > 0 and v_amount <= 9999999999.99) or v_amount <> pg_catalog.round(v_amount, 2) then
    raise exception 'Enter a positive offer with at most two decimal places.' using errcode = '22023';
  end if;
  v_message := nullif(pg_catalog.btrim(p_message), '');
  if v_message is not null and pg_catalog.char_length(v_message) > 500 then
    raise exception 'Keep your message to 500 characters or fewer.' using errcode = '22023';
  end if;

  insert into public.claims (gig_id, provider_id, state, offer_amount, message)
  values (p_gig_id, auth.uid(), 'pending', v_amount, v_message)
  on conflict (gig_id, provider_id) do nothing
  returning * into v_claim;
  if not found then
    select * into v_claim from public.claims
    where gig_id = p_gig_id and provider_id = auth.uid();
    return v_claim;
  end if;

  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(v_gig.poster_id, p_gig_id, 'claim_received',
    '@' || coalesce(v_name, 'A helper') || ' sent an offer for "' || v_gig.title || '".');
  return v_claim;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. withdraw_claim(): unchanged except that withdrawing the counteroffer on a
--    request closes that request out, so the poster is told (public gigs: no
--    new notification, as before).
-- ---------------------------------------------------------------------------
create or replace function public.withdraw_claim(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_claim public.claims;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- Same parent-first lock order as every other lifecycle command.
  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found then
    raise exception 'Gig not found';
  end if;
  select * into v_claim from public.claims
  where gig_id = p_gig_id and provider_id = auth.uid() for update;
  if not found then
    raise exception 'Offer not found';
  end if;
  if v_claim.state <> 'pending' then
    raise exception 'Only a pending offer can be withdrawn';
  end if;
  update public.claims set state = 'withdrawn' where id = v_claim.id;
  if v_gig.requested_helper_id is not distinct from auth.uid() then
    select username into v_name from public.public_profiles where id = auth.uid();
    perform public.notify(v_gig.poster_id, p_gig_id, 'request_declined',
      '@' || coalesce(v_name, 'The helper') || ' withdrew their offer on your request "' || v_gig.title ||
      '". You can post it publicly or cancel it.');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. select_provider(): identical to 0010, plus: on a request only the
--    requested helper's offer can be accepted.
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
  update public.claims set state = 'rejected' where gig_id = p_gig_id and id <> p_claim_id and state = 'pending';
  update public.gigs set selected_provider_id = v_claim.provider_id, agreed_amount = v_claim.offer_amount where id = p_gig_id;
  -- The exact address is deliberately NOT part of the notification.
  perform public.notify(v_claim.provider_id, p_gig_id, 'selected',
    'Your offer for "' || v_gig.title || '" was accepted.');
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. cancel_gig(): unchanged, plus the requested helper is told when a request
--    they have not answered (or have counteroffered on) is cancelled.
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
  if v_gig.status <> 'active' or v_gig.selected_provider_id is not null then
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
-- 10. accept_gig_request(): the requested helper accepts the POSTED price.
--     One transaction under the gig row lock; the unique selected-claim index
--     (0003) is the backstop. A pending counteroffer from the same helper is
--     converted to a selected claim at the posted price. The exact address is
--     not touched here: access follows selected_provider_id by RLS.
-- ---------------------------------------------------------------------------
create function public.accept_gig_request(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_claim public.claims;
  v_has_claim boolean;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.requested_helper_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' or v_gig.selected_provider_id is not null then
    raise exception 'This request is no longer open.';
  end if;
  -- Never assign a helper to a gig whose poster can no longer approve, start or
  -- confirm anything (account deleted or locked).
  if esg_private.account_unavailable(v_gig.poster_id) then
    raise exception 'This request is no longer available.';
  end if;

  select * into v_claim from public.claims
  where gig_id = p_gig_id and provider_id = auth.uid() for update;
  v_has_claim := found;  -- PERFORM below would reset FOUND
  if v_has_claim and v_claim.state <> 'pending' then
    raise exception 'This request is no longer open.';
  end if;

  perform esg_private.assert_requestable_helper(auth.uid(), v_gig.poster_id, v_gig.service_type);

  if v_has_claim then
    update public.claims set state = 'selected', offer_amount = v_gig.amount, message = null where id = v_claim.id;
  else
    insert into public.claims (gig_id, provider_id, state, offer_amount)
    values (p_gig_id, auth.uid(), 'selected', v_gig.amount);
  end if;
  update public.gigs set selected_provider_id = auth.uid(), agreed_amount = v_gig.amount where id = p_gig_id;

  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(v_gig.poster_id, p_gig_id, 'request_accepted',
    '@' || coalesce(v_name, 'The helper') || ' accepted your request "' || v_gig.title || '".');
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. decline_gig_request(): the requested helper closes the request out. The
--     gig is NOT cancelled and stays private; the poster decides what to do.
--     Recorded as a 'withdrawn' claim (a pending counteroffer is withdrawn).
--     Repeating it is a no-op.
-- ---------------------------------------------------------------------------
create function public.decline_gig_request(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_claim public.claims;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.requested_helper_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' or v_gig.selected_provider_id is not null then
    raise exception 'This request is no longer open.';
  end if;

  select * into v_claim from public.claims
  where gig_id = p_gig_id and provider_id = auth.uid() for update;
  if found then
    if v_claim.state <> 'pending' then
      return;
    end if;
    update public.claims set state = 'withdrawn' where id = v_claim.id;
  else
    insert into public.claims (gig_id, provider_id, state, offer_amount)
    values (p_gig_id, auth.uid(), 'withdrawn', v_gig.amount);
  end if;

  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(v_gig.poster_id, p_gig_id, 'request_declined',
    '@' || coalesce(v_name, 'The helper') || ' declined your request "' || v_gig.title ||
    '". You can post it publicly or cancel it.');
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. reassign_gig_request(): the poster makes an unanswered/declined request
--     public (p_new_helper_id null) or addresses it to another helper. One
--     transaction under the gig row lock: the target, the old helper's pending
--     offer and every notification change together or not at all, so a failure
--     can never leave the gig half-updated or accidentally public.
-- ---------------------------------------------------------------------------
create function public.reassign_gig_request(p_gig_id uuid, p_new_helper_id uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_old uuid;
  v_old_open boolean;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.requested_helper_id is null then
    raise exception 'This gig is not a helper request.';
  end if;
  if v_gig.status <> 'active' or v_gig.selected_provider_id is not null then
    raise exception 'This request is no longer open.';
  end if;

  v_old := v_gig.requested_helper_id;
  if p_new_helper_id is not null then
    if p_new_helper_id = v_old then
      raise exception 'That helper already has this request.' using errcode = '22023';
    end if;
    perform esg_private.assert_requestable_helper(p_new_helper_id, v_gig.poster_id, v_gig.service_type);
    if exists (select 1 from public.claims where gig_id = p_gig_id and provider_id = p_new_helper_id) then
      raise exception 'That helper has already responded to this gig.' using errcode = '22023';
    end if;
  end if;

  v_old_open := not exists (
    select 1 from public.claims
    where gig_id = p_gig_id and provider_id = v_old and state in ('withdrawn', 'rejected')
  );
  update public.gigs set requested_helper_id = p_new_helper_id where id = p_gig_id;
  update public.claims set state = 'rejected' where gig_id = p_gig_id and provider_id = v_old and state = 'pending';

  if v_old_open then
    perform public.notify(v_old, p_gig_id, 'request_withdrawn',
      'The request "' || v_gig.title || '" is no longer addressed to you.');
  end if;
  if p_new_helper_id is not null then
    select username into v_name from public.public_profiles where id = auth.uid();
    perform public.notify(p_new_helper_id, p_gig_id, 'gig_request',
      '@' || coalesce(v_name, 'Someone') || ' sent you a request: "' || v_gig.title || '".');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. delete_own_account(): the current 0018 body (eligibility check, username-
--     lock bypass, free-text scrubbing) plus the request lifecycle. A gig
--     addressed to the caller counts as marketplace history, so the account is
--     anonymized and locked instead of hard-deleted and the requested_helper_id
--     foreign key can never block deletion or publish a private request.
--     Everything below happens in the caller's single transaction, so a
--     failure leaves nothing half-closed:
--       * poster: their ACTIVE, UNASSIGNED requests are cancelled (pending
--         counteroffers rejected) and the requested helpers are told;
--       * requested helper: ACTIVE, UNASSIGNED requests addressed to them are
--         closed out (the same 'withdrawn' claim as a decline) and the posters
--         are told, so they can post it publicly or cancel it.
--     Public gigs, assigned gigs (already blocked by the eligibility check) and
--     drafts are untouched. Gig rows are locked in id order -- the same order
--     for both loops -- before their claims, matching every other lifecycle RPC.
-- ---------------------------------------------------------------------------
create or replace function public.delete_own_account()
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_has_history boolean;
  v_blocked boolean;
  v_gig public.gigs;
  v_open boolean;
  v_name text;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;

  select not eligible into v_blocked from public.check_deletion_eligibility();
  if v_blocked then
    raise exception 'You have Gigs that need attention. Resolve any active Gigs, incomplete Gig activity, or open Disputes before deleting your account.'
      using errcode = '22023';
  end if;

  select exists (
    select 1 from public.gigs where poster_id = v_uid or selected_provider_id = v_uid or requested_helper_id = v_uid
    union all
    select 1 from public.claims where provider_id = v_uid
    union all
    select 1 from public.chat_messages where sender_id = v_uid
    union all
    select 1 from public.gig_completions where user_id = v_uid
    union all
    select 1 from public.gig_incomplete_choices where user_id = v_uid
    union all
    select 1 from public.feedback where from_id = v_uid or to_id = v_uid
    union all
    select 1 from public.notifications where recipient_id = v_uid
  ) into v_has_history;

  if v_has_history then
    -- Requests this account posted: cancel them and tell the requested helper.
    for v_gig in
      select * from public.gigs
      where poster_id = v_uid and requested_helper_id is not null and status = 'active' and selected_provider_id is null
      order by id for update
    loop
      v_open := not exists (
        select 1 from public.claims
        where gig_id = v_gig.id and provider_id = v_gig.requested_helper_id and state in ('withdrawn', 'rejected')
      );
      update public.gigs set status = 'cancelled' where id = v_gig.id;
      update public.claims set state = 'rejected' where gig_id = v_gig.id and state = 'pending';
      if v_open then
        perform public.notify(v_gig.requested_helper_id, v_gig.id, 'request_withdrawn',
          'The request "' || v_gig.title || '" was cancelled because the poster closed their account.');
      end if;
    end loop;

    -- Requests addressed to this account: close them out and tell the poster.
    for v_gig in
      select * from public.gigs
      where requested_helper_id = v_uid and poster_id <> v_uid and status = 'active' and selected_provider_id is null
      order by id for update
    loop
      v_open := not exists (
        select 1 from public.claims
        where gig_id = v_gig.id and provider_id = v_uid and state in ('withdrawn', 'rejected')
      );
      if v_open then
        update public.claims set state = 'withdrawn' where gig_id = v_gig.id and provider_id = v_uid and state = 'pending';
        if not found then
          insert into public.claims (gig_id, provider_id, state, offer_amount)
          values (v_gig.id, v_uid, 'withdrawn', v_gig.amount);
        end if;
        perform public.notify(v_gig.poster_id, v_gig.id, 'request_declined',
          'The helper closed their account, so your request "' || v_gig.title || '" was closed. You can post it publicly or cancel it.');
      end if;
    end loop;

    perform pg_catalog.set_config('esg.bypass_profile_validation', 'on', true);
    update public.profiles set
      username = 'deleted' || pg_catalog.substr(v_uid::text, 1, 8),
      photo_url = null,
      skills = '[]'::jsonb,
      services = '[]'::jsonb,
      skills_other_text = null,
      services_other_text = null,
      private_location_text = null,
      private_lat = null,
      private_lng = null,
      public_location_text = null,
      public_lat = null,
      public_lng = null
      where id = v_uid;
    delete from public.profile_tags where profile_id = v_uid;
  end if;

  return v_has_history;
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Explicit permissions: authenticated only, never anon or PUBLIC.
-- ---------------------------------------------------------------------------
revoke execute on function
  public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[],text,uuid),
  public.publish_gig(uuid),
  public.create_claim(uuid,numeric,text),
  public.withdraw_claim(uuid),
  public.select_provider(uuid,uuid),
  public.cancel_gig(uuid),
  public.accept_gig_request(uuid),
  public.decline_gig_request(uuid),
  public.reassign_gig_request(uuid,uuid),
  public.delete_own_account()
  from public, anon, authenticated;
grant execute on function
  public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[],text,uuid),
  public.publish_gig(uuid),
  public.create_claim(uuid,numeric,text),
  public.withdraw_claim(uuid),
  public.select_provider(uuid,uuid),
  public.cancel_gig(uuid),
  public.accept_gig_request(uuid),
  public.decline_gig_request(uuid),
  public.reassign_gig_request(uuid,uuid),
  public.delete_own_account()
  to authenticated;

commit;
