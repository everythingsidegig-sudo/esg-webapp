-- ESG-SAFE-001 v1.0 / ESG-SAFE-002 v1.0, migration 0027: Block only (no Report, no Call 911).
-- Run only against an isolated Supabase test database after 0001 through 0027.
-- All fixtures roll back. Run as postgres (or an equivalent trusted role).
begin;

create temporary table bl_fixture (name text primary key, id uuid);
insert into bl_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['alice','bob','carol','dave','eve','frank','grace','stranger','outsider',
  'bl_inprogress','bl_inprogress2','bl_awaiting','bl_disputed',
  'bl_pend_a','bl_sel_reopen','bl_sel_cancel','bl_vis','bl_claim_fresh',
  'bl_pend_b','bl_sel_withdraw','bl_sel_withdraw_cancel']) as n(name);
grant select, update on bl_fixture to anon, authenticated;

create function pg_temp.bl_id(p_name text) returns uuid
language sql stable as $$ select id from pg_temp.bl_fixture where name = p_name; $$;
create function pg_temp.bl_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.bl_switch(p_user text) returns void language plpgsql as $$
declare v_id uuid;
begin
  if p_user = 'admin' then return; end if;
  if p_user = 'anon' then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    set local role anon;
  else
    select id into v_id from pg_temp.bl_fixture where name = p_user;
    perform set_config('request.jwt.claim.sub', v_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end;
$$;
create function pg_temp.bl_query(p_user text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.bl_switch(p_user);
  begin execute p_sql into v; exception when others then reset role; raise; end;
  reset role;
  return v;
end;
$$;
create function pg_temp.bl_exec(p_user text, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.bl_switch(p_user);
  begin execute p_sql; exception when others then reset role; raise; end;
  reset role;
end;
$$;
create function pg_temp.bl_error(p_user text, p_sql text, p_code text, p_label text, p_msg text default null) returns void
language plpgsql as $$
begin
  begin
    perform pg_temp.bl_exec(p_user, p_sql);
  exception when others then
    if sqlstate <> p_code or (p_msg is not null and position(p_msg in sqlerrm) = 0) then
      raise exception 'FAIL: % (got % %)', p_label, sqlstate, sqlerrm;
    end if;
    raise notice 'PASS: %', p_label; return;
  end;
  raise exception 'FAIL (expected error %): %', p_code, p_label;
end;
$$;
create function pg_temp.bl_denied(p_user text, p_sql text, p_label text) returns void
language plpgsql as $$ begin perform pg_temp.bl_error(p_user, p_sql, '42501', p_label); end; $$;
create function pg_temp.bl_block(p_blocker text, p_blocked text) returns void language sql as $$
  select pg_temp.bl_exec(p_blocker, pg_catalog.format($q$select public.block_user(%L)$q$, pg_temp.bl_id(p_blocked)));
$$;
create function pg_temp.bl_block_sql(p_blocked text) returns text language sql as $$
  select pg_catalog.format($q$select public.block_user(%L)$q$, pg_temp.bl_id(p_blocked));
$$;
create function pg_temp.bl_claim(p_gig text, p_user text) returns text language sql as $$
  select coalesce((select state::text from public.claims where gig_id = pg_temp.bl_id(p_gig) and provider_id = pg_temp.bl_id(p_user)), 'none');
$$;
create function pg_temp.bl_pending(p_gig text) returns bigint language sql as $$
  select count(*) from public.claims where gig_id = pg_temp.bl_id(p_gig) and state = 'pending';
$$;
create function pg_temp.bl_state(p_gig text) returns text language sql as $$
  select g.status::text || '/' || coalesce((select username from public.profiles where id = g.selected_provider_id), '-') || '/' ||
    (g.helper_withdrawn_at is not null)::text || '/' || (g.helper_removed_at is not null)::text
  from public.gigs g where g.id = pg_temp.bl_id(p_gig);
$$;
create function pg_temp.bl_chat(p_gig text) returns bigint language sql as $$
  select count(*) from public.chat_messages where gig_id = pg_temp.bl_id(p_gig);
$$;
create function pg_temp.bl_proposals(p_gig text) returns bigint language sql as $$
  select count(*) from public.price_proposals where gig_id = pg_temp.bl_id(p_gig);
$$;
create function pg_temp.bl_notes(p_user text, p_gig text, p_type text) returns bigint language sql as $$
  select count(*) from public.notifications where recipient_id = pg_temp.bl_id(p_user) and gig_id = pg_temp.bl_id(p_gig) and type = p_type;
$$;
create function pg_temp.bl_note_msg(p_user text, p_gig text, p_type text) returns text language sql as $$
  select message from public.notifications where recipient_id = pg_temp.bl_id(p_user) and gig_id = pg_temp.bl_id(p_gig) and type = p_type order by created_at desc limit 1;
$$;
create function pg_temp.bl_lemons(p_user text) returns int language sql as $$
  select lemon_count from public.profiles where id = pg_temp.bl_id(p_user);
$$;
create function pg_temp.bl_is_blocked(p_a text, p_b text) returns boolean language plpgsql as $fn$
declare v text;
begin
  v := pg_temp.bl_query('admin', pg_catalog.format($q$select esg_private.is_blocked(%L, %L)::text$q$, pg_temp.bl_id(p_a), pg_temp.bl_id(p_b)));
  return v = 'true';
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
  jsonb_build_object('username', 'BL' || replace(name, '_', '')), now(), now()
from bl_fixture where name in ('alice','bob','carol','dave','eve','frank','grace','stranger','outsider');

-- p_pending: providers with a pending claim. p_provider: the selected provider, if any (also gets a chat + open proposal).
create function pg_temp.bl_gig(p_name text, p_poster text, p_status text, p_provider text default null, p_pending text[] default array[]::text[]) returns void language plpgsql as $$
declare v_other text;
begin
  insert into public.gigs (id, poster_id, creation_request_id, service_type, title, description, amount, price_type, location_text, status,
    selected_provider_id, agreed_amount)
  values (pg_temp.bl_id(p_name), pg_temp.bl_id(p_poster), gen_random_uuid(), 'Cleaning', 'Gig ' || p_name, 'Description', 100, 'fixed', 'Kävlinge', p_status::public.gig_status,
    case when p_provider is not null then pg_temp.bl_id(p_provider) end, case when p_provider is not null then 120 end);
  if p_provider is not null then
    insert into public.claims (gig_id, provider_id, state, offer_amount) values (pg_temp.bl_id(p_name), pg_temp.bl_id(p_provider), 'selected', 120);
    insert into public.chat_messages (gig_id, sender_id, body) values (pg_temp.bl_id(p_name), pg_temp.bl_id(p_provider), 'Hello');
    insert into public.price_proposals (gig_id, proposer_id, round, from_amount, amount) values (pg_temp.bl_id(p_name), pg_temp.bl_id(p_poster), 1, 120, 110);
  end if;
  foreach v_other in array p_pending loop
    insert into public.claims (gig_id, provider_id, state, offer_amount) values (pg_temp.bl_id(p_name), pg_temp.bl_id(v_other), 'pending', 90);
  end loop;
end;
$$;

select pg_temp.bl_gig('bl_inprogress',  'alice', 'in_progress', 'bob');
select pg_temp.bl_gig('bl_inprogress2', 'dave',  'in_progress', 'carol');
select pg_temp.bl_gig('bl_awaiting',    'frank', 'awaiting_payment', 'grace');
select pg_temp.bl_gig('bl_disputed',    'frank', 'disputed', 'grace');

-- ---------------------------------------------------------------------------
-- 1. Structure.
-- ---------------------------------------------------------------------------
select pg_temp.bl_assert((select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname = 'block_user' and p.prosecdef and p.proconfig @> array['search_path=""']) = 1, 'block_user is SECURITY DEFINER with an empty search_path');
select pg_temp.bl_assert(has_function_privilege('authenticated', 'public.block_user(uuid)', 'EXECUTE') and not has_function_privilege('anon', 'public.block_user(uuid)', 'EXECUTE'), 'block_user: authenticated only');
select pg_temp.bl_assert((select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'esg_private' and p.proname = 'is_blocked' and p.prosecdef) = 1, 'esg_private.is_blocked is SECURITY DEFINER');
select pg_temp.bl_assert(has_function_privilege('authenticated', 'esg_private.is_blocked(uuid,uuid)', 'EXECUTE') and not has_function_privilege('anon', 'esg_private.is_blocked(uuid,uuid)', 'EXECUTE'), 'is_blocked: authenticated only, matching has_own_claim''s own convention');
select pg_temp.bl_assert((select relrowsecurity from pg_catalog.pg_class where oid = 'public.blocks'::regclass), 'the blocks table has row level security enabled');
select pg_temp.bl_assert(not has_table_privilege('anon', 'public.blocks', 'SELECT') and has_table_privilege('authenticated', 'public.blocks', 'SELECT'), 'blocks is readable by authenticated only');
select pg_temp.bl_assert(not has_table_privilege('authenticated', 'public.blocks', 'INSERT') and not has_table_privilege('authenticated', 'public.blocks', 'UPDATE') and not has_table_privilege('authenticated', 'public.blocks', 'DELETE'), 'blocks can only be written through block_user()');
select pg_temp.bl_assert((select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'gigs' and policyname = 'gigs_select' and roles = '{anon}') = 1, 'gigs_select is anon-only now (no esg_private reference, per the existing split-policy convention)');
select pg_temp.bl_assert((select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'gigs' and policyname = 'gigs_select_discovery' and roles = '{authenticated}') = 1, 'gigs_select_discovery carries the block check for authenticated');
select pg_temp.bl_assert((select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'public_profiles' and policyname = 'public_profiles_select_all' and roles = '{anon}') = 1, 'public_profiles_select_all is anon-only now');
select pg_temp.bl_assert((select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'public_profiles' and policyname = 'public_profiles_select_authenticated' and roles = '{authenticated}') = 1, 'public_profiles_select_authenticated carries the block check');

-- ---------------------------------------------------------------------------
-- 2. Refused while a gig between the pair is in progress / awaiting payment / disputed.
-- ---------------------------------------------------------------------------
select pg_temp.bl_error('alice', pg_temp.bl_block_sql('bob'), 'P0001', 'the poster cannot block while In Progress', 'in progress');
select pg_temp.bl_assert(not pg_temp.bl_is_blocked('alice', 'bob'), 'the refused attempt created no block');
select pg_temp.bl_assert(pg_temp.bl_state('bl_inprogress') = 'in_progress/BLbob/false/false', 'and left the gig untouched');
select pg_temp.bl_error('carol', pg_temp.bl_block_sql('dave'), 'P0001', 'nor can the provider, blocking the other way round', 'in progress');
select pg_temp.bl_assert(not pg_temp.bl_is_blocked('carol', 'dave'), 'no block from that attempt either');
select pg_temp.bl_error('frank', pg_temp.bl_block_sql('grace'), 'P0001', 'nor while awaiting payment', 'in progress');
select pg_temp.bl_error('grace', pg_temp.bl_block_sql('frank'), 'P0001', 'nor while disputed (same pair, a second blocking gig)', 'in progress');
select pg_temp.bl_assert(not pg_temp.bl_is_blocked('frank', 'grace'), 'still no block for that pair');

-- alice/bob's In Progress gig now resolves normally (same as any ordinary gig) -- clearing the way to
-- test that a block between them succeeds once nothing is left in progress.
update public.gigs set status = 'completed' where id = pg_temp.bl_id('bl_inprogress');

-- ---------------------------------------------------------------------------
-- 3. Poster blocks a provider with a pending claim: silent, no gig-state change, others unaffected.
-- ---------------------------------------------------------------------------
select pg_temp.bl_gig('bl_pend_a', 'alice', 'active', null, array['bob', 'carol']);
select pg_temp.bl_gig('bl_sel_reopen', 'alice', 'active', 'bob', array['carol', 'dave']);
select pg_temp.bl_gig('bl_sel_cancel', 'alice', 'active', 'bob');
select pg_temp.bl_gig('bl_vis', 'alice', 'active');
select pg_temp.bl_gig('bl_claim_fresh', 'alice', 'active');
select pg_temp.bl_assert(pg_temp.bl_chat('bl_sel_cancel') = 1 and pg_temp.bl_proposals('bl_sel_cancel') = 1, 'bl_sel_cancel starts with a chat message and an open proposal, before any block');

select pg_temp.bl_denied('anon', pg_temp.bl_block_sql('bob'), 'blocking requires authentication');
select pg_temp.bl_error('alice', pg_temp.bl_block_sql('alice'), 'P0001', 'alice cannot block herself', 'cannot block yourself');
select pg_temp.bl_error('alice', 'select public.block_user(gen_random_uuid())', 'P0001', 'blocking a made-up user id fails', 'User not found');

select pg_temp.bl_block('alice', 'bob');
select pg_temp.bl_assert(pg_temp.bl_is_blocked('alice', 'bob'), 'alice and bob are now mutually blocked');

-- 3a. The pending claim on bl_pend_a: bob's is closed, carol's pending claim is untouched, gig stays active.
select pg_temp.bl_assert(pg_temp.bl_claim('bl_pend_a', 'bob') = 'rejected', 'the poster blocking closes the pending claim as "rejected", like remove_helper');
select pg_temp.bl_assert(pg_temp.bl_claim('bl_pend_a', 'carol') = 'pending', 'an unrelated pending claim from someone else is unaffected');
select pg_temp.bl_assert(pg_temp.bl_state('bl_pend_a') = 'active/-/false/false', 'the gig itself never changes for a pending-claim-only closure');
select pg_temp.bl_assert(pg_temp.bl_notes('bob', 'bl_pend_a', 'helper_removed') = 0, 'closing a pending claim is silent, matching the ordinary pending-claim-rejection convention');

-- 3b. Selected/pre-start with other offers still pending: reopens.
select pg_temp.bl_assert(pg_temp.bl_claim('bl_sel_reopen', 'bob') = 'rejected', 'the blocked selected provider is rejected, not withdrawn (they did not choose this)');
select pg_temp.bl_assert(pg_temp.bl_pending('bl_sel_reopen') = 2, 'both other pending offers are kept');
select pg_temp.bl_assert(pg_temp.bl_state('bl_sel_reopen') = 'active/-/false/false', 'the gig reopens to active with the helper fields cleared -- reopening never sets helper_removed_at, same as remove_helper (that marker means "cancelled", not "a relationship ended")');
select pg_temp.bl_assert(pg_temp.bl_chat('bl_sel_reopen') = 0 and pg_temp.bl_proposals('bl_sel_reopen') = 0, 'the chat and open proposal are gone');
select pg_temp.bl_assert(pg_temp.bl_notes('bob', 'bl_sel_reopen', 'helper_removed') = 1, 'the blocked provider is told the same way an ordinary removal would tell them');
select pg_temp.bl_assert(pg_temp.bl_note_msg('bob', 'bl_sel_reopen', 'helper_removed') = 'The poster removed you from "Gig bl_sel_reopen".', 'with the exact same wording remove_helper uses (minus a reason, since Block collects none) -- so being blocked is indistinguishable from an ordinary removal');

-- 3c. Selected/pre-start with nobody else waiting: cancels, but -- unlike remove_helper -- chat still disappears.
select pg_temp.bl_assert(pg_temp.bl_state('bl_sel_cancel') = 'cancelled/-/false/true', 'with no other offer, the gig is cancelled, same as remove_helper');
select pg_temp.bl_assert(pg_temp.bl_chat('bl_sel_cancel') = 0 and pg_temp.bl_proposals('bl_sel_cancel') = 0, 'but the chat and proposal are deleted anyway -- Block''s "existing Chat disappears" is unconditional, unlike the ordinary reopen-only clearing');

-- 3d. Idempotency: blocking again changes nothing further and raises no error.
select pg_temp.bl_block('alice', 'bob');
select pg_temp.bl_assert((select count(*) from public.blocks where blocker_id = pg_temp.bl_id('alice') and blocked_id = pg_temp.bl_id('bob')) = 1, 'blocking twice does not duplicate the block row');

-- ---------------------------------------------------------------------------
-- 4. The other direction: the provider blocks the poster.
-- ---------------------------------------------------------------------------
select pg_temp.bl_gig('bl_pend_b', 'eve', 'active', null, array['dave']);
select pg_temp.bl_gig('bl_sel_withdraw', 'eve', 'active', 'dave', array['carol']);
select pg_temp.bl_gig('bl_sel_withdraw_cancel', 'eve', 'active', 'dave');
select pg_temp.bl_assert(pg_temp.bl_chat('bl_sel_withdraw_cancel') = 1, 'bl_sel_withdraw_cancel starts with a chat message, before any block');

select pg_temp.bl_block('dave', 'eve');
select pg_temp.bl_assert(pg_temp.bl_claim('bl_pend_b', 'dave') = 'withdrawn', 'the provider blocking closes their own pending claim as "withdrawn", like withdraw_claim');
select pg_temp.bl_assert(pg_temp.bl_notes('eve', 'bl_pend_b', 'helper_withdrew') = 0, 'still silent for a pending-claim-only closure, same as the other direction');

select pg_temp.bl_assert(pg_temp.bl_claim('bl_sel_withdraw', 'dave') = 'withdrawn', 'the blocking provider''s own selected claim is withdrawn, not rejected');
select pg_temp.bl_assert(pg_temp.bl_pending('bl_sel_withdraw') = 1, 'the other pending offer is kept');
select pg_temp.bl_assert(pg_temp.bl_state('bl_sel_withdraw') = 'active/-/false/false', 'reopens with both helper fields clear, same as the poster-initiated reopen case');
select pg_temp.bl_assert(pg_temp.bl_notes('eve', 'bl_sel_withdraw', 'helper_withdrew') = 1, 'the poster is told the same way an ordinary withdrawal would tell them');
select pg_temp.bl_assert(pg_temp.bl_note_msg('eve', 'bl_sel_withdraw', 'helper_withdrew') like '@BLdave withdrew from "Gig bl_sel_withdraw". Other offers are still open, so you can choose another helper.', 'with withdraw_before_start''s exact wording -- again indistinguishable from an ordinary withdrawal');

select pg_temp.bl_assert(pg_temp.bl_state('bl_sel_withdraw_cancel') = 'cancelled/-/true/false', 'with nobody else waiting, it cancels, helper_withdrawn_at set');
select pg_temp.bl_assert(pg_temp.bl_chat('bl_sel_withdraw_cancel') = 0, 'and the chat still disappears even though the gig is cancelled');

-- ---------------------------------------------------------------------------
-- 5. Neither Report nor Block ever touches reputation (BR-SAFE-011 / BR-SAFE2-011).
-- ---------------------------------------------------------------------------
select pg_temp.bl_assert(pg_temp.bl_lemons('alice') = 0 and pg_temp.bl_lemons('bob') = 0 and pg_temp.bl_lemons('eve') = 0 and pg_temp.bl_lemons('dave') = 0, 'blocking never assigns a lemon to anyone involved');
select pg_temp.bl_assert((select count(*) from public.feedback where from_id in (pg_temp.bl_id('alice'), pg_temp.bl_id('bob'), pg_temp.bl_id('eve'), pg_temp.bl_id('dave'))) = 0, 'and no feedback row is ever created by a block');

-- ---------------------------------------------------------------------------
-- 6. Mutual visibility: a blocked pair disappears from each other's discovery and profile.
-- ---------------------------------------------------------------------------
select pg_temp.bl_assert(pg_temp.bl_query('bob', pg_catalog.format($$select count(*) from public.gigs where id = %L$$, pg_temp.bl_id('bl_vis')))::int = 0, 'bob can no longer see alice''s open gig in discovery');
select pg_temp.bl_assert(pg_temp.bl_query('carol', pg_catalog.format($$select count(*) from public.gigs where id = %L$$, pg_temp.bl_id('bl_vis')))::int = 1, 'an unrelated user still sees it fine');
select pg_temp.bl_assert(pg_temp.bl_query('anon', pg_catalog.format($$select count(*) from public.gigs where id = %L$$, pg_temp.bl_id('bl_vis')))::int = 1, 'and so does a signed-out visitor (blocking only applies between accounts)');
select pg_temp.bl_assert(pg_temp.bl_query('bob', pg_catalog.format($$select count(*) from public.public_profiles where id = %L$$, pg_temp.bl_id('alice')))::int = 0, 'bob can no longer see alice''s public profile');
select pg_temp.bl_assert(pg_temp.bl_query('alice', pg_catalog.format($$select count(*) from public.public_profiles where id = %L$$, pg_temp.bl_id('bob')))::int = 0, 'nor alice his -- the block is mutual regardless of who initiated it');
select pg_temp.bl_assert(pg_temp.bl_query('carol', pg_catalog.format($$select count(*) from public.public_profiles where id = %L$$, pg_temp.bl_id('alice')))::int = 1, 'an unrelated user still sees alice''s profile');

-- ---------------------------------------------------------------------------
-- 7. Future interaction: a blocked pair cannot create a new claim on each other's gigs.
-- ---------------------------------------------------------------------------
select pg_temp.bl_error('bob', pg_catalog.format($$select public.create_claim(%L, 90, null)$$, pg_temp.bl_id('bl_claim_fresh')), 'P0001', 'bob cannot claim alice''s brand-new gig once blocked', 'Gig is not open for claims');
select pg_temp.bl_assert(pg_temp.bl_claim('bl_claim_fresh', 'bob') = 'none', 'and the refused attempt left no claim behind');
-- A stale claim from before the block is still just handed back unchanged (create_claim's own
-- pre-existing "retries return the existing offer unchanged" rule, now also covering a blocked pair).
select pg_temp.bl_assert(pg_temp.bl_query('bob', pg_catalog.format($$select state::text from public.create_claim(%L, 90, null)$$, pg_temp.bl_id('bl_pend_a'))) = 'rejected', 'retrying on a gig where bob already has a (block-closed) claim just returns it as-is, not a fresh error');

-- ---------------------------------------------------------------------------
-- 8. The blocks table itself: only the blocker can see their own row.
-- ---------------------------------------------------------------------------
select pg_temp.bl_assert(pg_temp.bl_query('alice', pg_catalog.format($$select count(*) from public.blocks where blocker_id = %L and blocked_id = %L$$, pg_temp.bl_id('alice'), pg_temp.bl_id('bob')))::int = 1, 'alice can see the block she created');
select pg_temp.bl_assert(pg_temp.bl_query('bob', pg_catalog.format($$select count(*) from public.blocks where blocked_id = %L$$, pg_temp.bl_id('bob')))::int = 0, 'bob cannot see who blocked him');

reset role;
rollback;
