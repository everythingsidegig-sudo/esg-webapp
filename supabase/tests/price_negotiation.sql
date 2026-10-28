-- Price negotiation in the gig chat (migration 0021): who may propose and answer, the three-round
-- limit, counters and withdrawals, the window before start, visibility and write protection.
-- Run only against an isolated Supabase test database after 0001 through 0021.
-- All fixtures roll back. Run as postgres (or an equivalent trusted role).
begin;

create temporary table pn_fixture (name text primary key, id uuid);
insert into pn_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['poster','helper','stranger','g_main','g_rounds','g_wd','g_started','g_prog','g_open','g_cancel','g_late','prop1']) as n(name);
grant select, update on pn_fixture to anon, authenticated;

create function pg_temp.pn_id(p_name text) returns uuid
language sql stable as $$ select id from pg_temp.pn_fixture where name = p_name; $$;
create function pg_temp.pn_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.pn_switch(p_user text) returns void language plpgsql as $$
declare v_id uuid;
begin
  if p_user = 'admin' then return; end if;
  if p_user = 'anon' then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    set local role anon;
  else
    select id into v_id from pg_temp.pn_fixture where name = p_user;
    perform set_config('request.jwt.claim.sub', v_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end;
$$;
create function pg_temp.pn_query(p_user text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.pn_switch(p_user);
  begin execute p_sql into v; exception when others then reset role; raise; end;
  reset role;
  return v;
end;
$$;
create function pg_temp.pn_exec(p_user text, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.pn_switch(p_user);
  begin execute p_sql; exception when others then reset role; raise; end;
  reset role;
end;
$$;
-- Expect an error with this SQLSTATE; p_msg (if given) must be contained in the message.
create function pg_temp.pn_error(p_user text, p_sql text, p_code text, p_label text, p_msg text default null) returns void
language plpgsql as $$
begin
  begin
    perform pg_temp.pn_exec(p_user, p_sql);
  exception when others then
    if sqlstate <> p_code or (p_msg is not null and position(p_msg in sqlerrm) = 0) then
      raise exception 'FAIL: % (got % %)', p_label, sqlstate, sqlerrm;
    end if;
    raise notice 'PASS: %', p_label; return;
  end;
  raise exception 'FAIL (expected error %): %', p_code, p_label;
end;
$$;
create function pg_temp.pn_denied(p_user text, p_sql text, p_label text) returns void
language plpgsql as $$ begin perform pg_temp.pn_error(p_user, p_sql, '42501', p_label); end; $$;
-- Shorthands.
create function pg_temp.pn_propose(p_user text, p_gig text, p_amount text) returns text language sql as $$
  select pg_temp.pn_query(p_user, pg_catalog.format($q$select (public.propose_price(%L, %s)).id::text$q$, pg_temp.pn_id(p_gig), p_amount));
$$;
create function pg_temp.pn_respond(p_user text, p_proposal text, p_accept boolean) returns void language sql as $$
  select pg_temp.pn_exec(p_user, pg_catalog.format($q$select public.respond_price_proposal(%L, %L)$q$, p_proposal, p_accept));
$$;
create function pg_temp.pn_state(p_gig text, p_round int) returns text language sql as $$
  select state::text || ':' || amount::text || ':' || from_amount::text from public.price_proposals where gig_id = pg_temp.pn_id(p_gig) and round = p_round;
$$;
create function pg_temp.pn_agreed(p_gig text) returns text language sql as $$
  select coalesce(agreed_amount::text, '-') from public.gigs where id = pg_temp.pn_id(p_gig);
$$;
create function pg_temp.pn_notes(p_user text, p_gig text, p_type text) returns bigint language sql as $$
  select count(*) from public.notifications where recipient_id = pg_temp.pn_id(p_user) and gig_id = pg_temp.pn_id(p_gig) and type = p_type;
$$;
create function pg_temp.pn_see(p_user text, p_gig text) returns text language plpgsql as $fn$
begin
  return pg_temp.pn_query(p_user, pg_catalog.format($q$select count(*)::text from public.price_proposals where gig_id = %L$q$, pg_temp.pn_id(p_gig)));
end;
$fn$;
grant execute on all functions in schema pg_temp to anon, authenticated;

do $$
declare v_schema text;
begin
  select nspname into v_schema from pg_catalog.pg_namespace where oid = pg_catalog.pg_my_temp_schema();
  execute pg_catalog.format('grant usage on schema %I to anon, authenticated', v_schema);
end;
$$;

insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
select id, 'authenticated', 'authenticated', name || '-' || id::text || '@example.invalid',
  jsonb_build_object('username', 'PN' || name), now(), now()
from pn_fixture where name in ('poster', 'helper', 'stranger');

-- Gigs in each state the rules care about. Inserted directly (as the migration role) so the test
-- exercises only the negotiation functions, not the earlier lifecycle.
create function pg_temp.pn_gig(p_name text, p_status text, p_helper boolean, p_started boolean default false) returns void language plpgsql as $$
begin
  insert into public.gigs (id, poster_id, creation_request_id, service_type, title, description, amount, price_type, location_text, status,
    selected_provider_id, agreed_amount, start_requested_at)
  values (pg_temp.pn_id(p_name), pg_temp.pn_id('poster'), gen_random_uuid(), 'Cleaning', 'Gig ' || p_name, 'Description', 100, 'fixed', 'Kävlinge', p_status::public.gig_status,
    case when p_helper then pg_temp.pn_id('helper') end, case when p_helper then 100 end,
    case when p_started then pg_catalog.now() end);
end;
$$;
select pg_temp.pn_gig('g_main', 'active', true);
select pg_temp.pn_gig('g_rounds', 'active', true);
select pg_temp.pn_gig('g_wd', 'active', true);
select pg_temp.pn_gig('g_late', 'active', true);
select pg_temp.pn_gig('g_started', 'active', true, true);
select pg_temp.pn_gig('g_prog', 'in_progress', true, true);
select pg_temp.pn_gig('g_open', 'active', false);
select pg_temp.pn_gig('g_cancel', 'cancelled', true);

-- ---------------------------------------------------------------------------
-- 1. Permissions and structure.
-- ---------------------------------------------------------------------------
select pg_temp.pn_assert((select relrowsecurity from pg_catalog.pg_class where oid = 'public.price_proposals'::regclass), 'price_proposals has row-level security');
select pg_temp.pn_assert(has_table_privilege('authenticated', 'public.price_proposals', 'SELECT')
  and not has_table_privilege('authenticated', 'public.price_proposals', 'INSERT')
  and not has_table_privilege('authenticated', 'public.price_proposals', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.price_proposals', 'DELETE')
  and not has_table_privilege('anon', 'public.price_proposals', 'SELECT'), 'clients can only read proposals; anon sees nothing; every write goes through the functions');
select pg_temp.pn_assert(not has_function_privilege('anon', 'public.propose_price(uuid,numeric)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.respond_price_proposal(uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.withdraw_price_proposal(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.propose_price(uuid,numeric)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.respond_price_proposal(uuid,boolean)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.withdraw_price_proposal(uuid)', 'EXECUTE'), 'the three functions are executable by authenticated users only');
select pg_temp.pn_assert((select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('propose_price', 'respond_price_proposal', 'withdraw_price_proposal') and p.prosecdef and p.proconfig @> array['search_path=""']) = 3,
  'all three are SECURITY DEFINER with an empty search_path');
select pg_temp.pn_assert((select count(*) from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'price_proposals') = 1, 'proposals are published to realtime so the chat updates live');

-- ---------------------------------------------------------------------------
-- 2. Who may propose, and when.
-- ---------------------------------------------------------------------------
select pg_temp.pn_denied('anon', pg_catalog.format($$select public.propose_price(%L, 120)$$, pg_temp.pn_id('g_main')), 'anon cannot propose a price');
select pg_temp.pn_denied('stranger', pg_catalog.format($$select public.propose_price(%L, 120)$$, pg_temp.pn_id('g_main')), 'someone outside the gig cannot propose');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, 120)$$, pg_temp.pn_id('g_open')), 'P0001', 'no price talk before a helper is selected', 'only be changed before the helper starts');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, 120)$$, pg_temp.pn_id('g_started')), 'P0001', 'the price is fixed once the helper has asked to start', 'only be changed before the helper starts');
select pg_temp.pn_error('helper', pg_catalog.format($$select public.propose_price(%L, 120)$$, pg_temp.pn_id('g_prog')), 'P0001', 'the price is fixed while the gig is in progress', 'only be changed before the helper starts');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, 120)$$, pg_temp.pn_id('g_cancel')), 'P0001', 'no price talk on a cancelled gig', 'only be changed before the helper starts');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, 0)$$, pg_temp.pn_id('g_main')), '22023', 'zero is not a price', 'positive amount');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, -5)$$, pg_temp.pn_id('g_main')), '22023', 'a negative price is refused', 'positive amount');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, 100.123)$$, pg_temp.pn_id('g_main')), '22023', 'more than two decimals is refused', 'two decimal places');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, 10000000000)$$, pg_temp.pn_id('g_main')), '22023', 'an absurd amount is refused', 'positive amount');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, null)$$, pg_temp.pn_id('g_main')), '22023', 'a missing amount is refused', 'positive amount');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, 100)$$, pg_temp.pn_id('g_main')), '22023', 'proposing the current price is refused', 'already the agreed price');
select pg_temp.pn_assert((select count(*) from public.price_proposals) = 0, 'every refused proposal left nothing behind');

