-- ESG-CAN-001 v1.0 (Provider Withdraw/Exit) and ESG-CAN-002 v1.0 (Poster Remove Provider), migration 0026:
-- withdraw_before_start() fills the gap between being selected and the unanswered-silence window;
-- exit_gig() lets the provider leave an in-progress engagement outright, always reopening to active;
-- remove_helper() now requires a reason.
-- Run only against an isolated Supabase test database after 0001 through 0026.
-- All fixtures roll back. Run as postgres (or an equivalent trusted role).
begin;

create temporary table wer_fixture (name text primary key, id uuid);
insert into wer_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['poster','helper','other1','other2','stranger','outsider',
  'wer_pre','wer_pre_last','wer_answering','wer_silent','wer_delayed','wer_wrongstatus',
  'wer_prog','wer_prog_lone','wer_prog_other','wer_active',
  'wer_rm']) as n(name);
grant select, update on wer_fixture to anon, authenticated;

create function pg_temp.wer_id(p_name text) returns uuid
language sql stable as $$ select id from pg_temp.wer_fixture where name = p_name; $$;
create function pg_temp.wer_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.wer_switch(p_user text) returns void language plpgsql as $$
declare v_id uuid;
begin
  if p_user = 'admin' then return; end if;
  if p_user = 'anon' then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    set local role anon;
  else
    select id into v_id from pg_temp.wer_fixture where name = p_user;
    perform set_config('request.jwt.claim.sub', v_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end;
$$;
create function pg_temp.wer_exec(p_user text, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.wer_switch(p_user);
  begin execute p_sql; exception when others then reset role; raise; end;
  reset role;
end;
$$;
create function pg_temp.wer_error(p_user text, p_sql text, p_code text, p_label text, p_msg text default null) returns void
language plpgsql as $$
begin
  begin
    perform pg_temp.wer_exec(p_user, p_sql);
  exception when others then
    if sqlstate <> p_code or (p_msg is not null and position(p_msg in sqlerrm) = 0) then
      raise exception 'FAIL: % (got % %)', p_label, sqlstate, sqlerrm;
    end if;
    raise notice 'PASS: %', p_label; return;
  end;
  raise exception 'FAIL (expected error %): %', p_code, p_label;
end;
$$;
create function pg_temp.wer_denied(p_user text, p_sql text, p_label text) returns void
language plpgsql as $$ begin perform pg_temp.wer_error(p_user, p_sql, '42501', p_label); end; $$;
create function pg_temp.wer_state(p_gig text) returns text language sql as $$
  select g.status::text || '/' || coalesce((select username from public.profiles where id = g.selected_provider_id), '-') || '/' ||
    (g.start_requested_at is not null)::text
  from public.gigs g where g.id = pg_temp.wer_id(p_gig);
$$;
create function pg_temp.wer_notes(p_user text, p_gig text, p_type text) returns bigint language sql as $$
  select count(*) from public.notifications where recipient_id = pg_temp.wer_id(p_user) and gig_id = pg_temp.wer_id(p_gig) and type = p_type;
$$;
create function pg_temp.wer_note_msg(p_user text, p_gig text, p_type text) returns text language sql as $$
  select message from public.notifications where recipient_id = pg_temp.wer_id(p_user) and gig_id = pg_temp.wer_id(p_gig) and type = p_type order by created_at desc limit 1;
$$;
create function pg_temp.wer_claim(p_gig text, p_user text) returns text language sql as $$
  select coalesce((select state::text from public.claims where gig_id = pg_temp.wer_id(p_gig) and provider_id = pg_temp.wer_id(p_user)), 'none');
$$;
create function pg_temp.wer_pending(p_gig text) returns bigint language sql as $$
  select count(*) from public.claims where gig_id = pg_temp.wer_id(p_gig) and state = 'pending';
$$;
create function pg_temp.wer_lemons(p_user text) returns int language sql as $$
  select lemon_count from public.profiles where id = pg_temp.wer_id(p_user);
$$;
create function pg_temp.wer_chat(p_gig text) returns bigint language sql as $$
  select count(*) from public.chat_messages where gig_id = pg_temp.wer_id(p_gig);
$$;
create function pg_temp.wer_proposals(p_gig text) returns bigint language sql as $$
  select count(*) from public.price_proposals where gig_id = pg_temp.wer_id(p_gig);
$$;
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
  jsonb_build_object('username', 'WER' || replace(name, '_', '')), now(), now()
from wer_fixture where name in ('poster', 'helper', 'other1', 'other2', 'stranger', 'outsider');

-- p_others: how many of other1/other2 hold a pending offer.
create function pg_temp.wer_gig(p_name text, p_status text, p_requested_hours_ago numeric default null, p_delayed boolean default false, p_others int default 0) returns void language plpgsql as $$
begin
  insert into public.gigs (id, poster_id, creation_request_id, service_type, title, description, amount, price_type, location_text, status,
    selected_provider_id, agreed_amount, start_requested_at, start_delayed_at)
  values (pg_temp.wer_id(p_name), pg_temp.wer_id('poster'), gen_random_uuid(), 'Cleaning', 'Gig ' || p_name, 'Description', 100, 'fixed', 'Kävlinge', p_status::public.gig_status,
    pg_temp.wer_id('helper'), 120,
    case when p_requested_hours_ago is not null then pg_catalog.now() - pg_catalog.make_interval(secs => (p_requested_hours_ago * 3600)::double precision) end,
    case when p_delayed then pg_catalog.now() - interval '1 hour' end);
  insert into public.claims (gig_id, provider_id, state, offer_amount) values (pg_temp.wer_id(p_name), pg_temp.wer_id('helper'), 'selected', 120);
  insert into public.chat_messages (gig_id, sender_id, body) values (pg_temp.wer_id(p_name), pg_temp.wer_id('helper'), 'Hello from the helper');
  insert into public.price_proposals (gig_id, proposer_id, round, from_amount, amount) values (pg_temp.wer_id(p_name), pg_temp.wer_id('poster'), 1, 120, 110);
  if p_others >= 1 then
    insert into public.claims (gig_id, provider_id, state, offer_amount) values (pg_temp.wer_id(p_name), pg_temp.wer_id('other1'), 'pending', 90);
  end if;
  if p_others >= 2 then
    insert into public.claims (gig_id, provider_id, state, offer_amount) values (pg_temp.wer_id(p_name), pg_temp.wer_id('other2'), 'pending', 95);
  end if;
end;
$$;

select pg_temp.wer_gig('wer_pre',        'active',      null, false, 2); -- selected, never requested a start, two others waiting
select pg_temp.wer_gig('wer_pre_last',   'active',      null, false, 0); -- selected, never requested a start, nobody else
select pg_temp.wer_gig('wer_answering',  'active',      1,    false, 2); -- start requested 1h ago, poster still has time
select pg_temp.wer_gig('wer_silent',     'active',      30,   false, 0); -- start requested 30h ago, silence threshold passed
select pg_temp.wer_gig('wer_delayed',    'active',      1,    true,  0); -- start requested, but the poster delayed it
select pg_temp.wer_gig('wer_wrongstatus','in_progress', null, false, 0);
select pg_temp.wer_gig('wer_prog',       'in_progress', null, false, 2); -- in progress, two others still waiting
select pg_temp.wer_gig('wer_prog_lone',  'in_progress', null, false, 0); -- in progress, nobody else waiting
select pg_temp.wer_gig('wer_prog_other', 'in_progress', null, false, 0);
select pg_temp.wer_gig('wer_active',     'active',      null, false, 0);
select pg_temp.wer_gig('wer_rm',         'active',      null, false, 0);

-- ---------------------------------------------------------------------------
-- 1. Structure.
-- ---------------------------------------------------------------------------
select pg_temp.wer_assert((select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('withdraw_before_start', 'exit_gig', 'remove_helper') and p.prosecdef and p.proconfig @> array['search_path=""']) = 3, 'all three functions are SECURITY DEFINER with an empty search_path');
select pg_temp.wer_assert(has_function_privilege('authenticated', 'public.withdraw_before_start(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.exit_gig(uuid, public.exit_reason, text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.remove_helper(uuid, text)', 'EXECUTE'), 'authenticated can call all three');
select pg_temp.wer_assert(not has_function_privilege('anon', 'public.withdraw_before_start(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.exit_gig(uuid, public.exit_reason, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.remove_helper(uuid, text)', 'EXECUTE'), 'anon can call none of them');
select pg_temp.wer_assert(not exists (select 1 from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname = 'remove_helper' and pronargs = 1), 'the old single-argument remove_helper overload is gone');

-- ---------------------------------------------------------------------------
-- 2. withdraw_before_start(): before a start was ever requested.
-- ---------------------------------------------------------------------------
select pg_temp.wer_denied('anon', pg_catalog.format($$select public.withdraw_before_start(%L)$$, pg_temp.wer_id('wer_pre')), 'anon cannot withdraw');
select pg_temp.wer_denied('stranger', pg_catalog.format($$select public.withdraw_before_start(%L)$$, pg_temp.wer_id('wer_pre')), 'nor a stranger');
select pg_temp.wer_denied('poster', pg_catalog.format($$select public.withdraw_before_start(%L)$$, pg_temp.wer_id('wer_pre')), 'nor the poster');
select pg_temp.wer_exec('helper', pg_catalog.format($$select public.withdraw_before_start(%L)$$, pg_temp.wer_id('wer_pre')));
select pg_temp.wer_assert(pg_temp.wer_state('wer_pre') = 'active/-/false', 'withdrawing before any start request reopens the gig');
select pg_temp.wer_assert(pg_temp.wer_claim('wer_pre', 'helper') = 'withdrawn' and pg_temp.wer_pending('wer_pre') = 2, 'the helper is withdrawn for good, both waiting offers are still pending');
select pg_temp.wer_assert(pg_temp.wer_chat('wer_pre') = 0 and pg_temp.wer_proposals('wer_pre') = 0, 'the conversation and the open proposal are cleared');
select pg_temp.wer_assert(pg_temp.wer_lemons('poster') = 0, 'withdrawing this early costs the poster no lemon');
select pg_temp.wer_assert(pg_temp.wer_notes('poster', 'wer_pre', 'helper_withdrew') = 1, 'the poster is told');
select pg_temp.wer_exec('helper', pg_catalog.format($$select public.create_claim(%L, 50)$$, pg_temp.wer_id('wer_pre')));
select pg_temp.wer_assert(pg_temp.wer_claim('wer_pre', 'helper') = 'withdrawn', 'the withdrawn helper cannot claim it again');

-- Nobody else waiting: withdrawing closes the gig instead of reopening it.
select pg_temp.wer_exec('helper', pg_catalog.format($$select public.withdraw_before_start(%L)$$, pg_temp.wer_id('wer_pre_last')));
select pg_temp.wer_assert(pg_temp.wer_state('wer_pre_last') = 'cancelled/-/false', 'with no other offer the gig is cancelled, not left active and empty');

-- ---------------------------------------------------------------------------
-- 3. withdraw_before_start(): while the poster still has time to answer a start request.
-- ---------------------------------------------------------------------------
select pg_temp.wer_exec('helper', pg_catalog.format($$select public.withdraw_before_start(%L)$$, pg_temp.wer_id('wer_answering')));
select pg_temp.wer_assert(pg_temp.wer_state('wer_answering') = 'active/-/false', 'withdrawing while the poster still has time also reopens the gig');
select pg_temp.wer_assert(pg_temp.wer_pending('wer_answering') = 2, 'both waiting offers survive');

-- ---------------------------------------------------------------------------
-- 4. withdraw_before_start(): refused once the silence window or a delay takes over.
-- ---------------------------------------------------------------------------
select pg_temp.wer_error('helper', pg_catalog.format($$select public.withdraw_before_start(%L)$$, pg_temp.wer_id('wer_silent')), 'P0001',
  'once 24 hours of silence pass, this path is refused in favor of the start-request screen', 'wait or withdraw from the start request screen instead');
select pg_temp.wer_assert(pg_temp.wer_claim('wer_silent', 'helper') = 'selected', 'the claim is untouched by the refusal');
select pg_temp.wer_error('helper', pg_catalog.format($$select public.withdraw_before_start(%L)$$, pg_temp.wer_id('wer_delayed')), 'P0001',
  'once the poster has delayed the start, withdraw_from_gig is the only way to leave');
select pg_temp.wer_error('helper', pg_catalog.format($$select public.withdraw_before_start(%L)$$, pg_temp.wer_id('wer_wrongstatus')), 'P0001',
  'withdraw_before_start is refused once the gig is in progress');

-- ---------------------------------------------------------------------------
-- 5. exit_gig(): only once the gig is in progress.
-- ---------------------------------------------------------------------------
select pg_temp.wer_error('helper', pg_catalog.format($$select public.exit_gig(%L, 'safety_concern', null)$$, pg_temp.wer_id('wer_active')), 'P0001',
  'exit_gig is refused before the gig is in progress', 'only exit a gig that is in progress');
select pg_temp.wer_denied('anon', pg_catalog.format($$select public.exit_gig(%L, 'safety_concern', null)$$, pg_temp.wer_id('wer_prog')), 'anon cannot exit a gig');
select pg_temp.wer_denied('stranger', pg_catalog.format($$select public.exit_gig(%L, 'safety_concern', null)$$, pg_temp.wer_id('wer_prog')), 'nor a stranger');
select pg_temp.wer_denied('poster', pg_catalog.format($$select public.exit_gig(%L, 'safety_concern', null)$$, pg_temp.wer_id('wer_prog')), 'nor the poster -- this is the provider''s action');
select pg_temp.wer_denied('other1', pg_catalog.format($$select public.exit_gig(%L, 'safety_concern', null)$$, pg_temp.wer_id('wer_prog')), 'nor a waiting offer, since they were never selected');

-- 'other' requires a comment; the approved reasons do not.
select pg_temp.wer_error('helper', pg_catalog.format($$select public.exit_gig(%L, 'other', null)$$, pg_temp.wer_id('wer_prog_other')), '22023',
  'exiting for "other" without a comment is refused', 'Enter a reason to exit');
select pg_temp.wer_error('helper', pg_catalog.format($$select public.exit_gig(%L, 'other', %L)$$, pg_temp.wer_id('wer_prog_other'), repeat('x', 501)), '22023',
  'a comment over 500 characters is refused', '500 characters');
select pg_temp.wer_assert(pg_temp.wer_claim('wer_prog_other', 'helper') = 'selected', 'the refused attempts left the claim untouched');
select pg_temp.wer_exec('helper', pg_catalog.format($$select public.exit_gig(%L, 'other', 'had to leave town')$$, pg_temp.wer_id('wer_prog_other')));
select pg_temp.wer_assert(pg_temp.wer_state('wer_prog_other') = 'active/-/false', 'a valid "other" reason with a comment succeeds and reopens the gig');
select pg_temp.wer_assert((select pg_temp.wer_note_msg('poster', 'wer_prog_other', 'helper_exited') like '%"had to leave town"%'), 'the comment reaches the poster');

-- With two offers still waiting: exit_gig reopens to active, keeping them, same as the pre-start siblings.
select pg_temp.wer_exec('helper', pg_catalog.format($$select public.exit_gig(%L, 'safety_concern', null)$$, pg_temp.wer_id('wer_prog')));
select pg_temp.wer_assert(pg_temp.wer_state('wer_prog') = 'active/-/false', 'exiting an in-progress gig reopens it to active');
select pg_temp.wer_assert(pg_temp.wer_claim('wer_prog', 'helper') = 'withdrawn' and pg_temp.wer_pending('wer_prog') = 2, 'the exiting provider is withdrawn for good, the waiting offers are untouched');
select pg_temp.wer_assert(pg_temp.wer_chat('wer_prog') = 0 and pg_temp.wer_proposals('wer_prog') = 0, 'the old conversation and proposal are cleared for the next provider');
select pg_temp.wer_assert(pg_temp.wer_lemons('poster') = 0, 'exiting never costs the poster a lemon');
select pg_temp.wer_assert((select pg_temp.wer_note_msg('poster', 'wer_prog', 'helper_exited') like '%safety concern%'), 'the poster is told the reason');

-- Spec mandates 'active', never 'cancelled', even with nobody else waiting -- unlike withdraw_before_start/remove_helper.
select pg_temp.wer_exec('helper', pg_catalog.format($$select public.exit_gig(%L, 'unable_to_locate_poster', null)$$, pg_temp.wer_id('wer_prog_lone')));
select pg_temp.wer_assert(pg_temp.wer_state('wer_prog_lone') = 'active/-/false', 'with nobody else waiting, exit_gig still reopens to active rather than cancelling');

-- ---------------------------------------------------------------------------
-- 6. remove_helper(): a reason is now required.
-- ---------------------------------------------------------------------------
select pg_temp.wer_error('poster', pg_catalog.format($$select public.remove_helper(%L, null)$$, pg_temp.wer_id('wer_rm')), '22023',
  'removing with no reason at all is refused', 'Enter a reason to remove this helper');
select pg_temp.wer_error('poster', pg_catalog.format($$select public.remove_helper(%L, '   ')$$, pg_temp.wer_id('wer_rm')), '22023',
  'a whitespace-only reason is refused the same way', 'Enter a reason to remove this helper');
select pg_temp.wer_error('poster', pg_catalog.format($$select public.remove_helper(%L, %L)$$, pg_temp.wer_id('wer_rm'), repeat('x', 501)), '22023',
  'a reason over 500 characters is refused', '500 characters');
select pg_temp.wer_assert(pg_temp.wer_claim('wer_rm', 'helper') = 'selected', 'the refused attempts left the claim untouched');
select pg_temp.wer_exec('poster', pg_catalog.format($$select public.remove_helper(%L, '  Not responding to messages  ')$$, pg_temp.wer_id('wer_rm')));
select pg_temp.wer_assert(pg_temp.wer_state('wer_rm') = 'cancelled/-/false', 'a real reason is accepted; with nobody else waiting the gig is cancelled as before');
select pg_temp.wer_assert((select pg_temp.wer_note_msg('helper', 'wer_rm', 'helper_removed') like '%Not responding to messages%'), 'the trimmed reason reaches the removed helper');

reset role;
rollback;
