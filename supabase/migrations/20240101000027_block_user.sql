-- ESG-SAFE-001 v1.0 (Provider Report/Block/Safety) and ESG-SAFE-002 v1.0 (Poster Report/Block/Safety).
-- Scope: BLOCK only. Report, evidence, support adjudication, Call 911 and Unblock are all out of scope
-- (confirmed with the task owner) -- there is no report record, no reason text, and no reputation effect.
--
-- Also confirmed with the task owner: Block is refused outright while there is an in-progress (or
-- awaiting-payment/disputed) gig between the two users, rather than trying to force the two-sided
-- Complete/Incomplete handshake (gig_completions -> gig_incomplete_choices -> submit_payment_amount)
-- through using only one side's input. A provider who needs to leave an in-progress gig for safety
-- reasons already has EXIT GIG (migration 0026, with its own "safety_concern" reason); a poster who
-- needs the gig to stop has the ordinary Complete/Incomplete flow once it is no longer in progress.
--
-- Scope limits worth flagging for a follow-up, not handled here: direct Gig Requests
-- (gigs.requested_helper_id / accept_gig_request) are not swept or guarded against a block -- only the
-- ordinary claims-based flow (create_claim) is. A pre-existing direct request to/from a blocked user
-- would need its own check in create_gig/accept_gig_request.
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

create table public.blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
alter table public.blocks enable row level security;
-- Only the blocker can see their own block rows: the blocked party is never told who blocked them,
-- the same ambiguity ordinary withdraw/remove already gives any closed relationship.
create policy blocks_select_own on public.blocks for select to authenticated using (blocker_id = auth.uid());
revoke all on table public.blocks from public, anon, authenticated;
grant select on table public.blocks to authenticated;

-- Authenticated-role-only helper (matching esg_private.has_own_claim/is_gig_poster's own convention):
-- never exposed to anon, so gigs_select/public_profiles_select_all (which anon also reads) are split
-- into an anon policy and a separate authenticated policy rather than referencing this from either.
create or replace function esg_private.is_blocked(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.blocks where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a)
  );
