-- Helper offers + agreed price + private service address.
--
-- Evolves the existing claim model (claims = a helper's offer on a gig) rather
-- than adding a bidding table:
--   * claims gain offer_amount (the helper's price) and an optional message;
--   * gigs gain agreed_amount, captured server-side from the accepted offer
--     while gigs.amount stays the poster's original budget;
--   * the exact service address lives in its own table whose RLS only ever
--     returns it to the poster and the accepted helper -- the same split the
--     app already uses for profiles / public_profiles.
-- No payment processing; this only records the agreed price.
begin;

-- ---------------------------------------------------------------------------
-- 1. claims: offer amount + message. Existing rows are backfilled with the
--    gig's posted budget (what they implicitly offered).
-- ---------------------------------------------------------------------------
alter table public.claims
  add column offer_amount numeric(12,2),
  add column message text;
update public.claims c set offer_amount = g.amount from public.gigs g where g.id = c.gig_id;
alter table public.claims alter column offer_amount set not null;
alter table public.claims
  add constraint claims_offer_amount_valid check (offer_amount > 0 and offer_amount <= 9999999999.99),
  add constraint claims_message_length check (message is null or pg_catalog.char_length(message) between 1 and 500);

-- Any other trusted writer that omits an amount (seed scripts, repairs) is
-- treated as an offer at the posted budget, matching the backfill above.
create function esg_private.default_claim_offer() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.offer_amount is null then
    select g.amount into new.offer_amount from public.gigs g where g.id = new.gig_id;
  end if;
  return new;
end;
$$;
revoke execute on function esg_private.default_claim_offer() from public, anon, authenticated;
create trigger trg_default_claim_offer before insert on public.claims
for each row execute function esg_private.default_claim_offer();

-- Offers are only created/changed through the RPCs below.
revoke insert, update, delete on table public.claims from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. gigs: agreed price (never client-writable: gigs has no INSERT/UPDATE
--    grants for clients since 0004/0005). Existing assigned gigs keep their
--    budget as the agreed price.
-- ---------------------------------------------------------------------------
alter table public.gigs add column agreed_amount numeric(12,2);
update public.gigs set agreed_amount = amount where selected_provider_id is not null;
alter table public.gigs
  add constraint gigs_agreed_amount_valid check (agreed_amount is null or (agreed_amount > 0 and agreed_amount <= 9999999999.99));

-- An assigned gig is no longer "open": the public (and Browse) only see gigs
-- that can still receive offers. The poster, the accepted helper and anyone
-- who made an offer keep access through gigs_select_participants (0002).
drop policy gigs_select on public.gigs;
create policy gigs_select on public.gigs for select to anon, authenticated using (
  status = 'active' and selected_provider_id is null
);

-- ---------------------------------------------------------------------------
-- 3. Private service address. Row-level security IS the boundary: anon has no
--    grant; authenticated users only get rows for their own gig (poster) or the
--    gig they were hired for while it is still being worked. Everyone else --
--    including pending, rejected and withdrawn helpers -- gets zero rows.
-- ---------------------------------------------------------------------------
create table public.gig_private_locations (
  gig_id uuid primary key references public.gigs(id) on delete cascade,
  address_text text not null check (pg_catalog.char_length(address_text) between 1 and 300),
  created_at timestamptz not null default now()
);
alter table public.gig_private_locations enable row level security;
create policy gig_private_locations_select on public.gig_private_locations for select to authenticated using (
  exists (
    select 1 from public.gigs g
    where g.id = gig_private_locations.gig_id
      and (
        g.poster_id = auth.uid()
        or (g.selected_provider_id = auth.uid() and g.status in ('active', 'in_progress', 'awaiting_payment', 'disputed'))
      )
  )
);
revoke all on table public.gig_private_locations from public, anon, authenticated;
grant select on table public.gig_private_locations to authenticated;

-- ---------------------------------------------------------------------------
-- 4. create_gig(): optional private address. A new argument changes the
--    function identity, so drop the old overload instead of leaving it callable.
-- ---------------------------------------------------------------------------
drop function public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[]);

create function public.create_gig(p_request_id uuid,p_service_type text,p_title text,
  p_description text,p_amount numeric,p_price_type text,p_scheduled_at timestamptz,
  p_location_text text,p_lat double precision,p_lng double precision,
  p_photo_url text default null,p_publish boolean default true,p_tag_ids uuid[] default '{}'::uuid[],
  p_private_address text default null)
returns public.gigs language plpgsql security definer set search_path = '' as $$
declare v_gig public.gigs; v_tag_ids uuid[]; v_address text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_request_id is null then raise exception 'Missing creation request.' using errcode='22023'; end if;
  perform 1 from public.profiles where id=auth.uid() and onboarding_completed_at is not null for update;
  if not found then raise exception 'Finish your profile setup before posting.' using errcode='22023'; end if;
  select * into v_gig from public.gigs where poster_id=auth.uid() and creation_request_id=p_request_id;
  if found then return v_gig; end if;
  if p_service_type is null or p_service_type <> all(array['Yard Work','Moving Help','Cleaning','Handyman','Delivery','Pet Care','Tech Help','Other']) then
    raise exception 'Choose a valid service type.' using errcode='22023'; end if;
  if p_title is null or pg_catalog.length(pg_catalog.btrim(p_title)) not between 1 and 120 then
    raise exception 'Enter a title of 1–120 characters.' using errcode='22023'; end if;
  if p_description is null or pg_catalog.length(pg_catalog.btrim(p_description)) not between 1 and 280 then
    raise exception 'Enter a description of 1–280 characters.' using errcode='22023'; end if;
  if p_amount is null or not (p_amount>0 and p_amount<=9999999999.99) or p_amount<>pg_catalog.round(p_amount,2) then
    raise exception 'Enter a positive amount with at most two decimal places.' using errcode='22023'; end if;
  if p_price_type is distinct from 'fixed' then
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
  insert into public.gigs(poster_id,creation_request_id,service_type,title,description,
    amount,price_type,scheduled_at,location_text,lat,lng,photo_url,status)
  values(auth.uid(),p_request_id,p_service_type,pg_catalog.btrim(p_title),pg_catalog.btrim(p_description),
    p_amount,'fixed',p_scheduled_at,pg_catalog.btrim(p_location_text),
    pg_catalog.round(p_lat::numeric,2)::double precision,pg_catalog.round(p_lng::numeric,2)::double precision,
    p_photo_url,case when p_publish then 'active'::public.gig_status else 'draft'::public.gig_status end)
  returning * into v_gig;
  insert into public.gig_tags (gig_id, tag_id)
  select v_gig.id, picked from pg_catalog.unnest(v_tag_ids) as picked
  on conflict do nothing;
  if v_address is not null then
    insert into public.gig_private_locations (gig_id, address_text) values (v_gig.id, v_address);
  end if;
  return v_gig;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. create_claim(): a helper's offer. Same locking/retry rules as 0003; the
--    amount defaults to the posted budget and is validated here, not in the UI.
-- ---------------------------------------------------------------------------
drop function public.create_claim(uuid);

create function public.create_claim(p_gig_id uuid, p_offer_amount numeric default null, p_message text default null)
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
-- 6. withdraw_claim(): a helper takes back their own pending offer.
-- ---------------------------------------------------------------------------
create function public.withdraw_claim(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_claim public.claims;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- Same parent-first lock order as every other lifecycle command.
  perform 1 from public.gigs where id = p_gig_id for update;
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
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. select_provider(): accepting an offer. Everything happens under the gig
--    row lock: one winner, the agreed price copied from THAT offer, competing
--    pending offers closed as 'rejected'. No client-supplied price exists.
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
-- 8. Explicit permissions for the new/replaced functions.
-- ---------------------------------------------------------------------------
revoke execute on function
  public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[],text),
  public.create_claim(uuid,numeric,text),
  public.withdraw_claim(uuid),
  public.select_provider(uuid,uuid)
  from public, anon, authenticated;
grant execute on function
  public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[],text),
  public.create_claim(uuid,numeric,text),
  public.withdraw_claim(uuid),
  public.select_provider(uuid,uuid)
  to authenticated;

commit;
