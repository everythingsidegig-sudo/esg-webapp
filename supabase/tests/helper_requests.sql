-- Helper-targeted gig requests: visibility, authorization, lifecycle, address privacy.
-- Run only against an isolated Supabase test database after 0001 through 0011.
-- All fixtures roll back. Run as postgres (or an equivalent trusted role).
begin;

create temporary table rq_fixture (name text primary key, id uuid);
insert into rq_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['poster','poster2','helper_a','helper_b','helper_c','helper_d','helper_e','helper_f','nocat','banned','ghost','stranger',
  'g_neg','g_fixed','g_decl','g_draft','g_public','g_cnt','g_move','g_cancel','g_stale','g_re','g_wd','g_del','g_taxo','g_p2','poster3','helper_g','g_p2b','g_pubdel','g_p3','g_p3b','g_hd','g_hd2','g_hd3','g_hdpub','g_sel']) as n(name);
grant select, update on rq_fixture to anon, authenticated;

create function pg_temp.rq_id(p_name text) returns uuid
language sql stable as $$ select id from pg_temp.rq_fixture where name = p_name; $$;
create function pg_temp.rq_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.rq_switch(p_user text) returns void language plpgsql as $$
declare v_id uuid;
begin
  if p_user = 'admin' then return; end if;
  if p_user = 'anon' then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    set local role anon;
  else
    select id into v_id from pg_temp.rq_fixture where name = p_user;
    perform set_config('request.jwt.claim.sub', v_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end;
$$;
create function pg_temp.rq_query(p_user text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.rq_switch(p_user);
  begin execute p_sql into v; exception when others then reset role; raise; end;
  reset role;
  return v;
end;
$$;
create function pg_temp.rq_exec(p_user text, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.rq_switch(p_user);
  begin execute p_sql; exception when others then reset role; raise; end;
  reset role;
end;
$$;
create function pg_temp.rq_error(p_user text, p_sql text, p_code text, p_label text, p_msg text default null) returns void
language plpgsql as $$
begin
  begin
    perform pg_temp.rq_exec(p_user, p_sql);
  exception when others then
    if sqlstate <> p_code or (p_msg is not null and sqlerrm <> p_msg) then
      raise exception 'FAIL: % (got % %)', p_label, sqlstate, sqlerrm;
    end if;
    raise notice 'PASS: %', p_label; return;
  end;
  raise exception 'FAIL (expected error %): %', p_code, p_label;
end;
$$;
create function pg_temp.rq_denied(p_user text, p_sql text, p_label text) returns void
language plpgsql as $$ begin perform pg_temp.rq_error(p_user, p_sql, '42501', p_label); end; $$;

do $$
declare v_schema text;
begin
  select nspname into v_schema from pg_catalog.pg_namespace where oid = pg_catalog.pg_my_temp_schema();
  execute pg_catalog.format('grant usage on schema %I to anon, authenticated', v_schema);
end;
$$;

-- Create a gig as a user and remember its id. Helper is a fixture name or null.
create function pg_temp.rq_gig(p_user text, p_name text, p_helper text, p_price text, p_publish boolean,
  p_address text default null, p_tags uuid[] default '{}', p_service text default 'Cleaning') returns void language plpgsql as $$
begin
  update pg_temp.rq_fixture set id = pg_temp.rq_query(p_user, pg_catalog.format(
    $q$select (public.create_gig(gen_random_uuid(),%L,'Gig %s','Description',500,%L,%s,'Kävlinge',null,null,null,%L,%L::uuid[],%L,%L)).id::text$q$,
    p_service, p_name, p_price, case when p_publish then 'now()+interval ''3 days''' else 'null' end, p_publish, p_tags, p_address,
    case when p_helper is null then null else pg_temp.rq_id(p_helper)::text end))::uuid
  where name = p_name;
end;
$$;
-- Names of fixture gigs a user can see.
create function pg_temp.rq_see(p_user text) returns text language sql as $$
  select pg_temp.rq_query(p_user, $q$select coalesce(string_agg(f.name, ',' order by f.name), '') from pg_temp.rq_fixture f join public.gigs g on g.id = f.id$q$);
$$;
create function pg_temp.rq_see_tags(p_user text) returns text language sql as $$
  select pg_temp.rq_query(p_user, $q$select coalesce(string_agg(distinct f.name, ',' order by f.name), '') from pg_temp.rq_fixture f join public.gig_tags t on t.gig_id = f.id$q$);
$$;
-- Address visible to a user; anon has no table grant at all, which counts as "nothing visible".
create function pg_temp.rq_addr(p_user text, p_gig text) returns text language plpgsql as $fn$
begin
  return pg_temp.rq_query(p_user, pg_catalog.format($q$select coalesce((select address_text from public.gig_private_locations where gig_id = %L), '')$q$, pg_temp.rq_id(p_gig)));
exception when insufficient_privilege then
  return '';
end;
$fn$;
create function pg_temp.rq_state(p_gig text) returns text language sql as $$
  select g.status::text || '/' || coalesce((select username from public.profiles where id = g.selected_provider_id), '-') || '/' ||
    coalesce((select username from public.profiles where id = g.requested_helper_id), '-') || '/' || coalesce(g.agreed_amount::text, '-')
  from public.gigs g where g.id = pg_temp.rq_id(p_gig);
$$;
create function pg_temp.rq_claim(p_gig text, p_user text) returns text language sql as $$
  select coalesce((select state::text || ':' || offer_amount::text from public.claims where gig_id = pg_temp.rq_id(p_gig) and provider_id = pg_temp.rq_id(p_user)), 'none');
$$;
create function pg_temp.rq_notes(p_user text, p_gig text, p_type text) returns bigint language sql as $$
  select count(*) from public.notifications where recipient_id = pg_temp.rq_id(p_user) and gig_id = pg_temp.rq_id(p_gig) and type = p_type;
$$;
grant execute on all functions in schema pg_temp to anon, authenticated;

insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
select id, 'authenticated', 'authenticated', name || '-' || id::text || '@example.invalid',
  jsonb_build_object('username', 'RQ' || pg_catalog.replace(name, '_', '')), now(), now()
from rq_fixture where name in ('poster','poster2','poster3','helper_g','helper_a','helper_b','helper_c','helper_d','helper_e','helper_f','nocat','banned','ghost','stranger');

select pg_temp.rq_query('poster', $$select public.save_onboarding('RQposter1', null, '1 Private Street', 55.7, 13.1, '[]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('poster2', $$select public.save_onboarding('RQposter2', null, '2 Private Street', 55.7, 13.1, '[]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('poster3', $$select public.save_onboarding('RQposter3', null, '3 Private Street', 55.7, 13.1, '[]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('helper_g', $$select public.save_onboarding('RQhelperG', null, 'Area G', 55.7, 13.1, '["Cleaning"]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('helper_a', $$select public.save_onboarding('RQhelperA', null, 'Area A', 55.7, 13.1, '["Cleaning"]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('helper_b', $$select public.save_onboarding('RQhelperB', null, 'Area B', 55.7, 13.1, '["Cleaning"]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('helper_c', $$select public.save_onboarding('RQhelperC', null, 'Area C', 55.7, 13.1, '["Cleaning","Delivery / Pickup"]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('helper_d', $$select public.save_onboarding('RQhelperD', null, 'Area D', 55.7, 13.1, '["Cleaning"]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('helper_e', $$select public.save_onboarding('RQhelperE', null, 'Area E', 55.7, 13.1, '["Cleaning"]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('helper_f', $$select public.save_onboarding('RQhelperF', null, 'Area F', 55.7, 13.1, '["Cleaning"]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('nocat', $$select public.save_onboarding('RQnocat01', null, 'Area N', 55.7, 13.1, '["Delivery / Pickup"]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('banned', $$select public.save_onboarding('RQbanned1', null, 'Area X', 55.7, 13.1, '["Cleaning"]'::jsonb, '[]'::jsonb)::text$$);
select pg_temp.rq_query('stranger', $$select public.save_onboarding('RQstrang1', null, 'Area S', 55.7, 13.1, '["Cleaning"]'::jsonb, '[]'::jsonb)::text$$);
-- ghost never finished onboarding (no onboarding_completed_at); banned is locked like a deleted account.
update auth.users set banned_until = now() + interval '100 years' where id = pg_temp.rq_id('banned');

-- ---------------------------------------------------------------------------
-- 1. Creating requests: validation happens in the database.
-- ---------------------------------------------------------------------------
select pg_temp.rq_error('poster', pg_catalog.format($$select public.create_gig(gen_random_uuid(),'Cleaning','x','x',500,'fixed',now()+interval '3 days','Kävlinge',null,null,null,true,'{}'::uuid[],null,%L)$$, pg_temp.rq_id('poster')),
  '22023', 'a poster cannot request themselves', 'You cannot send a request to yourself.');
select pg_temp.rq_error('poster', $$select public.create_gig(gen_random_uuid(),'Cleaning','x','x',500,'fixed',now()+interval '3 days','Kävlinge',null,null,null,true,'{}'::uuid[],null,gen_random_uuid())$$,
  '22023', 'a helper that does not exist is rejected', 'That helper isn''t available for requests.');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.create_gig(gen_random_uuid(),'Cleaning','x','x',500,'fixed',now()+interval '3 days','Kävlinge',null,null,null,true,'{}'::uuid[],null,%L)$$, pg_temp.rq_id('banned')),
  '22023', 'a banned/locked account cannot be requested', 'That helper isn''t available for requests.');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.create_gig(gen_random_uuid(),'Cleaning','x','x',500,'fixed',now()+interval '3 days','Kävlinge',null,null,null,true,'{}'::uuid[],null,%L)$$, pg_temp.rq_id('ghost')),
  '22023', 'an account without a finished profile cannot be requested', 'That helper isn''t available for requests.');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.create_gig(gen_random_uuid(),'Cleaning','x','x',500,'fixed',now()+interval '3 days','Kävlinge',null,null,null,true,'{}'::uuid[],null,%L)$$, pg_temp.rq_id('nocat')),
  '22023', 'a helper who does not offer the category is rejected', 'That helper doesn''t offer this category.');
select pg_temp.rq_error('poster', $$select public.create_gig(gen_random_uuid(),'Cleaning','x','x',500,'negotiable',now()+interval '3 days','Kävlinge',null,null,null,true,'{}'::uuid[],null,null)$$,
  '22023', 'public gigs stay fixed-price only: negotiable is accepted only for a request', 'This POC supports fixed-price gigs only.');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.create_gig(gen_random_uuid(),'Cleaning','x','x',500,'auction',now()+interval '3 days','Kävlinge',null,null,null,true,'{}'::uuid[],null,%L)$$, pg_temp.rq_id('helper_a')),
  '22023', 'unknown price types are still rejected for a request', 'This POC supports fixed-price gigs only.');
select pg_temp.rq_denied('anon', pg_catalog.format($$select public.create_gig(gen_random_uuid(),'Cleaning','x','x',500,'fixed',now()+interval '3 days','Kävlinge',null,null,null,true,'{}'::uuid[],null,%L)$$, pg_temp.rq_id('helper_a')),
  'anonymous users cannot create requests');

select pg_temp.rq_error('poster', pg_catalog.format($$select public.create_gig(gen_random_uuid(),'Cleaning','x',%L,500,'fixed',now()+interval '3 days','Kävlinge',null,null,null,true,'{}'::uuid[],null,%L)$$, repeat('d', 51), pg_temp.rq_id('helper_a')),
  '22023', 'the 50-character description limit from main applies to requests too', 'Enter a description of 1–50 characters.');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.create_gig(gen_random_uuid(),'Delivery','x','x',500,'fixed',now()+interval '3 days','Kävlinge',null,null,null,true,'{}'::uuid[],null,%L)$$, pg_temp.rq_id('helper_c')),
  '22023', 'the retired "Delivery" category is rejected (main renamed it to "Delivery / Pickup")', 'Choose a valid service type.');
-- A tag that exists for the category, to prove tag visibility follows the gig.
create temporary table rq_tag as select id from public.tags where service_type = 'Cleaning' order by name limit 1;
grant select on rq_tag to anon, authenticated;

select pg_temp.rq_gig('poster', 'g_public', null, 'fixed', true, 'Public Address 9', (select array_agg(id) from rq_tag));
select pg_temp.rq_gig('poster', 'g_neg', 'helper_a', 'negotiable', true, 'Secret Street 1', (select array_agg(id) from rq_tag));
select pg_temp.rq_gig('poster', 'g_fixed', 'helper_b', 'fixed', true, 'Secret Street 2');
select pg_temp.rq_gig('poster', 'g_decl', 'helper_c', 'fixed', true, 'Secret Street 3');
select pg_temp.rq_gig('poster', 'g_draft', 'helper_d', 'fixed', false, 'Secret Street 4');
select pg_temp.rq_gig('poster', 'g_cnt', 'helper_a', 'negotiable', true, 'Secret Street 5');
select pg_temp.rq_gig('poster', 'g_move', 'helper_b', 'fixed', true, 'Secret Street 6');
select pg_temp.rq_gig('poster', 'g_cancel', 'helper_a', 'negotiable', true, 'Secret Street 7');
select pg_temp.rq_gig('poster', 'g_stale', 'helper_b', 'fixed', true, 'Secret Street 8');
select pg_temp.rq_gig('poster', 'g_re', 'helper_e', 'negotiable', true, 'Secret Street 9');
select pg_temp.rq_gig('poster', 'g_wd', 'helper_e', 'negotiable', true, 'Secret Street 10');

select pg_temp.rq_gig('poster', 'g_taxo', 'helper_c', 'fixed', true, null, '{}', 'Delivery / Pickup');
select pg_temp.rq_assert((select service_type = 'Delivery / Pickup' and requested_helper_id = pg_temp.rq_id('helper_c') from public.gigs where id = pg_temp.rq_id('g_taxo')),
  'a request in a renamed category works for a helper who offers it (13-category taxonomy)');
select pg_temp.rq_assert(pg_temp.rq_state('g_neg') = 'active/-/RQhelperA/-', 'a request is an active, unassigned gig addressed to the helper');
select pg_temp.rq_assert((select price_type = 'negotiable' from public.gigs where id = pg_temp.rq_id('g_neg'))
  and (select price_type = 'fixed' from public.gigs where id = pg_temp.rq_id('g_fixed')), 'fixed and negotiable pricing are stored for requests');
select pg_temp.rq_assert((select price_type = 'fixed' and requested_helper_id is null from public.gigs where id = pg_temp.rq_id('g_public')), 'the public gig is unchanged: fixed, no requested helper');
select pg_temp.rq_assert(pg_temp.rq_state('g_draft') = 'draft/-/RQhelperD/-', 'a request can be saved as a draft');
select pg_temp.rq_assert(pg_temp.rq_notes('helper_a', 'g_neg', 'gig_request') = 1 and pg_temp.rq_notes('helper_b', 'g_fixed', 'gig_request') = 1,
  'the requested helper is notified when a live request is created');
select pg_temp.rq_assert(pg_temp.rq_notes('helper_d', 'g_draft', 'gig_request') = 0, 'no notification while the request is still a draft');
select pg_temp.rq_assert((select count(*) = 0 from public.notifications where gig_id in (pg_temp.rq_id('g_neg'), pg_temp.rq_id('g_public')) and recipient_id in (pg_temp.rq_id('poster'), pg_temp.rq_id('stranger'), pg_temp.rq_id('helper_b'))),
  'nobody but the requested helper is notified about a request');
select pg_temp.rq_assert((select message = '@RQposter1 sent you a request: "Gig g_neg".' from public.notifications where gig_id = pg_temp.rq_id('g_neg') and type = 'gig_request'),
  'the request notification names the poster and gig only');

-- ---------------------------------------------------------------------------
-- 2. Visibility: a request is never public.
-- ---------------------------------------------------------------------------
select pg_temp.rq_assert(pg_temp.rq_see('anon') = 'g_public', 'anonymous users (Browse) see only the public gig');
select pg_temp.rq_assert(pg_temp.rq_see('stranger') = 'g_public', 'an unrelated signed-in helper sees only the public gig');
select pg_temp.rq_assert(pg_temp.rq_see('helper_a') = 'g_cancel,g_cnt,g_neg,g_public', 'the requested helper sees their own requests (not the draft, not others'' requests)');
select pg_temp.rq_assert(pg_temp.rq_see('helper_b') = 'g_fixed,g_move,g_public,g_stale', 'another requested helper sees only requests addressed to them');
select pg_temp.rq_assert(pg_temp.rq_see('helper_d') = 'g_public', 'the helper named on a DRAFT request cannot see it before it is published');
select pg_temp.rq_assert(pg_temp.rq_see('poster') = 'g_cancel,g_cnt,g_decl,g_draft,g_fixed,g_move,g_neg,g_public,g_re,g_stale,g_taxo,g_wd', 'the poster sees everything they posted');
select pg_temp.rq_assert(pg_temp.rq_see_tags('anon') = 'g_public', 'anonymous users see tags of the public gig only');
select pg_temp.rq_assert(pg_temp.rq_see_tags('stranger') = 'g_public', 'unrelated helpers do not see the tags of a request');
select pg_temp.rq_assert(pg_temp.rq_see_tags('helper_a') = 'g_neg,g_public', 'the requested helper sees their request''s tags');
select pg_temp.rq_assert(pg_temp.rq_addr('helper_a', 'g_neg') = '' and pg_temp.rq_addr('stranger', 'g_neg') = '' and pg_temp.rq_addr('anon', 'g_neg') = '',
  'the exact address of a pending request is hidden from the requested helper, strangers and anonymous users');
select pg_temp.rq_assert(pg_temp.rq_addr('poster', 'g_neg') = 'Secret Street 1', 'the poster can read their own address');

-- ---------------------------------------------------------------------------
-- 3. Offers on a request: only the requested helper, only if negotiable.
-- ---------------------------------------------------------------------------
select pg_temp.rq_error('stranger', pg_catalog.format($$select public.create_claim(%L, 100, null)$$, pg_temp.rq_id('g_neg')), 'P0001',
  'another helper cannot offer on a request (same message as any closed gig)', 'Gig is not open for claims');
select pg_temp.rq_error('helper_b', pg_catalog.format($$select public.create_claim(%L, 100, null)$$, pg_temp.rq_id('g_neg')), 'P0001',
  'a helper addressed on a different request cannot offer on this one', 'Gig is not open for claims');
select pg_temp.rq_error('helper_b', pg_catalog.format($$select public.create_claim(%L, 100, null)$$, pg_temp.rq_id('g_fixed')), 'P0001',
  'a fixed-price request cannot be counteroffered', 'This request has a fixed price. Accept or decline it instead of making an offer.');
select pg_temp.rq_assert((select count(*) = 0 from public.claims where gig_id in (pg_temp.rq_id('g_neg'), pg_temp.rq_id('g_fixed'))), 'rejected offers leave no claim rows behind');
select pg_temp.rq_error('anon', pg_catalog.format($$select public.create_claim(%L, 100, null)$$, pg_temp.rq_id('g_neg')), '42501', 'anonymous users cannot offer');
-- Public gigs behave exactly as before: any positive price is an offer.
select pg_temp.rq_query('stranger', pg_catalog.format($$select (public.create_claim(%L, 350.50, 'public offer')).id::text$$, pg_temp.rq_id('g_public')));
select pg_temp.rq_assert(pg_temp.rq_claim('g_public', 'stranger') = 'pending:350.50', 'public gig offers are unchanged (different price on a fixed gig still allowed)');

-- Counteroffer on a negotiable request -> poster accepts through the existing select_provider.
select pg_temp.rq_query('helper_a', pg_catalog.format($$select (public.create_claim(%L, 420, 'Can do for less')).id::text$$, pg_temp.rq_id('g_neg')));
select pg_temp.rq_assert(pg_temp.rq_claim('g_neg', 'helper_a') = 'pending:420.00', 'the requested helper can counteroffer on a negotiable request');
select pg_temp.rq_assert(pg_temp.rq_notes('poster', 'g_neg', 'claim_received') = 1, 'the poster is notified of the counteroffer with the existing notification type');
select pg_temp.rq_assert(pg_temp.rq_state('g_neg') = 'active/-/RQhelperA/-', 'a counteroffer alone does not assign the helper');
select pg_temp.rq_assert(pg_temp.rq_addr('helper_a', 'g_neg') = '', 'a pending counteroffer does not release the exact address');
select pg_temp.rq_error('helper_a', pg_catalog.format($$insert into public.chat_messages (gig_id, sender_id, body) values (%L, %L, 'hi')$$, pg_temp.rq_id('g_neg'), pg_temp.rq_id('helper_a')), '42501',
  'no chat before assignment: a pending counteroffer cannot message the poster');
select pg_temp.rq_error('helper_a', pg_catalog.format($$select public.select_provider(%L, %L)$$, pg_temp.rq_id('g_neg'), (select id from public.claims where gig_id = pg_temp.rq_id('g_neg'))), '42501',
  'the helper cannot accept their own counteroffer');
select pg_temp.rq_exec('poster', pg_catalog.format($$select public.select_provider(%L, %L)$$, pg_temp.rq_id('g_neg'), (select id from public.claims where gig_id = pg_temp.rq_id('g_neg'))));
select pg_temp.rq_assert(pg_temp.rq_state('g_neg') = 'active/RQhelperA/RQhelperA/420.00', 'accepting the counteroffer assigns the helper at the offered price');
select pg_temp.rq_assert((select amount = 500 from public.gigs where id = pg_temp.rq_id('g_neg')), 'the posted budget is preserved');
select pg_temp.rq_assert(pg_temp.rq_addr('helper_a', 'g_neg') = 'Secret Street 1', 'after the poster accepts, the assigned helper can read the exact address');
select pg_temp.rq_assert(pg_temp.rq_addr('stranger', 'g_neg') = '' and pg_temp.rq_addr('helper_b', 'g_neg') = '', 'other helpers still cannot read it');
select pg_temp.rq_assert(pg_temp.rq_notes('helper_a', 'g_neg', 'selected') = 1, 'the accepted helper gets the existing "selected" notification');
select pg_temp.rq_assert(pg_temp.rq_see_tags('stranger') = 'g_public', 'tags of an assigned gig are no longer public');
select pg_temp.rq_exec('helper_a', pg_catalog.format($$insert into public.chat_messages (gig_id, sender_id, body) values (%L, %L, 'hello')$$, pg_temp.rq_id('g_neg'), pg_temp.rq_id('helper_a')));
select pg_temp.rq_assert(pg_temp.rq_query('poster', pg_catalog.format($$select count(*)::text from public.chat_messages where gig_id = %L$$, pg_temp.rq_id('g_neg'))) = '1'
  and pg_temp.rq_query('stranger', pg_catalog.format($$select count(*)::text from public.chat_messages where gig_id = %L$$, pg_temp.rq_id('g_neg'))) = '0',
  'chat opens for the poster and assigned helper only (the existing gig-scoped chat)');

-- ---------------------------------------------------------------------------
-- 4. Accepting the posted price.
-- ---------------------------------------------------------------------------
select pg_temp.rq_denied('stranger', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_fixed')), 'another helper cannot accept a request addressed to someone else');
select pg_temp.rq_denied('poster', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_fixed')), 'the poster cannot accept their own request');
select pg_temp.rq_denied('anon', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_fixed')), 'anonymous users cannot accept');
select pg_temp.rq_denied('helper_a', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_fixed')), 'a helper requested on another gig cannot accept this one');
select pg_temp.rq_assert(pg_temp.rq_state('g_fixed') = 'active/-/RQhelperB/-', 'failed accepts changed nothing');
select pg_temp.rq_exec('helper_b', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_fixed')));
select pg_temp.rq_assert(pg_temp.rq_state('g_fixed') = 'active/RQhelperB/RQhelperB/500.00', 'accepting assigns the helper at the posted price');
select pg_temp.rq_assert(pg_temp.rq_claim('g_fixed', 'helper_b') = 'selected:500.00', 'the acceptance is recorded as the selected claim');
select pg_temp.rq_assert(pg_temp.rq_notes('poster', 'g_fixed', 'request_accepted') = 1, 'the poster is notified of the acceptance');
select pg_temp.rq_assert(pg_temp.rq_addr('helper_b', 'g_fixed') = 'Secret Street 2', 'the accepting helper can now read the exact address');
select pg_temp.rq_assert(pg_temp.rq_addr('stranger', 'g_fixed') = '' and pg_temp.rq_addr('helper_a', 'g_fixed') = '' and pg_temp.rq_addr('anon', 'g_fixed') = '',
  'no other user or anonymous visitor can read it');
select pg_temp.rq_error('helper_b', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_fixed')), 'P0001', 'a second accept is refused', 'This request is no longer open.');
select pg_temp.rq_error('admin', pg_catalog.format($$insert into public.claims (gig_id, provider_id, state, offer_amount) values (%L, %L, 'selected', 1)$$, pg_temp.rq_id('g_fixed'), pg_temp.rq_id('stranger')), '23505',
  'the unique selected-claim index is the backstop against two winners');
select pg_temp.rq_exec('helper_b', pg_catalog.format($$insert into public.chat_messages (gig_id, sender_id, body) values (%L, %L, 'on my way')$$, pg_temp.rq_id('g_fixed'), pg_temp.rq_id('helper_b')));
select pg_temp.rq_exec('helper_b', pg_catalog.format($$select public.request_start(%L)$$, pg_temp.rq_id('g_fixed')));
select pg_temp.rq_assert((select start_requested_at is not null from public.gigs where id = pg_temp.rq_id('g_fixed')), 'the existing completion lifecycle continues after an accepted request');

-- A pending counteroffer can be replaced by accepting the original price.
select pg_temp.rq_query('helper_a', pg_catalog.format($$select (public.create_claim(%L, 300, 'cheaper')).id::text$$, pg_temp.rq_id('g_cnt')));
select pg_temp.rq_exec('helper_a', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_cnt')));
select pg_temp.rq_assert(pg_temp.rq_state('g_cnt') = 'active/RQhelperA/RQhelperA/500.00' and pg_temp.rq_claim('g_cnt', 'helper_a') = 'selected:500.00',
  'accepting the posted price after a counteroffer assigns at the posted price, not the counteroffer');

-- ---------------------------------------------------------------------------
-- 5. Declining: the gig is NOT cancelled and stays private.
-- ---------------------------------------------------------------------------
select pg_temp.rq_denied('stranger', pg_catalog.format($$select public.decline_gig_request(%L)$$, pg_temp.rq_id('g_decl')), 'only the requested helper can decline');
select pg_temp.rq_denied('poster', pg_catalog.format($$select public.decline_gig_request(%L)$$, pg_temp.rq_id('g_decl')), 'the poster cannot decline their own request');
select pg_temp.rq_exec('helper_c', pg_catalog.format($$select public.decline_gig_request(%L)$$, pg_temp.rq_id('g_decl')));
select pg_temp.rq_assert(pg_temp.rq_state('g_decl') = 'active/-/RQhelperC/-', 'a declined request stays active, unassigned and private (not cancelled)');
select pg_temp.rq_assert(pg_temp.rq_claim('g_decl', 'helper_c') = 'withdrawn:500.00', 'the decline is recorded as a closed-out (withdrawn) claim');
select pg_temp.rq_assert(pg_temp.rq_notes('poster', 'g_decl', 'request_declined') = 1
  and (select message = '@RQhelperC declined your request "Gig g_decl". You can post it publicly or cancel it.' from public.notifications where gig_id = pg_temp.rq_id('g_decl') and type = 'request_declined'),
  'the poster is notified with accurate text');
select pg_temp.rq_exec('helper_c', pg_catalog.format($$select public.decline_gig_request(%L)$$, pg_temp.rq_id('g_decl')));
select pg_temp.rq_assert(pg_temp.rq_notes('poster', 'g_decl', 'request_declined') = 1, 'declining twice is a no-op (no duplicate notification)');
select pg_temp.rq_error('helper_c', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_decl')), 'P0001', 'a declined request cannot be accepted afterwards (stale page)', 'This request is no longer open.');
select pg_temp.rq_assert(pg_temp.rq_claim('g_decl', 'helper_c') = 'withdrawn:500.00'
  and pg_temp.rq_query('helper_c', pg_catalog.format($$select (public.create_claim(%L, 400, null)).state::text$$, pg_temp.rq_id('g_decl'))) = 'withdrawn',
  'a closed-out request is never reopened: create_claim returns the withdrawn claim unchanged (established claim semantics)');
select pg_temp.rq_assert(pg_temp.rq_addr('helper_c', 'g_decl') = '' and pg_temp.rq_addr('anon', 'g_decl') = '', 'a declined request releases no address');

-- ---------------------------------------------------------------------------
-- 6. Withdrawing a counteroffer closes the request out and tells the poster.
-- ---------------------------------------------------------------------------
select pg_temp.rq_query('helper_e', pg_catalog.format($$select (public.create_claim(%L, 450, null)).id::text$$, pg_temp.rq_id('g_wd')));
select pg_temp.rq_exec('helper_e', pg_catalog.format($$select public.withdraw_claim(%L)$$, pg_temp.rq_id('g_wd')));
select pg_temp.rq_assert(pg_temp.rq_claim('g_wd', 'helper_e') = 'withdrawn:450.00' and pg_temp.rq_state('g_wd') = 'active/-/RQhelperE/-',
  'withdrawing the counteroffer closes the request out; the gig stays active and private');
select pg_temp.rq_assert((select message = '@RQhelperE withdrew their offer on your request "Gig g_wd". You can post it publicly or cancel it.'
  from public.notifications where gig_id = pg_temp.rq_id('g_wd') and type = 'request_declined'), 'the poster is told, with accurate text');
select pg_temp.rq_error('helper_e', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_wd')), 'P0001', 'a withdrawn counteroffer cannot be accepted by the helper afterwards', 'This request is no longer open.');
select pg_temp.rq_assert(pg_temp.rq_notes('poster', 'g_public', 'request_declined') = 0, 'public gigs: withdrawing an offer sends no new notification (unchanged)');

-- ---------------------------------------------------------------------------
-- 7. Cancelling a request.
-- ---------------------------------------------------------------------------
select pg_temp.rq_query('helper_a', pg_catalog.format($$select (public.create_claim(%L, 400, null)).id::text$$, pg_temp.rq_id('g_cancel')));
select pg_temp.rq_denied('stranger', pg_catalog.format($$select public.cancel_gig(%L)$$, pg_temp.rq_id('g_cancel')), 'only the poster can cancel a request');
select pg_temp.rq_denied('helper_a', pg_catalog.format($$select public.cancel_gig(%L)$$, pg_temp.rq_id('g_cancel')), 'the requested helper cannot cancel it');
select pg_temp.rq_exec('poster', pg_catalog.format($$select public.cancel_gig(%L)$$, pg_temp.rq_id('g_cancel')));
select pg_temp.rq_assert(pg_temp.rq_state('g_cancel') like 'cancelled/-/RQhelperA/%' and pg_temp.rq_claim('g_cancel', 'helper_a') = 'rejected:400.00',
  'cancelling closes the request and rejects the helper''s pending counteroffer (existing behavior)');
select pg_temp.rq_assert(pg_temp.rq_notes('helper_a', 'g_cancel', 'request_withdrawn') = 1, 'the requested helper is told the request was cancelled');
select pg_temp.rq_error('helper_a', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_cancel')), 'P0001', 'a cancelled request cannot be accepted (stale page)', 'This request is no longer open.');
select pg_temp.rq_assert(pg_temp.rq_see('anon') not like '%g_cancel%' and pg_temp.rq_addr('helper_a', 'g_cancel') = '', 'cancelling never makes the request public or releases the address');

-- ---------------------------------------------------------------------------
-- 8. Reassigning / making a request public (atomic, poster only).
-- ---------------------------------------------------------------------------
select pg_temp.rq_denied('stranger', pg_catalog.format($$select public.reassign_gig_request(%L, null)$$, pg_temp.rq_id('g_move')), 'a stranger cannot reassign or publish a request');
select pg_temp.rq_denied('helper_b', pg_catalog.format($$select public.reassign_gig_request(%L, null)$$, pg_temp.rq_id('g_move')), 'the requested helper cannot reassign or publish it');
select pg_temp.rq_denied('anon', pg_catalog.format($$select public.reassign_gig_request(%L, null)$$, pg_temp.rq_id('g_move')), 'anonymous users cannot reassign');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.reassign_gig_request(%L, null)$$, pg_temp.rq_id('g_public')), 'P0001', 'a normal public gig is not a request', 'This gig is not a helper request.');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.reassign_gig_request(%L, %L)$$, pg_temp.rq_id('g_move'), pg_temp.rq_id('poster')), '22023', 'a request cannot be reassigned to the poster', 'You cannot send a request to yourself.');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.reassign_gig_request(%L, %L)$$, pg_temp.rq_id('g_move'), pg_temp.rq_id('helper_b')), '22023', 'reassigning to the current helper is refused', 'That helper already has this request.');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.reassign_gig_request(%L, %L)$$, pg_temp.rq_id('g_move'), pg_temp.rq_id('banned')), '22023', 'a banned helper cannot be the new target', 'That helper isn''t available for requests.');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.reassign_gig_request(%L, %L)$$, pg_temp.rq_id('g_move'), pg_temp.rq_id('nocat')), '22023', 'a helper without the category cannot be the new target', 'That helper doesn''t offer this category.');
select pg_temp.rq_assert(pg_temp.rq_state('g_move') = 'active/-/RQhelperB/-' and pg_temp.rq_see('anon') not like '%g_move%' and pg_temp.rq_notes('helper_c', 'g_move', 'gig_request') = 0,
  'a failed reassignment changes nothing: same target, still private, nobody notified (atomic)');

-- To another helper while the old one has a pending counteroffer.
select pg_temp.rq_query('helper_e', pg_catalog.format($$select (public.create_claim(%L, 410, null)).id::text$$, pg_temp.rq_id('g_re')));
select pg_temp.rq_exec('poster', pg_catalog.format($$select public.reassign_gig_request(%L, %L)$$, pg_temp.rq_id('g_re'), pg_temp.rq_id('helper_c')));
select pg_temp.rq_assert(pg_temp.rq_state('g_re') = 'active/-/RQhelperC/-' and pg_temp.rq_claim('g_re', 'helper_e') = 'rejected:410.00',
  'reassigning moves the target and rejects the old helper''s pending counteroffer in one step');
select pg_temp.rq_assert(pg_temp.rq_notes('helper_e', 'g_re', 'request_withdrawn') = 1 and pg_temp.rq_notes('helper_c', 'g_re', 'gig_request') = 1,
  'the old helper is told it was withdrawn and the new helper is notified');
select pg_temp.rq_assert(pg_temp.rq_see('helper_c') like '%g_re%' and pg_temp.rq_addr('helper_c', 'g_re') = '' and pg_temp.rq_addr('helper_e', 'g_re') = '' and pg_temp.rq_see('anon') not like '%g_re%',
  'the new helper sees the request but neither helper can read the address; it is still not public');
select pg_temp.rq_error('helper_e', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_re')), '42501', 'the previous helper''s stale page cannot accept after reassignment');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.reassign_gig_request(%L, %L)$$, pg_temp.rq_id('g_re'), pg_temp.rq_id('helper_e')), '22023', 'a helper who already responded cannot be asked again', 'That helper has already responded to this gig.');
select pg_temp.rq_exec('helper_c', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_re')));
select pg_temp.rq_assert(pg_temp.rq_state('g_re') = 'active/RQhelperC/RQhelperC/500.00' and pg_temp.rq_addr('helper_c', 'g_re') = 'Secret Street 9' and pg_temp.rq_addr('helper_e', 'g_re') = '',
  'only the newly requested helper receives the address after accepting');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.reassign_gig_request(%L, null)$$, pg_temp.rq_id('g_re')), 'P0001', 'an accepted request can no longer be reassigned or published', 'This request is no longer open.');

-- Race: poster reassigns while the old helper's page still shows the request.
select pg_temp.rq_exec('poster', pg_catalog.format($$select public.reassign_gig_request(%L, %L)$$, pg_temp.rq_id('g_move'), pg_temp.rq_id('helper_c')));
select pg_temp.rq_error('helper_b', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_move')), '42501', 'a stale accept from the previous helper is refused after reassignment');
select pg_temp.rq_assert(pg_temp.rq_state('g_move') = 'active/-/RQhelperC/-' and pg_temp.rq_addr('helper_b', 'g_move') = '' and pg_temp.rq_see('helper_b') not like '%g_move%',
  'the previous helper loses access to the request and never sees the address');

-- Make a request public: after a decline, and while unanswered.
select pg_temp.rq_exec('poster', pg_catalog.format($$select public.reassign_gig_request(%L, null)$$, pg_temp.rq_id('g_decl')));
select pg_temp.rq_exec('poster', pg_catalog.format($$select public.reassign_gig_request(%L, null)$$, pg_temp.rq_id('g_stale')));
select pg_temp.rq_assert(pg_temp.rq_see('anon') like '%g_decl%' and pg_temp.rq_see('anon') like '%g_stale%' and pg_temp.rq_see('stranger') like '%g_decl%',
  'after the poster makes a request public it appears in Browse like any public gig');
select pg_temp.rq_assert(pg_temp.rq_addr('anon', 'g_decl') = '' and pg_temp.rq_addr('stranger', 'g_stale') = '', 'a public request still keeps the exact address private');
select pg_temp.rq_assert(pg_temp.rq_notes('helper_b', 'g_stale', 'request_withdrawn') = 1 and pg_temp.rq_notes('helper_c', 'g_decl', 'request_withdrawn') = 0,
  'an unanswered helper is told; one who already declined is not notified again');
select pg_temp.rq_error('helper_b', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_stale')), '42501', 'a stale accept cannot assign a gig that has been made public');
select pg_temp.rq_query('stranger', pg_catalog.format($$select (public.create_claim(%L, 480, 'public offer')).id::text$$, pg_temp.rq_id('g_stale')));
select pg_temp.rq_exec('poster', pg_catalog.format($$select public.select_provider(%L, %L)$$, pg_temp.rq_id('g_stale'), (select id from public.claims where gig_id = pg_temp.rq_id('g_stale') and provider_id = pg_temp.rq_id('stranger'))));
select pg_temp.rq_assert(pg_temp.rq_addr('stranger', 'g_stale') = 'Secret Street 8' and pg_temp.rq_addr('helper_b', 'g_stale') = '' and pg_temp.rq_addr('helper_a', 'g_stale') = '',
  'the public offer flow still works on a former request; the address goes only to the accepted helper');
select pg_temp.rq_assert(pg_temp.rq_claim('g_decl', 'helper_c') = 'withdrawn:500.00' and pg_temp.rq_addr('helper_c', 'g_decl') = '',
  'the helper who declined stays closed out even after the gig is public');
select pg_temp.rq_assert((select count(*) = 0 from public.notifications where message like '%Secret Street%'), 'no notification ever contains an exact address');

-- Defense in depth: even a claim that bypassed create_claim cannot be accepted on a request.
insert into public.claims (gig_id, provider_id, state, offer_amount)
values (pg_temp.rq_id('g_wd'), pg_temp.rq_id('stranger'), 'pending', 100);
select pg_temp.rq_error('poster', pg_catalog.format($$select public.select_provider(%L, %L)$$, pg_temp.rq_id('g_wd'), (select id from public.claims where gig_id = pg_temp.rq_id('g_wd') and provider_id = pg_temp.rq_id('stranger'))),
  'P0001', 'select_provider refuses any claim except the requested helper''s on a request', 'Claim not found or not actionable');
delete from public.claims where gig_id = pg_temp.rq_id('g_wd') and provider_id = pg_temp.rq_id('stranger');

-- ---------------------------------------------------------------------------
-- 9. Drafts: publishing a requested draft, then cancelling it.
-- ---------------------------------------------------------------------------
select pg_temp.rq_exec('poster', pg_catalog.format($$select public.publish_gig(%L)$$, pg_temp.rq_id('g_draft')));
select pg_temp.rq_assert(pg_temp.rq_notes('helper_d', 'g_draft', 'gig_request') = 1 and pg_temp.rq_see('helper_d') like '%g_draft%', 'publishing a requested draft notifies the helper and makes it visible to them only');
select pg_temp.rq_assert(pg_temp.rq_see('stranger') not like '%g_draft%' and pg_temp.rq_see('anon') not like '%g_draft%', 'a published request is still hidden from everyone else');
select pg_temp.rq_exec('poster', pg_catalog.format($$select public.cancel_gig(%L)$$, pg_temp.rq_id('g_draft')));
select pg_temp.rq_assert(pg_temp.rq_notes('helper_d', 'g_draft', 'request_withdrawn') = 1, 'an unanswered helper is told when a request is cancelled');

-- Direct data-integrity checks.
select pg_temp.rq_error('admin', pg_catalog.format($$update public.gigs set requested_helper_id = poster_id where id = %L$$, pg_temp.rq_id('g_public')), '23514', 'the database refuses a request addressed to the poster');
select pg_temp.rq_denied('helper_a', pg_catalog.format($$update public.gigs set requested_helper_id = %L where id = %L$$, pg_temp.rq_id('helper_a'), pg_temp.rq_id('g_public')), 'clients cannot edit requested_helper_id directly');
select pg_temp.rq_denied('poster', pg_catalog.format($$update public.gigs set requested_helper_id = null where id = %L$$, pg_temp.rq_id('g_move')), 'even the poster cannot make a request public with a direct UPDATE (only the RPC can)');
select pg_temp.rq_assert(pg_temp.rq_see('anon') not like '%g_move%', 'the failed direct UPDATE did not publish the request');

-- ---------------------------------------------------------------------------
-- 10. Account deletion: a requested helper never breaks deletion and the
--     request never becomes public. An ordinary clean account is unchanged.
-- ---------------------------------------------------------------------------
select pg_temp.rq_gig('poster', 'g_del', 'helper_f', 'fixed', false, 'Secret Street 11');
select pg_temp.rq_assert(not exists (select 1 from public.notifications where recipient_id = pg_temp.rq_id('helper_f'))
  and not exists (select 1 from public.claims where provider_id = pg_temp.rq_id('helper_f')),
  'setup: helper_f is named only on a draft request (no claim, no notification, no other history)');
select pg_temp.rq_error('admin', pg_catalog.format($$delete from public.profiles where id = %L$$, pg_temp.rq_id('helper_f')), '23503',
  'the foreign key blocks removing a requested helper outright, so a private request can never silently become public');
select pg_temp.rq_assert(pg_temp.rq_query('helper_f', $$select public.delete_own_account()::text$$) = 'true',
  'a helper named on a request counts as marketplace history: the account is anonymized/locked instead of hard-deleted');
select pg_temp.rq_assert((select username ~ '^deleted[0-9a-f]{8}$' and skills = '[]'::jsonb from public.profiles where id = pg_temp.rq_id('helper_f')), 'the requested helper''s profile is anonymized');
select pg_temp.rq_assert(pg_temp.rq_state('g_del') like 'draft/-/deleted%' and pg_temp.rq_see('anon') not like '%g_del%' and pg_temp.rq_see('stranger') not like '%g_del%',
  'the request keeps its (now anonymous) target and stays private');
select pg_temp.rq_error('poster', pg_catalog.format($$select public.publish_gig(%L)$$, pg_temp.rq_id('g_del')), '22023', 'publishing a request to a deleted helper is refused', 'That helper isn''t available for requests.');
select pg_temp.rq_error('helper_a', $$select public.delete_own_account()$$, '22023',
  'a helper whose request was accepted (assigned, active gig) is blocked by main''s deletion eligibility check',
  'You have Gigs that need attention. Resolve any active Gigs, incomplete Gig activity, or open Disputes before deleting your account.');
select pg_temp.rq_error('poster', $$select public.delete_own_account()$$, '22023', 'a poster with an assigned gig is still blocked (main''s eligibility check is intact)',
  'You have Gigs that need attention. Resolve any active Gigs, incomplete Gig activity, or open Disputes before deleting your account.');
-- Poster deletes: their ACTIVE, UNASSIGNED requests are cancelled and the helpers told;
-- their public gigs are untouched (existing behavior).
select pg_temp.rq_gig('poster2', 'g_p2', 'helper_e', 'fixed', true, 'Secret Street 12');
select pg_temp.rq_gig('poster2', 'g_p2b', 'helper_e', 'negotiable', true, 'Secret Street 13');
select pg_temp.rq_gig('poster2', 'g_pubdel', null, 'fixed', true, 'Secret Street 14');
select pg_temp.rq_query('helper_e', pg_catalog.format($$select (public.create_claim(%L, 430, null)).id::text$$, pg_temp.rq_id('g_p2b')));
select pg_temp.rq_query('stranger', pg_catalog.format($$select (public.create_claim(%L, 520, 'public offer')).id::text$$, pg_temp.rq_id('g_pubdel')));
select pg_temp.rq_assert(pg_temp.rq_query('poster2', $$select public.delete_own_account()::text$$) = 'true',
  'a poster whose only gigs are unassigned requests/public gigs is not blocked (pending requests are non-blocking like any unselected gig)');
select pg_temp.rq_assert(pg_temp.rq_state('g_p2') like 'cancelled/-/RQhelperE/-' and pg_temp.rq_state('g_p2b') like 'cancelled/-/RQhelperE/-',
  'the deleted poster''s active unassigned requests are cancelled, not left pending or made public');
select pg_temp.rq_assert(pg_temp.rq_claim('g_p2b', 'helper_e') = 'rejected:430.00', 'a pending counteroffer on a cancelled request is rejected');
select pg_temp.rq_assert(pg_temp.rq_notes('helper_e', 'g_p2', 'request_withdrawn') = 1 and pg_temp.rq_notes('helper_e', 'g_p2b', 'request_withdrawn') = 1
  and (select message = 'The request "Gig g_p2" was cancelled because the poster closed their account.' from public.notifications where gig_id = pg_temp.rq_id('g_p2') and type = 'request_withdrawn'),
  'the requested helper is notified with accurate text, once per request');
select pg_temp.rq_assert(pg_temp.rq_see('anon') not like '%g_p2%' and pg_temp.rq_see('stranger') not like '%g_p2%', 'cancelled requests never become public');
select pg_temp.rq_assert(pg_temp.rq_state('g_pubdel') like 'active/-/-/-' and pg_temp.rq_see('anon') like '%g_pubdel%' and pg_temp.rq_claim('g_pubdel', 'stranger') = 'pending:520.00',
  'public gigs of a deleted poster are unchanged (existing behavior): still active, public, offers untouched');
select pg_temp.rq_error('helper_e', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_p2')), 'P0001',
  'the requested helper cannot accept a request after the poster deleted their account', 'This request is no longer open.');

-- A poster who is anonymized or locked WITHOUT the cleanup having run (e.g. locked by an
-- admin) still cannot have a helper assigned to them: accept_gig_request refuses.
select pg_temp.rq_gig('poster3', 'g_p3', 'helper_e', 'fixed', true, 'Secret Street 15');
select pg_temp.rq_gig('poster3', 'g_p3b', 'helper_e', 'fixed', true, 'Secret Street 16');
select set_config('esg.bypass_profile_validation', 'on', true);
update public.profiles set username = 'deleted' || substr(id::text, 1, 8) where id = pg_temp.rq_id('poster3');
select pg_temp.rq_error('helper_e', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_p3')), 'P0001',
  'accept_gig_request refuses a request whose poster is anonymized', 'This request is no longer available.');
update public.profiles set username = 'RQposter3' where id = pg_temp.rq_id('poster3');
select set_config('esg.bypass_profile_validation', '', true);
update auth.users set banned_until = now() + interval '100 years' where id = pg_temp.rq_id('poster3');
select pg_temp.rq_error('helper_e', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_p3b')), 'P0001',
  'accept_gig_request refuses a request whose poster is banned', 'This request is no longer available.');
select pg_temp.rq_assert(pg_temp.rq_state('g_p3') = 'active/-/RQhelperE/-' and pg_temp.rq_state('g_p3b') = 'active/-/RQhelperE/-' and pg_temp.rq_addr('helper_e', 'g_p3') = '',
  'the refused accepts changed nothing and released no address');

-- Requested helper deletes: active unassigned requests addressed to them are closed out
-- and the posters told; their public offers are untouched.
select pg_temp.rq_gig('poster', 'g_hd', 'helper_g', 'fixed', true, 'Secret Street 17');
select pg_temp.rq_gig('poster', 'g_hd2', 'helper_g', 'negotiable', true, 'Secret Street 18');
select pg_temp.rq_gig('poster', 'g_hd3', 'helper_g', 'fixed', true, 'Secret Street 19');
select pg_temp.rq_gig('poster', 'g_hdpub', null, 'fixed', true, 'Secret Street 20');
select pg_temp.rq_query('helper_g', pg_catalog.format($$select (public.create_claim(%L, 450, null)).id::text$$, pg_temp.rq_id('g_hd2')));
select pg_temp.rq_exec('helper_g', pg_catalog.format($$select public.decline_gig_request(%L)$$, pg_temp.rq_id('g_hd3')));
select pg_temp.rq_query('helper_g', pg_catalog.format($$select (public.create_claim(%L, 480, 'public offer')).id::text$$, pg_temp.rq_id('g_hdpub')));
-- main 0018: free text on the profile is scrubbed by deletion; this must survive the rebuilt function.
update public.profiles set skills = '["Cleaning","Other"]'::jsonb, skills_other_text = 'Personal note with a home address' where id = pg_temp.rq_id('helper_g');
select pg_temp.rq_assert(pg_temp.rq_query('helper_g', $$select public.delete_own_account()::text$$) = 'true', 'a requested helper with only pending requests can delete their account');
select pg_temp.rq_assert((select skills_other_text is null and services_other_text is null and skills = '[]'::jsonb and username ~ '^deleted[0-9a-f]{8}$' from public.profiles where id = pg_temp.rq_id('helper_g')),
  'deletion still scrubs the profile free text and skills (main 0018 behavior preserved in the rebuilt function)');
select pg_temp.rq_assert(pg_temp.rq_state('g_hd') like 'active/-/deleted%/-' and pg_temp.rq_state('g_hd2') like 'active/-/deleted%/-',
  'the requests stay active and private (not cancelled, not made public) so the poster decides what to do');
select pg_temp.rq_assert(pg_temp.rq_claim('g_hd', 'helper_g') = 'withdrawn:500.00' and pg_temp.rq_claim('g_hd2', 'helper_g') = 'withdrawn:450.00',
  'the request is closed out with the same withdrawn claim as a decline (a pending counteroffer is withdrawn)');
select pg_temp.rq_assert(pg_temp.rq_notes('poster', 'g_hd', 'request_declined') = 1 and pg_temp.rq_notes('poster', 'g_hd2', 'request_declined') = 1
  and (select message = 'The helper closed their account, so your request "Gig g_hd" was closed. You can post it publicly or cancel it.'
       from public.notifications where gig_id = pg_temp.rq_id('g_hd') and type = 'request_declined'),
  'the poster is notified with accurate text');
select pg_temp.rq_assert(pg_temp.rq_notes('poster', 'g_hd3', 'request_declined') = 1, 'a request the helper had already declined is not notified a second time');
select pg_temp.rq_assert(pg_temp.rq_see('anon') not like '%g_hd,%' and pg_temp.rq_see('anon') not like '%g_hd2%' and pg_temp.rq_see('anon') not like '%g_hd3%', 'closed requests are not public');
select pg_temp.rq_assert(pg_temp.rq_claim('g_hdpub', 'helper_g') = 'pending:480.00' and pg_temp.rq_see('anon') like '%g_hdpub%', 'the deleted helper''s offer on a public gig is untouched (existing behavior)');
select pg_temp.rq_exec('poster', pg_catalog.format($$select public.reassign_gig_request(%L, null)$$, pg_temp.rq_id('g_hd')));
select pg_temp.rq_exec('poster', pg_catalog.format($$select public.cancel_gig(%L)$$, pg_temp.rq_id('g_hd2')));
select pg_temp.rq_assert(pg_temp.rq_see('anon') like '%g_hd%' and pg_temp.rq_state('g_hd2') like 'cancelled/%', 'the poster can then repost publicly or cancel');

-- The new constraint: a request can only ever be assigned to its requested helper.
select pg_temp.rq_gig('poster', 'g_sel', 'helper_a', 'fixed', true, 'Secret Street 21');
select pg_temp.rq_error('admin', pg_catalog.format($$update public.gigs set selected_provider_id = %L where id = %L$$, pg_temp.rq_id('stranger'), pg_temp.rq_id('g_sel')), '23514',
  'the database refuses to assign a request to anyone but the requested helper (gigs_selected_matches_requested)');
select pg_temp.rq_assert(pg_temp.rq_state('g_sel') = 'active/-/RQhelperA/-', 'the refused update changed nothing');
select pg_temp.rq_exec('helper_a', pg_catalog.format($$select public.accept_gig_request(%L)$$, pg_temp.rq_id('g_sel')));
select pg_temp.rq_assert(pg_temp.rq_state('g_sel') = 'active/RQhelperA/RQhelperA/500.00', 'assigning the requested helper satisfies the constraint');
select pg_temp.rq_assert(pg_temp.rq_query('ghost', $$select public.delete_own_account()::text$$) = 'false', 'an ordinary account with no marketplace history is still reported as safe to hard-delete');

-- ---------------------------------------------------------------------------
-- 11. Grants, signatures and regression of earlier hardening.
-- ---------------------------------------------------------------------------
select pg_temp.rq_assert(to_regprocedure('public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[],text)') is null
  and to_regprocedure('public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[],text,uuid)') is not null,
  'the 14-argument create_gig is gone, not left callable');
select pg_temp.rq_assert(has_function_privilege('authenticated', 'public.accept_gig_request(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.decline_gig_request(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.reassign_gig_request(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.accept_gig_request(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.decline_gig_request(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.reassign_gig_request(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[],text,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'esg_private.assert_requestable_helper(uuid,uuid,text)', 'EXECUTE'),
  'request RPCs are executable by authenticated users only; the eligibility check is not callable by clients');
select pg_temp.rq_assert((select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'esg_private') and p.proname in ('accept_gig_request','decline_gig_request','reassign_gig_request','assert_requestable_helper','create_gig','publish_gig','create_claim','withdraw_claim','select_provider','cancel_gig','delete_own_account')
  and p.prosecdef and p.proconfig @> array['search_path=""']) = 11, 'every request-related function is SECURITY DEFINER with an empty search_path');
select pg_temp.rq_assert(not has_table_privilege('authenticated', 'public.gigs', 'UPDATE') and not has_table_privilege('authenticated', 'public.gigs', 'INSERT')
  and not has_table_privilege('authenticated', 'public.claims', 'INSERT') and not has_table_privilege('authenticated', 'public.claims', 'UPDATE'), 'direct-write hardening on gigs and claims is intact');

reset role;
rollback;