$$;
alter function esg_private.is_blocked(uuid, uuid) owner to current_user;
revoke all on function esg_private.is_blocked(uuid, uuid) from public, anon, authenticated;
grant execute on function esg_private.is_blocked(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- block_user(): sweeps every shared gig relationship, not just one gig in context, since a block is a
-- user-to-user action ("cannot interact... afterward"), not a per-gig one.
-- ---------------------------------------------------------------------------
create function public.block_user(p_blocked_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_gig record;
  v_reopen boolean;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  v_uid := auth.uid();

  if p_blocked_id = v_uid then
    raise exception 'You cannot block yourself';
  end if;
  if not exists (select 1 from public.profiles where id = p_blocked_id) then
    raise exception 'User not found';
  end if;

  if exists (
    select 1 from public.gigs
    where status in ('in_progress', 'awaiting_payment', 'disputed')
      and ((poster_id = v_uid and selected_provider_id = p_blocked_id) or (poster_id = p_blocked_id and selected_provider_id = v_uid))
  ) then
    raise exception 'You can''t block while a gig between you is in progress. Resolve or exit it first.';
  end if;

  insert into public.blocks (blocker_id, blocked_id) values (v_uid, p_blocked_id)
  on conflict (blocker_id, blocked_id) do nothing;

  for v_gig in
    select g.* from public.gigs g
    where g.status = 'active'
      and (
        (g.poster_id = v_uid and g.selected_provider_id = p_blocked_id)
        or (g.poster_id = p_blocked_id and g.selected_provider_id = v_uid)
        or (g.poster_id = v_uid and exists (select 1 from public.claims c where c.gig_id = g.id and c.provider_id = p_blocked_id and c.state = 'pending'))
        or (g.poster_id = p_blocked_id and exists (select 1 from public.claims c where c.gig_id = g.id and c.provider_id = v_uid and c.state = 'pending'))
      )
    for update
  loop
    if v_gig.selected_provider_id is not null then
      -- A selected/pre-start/start-pending/delayed relationship: close it the same way
      -- remove_helper/withdraw_before_start do, except Chat always disappears here, even when the
      -- gig ends up cancelled (Block's "existing Chat disappears" is unconditional; the ordinary
      -- withdraw/remove functions only clear it when reopening for the next helper).
      if v_gig.poster_id = v_uid then
        update public.claims set state = 'rejected' where gig_id = v_gig.id and provider_id = p_blocked_id and state = 'selected';
      else
        update public.claims set state = 'withdrawn' where gig_id = v_gig.id and provider_id = v_uid and state = 'selected';
      end if;
      v_reopen := exists (select 1 from public.claims where gig_id = v_gig.id and state = 'pending');
      delete from public.chat_messages where gig_id = v_gig.id;
      delete from public.price_proposals where gig_id = v_gig.id;
      update public.gigs set
        status = (case when v_reopen then 'active' else 'cancelled' end)::public.gig_status,
        selected_provider_id = null,
        agreed_amount = null,
        start_requested_at = null,
        start_delayed_at = null,
        start_wait_count = 0,
        start_wait_until = null,
        helper_withdrawn_at = case when v_gig.poster_id <> v_uid and not v_reopen then pg_catalog.now() else null end,
        helper_removed_at = case when v_gig.poster_id = v_uid and not v_reopen then pg_catalog.now() else null end
      where id = v_gig.id;

      -- Same message shape an ordinary removal/withdrawal would give: the blocked party cannot tell
      -- this closure apart from any other, same ambiguity as not knowing you were blocked elsewhere.
      if v_gig.poster_id = v_uid then
        perform public.notify(p_blocked_id, v_gig.id, 'helper_removed', 'The poster removed you from "' || v_gig.title || '".');
      else
        select username into v_name from public.public_profiles where id = v_uid;
        perform public.notify(p_blocked_id, v_gig.id, 'helper_withdrew',
          '@' || coalesce(v_name, 'Your helper') || ' withdrew from "' || v_gig.title || '". ' ||
          case when v_reopen then 'Other offers are still open, so you can choose another helper.' else 'You can post it again for everyone.' end);
      end if;
    else
      -- Only a pending claim: close it silently, matching the existing silent-rejection convention
      -- for ordinary pending claims (no notification is sent for this case anywhere else either).
      if v_gig.poster_id = v_uid then
        update public.claims set state = 'rejected' where gig_id = v_gig.id and provider_id = p_blocked_id and state = 'pending';
      else
        update public.claims set state = 'withdrawn' where gig_id = v_gig.id and provider_id = v_uid and state = 'pending';
      end if;
    end if;
  end loop;
end;
$$;

revoke execute on function public.block_user(uuid) from public, anon, authenticated;
grant execute on function public.block_user(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Future interaction: a blocked pair can no longer claim each other's gigs (BR-SAFE-004/BR-SAFE2-005).
-- Same signature as the live 20240101000019 version: CREATE OR REPLACE keeps its existing grants.
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
    -- Retries return the existing offer unchanged (never reopened or edited) -- including one a
    -- block already closed out; a blocked user who still has a stale row just gets it back as-is.
    return v_claim;
  end if;

  -- Same vague "not open" message as the requested-helper mismatch below: a blocked user learns
  -- nothing about why a brand-new claim attempt never even gets as far as the amount/message checks.
  if v_gig.status <> 'active' or v_gig.selected_provider_id is not null or esg_private.is_blocked(auth.uid(), v_gig.poster_id) then
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
-- Discovery/profile visibility: a blocked pair disappears from each other's search/browse/profile.
-- Anon has no account and nothing to block, so its policy stays exactly as before, unchanged and with
-- no esg_private reference (matching 20240101000002's own stated reason for splitting these policies:
-- "avoid any need for anonymous EXECUTE"). Only the authenticated-facing policy gains the block check.
-- ---------------------------------------------------------------------------
drop policy gigs_select on public.gigs;
create policy gigs_select on public.gigs for select to anon using (
  status = 'active' and selected_provider_id is null and requested_helper_id is null
);
create policy gigs_select_discovery on public.gigs for select to authenticated using (
  status = 'active' and selected_provider_id is null and requested_helper_id is null
  and not esg_private.is_blocked(auth.uid(), poster_id)
);

drop policy public_profiles_select_all on public.public_profiles;
create policy public_profiles_select_all on public.public_profiles for select to anon using (true);
create policy public_profiles_select_authenticated on public.public_profiles for select to authenticated using (
  id = auth.uid() or not esg_private.is_blocked(auth.uid(), id)
);

commit;