-- ---------------------------------------------------------------------------
-- 3. Round 1: poster proposes, helper declines. The agreed price does not move.
-- ---------------------------------------------------------------------------
select pg_temp.pn_assert(pg_temp.pn_propose('poster', 'g_main', '120') is not null, 'the poster proposes 120');
update pg_temp.pn_fixture set id = (select id from public.price_proposals where gig_id = pg_temp.pn_id('g_main') and round = 1) where name = 'prop1';  -- remember round 1's id
select pg_temp.pn_assert(pg_temp.pn_state('g_main', 1) = 'pending:120.00:100.00', 'round 1 is pending, records the price it started from');
select pg_temp.pn_assert(pg_temp.pn_agreed('g_main') = '100.00', 'a pending proposal does not change the agreed price');
select pg_temp.pn_assert(pg_temp.pn_notes('helper', 'g_main', 'price_proposed') = 1 and pg_temp.pn_notes('poster', 'g_main', 'price_proposed') = 0, 'only the helper is notified');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, 130)$$, pg_temp.pn_id('g_main')), 'P0001', 'you cannot stack a second proposal on your own pending one', 'waiting for a reply');
select pg_temp.pn_assert(pg_temp.pn_see('poster', 'g_main') = '1' and pg_temp.pn_see('helper', 'g_main') = '1', 'both people in the gig can read the proposal');
select pg_temp.pn_assert(pg_temp.pn_see('stranger', 'g_main') = '0', 'a stranger sees no proposals');
select pg_temp.pn_denied('anon', 'select count(*) from public.price_proposals', 'anon cannot read proposals at all');
select pg_temp.pn_denied('poster', pg_catalog.format($$select public.respond_price_proposal(%L, true)$$, (select id from pg_temp.pn_fixture where name = 'prop1')), 'the proposer cannot accept their own proposal');
select pg_temp.pn_denied('stranger', pg_catalog.format($$select public.respond_price_proposal(%L, true)$$, (select id from pg_temp.pn_fixture where name = 'prop1')), 'a stranger cannot answer it');
select pg_temp.pn_denied('anon', pg_catalog.format($$select public.respond_price_proposal(%L, true)$$, (select id from pg_temp.pn_fixture where name = 'prop1')), 'anon cannot answer it');
select pg_temp.pn_denied('stranger', pg_catalog.format($$select public.withdraw_price_proposal(%L)$$, (select id from pg_temp.pn_fixture where name = 'prop1')), 'a stranger cannot withdraw it');
select pg_temp.pn_denied('helper', pg_catalog.format($$select public.withdraw_price_proposal(%L)$$, (select id from pg_temp.pn_fixture where name = 'prop1')), 'only the proposer can withdraw');
select pg_temp.pn_denied('helper', $$update public.price_proposals set state = 'accepted'$$, 'clients cannot write proposals directly');
select pg_temp.pn_denied('poster', pg_catalog.format($$insert into public.price_proposals (gig_id, proposer_id, round, from_amount, amount) values (%L, %L, 2, 100, 1)$$, pg_temp.pn_id('g_main'), pg_temp.pn_id('poster')), 'nor insert one');
select pg_temp.pn_respond('helper', (select id::text from pg_temp.pn_fixture where name = 'prop1'), false);
select pg_temp.pn_assert(pg_temp.pn_state('g_main', 1) = 'declined:120.00:100.00' and pg_temp.pn_agreed('g_main') = '100.00', 'declining leaves the agreed price at 100');
select pg_temp.pn_assert(pg_temp.pn_notes('poster', 'g_main', 'price_declined') = 1, 'the proposer is told');
select pg_temp.pn_error('helper', pg_catalog.format($$select public.respond_price_proposal(%L, true)$$, (select id from pg_temp.pn_fixture where name = 'prop1')), 'P0001', 'a declined proposal cannot be accepted afterwards', 'no longer open');

