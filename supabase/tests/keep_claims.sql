-- Keeping the other offers (migration 0024): choosing a helper no longer rejects the other pending offers;
-- they end with the gig, and when the chosen helper leaves before the start the gig reopens for them.
-- Run only against an isolated Supabase test database after 0001 through 0024.
-- All fixtures roll back. Run as postgres (or an equivalent trusted role).
begin;

create temporary table kc_fixture (name text primary key, id uuid);
insert into kc_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['poster','helper','other1','other2','stranger','outsider','g_pick','g_late','g_rm','g_rm_last','g_rm_gone','g_wu','g_wd','g_cancel','g_priv','g_second','g_rmw','g_done','g_inc','g_pay','g_can','g_prog']) as n(name);
grant select, update on kc_fixture to anon, authenticated;

create function pg_temp.kc_id(p_name text) returns uuid
language sql stable as $$ select id from pg_temp.kc_fixture where name = p_name; $$;
create function pg_temp.kc_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.kc_switch(p_user text) returns void language plpgsql as $$
declare v_id uuid;
begin
  if p_user = 'admin' then return; end if;
  if p_user = 'anon' then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    set local role anon;
  else
    select id into v_id from pg_temp.kc_fixture where name = p_user;
    perform set_config('request.jwt.claim.sub', v_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end;
$$;
create function pg_temp.kc_query(p_user text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.kc_switch(p_user);
  begin execute p_sql into v; exception when others then reset role; raise; end;
  reset role;
  return v;
end;
$$;
create function pg_temp.kc_exec(p_user text, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.kc_switch(p_user);
  begin execute p_sql; exception when others then reset role; raise; end;
  reset role;
end;
$$;
create function pg_temp.kc_error(p_user text, p_sql text, p_code text, p_label text, p_msg text default null) returns void
language plpgsql as $$
begin
  begin
    perform pg_temp.kc_exec(p_user, p_sql);
  exception when others then
    if sqlstate <> p_code or (p_msg is not null and position(p_msg in sqlerrm) = 0) then
      raise exception 'FAIL: % (got % %)', p_label, sqlstate, sqlerrm;
    end if;
    raise notice 'PASS: %', p_label; return;
  end;
  raise exception 'FAIL (expected error %): %', p_code, p_label;
end;
$$;
create function pg_temp.kc_denied(p_user text, p_sql text, p_label text) returns void
language plpgsql as $$ begin perform pg_temp.kc_error(p_user, p_sql, '42501', p_label); end; $$;
create function pg_temp.kc_call(p_user text, p_fn text, p_gig text) returns void language sql as $$
  select pg_temp.kc_exec(p_user, pg_catalog.format($q$select public.%I(%L)$q$, p_fn, pg_temp.kc_id(p_gig)));
$$;
create function pg_temp.kc_state(p_gig text) returns text language sql as $$
  select g.status::text || '/' || coalesce((select username from public.profiles where id = g.selected_provider_id), '-') || '/' ||
    (g.start_requested_at is not null)::text || '/' || g.start_wait_count::text || '/' || (g.helper_withdrawn_at is not null)::text || '/' || (g.helper_removed_at is not null)::text
  from public.gigs g where g.id = pg_temp.kc_id(p_gig);
$$;
create function pg_temp.kc_notes(p_user text, p_gig text, p_type text) returns bigint language sql as $$
  select count(*) from public.notifications where recipient_id = pg_temp.kc_id(p_user) and gig_id = pg_temp.kc_id(p_gig) and type = p_type;
$$;
create function pg_temp.kc_claim(p_gig text, p_user text) returns text language sql as $$
  select coalesce((select state::text from public.claims where gig_id = pg_temp.kc_id(p_gig) and provider_id = pg_temp.kc_id(p_user)), 'none');
$$;
create function pg_temp.kc_lemons(p_user text) returns int language sql as $$
  select lemon_count from public.profiles where id = pg_temp.kc_id(p_user);
$$;
create function pg_temp.kc_address(p_user text, p_gig text) returns text language plpgsql as $fn$
begin
  return pg_temp.kc_query(p_user, pg_catalog.format($q$select coalesce((select address_text from public.gig_private_locations where gig_id = %L), '')$q$, pg_temp.kc_id(p_gig)));
end;
$fn$;
create function pg_temp.kc_public(p_gig text) returns text language plpgsql as $fn$
begin
  return pg_temp.kc_query('anon', pg_catalog.format($q$select count(*)::text from public.gigs where id = %L$q$, pg_temp.kc_id(p_gig)));
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
  jsonb_build_object('username', 'KC' || replace(name, '_', '')), now(), now()
from kc_fixture where name in ('poster', 'helper', 'other1', 'other2', 'stranger', 'outsider');


-- p_others: how many of other1/other2 hold a pending offer. A gig with a helper also gets a chat and an open price proposal.
create function pg_temp.kc_gig(p_name text, p_status text, p_helper boolean, p_others int default 2, p_requested_hours_ago numeric default null,
  p_waits int default 0, p_wait_until_hours numeric default null, p_delayed boolean default false, p_private boolean default false) returns void language plpgsql as $$
begin
  insert into public.gigs (id, poster_id, creation_request_id, service_type, title, description, amount, price_type, location_text, status,
    selected_provider_id, agreed_amount, requested_helper_id, start_requested_at, start_delayed_at, start_wait_count, start_wait_until)
  values (pg_temp.kc_id(p_name), pg_temp.kc_id('poster'), gen_random_uuid(), 'Cleaning', 'Gig ' || p_name, 'Description', 100, 'fixed', 'Kävlinge', p_status::public.gig_status,
    case when p_helper then pg_temp.kc_id('helper') end, case when p_helper then 120 end, case when p_private then pg_temp.kc_id('helper') end,
    case when p_requested_hours_ago is not null then pg_catalog.now() - pg_catalog.make_interval(secs => (p_requested_hours_ago * 3600)::double precision) end,
    case when p_delayed then pg_catalog.now() - interval '1 hour' end, p_waits,
    case when p_wait_until_hours is not null then pg_catalog.now() + pg_catalog.make_interval(secs => (p_wait_until_hours * 3600)::double precision) end);
  if p_helper then
    insert into public.claims (gig_id, provider_id, state, offer_amount) values (pg_temp.kc_id(p_name), pg_temp.kc_id('helper'), 'selected', 120);
    insert into public.chat_messages (gig_id, sender_id, body) values (pg_temp.kc_id(p_name), pg_temp.kc_id('helper'), 'Hello from the first helper');
    insert into public.chat_messages (gig_id, sender_id, body) values (pg_temp.kc_id(p_name), pg_temp.kc_id('poster'), 'Hello back');
    insert into public.price_proposals (gig_id, proposer_id, round, from_amount, amount) values (pg_temp.kc_id(p_name), pg_temp.kc_id('poster'), 1, 120, 110);
  end if;
  if p_others >= 1 then
    insert into public.claims (gig_id, provider_id, state, offer_amount) values (pg_temp.kc_id(p_name), pg_temp.kc_id('other1'), 'pending', 90);
  end if;
  if p_others >= 2 then
    insert into public.claims (gig_id, provider_id, state, offer_amount) values (pg_temp.kc_id(p_name), pg_temp.kc_id('other2'), 'pending', 95);
  end if;
  insert into public.gig_private_locations (gig_id, address_text) values (pg_temp.kc_id(p_name), '1 Private Street');
end;
$$;
create function pg_temp.kc_chat(p_user text, p_gig text) returns int language plpgsql as $fn$
begin
  return pg_temp.kc_query(p_user, pg_catalog.format($q$select count(*) from public.chat_messages where gig_id = %L$q$, pg_temp.kc_id(p_gig)))::int;
end;
$fn$;
create function pg_temp.kc_proposals(p_gig text) returns bigint language sql as $$
  select count(*) from public.price_proposals where gig_id = pg_temp.kc_id(p_gig);
$$;
create function pg_temp.kc_pending(p_gig text) returns bigint language sql as $$
  select count(*) from public.claims where gig_id = pg_temp.kc_id(p_gig) and state = 'pending';
$$;
select pg_temp.kc_gig('g_pick',   'active', false);                       -- open, two offers, ready to choose from
select pg_temp.kc_gig('g_late',   'active', false, 0);
select pg_temp.kc_gig('g_rm',     'active', true);                        -- helper chosen, two other offers
select pg_temp.kc_gig('g_rm_last','active', true, 0);                     -- helper chosen, nobody else
select pg_temp.kc_gig('g_rm_gone','active', true);                        -- helper chosen; the other offers will be withdrawn
select pg_temp.kc_gig('g_wu',     'active', true, 2, 80, 2, -1);          -- unanswered start, both waits over
select pg_temp.kc_gig('g_wd',     'active', true, 2, 5, 0, null, true);   -- start delayed by the poster
select pg_temp.kc_gig('g_cancel', 'active', false);
select pg_temp.kc_gig('g_priv',   'active', true, 0, null, 0, null, false, true);
select pg_temp.kc_gig('g_second', 'active', true, 1);
select pg_temp.kc_gig('g_rmw',    'active', true, 1, 30, 1, 10);           -- unanswered start, one wait taken and still running
select pg_temp.kc_gig('g_done',   'in_progress', true);
select pg_temp.kc_gig('g_inc',    'in_progress', true);
select pg_temp.kc_gig('g_pay',    'in_progress', true);
select pg_temp.kc_gig('g_can',    'active', true);
select pg_temp.kc_gig('g_prog',   'in_progress', true);

-- ---------------------------------------------------------------------------
-- 1. Structure.
-- ---------------------------------------------------------------------------
select pg_temp.kc_assert((select count(*) from pg_trigger where tgname = 'gigs_close_pending_claims' and not tgisinternal) = 1, 'the closing trigger exists');
select pg_temp.kc_assert(not has_function_privilege('authenticated', 'public.close_pending_claims()', 'EXECUTE') and not has_function_privilege('anon', 'public.close_pending_claims()', 'EXECUTE'), 'the trigger function is not callable by clients');
select pg_temp.kc_assert((select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('select_provider', 'withdraw_from_gig', 'withdraw_unanswered', 'remove_helper', 'close_pending_claims') and p.prosecdef and p.proconfig @> array['search_path=""']) = 5, 'all five functions are SECURITY DEFINER with an empty search_path');
select pg_temp.kc_assert(has_function_privilege('authenticated', 'public.select_provider(uuid,uuid)', 'EXECUTE') and not has_function_privilege('anon', 'public.select_provider(uuid,uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.remove_helper(uuid)', 'EXECUTE') and not has_function_privilege('anon', 'public.remove_helper(uuid)', 'EXECUTE'), 'replacing the functions kept their grants');

-- ---------------------------------------------------------------------------
-- 2. Choosing a helper keeps the other offers.
-- ---------------------------------------------------------------------------
select pg_temp.kc_exec('poster', pg_catalog.format($$select public.select_provider(%L, %L)$$, pg_temp.kc_id('g_pick'),
  (select id from public.claims where gig_id = pg_temp.kc_id('g_pick') and provider_id = pg_temp.kc_id('other1'))));
select pg_temp.kc_assert((select selected_provider_id = pg_temp.kc_id('other1') and agreed_amount = 90 and status = 'active' from public.gigs where id = pg_temp.kc_id('g_pick')), 'the chosen helper and their offer are recorded');
select pg_temp.kc_assert(pg_temp.kc_claim('g_pick', 'other1') = 'selected' and pg_temp.kc_claim('g_pick', 'other2') = 'pending', 'the other offer stays pending');
select pg_temp.kc_assert(pg_temp.kc_notes('other1', 'g_pick', 'selected') = 1 and pg_temp.kc_notes('other2', 'g_pick', 'selected') = 0, 'only the chosen helper is told they were selected');
select pg_temp.kc_error('poster', pg_catalog.format($$select public.select_provider(%L, %L)$$, pg_temp.kc_id('g_pick'),
  (select id from public.claims where gig_id = pg_temp.kc_id('g_pick') and provider_id = pg_temp.kc_id('other2'))), 'P0001', 'a second helper cannot be chosen while one is', 'Provider already selected');
select pg_temp.kc_assert((select count(*) from public.claims where gig_id = pg_temp.kc_id('g_pick') and state = 'selected') = 1, 'still exactly one selected helper');
select pg_temp.kc_assert(pg_temp.kc_query('poster', pg_catalog.format($$select count(*) from public.claims where gig_id = %L and state = 'pending'$$, pg_temp.kc_id('g_pick')))::int = 1, 'the poster can still see the waiting offer');
-- What a waiting helper can and cannot do.
select pg_temp.kc_assert(pg_temp.kc_address('other2', 'g_pick') = '' and pg_temp.kc_address('other1', 'g_pick') = '1 Private Street', 'a waiting helper never sees the private address');
select pg_temp.kc_assert(pg_temp.kc_chat('other2', 'g_pick') = 0, 'nor the conversation');
select pg_temp.kc_denied('other2', pg_catalog.format($$insert into public.chat_messages (gig_id, sender_id, body) values (%L, %L, 'me too')$$, pg_temp.kc_id('g_pick'), pg_temp.kc_id('other2')), 'nor can they post into it');
select pg_temp.kc_assert(pg_temp.kc_query('other2', pg_catalog.format($$select count(*) from public.gigs where id = %L$$, pg_temp.kc_id('g_pick')))::int = 1, 'they can still open the gig to see where their offer stands');
select pg_temp.kc_assert(pg_temp.kc_public('g_pick') = '0', 'an assigned gig is not public');
select pg_temp.kc_error('outsider', pg_catalog.format($$select public.create_claim(%L, 70)$$, pg_temp.kc_id('g_pick')), 'P0001', 'nobody new can make an offer while a helper is chosen', 'Gig is not open for claims');
select pg_temp.kc_assert(pg_temp.kc_claim('g_pick', 'outsider') = 'none', 'and the refused offer left no claim behind');
select pg_temp.kc_denied('other2', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.kc_id('g_pick')), 'a waiting helper cannot remove the chosen one');
select pg_temp.kc_call('other2', 'withdraw_claim', 'g_pick');
select pg_temp.kc_assert(pg_temp.kc_claim('g_pick', 'other2') = 'withdrawn', 'a waiting helper can still withdraw their offer');

-- ---------------------------------------------------------------------------
-- 3. The offers end with the gig; not before.
-- ---------------------------------------------------------------------------
update public.gigs set status = 'awaiting_payment' where id = pg_temp.kc_id('g_pay');
select pg_temp.kc_assert(pg_temp.kc_pending('g_pay') = 2 and pg_temp.kc_pending('g_prog') = 2, 'still pending while the gig is in progress or awaiting payment');
update public.gigs set status = 'disputed' where id = pg_temp.kc_id('g_prog');
select pg_temp.kc_assert(pg_temp.kc_pending('g_prog') = 2, 'and while it is disputed');
update public.gigs set status = 'completed' where id = pg_temp.kc_id('g_done');
select pg_temp.kc_assert(pg_temp.kc_pending('g_done') = 0 and pg_temp.kc_claim('g_done', 'other1') = 'rejected' and pg_temp.kc_claim('g_done', 'other2') = 'rejected', 'completing the gig rejects the waiting offers');
select pg_temp.kc_assert(pg_temp.kc_claim('g_done', 'helper') = 'selected', 'and leaves the chosen helper selected');
update public.gigs set status = 'incomplete' where id = pg_temp.kc_id('g_inc');
select pg_temp.kc_assert(pg_temp.kc_pending('g_inc') = 0 and pg_temp.kc_claim('g_inc', 'other1') = 'rejected', 'an incomplete gig closes them too');
update public.gigs set status = 'completed' where id = pg_temp.kc_id('g_pay');
select pg_temp.kc_assert(pg_temp.kc_pending('g_pay') = 0, 'payment then completion also closes them');
-- A gig with no helper that the poster cancels: unchanged behaviour.
select pg_temp.kc_call('poster', 'cancel_gig', 'g_cancel');
select pg_temp.kc_assert(pg_temp.kc_pending('g_cancel') = 0 and pg_temp.kc_claim('g_cancel', 'other1') = 'rejected', 'cancelling an open gig rejects the offers as before');

-- ---------------------------------------------------------------------------
-- 4. The poster removes the helper: the gig reopens for the waiting offers.
-- ---------------------------------------------------------------------------
select pg_temp.kc_assert(pg_temp.kc_chat('helper', 'g_rm') = 2 and pg_temp.kc_proposals('g_rm') = 1, 'before removal there is a conversation and an open proposal');
select pg_temp.kc_call('poster', 'remove_helper', 'g_rm');
select pg_temp.kc_assert(pg_temp.kc_state('g_rm') = 'active/-/false/0/false/false', 'the gig reopens: active, no helper, nothing recorded as closed');
select pg_temp.kc_assert(pg_temp.kc_claim('g_rm', 'helper') = 'rejected' and pg_temp.kc_pending('g_rm') = 2, 'the removed helper is out, both waiting offers are pending');
select pg_temp.kc_assert((select agreed_amount is null and start_requested_at is null and start_wait_until is null from public.gigs where id = pg_temp.kc_id('g_rm')), 'the agreement and start fields are cleared');
select pg_temp.kc_assert(pg_temp.kc_notes('helper', 'g_rm', 'helper_removed') = 1, 'the removed helper is told');
select pg_temp.kc_assert(pg_temp.kc_chat('poster', 'g_rm') = 0 and pg_temp.kc_proposals('g_rm') = 0, 'the old conversation and proposals are gone, so the next helper starts clean');
select pg_temp.kc_assert(pg_temp.kc_address('helper', 'g_rm') = '' and pg_temp.kc_address('poster', 'g_rm') = '1 Private Street', 'the removed helper loses the address');
select pg_temp.kc_assert(pg_temp.kc_public('g_rm') = '1', 'the reopened gig is public again');
select pg_temp.kc_assert(pg_temp.kc_lemons('poster') = 0, 'removal costs nobody a lemon');
select pg_temp.kc_exec('helper', pg_catalog.format($$select public.create_claim(%L, 50)$$, pg_temp.kc_id('g_rm')));
select pg_temp.kc_assert(pg_temp.kc_claim('g_rm', 'helper') = 'rejected', 'the removed helper cannot claim it again');
-- The poster now chooses one of the waiting offers; the new helper sees nothing of the first conversation.
select pg_temp.kc_exec('poster', pg_catalog.format($$select public.select_provider(%L, %L)$$, pg_temp.kc_id('g_rm'),
  (select id from public.claims where gig_id = pg_temp.kc_id('g_rm') and provider_id = pg_temp.kc_id('other2'))));
select pg_temp.kc_assert((select selected_provider_id = pg_temp.kc_id('other2') and agreed_amount = 95 from public.gigs where id = pg_temp.kc_id('g_rm')), 'the poster can choose a waiting helper, at their own offer');
select pg_temp.kc_assert(pg_temp.kc_chat('other2', 'g_rm') = 0 and pg_temp.kc_address('other2', 'g_rm') = '1 Private Street', 'the new helper starts with an empty chat and gets the address');
select pg_temp.kc_assert(pg_temp.kc_pending('g_rm') = 1 and pg_temp.kc_claim('g_rm', 'other1') = 'pending', 'the remaining offer keeps waiting');
-- And again: removing the second helper reopens it for the last waiting offer; removing that one closes it for good.
select pg_temp.kc_call('poster', 'remove_helper', 'g_rm');
select pg_temp.kc_assert(pg_temp.kc_state('g_rm') = 'active/-/false/0/false/false' and pg_temp.kc_pending('g_rm') = 1, 'removing the second helper reopens it for the last offer');
select pg_temp.kc_exec('poster', pg_catalog.format($$select public.select_provider(%L, %L)$$, pg_temp.kc_id('g_rm'),
  (select id from public.claims where gig_id = pg_temp.kc_id('g_rm') and provider_id = pg_temp.kc_id('other1'))));
select pg_temp.kc_call('poster', 'remove_helper', 'g_rm');
select pg_temp.kc_assert(pg_temp.kc_state('g_rm') = 'cancelled/-/false/0/false/true' and pg_temp.kc_pending('g_rm') = 0, 'with no offer left the gig closes as cancelled, as before');

-- Removing while the helper is mid-wait: the wait bookkeeping is reset for the next helper.
select pg_temp.kc_assert(pg_temp.kc_state('g_rmw') = 'active/KChelper/true/1/false/false', 'g_rmw starts with a start request and one wait taken');
select pg_temp.kc_call('poster', 'remove_helper', 'g_rmw');
select pg_temp.kc_assert(pg_temp.kc_state('g_rmw') = 'active/-/false/0/false/false' and (select start_wait_until is null from public.gigs where id = pg_temp.kc_id('g_rmw')), 'removing mid-wait reopens the gig with the wait count and timer reset');

-- Nobody else waiting: the old behaviour.
select pg_temp.kc_assert(pg_temp.kc_chat('helper', 'g_rm_last') = 2 and pg_temp.kc_proposals('g_rm_last') = 1, 'g_rm_last has a conversation');
select pg_temp.kc_call('poster', 'remove_helper', 'g_rm_last');
select pg_temp.kc_assert(pg_temp.kc_state('g_rm_last') = 'cancelled/-/false/0/false/true', 'removing the only helper closes the gig as cancelled');
select pg_temp.kc_assert(pg_temp.kc_chat('poster', 'g_rm_last') = 2 and pg_temp.kc_proposals('g_rm_last') = 1, 'and leaves its conversation alone (nothing reopens)');
-- The waiting helpers withdrew before the chosen one left.
select pg_temp.kc_call('other1', 'withdraw_claim', 'g_rm_gone');
select pg_temp.kc_call('other2', 'withdraw_claim', 'g_rm_gone');
select pg_temp.kc_call('poster', 'remove_helper', 'g_rm_gone');
select pg_temp.kc_assert(pg_temp.kc_state('g_rm_gone') = 'cancelled/-/false/0/false/true', 'if every waiting helper withdrew, removal closes the gig');
-- A private request has no other offers.
select pg_temp.kc_call('poster', 'remove_helper', 'g_priv');
select pg_temp.kc_assert(pg_temp.kc_state('g_priv') = 'cancelled/-/false/0/false/true' and pg_temp.kc_public('g_priv') = '0', 'a private request closes and stays private');
select pg_temp.kc_error('poster', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.kc_id('g_prog')), 'P0001', 'removal is still refused once the gig is in progress', 'before the gig starts');

-- ---------------------------------------------------------------------------
-- 5. The helper leaves after silence or a delay: same reopening, same lemon rule.
-- ---------------------------------------------------------------------------
select pg_temp.kc_call('helper', 'withdraw_unanswered', 'g_wu');
select pg_temp.kc_assert(pg_temp.kc_state('g_wu') = 'active/-/false/0/false/false' and pg_temp.kc_pending('g_wu') = 2, 'after silence the helper withdraws and the gig reopens for the waiting offers');
select pg_temp.kc_assert(pg_temp.kc_lemons('poster') = 1 and pg_temp.kc_lemons('helper') = 0, 'the poster still gets exactly one lemon');
select pg_temp.kc_assert(pg_temp.kc_claim('g_wu', 'helper') = 'withdrawn', 'the helper''s claim is closed for good');
select pg_temp.kc_assert((select message like '%You received a lemon%Other offers are still open%' from public.notifications where gig_id = pg_temp.kc_id('g_wu') and type = 'helper_withdrew' limit 1), 'the poster is told about the lemon and the open offers');
select pg_temp.kc_assert(pg_temp.kc_chat('poster', 'g_wu') = 0 and pg_temp.kc_proposals('g_wu') = 0, 'the first helper''s conversation is cleared');
select pg_temp.kc_exec('helper', pg_catalog.format($$select public.create_claim(%L, 50)$$, pg_temp.kc_id('g_wu')));
select pg_temp.kc_assert(pg_temp.kc_claim('g_wu', 'helper') = 'withdrawn', 'and they cannot claim it again');

select pg_temp.kc_call('helper', 'withdraw_from_gig', 'g_wd');
select pg_temp.kc_assert(pg_temp.kc_state('g_wd') = 'active/-/false/0/false/false' and pg_temp.kc_pending('g_wd') = 2, 'after a delay the helper withdraws and the gig reopens');
select pg_temp.kc_assert(pg_temp.kc_chat('poster', 'g_wd') = 0 and pg_temp.kc_proposals('g_wd') = 0, 'and the first helper''s conversation and proposals are cleared');
select pg_temp.kc_assert(pg_temp.kc_lemons('poster') = 1, 'with no extra lemon (the poster did answer)');
select pg_temp.kc_assert((select start_delayed_at is null and start_requested_at is null from public.gigs where id = pg_temp.kc_id('g_wd')), 'the delay is cleared for the next helper');
select pg_temp.kc_assert((select message like '%Other offers are still open%' from public.notifications where gig_id = pg_temp.kc_id('g_wd') and type = 'helper_withdrew' limit 1), 'the poster is told');
-- Reopened, then cancelled by the poster: the waiting offers are closed.
select pg_temp.kc_call('poster', 'cancel_gig', 'g_wd');
select pg_temp.kc_assert(pg_temp.kc_state('g_wd') like 'cancelled/%' and pg_temp.kc_pending('g_wd') = 0 and pg_temp.kc_claim('g_wd', 'other1') = 'rejected', 'cancelling the reopened gig rejects the waiting offers');

-- The existing rules around it are untouched.
select pg_temp.kc_denied('anon', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.kc_id('g_can')), 'anon still cannot remove a helper');
select pg_temp.kc_denied('stranger', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.kc_id('g_can')), 'nor a stranger');
select pg_temp.kc_denied('helper', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.kc_id('g_can')), 'nor the helper');
select pg_temp.kc_denied('anon', pg_catalog.format($$select public.select_provider(%L, gen_random_uuid())$$, pg_temp.kc_id('g_late')), 'anon cannot choose a helper');
select pg_temp.kc_denied('stranger', pg_catalog.format($$select public.select_provider(%L, gen_random_uuid())$$, pg_temp.kc_id('g_late')), 'nor a stranger');
select pg_temp.kc_error('poster', pg_catalog.format($$select public.select_provider(%L, gen_random_uuid())$$, pg_temp.kc_id('g_late')), 'P0001', 'choosing a made-up offer still fails', 'Claim not found or not actionable');

reset role;
rollback;
