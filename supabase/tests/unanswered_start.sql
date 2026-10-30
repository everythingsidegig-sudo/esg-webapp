-- Unanswered start request and removing a helper (migration 0023): the two 24-hour waits, withdrawing
-- after the poster stayed silent (the poster gets a lemon), and the poster removing a helper before the start.
-- Run only against an isolated Supabase test database after 0001 through 0023.
-- All fixtures roll back. Run as postgres (or an equivalent trusted role).
begin;

create temporary table us_fixture (name text primary key, id uuid);
insert into us_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['poster','helper','stranger','other_helper','g_new','g_old','g_wait2','g_one','g_ready','g_early','g_delayed','g_noreq','g_prog','g_rm1','g_rm2','g_rm_prog','g_rm_open','g_rm_priv','g_approve']) as n(name);
grant select, update on us_fixture to anon, authenticated;

create function pg_temp.us_id(p_name text) returns uuid
language sql stable as $$ select id from pg_temp.us_fixture where name = p_name; $$;
create function pg_temp.us_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.us_switch(p_user text) returns void language plpgsql as $$
declare v_id uuid;
begin
  if p_user = 'admin' then return; end if;
  if p_user = 'anon' then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    set local role anon;
  else
    select id into v_id from pg_temp.us_fixture where name = p_user;
    perform set_config('request.jwt.claim.sub', v_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end;
$$;
create function pg_temp.us_query(p_user text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.us_switch(p_user);
  begin execute p_sql into v; exception when others then reset role; raise; end;
  reset role;
  return v;
end;
$$;
create function pg_temp.us_exec(p_user text, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.us_switch(p_user);
  begin execute p_sql; exception when others then reset role; raise; end;
  reset role;
end;
$$;
create function pg_temp.us_error(p_user text, p_sql text, p_code text, p_label text, p_msg text default null) returns void
language plpgsql as $$
begin
  begin
    perform pg_temp.us_exec(p_user, p_sql);
  exception when others then
    if sqlstate <> p_code or (p_msg is not null and position(p_msg in sqlerrm) = 0) then
      raise exception 'FAIL: % (got % %)', p_label, sqlstate, sqlerrm;
    end if;
    raise notice 'PASS: %', p_label; return;
  end;
  raise exception 'FAIL (expected error %): %', p_code, p_label;
end;
$$;
create function pg_temp.us_denied(p_user text, p_sql text, p_label text) returns void
language plpgsql as $$ begin perform pg_temp.us_error(p_user, p_sql, '42501', p_label); end; $$;
create function pg_temp.us_call(p_user text, p_fn text, p_gig text) returns void language sql as $$
  select pg_temp.us_exec(p_user, pg_catalog.format($q$select public.%I(%L)$q$, p_fn, pg_temp.us_id(p_gig)));
$$;
create function pg_temp.us_state(p_gig text) returns text language sql as $$
  select g.status::text || '/' || coalesce((select username from public.profiles where id = g.selected_provider_id), '-') || '/' ||
    (g.start_requested_at is not null)::text || '/' || g.start_wait_count::text || '/' || (g.helper_withdrawn_at is not null)::text || '/' || (g.helper_removed_at is not null)::text
  from public.gigs g where g.id = pg_temp.us_id(p_gig);
$$;
create function pg_temp.us_notes(p_user text, p_gig text, p_type text) returns bigint language sql as $$
  select count(*) from public.notifications where recipient_id = pg_temp.us_id(p_user) and gig_id = pg_temp.us_id(p_gig) and type = p_type;
$$;
create function pg_temp.us_claim(p_gig text, p_user text) returns text language sql as $$
  select coalesce((select state::text from public.claims where gig_id = pg_temp.us_id(p_gig) and provider_id = pg_temp.us_id(p_user)), 'none');
$$;
create function pg_temp.us_lemons(p_user text) returns int language sql as $$
  select lemon_count from public.profiles where id = pg_temp.us_id(p_user);
$$;
create function pg_temp.us_address(p_user text, p_gig text) returns text language plpgsql as $fn$
begin
  return pg_temp.us_query(p_user, pg_catalog.format($q$select coalesce((select address_text from public.gig_private_locations where gig_id = %L), '')$q$, pg_temp.us_id(p_gig)));
end;
$fn$;
create function pg_temp.us_public(p_gig text) returns text language plpgsql as $fn$
begin
  return pg_temp.us_query('anon', pg_catalog.format($q$select count(*)::text from public.gigs where id = %L$q$, pg_temp.us_id(p_gig)));
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
  jsonb_build_object('username', 'US' || replace(name, '_', '')), now(), now()
from us_fixture where name in ('poster', 'helper', 'stranger', 'other_helper');

-- p_requested_hours_ago: when the start was requested (null = never); p_waits / p_wait_until_hours: waits taken and when the
-- latest wait ends (hours from now, negative = already over); p_delayed: the poster answered with a delay.
create function pg_temp.us_gig(p_name text, p_status text, p_helper boolean, p_requested_hours_ago numeric default null, p_waits int default 0,
  p_wait_until_hours numeric default null, p_delayed boolean default false, p_private boolean default false) returns void language plpgsql as $$
begin
  insert into public.gigs (id, poster_id, creation_request_id, service_type, title, description, amount, price_type, location_text, status,
    selected_provider_id, agreed_amount, requested_helper_id, start_requested_at, start_delayed_at, start_wait_count, start_wait_until)
  values (pg_temp.us_id(p_name), pg_temp.us_id('poster'), gen_random_uuid(), 'Cleaning', 'Gig ' || p_name, 'Description', 100, 'fixed', 'Kävlinge', p_status::public.gig_status,
    case when p_helper then pg_temp.us_id('helper') end, case when p_helper then 120 end, case when p_private then pg_temp.us_id('helper') end,
    case when p_requested_hours_ago is not null then pg_catalog.now() - pg_catalog.make_interval(secs => (p_requested_hours_ago * 3600)::double precision) end,
    case when p_delayed then pg_catalog.now() - interval '1 hour' end, p_waits,
    case when p_wait_until_hours is not null then pg_catalog.now() + pg_catalog.make_interval(secs => (p_wait_until_hours * 3600)::double precision) end);
  if p_helper then
    insert into public.claims (gig_id, provider_id, state, offer_amount) values (pg_temp.us_id(p_name), pg_temp.us_id('helper'), 'selected', 120);
  end if;
  insert into public.gig_private_locations (gig_id, address_text) values (pg_temp.us_id(p_name), '1 Private Street');
end;
$$;
select pg_temp.us_gig('g_new',     'active', true, 1);                 -- asked 1 hour ago: too early to wait
select pg_temp.us_gig('g_old',     'active', true, 25);                -- asked 25 hours ago: the first wait is available
select pg_temp.us_gig('g_wait2',   'active', true, 49, 1, -1);         -- one wait taken and over: the second is available
select pg_temp.us_gig('g_one',     'active', true, 49, 1, -1);         -- one wait taken and over
select pg_temp.us_gig('g_ready',   'active', true, 80, 2, -1);         -- both waits over: may withdraw
select pg_temp.us_gig('g_early',   'active', true, 80, 2, 3);          -- second wait still running
select pg_temp.us_gig('g_delayed', 'active', true, 80, 2, -1, true);   -- the poster DID answer (delayed)
select pg_temp.us_gig('g_noreq',   'active', true);                    -- helper selected, no start request
select pg_temp.us_gig('g_prog',    'in_progress', true, 80);
select pg_temp.us_gig('g_rm1',     'active', true);                    -- removal before any start request
select pg_temp.us_gig('g_rm2',     'active', true, 5);                 -- removal while a start request waits
select pg_temp.us_gig('g_rm_prog', 'in_progress', true, 5);
select pg_temp.us_gig('g_rm_open', 'active', false);
select pg_temp.us_gig('g_rm_priv', 'active', true, null, 0, null, false, true);
select pg_temp.us_gig('g_approve', 'active', true, 1);

-- ---------------------------------------------------------------------------
-- 1. Structure and permissions.
-- ---------------------------------------------------------------------------
select pg_temp.us_assert((select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'gigs'
  and column_name in ('start_wait_count', 'start_wait_until', 'helper_removed_at')) = 3, 'the three new gig columns exist');
select pg_temp.us_assert(not has_column_privilege('authenticated', 'public.gigs', 'start_wait_count', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.gigs', 'helper_removed_at', 'UPDATE'), 'clients cannot write them directly');
select pg_temp.us_assert(not has_function_privilege('anon', 'public.wait_for_start(uuid)', 'EXECUTE') and not has_function_privilege('anon', 'public.withdraw_unanswered(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.remove_helper(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.wait_for_start(uuid)', 'EXECUTE') and has_function_privilege('authenticated', 'public.withdraw_unanswered(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.remove_helper(uuid)', 'EXECUTE'), 'the three functions are executable by authenticated users only');
select pg_temp.us_assert((select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('wait_for_start', 'withdraw_unanswered', 'remove_helper') and p.prosecdef and p.proconfig @> array['search_path=""']) = 3, 'all three are SECURITY DEFINER with an empty search_path');
select pg_temp.us_assert(pg_temp.us_lemons('poster') = 0 and pg_temp.us_lemons('helper') = 0, 'nobody has a lemon to start with');

-- ---------------------------------------------------------------------------
-- 2. Waiting: 24 hours of silence before each of at most two waits.
-- ---------------------------------------------------------------------------
select pg_temp.us_denied('anon', pg_catalog.format($$select public.wait_for_start(%L)$$, pg_temp.us_id('g_old')), 'anon cannot wait');
select pg_temp.us_denied('stranger', pg_catalog.format($$select public.wait_for_start(%L)$$, pg_temp.us_id('g_old')), 'a stranger cannot wait');
select pg_temp.us_denied('poster', pg_catalog.format($$select public.wait_for_start(%L)$$, pg_temp.us_id('g_old')), 'the poster cannot wait on their own gig');
select pg_temp.us_denied('other_helper', pg_catalog.format($$select public.wait_for_start(%L)$$, pg_temp.us_id('g_old')), 'a helper who was not selected cannot wait');
select pg_temp.us_error('helper', pg_catalog.format($$select public.wait_for_start(%L)$$, pg_temp.us_id('g_noreq')), 'P0001', 'no start request, nothing to wait for', 'no unanswered start request');
select pg_temp.us_error('helper', pg_catalog.format($$select public.wait_for_start(%L)$$, pg_temp.us_id('g_prog')), 'P0001', 'a gig already in progress has nothing to wait for', 'no unanswered start request');
select pg_temp.us_error('helper', pg_catalog.format($$select public.wait_for_start(%L)$$, pg_temp.us_id('g_delayed')), 'P0001', 'once the poster has answered (delayed) there is no silence to wait out', 'no unanswered start request');
select pg_temp.us_error('helper', pg_catalog.format($$select public.wait_for_start(%L)$$, pg_temp.us_id('g_new')), 'P0001', 'one hour of silence is too early to wait again', 'still has time');
select pg_temp.us_assert(pg_temp.us_state('g_new') = 'active/UShelper/true/0/false/false', 'refused attempts changed nothing');

select pg_temp.us_call('helper', 'wait_for_start', 'g_old');
select pg_temp.us_assert(pg_temp.us_state('g_old') = 'active/UShelper/true/1/false/false', 'after 24 hours of silence the first wait is recorded');
select pg_temp.us_assert((select start_wait_until between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute' from public.gigs where id = pg_temp.us_id('g_old')), 'it runs for 24 hours');
select pg_temp.us_assert(pg_temp.us_notes('poster', 'g_old', 'start_reminder') = 1 and pg_temp.us_notes('helper', 'g_old', 'start_reminder') = 0, 'the poster is reminded, the helper is not');
select pg_temp.us_error('helper', pg_catalog.format($$select public.wait_for_start(%L)$$, pg_temp.us_id('g_old')), 'P0001', 'a second wait cannot start while the first is running', 'still has time');
select pg_temp.us_call('helper', 'wait_for_start', 'g_wait2');
select pg_temp.us_assert(pg_temp.us_state('g_wait2') = 'active/UShelper/true/2/false/false', 'the second wait is recorded once the first is over');
select pg_temp.us_error('helper', pg_catalog.format($$select public.wait_for_start(%L)$$, pg_temp.us_id('g_ready')), 'P0001', 'there is no third wait', 'already waited twice');
select pg_temp.us_error('helper', pg_catalog.format($$select public.wait_for_start(%L)$$, pg_temp.us_id('g_early')), 'P0001', 'nor while the second is still running', 'already waited twice');

-- ---------------------------------------------------------------------------
-- 3. Withdrawing after the poster stayed silent: the poster gets a lemon.
-- ---------------------------------------------------------------------------
select pg_temp.us_denied('anon', pg_catalog.format($$select public.withdraw_unanswered(%L)$$, pg_temp.us_id('g_ready')), 'anon cannot withdraw');
select pg_temp.us_denied('stranger', pg_catalog.format($$select public.withdraw_unanswered(%L)$$, pg_temp.us_id('g_ready')), 'a stranger cannot withdraw');
select pg_temp.us_denied('poster', pg_catalog.format($$select public.withdraw_unanswered(%L)$$, pg_temp.us_id('g_ready')), 'the poster cannot withdraw their helper');
select pg_temp.us_denied('other_helper', pg_catalog.format($$select public.withdraw_unanswered(%L)$$, pg_temp.us_id('g_ready')), 'a helper who was not selected cannot withdraw');
select pg_temp.us_error('helper', pg_catalog.format($$select public.withdraw_unanswered(%L)$$, pg_temp.us_id('g_old')), 'P0001', 'not before both waits have been taken', 'waited twice');
select pg_temp.us_error('helper', pg_catalog.format($$select public.withdraw_unanswered(%L)$$, pg_temp.us_id('g_one')), 'P0001', 'not after only one wait', 'waited twice');
select pg_temp.us_error('helper', pg_catalog.format($$select public.withdraw_unanswered(%L)$$, pg_temp.us_id('g_early')), 'P0001', 'not while the second wait is still running', 'waited twice');
select pg_temp.us_error('helper', pg_catalog.format($$select public.withdraw_unanswered(%L)$$, pg_temp.us_id('g_delayed')), 'P0001', 'not if the poster answered by delaying the start', 'no unanswered start request');
select pg_temp.us_error('helper', pg_catalog.format($$select public.withdraw_unanswered(%L)$$, pg_temp.us_id('g_noreq')), 'P0001', 'not without a start request', 'no unanswered start request');
select pg_temp.us_assert(pg_temp.us_lemons('poster') = 0, 'none of the refused attempts cost the poster a lemon');
select pg_temp.us_assert(pg_temp.us_address('helper', 'g_ready') = '1 Private Street', 'before withdrawing the helper can read the private address');

select pg_temp.us_call('helper', 'withdraw_unanswered', 'g_ready');
select pg_temp.us_assert(pg_temp.us_state('g_ready') = 'cancelled/-/false/0/true/false', 'the gig closes: cancelled, helper removed, start fields cleared, withdrawal recorded');
select pg_temp.us_assert(pg_temp.us_claim('g_ready', 'helper') = 'withdrawn', 'the helper''s claim is closed for good');
select pg_temp.us_assert(pg_temp.us_lemons('poster') = 1 and pg_temp.us_lemons('helper') = 0, 'the poster has exactly one lemon, the helper none');
select pg_temp.us_assert((select count(*) from public.feedback where gig_id = pg_temp.us_id('g_ready') and from_id = pg_temp.us_id('helper') and to_id = pg_temp.us_id('poster') and type = 'lemon') = 1, 'recorded as an ordinary lemon feedback row');
select pg_temp.us_assert(pg_temp.us_notes('poster', 'g_ready', 'helper_withdrew') = 1, 'the poster is told, and the notice says they received a lemon');
select pg_temp.us_assert((select message like '%You received a lemon%' from public.notifications where gig_id = pg_temp.us_id('g_ready') and type = 'helper_withdrew' limit 1), 'wording');
select pg_temp.us_assert(pg_temp.us_address('helper', 'g_ready') = '' and pg_temp.us_address('poster', 'g_ready') = '1 Private Street', 'the helper loses the private address, the poster keeps it');
select pg_temp.us_assert(pg_temp.us_public('g_ready') = '0', 'the gig is not reopened publicly');
select pg_temp.us_denied('helper', pg_catalog.format($$select public.withdraw_unanswered(%L)$$, pg_temp.us_id('g_ready')), 'a second withdrawal is refused: they are no longer the helper');
select pg_temp.us_assert(pg_temp.us_lemons('poster') = 1, 'so the poster cannot be given a second lemon for the same gig');
-- The lemon counts like any other lemon in the public percentage's denominator (the existing rule).
select pg_temp.us_assert((select lemon_count from public.profiles where id = pg_temp.us_id('poster')) = 1, 'it is the same private counter');

-- ---------------------------------------------------------------------------
-- 4. The poster removes the helper before the start.
-- ---------------------------------------------------------------------------
select pg_temp.us_denied('anon', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.us_id('g_rm1')), 'anon cannot remove a helper');
select pg_temp.us_denied('stranger', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.us_id('g_rm1')), 'a stranger cannot');
select pg_temp.us_denied('helper', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.us_id('g_rm1')), 'the helper cannot remove themselves this way');
select pg_temp.us_denied('other_helper', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.us_id('g_rm1')), 'nor can another helper');
select pg_temp.us_error('poster', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.us_id('g_rm_open')), 'P0001', 'there is no helper to remove on an open gig', 'before the gig starts');
select pg_temp.us_error('poster', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.us_id('g_rm_prog')), 'P0001', 'once the gig has started the helper cannot be removed', 'before the gig starts');
select pg_temp.us_assert(pg_temp.us_state('g_rm1') = 'active/UShelper/false/0/false/false', 'refused attempts changed nothing');

select pg_temp.us_call('poster', 'remove_helper', 'g_rm1');
select pg_temp.us_assert(pg_temp.us_state('g_rm1') = 'cancelled/-/false/0/false/true', 'the poster removes the helper: gig closed, helper gone, removal recorded');
select pg_temp.us_assert(pg_temp.us_claim('g_rm1', 'helper') = 'rejected', 'the claim is rejected (not withdrawn: they did not choose this)');
select pg_temp.us_assert(pg_temp.us_notes('helper', 'g_rm1', 'helper_removed') = 1 and pg_temp.us_notes('poster', 'g_rm1', 'helper_removed') = 0, 'the helper is told');
select pg_temp.us_assert(pg_temp.us_lemons('poster') = 1 and pg_temp.us_lemons('helper') = 0, 'removing costs nobody a lemon');
select pg_temp.us_assert((select count(*) from public.feedback where gig_id = pg_temp.us_id('g_rm1')) = 0, 'and records no feedback');
select pg_temp.us_assert(pg_temp.us_address('helper', 'g_rm1') = '' and pg_temp.us_address('poster', 'g_rm1') = '1 Private Street', 'the removed helper loses the private address');
select pg_temp.us_assert(pg_temp.us_public('g_rm1') = '0', 'the gig is not reopened publicly by itself');
select pg_temp.us_error('poster', pg_catalog.format($$select public.remove_helper(%L)$$, pg_temp.us_id('g_rm1')), 'P0001', 'removing twice is refused', 'before the gig starts');
select pg_temp.us_exec('helper', pg_catalog.format($$select public.create_claim(%L, 50, null)$$, pg_temp.us_id('g_rm1')));
select pg_temp.us_assert(pg_temp.us_claim('g_rm1', 'helper') = 'rejected' and pg_temp.us_state('g_rm1') = 'cancelled/-/false/0/false/true', 'the removed helper cannot claim it again');

-- While a start request is waiting, and for a private request.
select pg_temp.us_call('poster', 'remove_helper', 'g_rm2');
select pg_temp.us_assert(pg_temp.us_state('g_rm2') = 'cancelled/-/false/0/false/true' and pg_temp.us_lemons('poster') = 1, 'removal also works while a start request waits, at no cost');
select pg_temp.us_call('poster', 'remove_helper', 'g_rm_priv');
select pg_temp.us_assert(pg_temp.us_state('g_rm_priv') = 'cancelled/-/false/0/false/true'
  and (select requested_helper_id from public.gigs where id = pg_temp.us_id('g_rm_priv')) = pg_temp.us_id('helper')
  and pg_temp.us_public('g_rm_priv') = '0', 'a private request closes the same way and stays private');

-- ---------------------------------------------------------------------------
-- 5. The existing start flow is untouched.
-- ---------------------------------------------------------------------------
select pg_temp.us_call('poster', 'approve_start', 'g_approve');
select pg_temp.us_assert(pg_temp.us_state('g_approve') like 'in_progress/%', 'approve_start still works');
select pg_temp.us_call('poster', 'delay_start', 'g_wait2');
select pg_temp.us_assert((select start_delayed_at is not null from public.gigs where id = pg_temp.us_id('g_wait2')), 'delay_start (0022) still works after waits were taken');
select pg_temp.us_call('helper', 'withdraw_from_gig', 'g_wait2');
select pg_temp.us_assert(pg_temp.us_state('g_wait2') like 'cancelled/-/false/%/true/false' and pg_temp.us_lemons('poster') = 1, 'withdrawing after a delay (0022) still costs the poster nothing');

reset role;
rollback;