-- ---------------------------------------------------------------------------
-- 4. Rounds 2 and 3: the helper proposes, the poster counters, the helper accepts the counter.
-- ---------------------------------------------------------------------------
select pg_temp.pn_assert(pg_temp.pn_propose('helper', 'g_main', '110') is not null, 'round 2: the helper proposes 110');
select pg_temp.pn_assert(pg_temp.pn_state('g_main', 2) = 'pending:110.00:100.00' and pg_temp.pn_notes('poster', 'g_main', 'price_proposed') = 1, 'round 2 is pending and the poster is told');
select pg_temp.pn_assert(pg_temp.pn_propose('poster', 'g_main', '105') is not null, 'round 3: the poster counters with 105');
select pg_temp.pn_assert(pg_temp.pn_state('g_main', 2) = 'declined:110.00:100.00', 'a counter declines the proposal it answers');
select pg_temp.pn_assert(pg_temp.pn_state('g_main', 3) = 'pending:105.00:100.00', 'and becomes the single pending proposal');
select pg_temp.pn_assert((select count(*) from public.price_proposals where gig_id = pg_temp.pn_id('g_main') and state = 'pending') = 1, 'never more than one pending proposal');
select pg_temp.pn_respond('helper', (select id::text from public.price_proposals where gig_id = pg_temp.pn_id('g_main') and round = 3), true);
select pg_temp.pn_assert(pg_temp.pn_state('g_main', 3) = 'accepted:105.00:100.00' and pg_temp.pn_agreed('g_main') = '105.00', 'accepting sets the agreed price to 105');
select pg_temp.pn_assert(pg_temp.pn_notes('poster', 'g_main', 'price_accepted') = 1 and pg_temp.pn_notes('helper', 'g_main', 'price_accepted') = 0, 'accepting notifies the proposer (the poster made round 3) and nobody else');
select pg_temp.pn_assert(pg_temp.pn_notes('poster', 'g_main', 'price_declined') = 1 and pg_temp.pn_notes('poster', 'g_main', 'price_proposed') = 1 and pg_temp.pn_notes('helper', 'g_main', 'price_proposed') = 2, 'the negotiation produced the expected notices: poster 1 decline + 1 proposal, helper 2 proposals');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, 99)$$, pg_temp.pn_id('g_main')), 'P0001', 'once a price is agreed the negotiation is over', 'already agreed');
select pg_temp.pn_error('helper', pg_catalog.format($$select public.respond_price_proposal(%L, true)$$, (select id from public.price_proposals where gig_id = pg_temp.pn_id('g_main') and round = 3)), 'P0001', 'an accepted proposal cannot be answered again', 'no longer open');
select pg_temp.pn_assert((select amount from public.gigs where id = pg_temp.pn_id('g_main')) = 100, 'the original budget (gigs.amount) is never rewritten');

