-- Price negotiation in the gig chat (up to three rounds).
--
-- Once a helper has been selected, either side may propose a new price from the chat and the
-- other side accepts or declines it. Rules (all enforced here, never in the UI alone):
--   * Who:     only the poster and the selected helper of the gig.
--   * When:    while the gig is active, a helper is selected and the helper has NOT yet asked to
--              start. Once start is requested the price is fixed.
--   * Rounds:  at most three proposals per gig. Every proposal counts as a round, whatever its
--              outcome (declined, withdrawn, countered), so the exchange cannot run on forever.
--   * Flow:    a proposal is pending until the OTHER side accepts or declines it; the proposer may
--              withdraw it. Proposing while the other side's proposal is pending is a counter: the
--              earlier proposal is declined and the new one is the next round.
--   * Accept:  sets gigs.agreed_amount to the proposed amount and ends the negotiation (no further
--              proposals). Decline, withdraw and counter leave the agreed price untouched.
-- No existing function is replaced. The chat itself (chat_messages) is unchanged; the app shows
-- proposals in the conversation from this table.
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

create type public.price_proposal_state as enum ('pending', 'accepted', 'declined', 'withdrawn');

create table public.price_proposals (
  id uuid primary key default gen_random_uuid(),
  gig_id uuid not null references public.gigs(id) on delete cascade,
  proposer_id uuid not null references public.profiles(id),
  round smallint not null check (round between 1 and 3),
  from_amount numeric(12,2) not null check (from_amount > 0),
  amount numeric(12,2) not null check (amount > 0 and amount <= 9999999999.99),
  state public.price_proposal_state not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (gig_id, round),
  constraint price_proposals_changes_price check (amount <> from_amount),
  constraint price_proposals_responded check ((state = 'pending') = (responded_at is null))
);
-- One open proposal per gig, so there is never an ambiguous "which one do I answer".
create unique index price_proposals_one_pending_per_gig on public.price_proposals (gig_id) where state = 'pending';
create index price_proposals_gig_created_idx on public.price_proposals (gig_id, created_at);

-- Visible to the two people in the gig, like the chat. No client writes: only the functions below.
alter table public.price_proposals enable row level security;
create policy price_proposals_select_participants on public.price_proposals for select to authenticated using (
  exists (
    select 1 from public.gigs g
    where g.id = price_proposals.gig_id and (g.poster_id = auth.uid() or g.selected_provider_id = auth.uid())
  )
);
revoke all on public.price_proposals from public, anon, authenticated;
grant select on public.price_proposals to authenticated;
alter publication supabase_realtime add table public.price_proposals;

