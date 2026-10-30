-- Delay start and withdraw (migration 0022): who may delay a start request, when the helper may withdraw,
-- what withdrawing does (claim closed, helper removed from the gig and its private address, gig closed),
-- and that the existing start flow is untouched.
-- Run only against an isolated Supabase test database after 0001 through 0022.
-- All fixtures roll back. Run as postgres (or an equivalent trusted role).
begin;

create temporary table ds_fixture (name text primary key, id uuid);
insert into ds_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['poster','helper','stranger','other_helper','g_main','g_noreq','g_open','g_prog','g_priv','g_priv2','g_twice','g_done']) as n(name);
grant select, update on ds_fixture to anon, authenticated;

create function pg_temp.ds_id(p_name text) returns uuid
language sql stable as $$ select id from pg_temp.ds_fixture where name = p_name; $$;
create function pg_temp.ds_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.ds_switch(p_user text) returns void language plpgsql as $$
declare v_id uuid;
begin
  if p_user = 'admin' then return; end if;
  if p_user = 'anon' then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    set local role anon;
  else
    select id into v_id from pg_temp.ds_fixture where name = p_user;
    perform set_config('request.jwt.claim.sub', v_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end;
$$;
create function pg_temp.ds_query(p_user text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.ds_switch(p_user);
  begin execute p_sql into v; exception when others then reset role; raise; end;
  reset role;
  return v;
end;
$$;
create function pg_temp.ds_exec(p_user text, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.ds_switch(p_user);
  begin execute p_sql; exception when others then reset role; raise; end;
  reset role;
end;
$$;
create function pg_temp.ds_error(p_user text, p_sql text, p_code text, p_label text, p_msg text default null) returns void
language plpgsql as $$
begin
  begin
    perform pg_temp.ds_exec(p_user, p_sql);
  exception when others then
    if sqlstate <> p_code or (p_msg is not null and position(p_msg in sqlerrm) = 0) then
      raise exception 'FAIL: % (got % %)', p_label, sqlstate, sqlerrm;
    end if;
    raise notice 'PASS: %', p_label; return;
  end;
  raise exception 'FAIL (expected error %): %', p_code, p_label;
end;
$$;
create function pg_temp.ds_denied(p_user text, p_sql text, p_label text) returns void
language plpgsql as $$ begin perform pg_temp.ds_error(p_user, p_sql, '42501', p_label); end; $$;
create function pg_temp.ds_delay(p_user text, p_gig text) returns void language sql as $$
  select pg_temp.ds_exec(p_user, pg_catalog.format($q$select public.delay_start(%L)$q$, pg_temp.ds_id(p_gig)));
$$;
create function pg_temp.ds_withdraw(p_user text, p_gig text) returns void language sql as $$
  select pg_temp.ds_exec(p_user, pg_catalog.format($q$select public.withdraw_from_gig(%L)$q$, pg_temp.ds_id(p_gig)));
$$;
-- A gig's state as one comparable string: status/helper/agreed/requested-start/delayed/withdrawn.
create function pg_temp.ds_state(p_gig text) returns text language sql as $$
  select g.status::text || '/' || coalesce((select username from public.profiles where id = g.selected_provider_id), '-') || '/' ||
    coalesce(g.agreed_amount::text, '-') || '/' || (g.start_requested_at is not null)::text || '/' || (g.start_delayed_at is not null)::text || '/' || (g.helper_withdrawn_at is not null)::text
  from public.gigs g where g.id = pg_temp.ds_id(p_gig);
$$;
create function pg_temp.ds_notes(p_user text, p_gig text, p_type text) returns bigint language sql as $$
  select count(*) from public.notifications where recipient_id = pg_temp.ds_id(p_user) and gig_id = pg_temp.ds_id(p_gig) and type = p_type;
$$;
create function pg_temp.ds_claim(p_gig text, p_user text) returns text language sql as $$
  select coalesce((select state::text from public.claims where gig_id = pg_temp.ds_id(p_gig) and provider_id = pg_temp.ds_id(p_user)), 'none');
$$;
create function pg_temp.ds_address(p_user text, p_gig text) returns text language plpgsql as $fn$
begin
  return pg_temp.ds_query(p_user, pg_catalog.format($q$select coalesce((select address_text from public.gig_private_locations where gig_id = %L), '')$q$, pg_temp.ds_id(p_gig)));
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
  jsonb_build_object('username', 'DS' || replace(name, '_', '')), now(), now()
from ds_fixture where name in ('poster', 'helper', 'stranger', 'other_helper');

-- Gigs in each state the rules care about, inserted directly so only the new functions are exercised.
create function pg_temp.ds_gig(p_name text, p_status text, p_helper boolean, p_requested boolean default false, p_start boolean default false) returns void language plpgsql as $$
begin
  insert into public.gigs (id, poster_id, creation_request_id, service_type, title, description, amount, price_type, location_text, status,
    selected_provider_id, agreed_amount, requested_helper_id, start_requested_at)
  values (pg_temp.ds_id(p_name), pg_temp.ds_id('poster'), gen_random_uuid(), 'Cleaning', 'Gig ' || p_name, 'Description', 100, 'fixed', 'Kävlinge', p_status::public.gig_status,
    case when p_helper then pg_temp.ds_id('helper') end, case when p_helper then 120 end,
    case when p_requested then pg_temp.ds_id('helper') end, case when p_start then pg_catalog.now() end);
  if p_helper then
    insert into public.claims (gig_id, provider_id, state, offer_amount) values (pg_temp.ds_id(p_name), pg_temp.ds_id('helper'), 'selected', 120);
  end if;
  insert into public.gig_private_locations (gig_id, address_text) values (pg_temp.ds_id(p_name), '1 Private Street');
end;
$$;
select pg_temp.ds_gig('g_main', 'active', true, false, true);       -- start requested, not yet delayed
select pg_temp.ds_gig('g_noreq', 'active', true);                   -- helper selected, no start request
select pg_temp.ds_gig('g_open', 'active', false);                   -- nobody selected
select pg_temp.ds_gig('g_prog', 'in_progress', true, false, true);  -- already started
select pg_temp.ds_gig('g_priv', 'active', true, true, true);        -- a private request that was accepted
select pg_temp.ds_gig('g_priv2', 'active', true, true, true);       -- a private request, start requested
select pg_temp.ds_gig('g_twice', 'active', true, false, true);
select pg_temp.ds_gig('g_done', 'completed', true, false, true);

-- ---------------------------------------------------------------------------
-- 1. Structure and permissions.
-- ---------------------------------------------------------------------------
select pg_temp.ds_assert((select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'gigs' and column_name in ('start_delayed_at', 'helper_withdrawn_at')) = 2, 'the two new gig columns exist');
select pg_temp.ds_assert(not has_column_privilege('authenticated', 'public.gigs', 'start_delayed_at', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.gigs', 'helper_withdrawn_at', 'UPDATE'), 'clients cannot write the new columns directly');
select pg_temp.ds_assert(not has_function_privilege('anon', 'public.delay_start(uuid)', 'EXECUTE') and not has_function_privilege('anon', 'public.withdraw_from_gig(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.delay_start(uuid)', 'EXECUTE') and has_function_privilege('authenticated', 'public.withdraw_from_gig(uuid)', 'EXECUTE'), 'both functions are executable by authenticated users only');
select pg_temp.ds_assert((select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('delay_start', 'withdraw_from_gig')
  and p.prosecdef and p.proconfig @> array['search_path=""']) = 2, 'both are SECURITY DEFINER with an empty search_path');

-- ---------------------------------------------------------------------------
-- 2. Delaying a start request.
-- ---------------------------------------------------------------------------
select pg_temp.ds_denied('anon', pg_catalog.format($$select public.delay_start(%L)$$, pg_temp.ds_id('g_main')), 'anon cannot delay a start');
select pg_temp.ds_denied('stranger', pg_catalog.format($$select public.delay_start(%L)$$, pg_temp.ds_id('g_main')), 'a stranger cannot delay a start');
select pg_temp.ds_denied('helper', pg_catalog.format($$select public.delay_start(%L)$$, pg_temp.ds_id('g_main')), 'the helper cannot delay their own start request');
select pg_temp.ds_error('poster', pg_catalog.format($$select public.delay_start(%L)$$, pg_temp.ds_id('g_noreq')), 'P0001', 'nothing to delay before the helper asks to start', 'no start request');
select pg_temp.ds_error('poster', pg_catalog.format($$select public.delay_start(%L)$$, pg_temp.ds_id('g_open')), 'P0001', 'nothing to delay on a gig without a helper', 'no start request');
select pg_temp.ds_error('poster', pg_catalog.format($$select public.delay_start(%L)$$, pg_temp.ds_id('g_prog')), 'P0001', 'a gig already in progress cannot be delayed', 'no start request');
select pg_temp.ds_error('poster', pg_catalog.format($$select public.delay_start(%L)$$, pg_temp.ds_id('g_done')), 'P0001', 'nor a finished gig', 'no start request');
select pg_temp.ds_assert(pg_temp.ds_state('g_main') = 'active/DShelper/120.00/true/false/false', 'refused attempts changed nothing');

select pg_temp.ds_delay('poster', 'g_main');
select pg_temp.ds_assert(pg_temp.ds_state('g_main') = 'active/DShelper/120.00/true/true/false', 'the poster delays: still active, same helper, same price, start request kept, delay recorded');
select pg_temp.ds_assert(pg_temp.ds_notes('helper', 'g_main', 'start_delayed') = 1 and pg_temp.ds_notes('poster', 'g_main', 'start_delayed') = 0, 'only the helper is told');
select pg_temp.ds_error('poster', pg_catalog.format($$select public.delay_start(%L)$$, pg_temp.ds_id('g_main')), 'P0001', 'a start request can be delayed only once', 'already delayed');
select pg_temp.ds_assert(pg_temp.ds_notes('helper', 'g_main', 'start_delayed') = 1, 'and the refused repeat sent no second notice');

-- The existing start flow still works after a delay.
select pg_temp.ds_exec('poster', pg_catalog.format($$select public.approve_start(%L)$$, pg_temp.ds_id('g_twice')));
select pg_temp.ds_assert(pg_temp.ds_state('g_twice') like 'in_progress/%', 'approve_start is unchanged for an undelayed request');
select pg_temp.ds_delay('poster', 'g_priv');
select pg_temp.ds_exec('poster', pg_catalog.format($$select public.approve_start(%L)$$, pg_temp.ds_id('g_priv')));
select pg_temp.ds_assert(pg_temp.ds_state('g_priv') like 'in_progress/%', 'the poster can still approve the start after delaying it');
select pg_temp.ds_error('poster', pg_catalog.format($$select public.delay_start(%L)$$, pg_temp.ds_id('g_priv')), 'P0001', 'and cannot delay it once it is in progress', 'no start request');
select pg_temp.ds_error('helper', pg_catalog.format($$select public.withdraw_from_gig(%L)$$, pg_temp.ds_id('g_priv')), 'P0001', 'once in progress the helper cannot withdraw this way', 'only withdraw while');

-- ---------------------------------------------------------------------------
-- 3. Withdrawing: only the selected helper, only while the start is delayed.
-- ---------------------------------------------------------------------------
select pg_temp.ds_denied('anon', pg_catalog.format($$select public.withdraw_from_gig(%L)$$, pg_temp.ds_id('g_main')), 'anon cannot withdraw');
select pg_temp.ds_denied('stranger', pg_catalog.format($$select public.withdraw_from_gig(%L)$$, pg_temp.ds_id('g_main')), 'a stranger cannot withdraw');
select pg_temp.ds_denied('other_helper', pg_catalog.format($$select public.withdraw_from_gig(%L)$$, pg_temp.ds_id('g_main')), 'a helper who was not selected cannot withdraw');
select pg_temp.ds_denied('poster', pg_catalog.format($$select public.withdraw_from_gig(%L)$$, pg_temp.ds_id('g_main')), 'the poster cannot withdraw the helper');
select pg_temp.ds_error('helper', pg_catalog.format($$select public.withdraw_from_gig(%L)$$, pg_temp.ds_id('g_noreq')), 'P0001', 'before any delay the helper cannot withdraw', 'only withdraw while');
select pg_temp.ds_error('helper', pg_catalog.format($$select public.withdraw_from_gig(%L)$$, pg_temp.ds_id('g_twice')), 'P0001', 'nor once the gig is in progress', 'only withdraw while');
select pg_temp.ds_assert(pg_temp.ds_address('helper', 'g_main') = '1 Private Street', 'before withdrawing the helper can read the private address');

select pg_temp.ds_withdraw('helper', 'g_main');
select pg_temp.ds_assert(pg_temp.ds_state('g_main') = 'cancelled/-/-/false/false/true', 'withdrawing closes the gig: cancelled, no helper, no agreed price, start fields cleared, withdrawal recorded');
select pg_temp.ds_assert(pg_temp.ds_claim('g_main', 'helper') = 'withdrawn', 'the helper''s claim is withdrawn');
select pg_temp.ds_assert(pg_temp.ds_notes('poster', 'g_main', 'helper_withdrew') = 1 and pg_temp.ds_notes('helper', 'g_main', 'helper_withdrew') = 0, 'the poster is told');
select pg_temp.ds_assert(pg_temp.ds_address('helper', 'g_main') = '', 'the withdrawn helper no longer sees the private address');
select pg_temp.ds_assert(pg_temp.ds_address('poster', 'g_main') = '1 Private Street', 'the poster still does');
select pg_temp.ds_assert((select count(*) from public.gigs where id = pg_temp.ds_id('g_main') and status = 'active') = 0
  and pg_temp.ds_query('anon', pg_catalog.format($q$select count(*)::text from public.gigs where id = %L$q$, pg_temp.ds_id('g_main'))) = '0', 'the gig is not public: it is not reopened by itself');
select pg_temp.ds_denied('helper', pg_catalog.format($$select public.withdraw_from_gig(%L)$$, pg_temp.ds_id('g_main')), 'a second withdrawal is refused: they are no longer the selected helper');
select pg_temp.ds_denied('helper', pg_catalog.format($$select public.delay_start(%L)$$, pg_temp.ds_id('g_main')), 'the helper still cannot delay anything');
select pg_temp.ds_exec('helper', pg_catalog.format($$select public.create_claim(%L, 50, null)$$, pg_temp.ds_id('g_main')));
select pg_temp.ds_assert(pg_temp.ds_claim('g_main', 'helper') = 'withdrawn' and pg_temp.ds_state('g_main') = 'cancelled/-/-/false/false/true', 'trying to claim the closed gig again changes nothing: the claim stays withdrawn and the gig stays closed');
select pg_temp.ds_error('poster', pg_catalog.format($$select public.delay_start(%L)$$, pg_temp.ds_id('g_main')), 'P0001', 'and there is nothing left to delay', 'no start request');

-- A private request: the helper who withdraws is no longer the requested helper's open request, and the gig closes the same way.
select pg_temp.ds_delay('poster', 'g_priv2');
select pg_temp.ds_withdraw('helper', 'g_priv2');
select pg_temp.ds_assert(pg_temp.ds_state('g_priv2') = 'cancelled/-/-/false/false/true', 'a private request closes the same way when its helper withdraws');
select pg_temp.ds_assert((select requested_helper_id from public.gigs where id = pg_temp.ds_id('g_priv2')) = pg_temp.ds_id('helper'), 'the original request target stays on record (the app then offers only a public repost)');
select pg_temp.ds_assert(pg_temp.ds_query('anon', pg_catalog.format($q$select count(*)::text from public.gigs where id = %L$q$, pg_temp.ds_id('g_priv2'))) = '0', 'a withdrawn private request is never public');
select pg_temp.ds_assert((select count(*) from public.gigs where status = 'active' and selected_provider_id is null and requested_helper_id is null and id in (pg_temp.ds_id('g_main'), pg_temp.ds_id('g_priv2'))) = 0, 'nothing reappears in the public gig list');

reset role;
rollback;