-- ---------------------------------------------------------------------------
-- 5. Three rounds, whatever happens to them.
-- ---------------------------------------------------------------------------
select pg_temp.pn_propose('poster', 'g_rounds', '110');
select pg_temp.pn_respond('helper', (select id::text from public.price_proposals where gig_id = pg_temp.pn_id('g_rounds') and round = 1), false);
select pg_temp.pn_propose('helper', 'g_rounds', '120');
select pg_temp.pn_respond('poster', (select id::text from public.price_proposals where gig_id = pg_temp.pn_id('g_rounds') and round = 2), false);
select pg_temp.pn_propose('poster', 'g_rounds', '115');
select pg_temp.pn_assert((select count(*) from public.price_proposals where gig_id = pg_temp.pn_id('g_rounds')) = 3, 'three rounds used');
select pg_temp.pn_error('helper', pg_catalog.format($$select public.propose_price(%L, 118)$$, pg_temp.pn_id('g_rounds')), 'P0001', 'a fourth proposal is refused, even as a counter', 'three times');
select pg_temp.pn_respond('helper', (select id::text from public.price_proposals where gig_id = pg_temp.pn_id('g_rounds') and round = 3), false);
select pg_temp.pn_error('poster', pg_catalog.format($$select public.propose_price(%L, 117)$$, pg_temp.pn_id('g_rounds')), 'P0001', 'and after the last decline there is no fourth round either', 'three times');
select pg_temp.pn_assert(pg_temp.pn_agreed('g_rounds') = '100.00', 'three declined rounds leave the original price');
select pg_temp.pn_assert((select count(*) from public.price_proposals where gig_id = pg_temp.pn_id('g_rounds')) = 3, 'no row was added by the refused attempts');