-- ---------------------------------------------------------------------------
-- propose_price(): a new proposal, or a counter to the other side's pending one.
-- ---------------------------------------------------------------------------
create function public.propose_price(p_gig_id uuid, p_amount numeric) returns public.price_proposals
language plpgsql security definer set search_path = '' as $$
declare
  c_max_rounds constant smallint := 3;
  v_gig public.gigs;
  v_pending public.price_proposals;
  v_has_pending boolean;
  v_round smallint;
  v_current numeric(12,2);
  v_row public.price_proposals;
  v_other uuid;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or (v_gig.poster_id is distinct from auth.uid() and v_gig.selected_provider_id is distinct from auth.uid()) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' or v_gig.selected_provider_id is null or v_gig.start_requested_at is not null then
    raise exception 'The price can only be changed before the helper starts.';
  end if;
  if p_amount is null or not (p_amount > 0 and p_amount <= 9999999999.99) or p_amount <> pg_catalog.round(p_amount, 2) then
    raise exception 'Enter a positive amount with at most two decimal places.' using errcode = '22023';
  end if;
  v_current := coalesce(v_gig.agreed_amount, v_gig.amount);
  if p_amount = v_current then
    raise exception 'That is already the agreed price.' using errcode = '22023';
  end if;
  if exists (select 1 from public.price_proposals where gig_id = p_gig_id and state = 'accepted') then
    raise exception 'A new price was already agreed for this gig.';
  end if;

  select * into v_pending from public.price_proposals where gig_id = p_gig_id and state = 'pending' for update;
  v_has_pending := found;
  if v_has_pending and v_pending.proposer_id = auth.uid() then
    raise exception 'You already have a proposal waiting for a reply. Withdraw it first.';
  end if;

  select pg_catalog.count(*) + 1 into v_round from public.price_proposals where gig_id = p_gig_id;
  if v_round > c_max_rounds then
    raise exception 'The price has already been proposed three times.';
  end if;

  if v_has_pending then
    update public.price_proposals set state = 'declined', responded_at = pg_catalog.now() where id = v_pending.id;
  end if;

  insert into public.price_proposals (gig_id, proposer_id, round, from_amount, amount)
  values (p_gig_id, auth.uid(), v_round, v_current, p_amount)
  returning * into v_row;

  v_other := case when auth.uid() = v_gig.poster_id then v_gig.selected_provider_id else v_gig.poster_id end;
  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(v_other, p_gig_id, 'price_proposed',
    '@' || coalesce(v_name, 'Someone') || ' proposed a new price for "' || v_gig.title || '". Open the chat to reply.');
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- respond_price_proposal(): the OTHER side accepts or declines.
-- ---------------------------------------------------------------------------
create function public.respond_price_proposal(p_proposal_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_prop public.price_proposals;
  v_gig public.gigs;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_accept is null then
    raise exception 'Choose accept or decline.' using errcode = '22023';
  end if;

  -- Lock order matches every other lifecycle function: the gig first, then its rows.
  select * into v_prop from public.price_proposals where id = p_proposal_id;
  if not found then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into v_gig from public.gigs where id = v_prop.gig_id for update;
  if not found
     or (v_gig.poster_id is distinct from auth.uid() and v_gig.selected_provider_id is distinct from auth.uid())
     or v_prop.proposer_id = auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into v_prop from public.price_proposals where id = p_proposal_id for update;
  if v_prop.state <> 'pending' then
    raise exception 'This proposal is no longer open.';
  end if;
  if v_gig.status <> 'active' or v_gig.selected_provider_id is null or v_gig.start_requested_at is not null then
    raise exception 'The price can no longer be changed.';
  end if;

  select username into v_name from public.public_profiles where id = auth.uid();
  if p_accept then
    update public.price_proposals set state = 'accepted', responded_at = pg_catalog.now() where id = v_prop.id;
    update public.gigs set agreed_amount = v_prop.amount where id = v_gig.id;
    perform public.notify(v_prop.proposer_id, v_gig.id, 'price_accepted',
      '@' || coalesce(v_name, 'Someone') || ' accepted your price for "' || v_gig.title || '".');
  else
    update public.price_proposals set state = 'declined', responded_at = pg_catalog.now() where id = v_prop.id;
    perform public.notify(v_prop.proposer_id, v_gig.id, 'price_declined',
      '@' || coalesce(v_name, 'Someone') || ' declined your price for "' || v_gig.title || '".');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- withdraw_price_proposal(): the proposer takes back a proposal that is still waiting.
-- ---------------------------------------------------------------------------
create function public.withdraw_price_proposal(p_proposal_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_prop public.price_proposals;
  v_gig public.gigs;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_prop from public.price_proposals where id = p_proposal_id;
  if not found or v_prop.proposer_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into v_gig from public.gigs where id = v_prop.gig_id for update;
  select * into v_prop from public.price_proposals where id = p_proposal_id for update;
  if v_prop.state <> 'pending' then
    raise exception 'This proposal is no longer open.';
  end if;

  update public.price_proposals set state = 'withdrawn', responded_at = pg_catalog.now() where id = v_prop.id;
  select username into v_name from public.public_profiles where id = auth.uid();
  perform public.notify(
    case when v_prop.proposer_id = v_gig.poster_id then v_gig.selected_provider_id else v_gig.poster_id end,
    v_gig.id, 'price_withdrawn',
    '@' || coalesce(v_name, 'Someone') || ' withdrew their price proposal for "' || v_gig.title || '".');
end;
$$;

-- Authenticated users only; never anon or PUBLIC.
revoke execute on function
  public.propose_price(uuid, numeric),
  public.respond_price_proposal(uuid, boolean),
  public.withdraw_price_proposal(uuid)
  from public, anon, authenticated;
grant execute on function
  public.propose_price(uuid, numeric),
  public.respond_price_proposal(uuid, boolean),
  public.withdraw_price_proposal(uuid)
  to authenticated;

commit;