-- ---------------------------------------------------------------------------
-- 6. Withdrawing counts as a round and notifies the other side.
-- ---------------------------------------------------------------------------
select pg_temp.pn_propose('helper', 'g_wd', '90');
select pg_temp.pn_exec('helper', pg_catalog.format($$select public.withdraw_price_proposal(%L)$$, (select id from public.price_proposals where gig_id = pg_temp.pn_id('g_wd') and round = 1)));
select pg_temp.pn_assert(pg_temp.pn_state('g_wd', 1) = 'withdrawn:90.00:100.00' and pg_temp.pn_agreed('g_wd') = '100.00', 'a withdrawn proposal changes nothing');
select pg_temp.pn_assert(pg_temp.pn_notes('poster', 'g_wd', 'price_withdrawn') = 1, 'the other side is told');
select pg_temp.pn_error('helper', pg_catalog.format($$select public.withdraw_price_proposal(%L)$$, (select id from public.price_proposals where gig_id = pg_temp.pn_id('g_wd') and round = 1)), 'P0001', 'a withdrawn proposal cannot be withdrawn again', 'no longer open');
select pg_temp.pn_error('poster', pg_catalog.format($$select public.respond_price_proposal(%L, true)$$, (select id from public.price_proposals where gig_id = pg_temp.pn_id('g_wd') and round = 1)), 'P0001', 'nor accepted', 'no longer open');
select pg_temp.pn_propose('helper', 'g_wd', '95');
select pg_temp.pn_assert(pg_temp.pn_state('g_wd', 2) = 'pending:95.00:100.00', 'after withdrawing, the proposer can propose again (round 2)');

-- ---------------------------------------------------------------------------
-- 7. The window closes when the helper asks to start: a pending proposal can no longer be accepted.
-- ---------------------------------------------------------------------------
select pg_temp.pn_propose('poster', 'g_late', '130');
update public.gigs set start_requested_at = now() where id = pg_temp.pn_id('g_late');
select pg_temp.pn_error('helper', pg_catalog.format($$select public.respond_price_proposal(%L, true)$$, (select id from public.price_proposals where gig_id = pg_temp.pn_id('g_late'))), 'P0001', 'a pending proposal cannot be accepted after start was requested', 'can no longer be changed');
select pg_temp.pn_assert(pg_temp.pn_agreed('g_late') = '100.00', 'the price stayed at 100');
select pg_temp.pn_exec('poster', pg_catalog.format($$select public.withdraw_price_proposal(%L)$$, (select id from public.price_proposals where gig_id = pg_temp.pn_id('g_late'))));
select pg_temp.pn_assert((select state::text from public.price_proposals where gig_id = pg_temp.pn_id('g_late')) = 'withdrawn', 'the proposer can still withdraw it');

-- ---------------------------------------------------------------------------
-- 8. Data rules and isolation between gigs.
-- ---------------------------------------------------------------------------
select pg_temp.pn_assert(pg_temp.pn_see('poster', 'g_open') = '0' and pg_temp.pn_see('poster', 'g_started') = '0', 'other gigs have no proposals');
select pg_temp.pn_error('admin', pg_catalog.format($$insert into public.price_proposals (gig_id, proposer_id, round, from_amount, amount) values (%L, %L, 1, 100, 100)$$, pg_temp.pn_id('g_open'), pg_temp.pn_id('poster')), '23514', 'the table itself refuses a "change" to the same price');
select pg_temp.pn_error('admin', pg_catalog.format($$insert into public.price_proposals (gig_id, proposer_id, round, from_amount, amount) values (%L, %L, 4, 100, 120)$$, pg_temp.pn_id('g_open'), pg_temp.pn_id('poster')), '23514', 'and a fourth round');
select pg_temp.pn_error('admin', pg_catalog.format($$insert into public.price_proposals (gig_id, proposer_id, round, from_amount, amount, state) values (%L, %L, 1, 100, 120, 'accepted')$$, pg_temp.pn_id('g_open'), pg_temp.pn_id('poster')), '23514', 'and an answered proposal without an answer time');

reset role;
rollback;
