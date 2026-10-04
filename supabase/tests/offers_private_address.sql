-- Offers -> acceptance -> agreed price -> private address -> messaging.
-- Run only against an isolated Supabase test database after 0001 through 0010.
-- All fixtures roll back. Run as postgres (or an equivalent trusted role).
begin;

create temporary table of_fixture (name text primary key, id uuid);
insert into of_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['poster','helper_a','helper_b','helper_c','helper_d','stranger',
  'gig','gig2','gig_draft','gig_done','claim_a','claim_b','claim_c','claim_d','claim_g2']) as n(name);
grant select, update on of_fixture to anon, authenticated;

create function pg_temp.of_id(p_name text) returns uuid
language sql stable as $$ select id from pg_temp.of_fixture where name = p_name; $$;
create function pg_temp.of_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;

-- Impersonate a fixture user ('admin' = the trusted migration role, 'anon' = no identity).
create function pg_temp.of_switch(p_user text) returns void language plpgsql as $$
declare v_id uuid;
begin
  if p_user = 'admin' then return; end if;
  if p_user = 'anon' then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    set local role anon;
  else
    select id into v_id from pg_temp.of_fixture where name = p_user;
    perform set_config('request.jwt.claim.sub', v_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end;
$$;
create function pg_temp.of_query(p_user text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.of_switch(p_user);
  begin execute p_sql into v; exception when others then reset role; raise; end;
  reset role;
  return v;
end;
$$;
create function pg_temp.of_exec(p_user text, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.of_switch(p_user);
  begin execute p_sql; exception when others then reset role; raise; end;
  reset role;
end;
$$;
create function pg_temp.of_error(p_user text, p_sql text, p_code text, p_label text, p_msg text default null) returns void
language plpgsql as $$
begin
  begin
    perform pg_temp.of_exec(p_user, p_sql);
  exception when others then
    if sqlstate <> p_code or (p_msg is not null and sqlerrm <> p_msg) then
      raise exception 'FAIL: % (got % %)', p_label, sqlstate, sqlerrm;
    end if;
    raise notice 'PASS: %', p_label; return;
  end;
  raise exception 'FAIL (expected error %): %', p_code, p_label;
end;
$$;
create function pg_temp.of_denied(p_user text, p_sql text, p_label text) returns void
language plpgsql as $$ begin perform pg_temp.of_error(p_user, p_sql, '42501', p_label); end; $$;

do $$
declare v_schema text;
begin
  select nspname into v_schema from pg_catalog.pg_namespace where oid = pg_catalog.pg_my_temp_schema();
  execute pg_catalog.format('grant usage on schema %I to anon, authenticated', v_schema);
end;
$$;
grant execute on all functions in schema pg_temp to anon, authenticated;

insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
select id, 'authenticated', 'authenticated', name || '-' || id::text || '@example.invalid',
  jsonb_build_object('username', case name when 'poster' then 'OfferPoster' when 'helper_a' then 'OfferHelperA'
    when 'helper_b' then 'OfferHelperB' when 'helper_c' then 'OfferHelperC' when 'helper_d' then 'OfferHelperD' else 'OfferStranger' end),
  now(), now()
from of_fixture where name in ('poster','helper_a','helper_b','helper_c','helper_d','stranger');

select pg_temp.of_query('poster', $$select public.save_onboarding('OfferPoster', null, '1 Private Street', 55.7, 13.1, '[]'::jsonb, '[]'::jsonb)::text$$);

-- ---------------------------------------------------------------------------
-- 1. Gigs: a published gig WITH a private address, a second open gig, a draft
--    (blank address), and a completed gig.
-- ---------------------------------------------------------------------------
update of_fixture set id = pg_temp.of_query('poster', $$select (public.create_gig(gen_random_uuid(),'Cleaning','Yard Cleaning','Rake the leaves',500,'fixed',now()+interval '3 days','Kävlinge',55.789,13.114,null,true,'{}'::uuid[],'  Examplegatan 12, 244 XX Kävlinge  ')).id::text$$)::uuid where name = 'gig';
update of_fixture set id = pg_temp.of_query('poster', $$select (public.create_gig(gen_random_uuid(),'Cleaning','Second gig','Another job',300,'fixed',now()+interval '3 days','Kävlinge',55.789,13.114)).id::text$$)::uuid where name = 'gig2';
update of_fixture set id = pg_temp.of_query('poster', $$select (public.create_gig(gen_random_uuid(),'Cleaning','Draft gig','Not published',300,'fixed',null,'Kävlinge',null,null,null,false,'{}'::uuid[],'   ')).id::text$$)::uuid where name = 'gig_draft';
update of_fixture set id = pg_temp.of_query('poster', $$select (public.create_gig(gen_random_uuid(),'Cleaning','Done gig','Finished',300,'fixed',now()+interval '3 days','Kävlinge',null,null)).id::text$$)::uuid where name = 'gig_done';
update public.gigs set status = 'completed' where id = pg_temp.of_id('gig_done');

select pg_temp.of_assert((select address_text from public.gig_private_locations where gig_id = pg_temp.of_id('gig')) = 'Examplegatan 12, 244 XX Kävlinge', 'create_gig stores the trimmed private address');
select pg_temp.of_assert((select count(*) from public.gig_private_locations where gig_id = pg_temp.of_id('gig_draft')) = 0, 'a blank private address stores nothing');
select pg_temp.of_error('poster', $$select public.create_gig(gen_random_uuid(),'Cleaning','Long address','x',300,'fixed',now()+interval '3 days','Kävlinge',null,null,null,true,'{}'::uuid[],repeat('x',301))$$, '22023', 'an over-long private address is rejected server-side');
select pg_temp.of_assert((select agreed_amount is null and amount = 500 from public.gigs where id = pg_temp.of_id('gig')), 'a new gig has a budget and no agreed price');

-- ---------------------------------------------------------------------------
-- 2. Offers: defaults to the budget; higher; lower; message; validation.
-- ---------------------------------------------------------------------------
update of_fixture set id = pg_temp.of_query('helper_a', $$select (public.create_claim(pg_temp.of_id('gig'))).id::text$$)::uuid where name = 'claim_a';
update of_fixture set id = pg_temp.of_query('helper_b', $$select (public.create_claim(pg_temp.of_id('gig'), 650, '  I can do it for 650 SEK because I bring the equipment.  ')).id::text$$)::uuid where name = 'claim_b';
update of_fixture set id = pg_temp.of_query('helper_c', $$select (public.create_claim(pg_temp.of_id('gig'), 400.50)).id::text$$)::uuid where name = 'claim_c';
update of_fixture set id = pg_temp.of_query('helper_d', $$select (public.create_claim(pg_temp.of_id('gig'), 520, '   ')).id::text$$)::uuid where name = 'claim_d';
update of_fixture set id = pg_temp.of_query('helper_a', $$select (public.create_claim(pg_temp.of_id('gig2'), 310)).id::text$$)::uuid where name = 'claim_g2';

select pg_temp.of_assert((select offer_amount = 500 and message is null and state = 'pending' from public.claims where id = pg_temp.of_id('claim_a')), 'an offer without an amount defaults to the posted budget');
select pg_temp.of_assert((select offer_amount = 650 and message = 'I can do it for 650 SEK because I bring the equipment.' from public.claims where id = pg_temp.of_id('claim_b')), 'a higher offer is accepted, with its message trimmed');
select pg_temp.of_assert((select offer_amount = 400.50 from public.claims where id = pg_temp.of_id('claim_c')), 'a lower offer is allowed');
select pg_temp.of_assert((select message is null from public.claims where id = pg_temp.of_id('claim_d')), 'a blank message is stored as no message');
select pg_temp.of_assert((select amount = 500 from public.gigs where id = pg_temp.of_id('gig')), 'offers never change the posted budget');

select pg_temp.of_error('stranger', $$select public.create_claim(pg_temp.of_id('gig'), 0)$$, '22023', 'a zero offer is rejected');
select pg_temp.of_error('stranger', $$select public.create_claim(pg_temp.of_id('gig'), -5)$$, '22023', 'a negative offer is rejected');
select pg_temp.of_error('stranger', $$select public.create_claim(pg_temp.of_id('gig'), 500.001)$$, '22023', 'more than two decimals is rejected');
select pg_temp.of_error('stranger', $$select public.create_claim(pg_temp.of_id('gig'), 'NaN'::numeric)$$, '22023', 'NaN is rejected');
select pg_temp.of_error('stranger', $$select public.create_claim(pg_temp.of_id('gig'), 'Infinity'::numeric)$$, '22023', 'Infinity is rejected');
select pg_temp.of_error('stranger', $$select public.create_claim(pg_temp.of_id('gig'), 10000000000)$$, '22023', 'an absurdly large offer is rejected');
select pg_temp.of_error('stranger', $$select public.create_claim(pg_temp.of_id('gig'), 500, repeat('x', 501))$$, '22023', 'an over-long message is rejected');
select pg_temp.of_assert((select count(*) from public.claims where provider_id = pg_temp.of_id('stranger')) = 0, 'no rejected offer left a row behind');
select pg_temp.of_error('poster', $$select public.create_claim(pg_temp.of_id('gig'))$$, 'P0001', 'the poster cannot offer on their own gig', 'You cannot claim your own gig');
select pg_temp.of_error('stranger', $$select public.create_claim(pg_temp.of_id('gig_draft'))$$, 'P0001', 'no offers on a draft gig', 'Gig is not open for claims');
select pg_temp.of_error('stranger', $$select public.create_claim(pg_temp.of_id('gig_done'))$$, 'P0001', 'no offers on a completed gig', 'Gig is not open for claims');
select pg_temp.of_error('anon', $$select public.create_claim(pg_temp.of_id('gig'))$$, '42501', 'anonymous users cannot make offers');
select pg_temp.of_assert(pg_temp.of_query('helper_b', $$select (public.create_claim(pg_temp.of_id('gig'), 999)).offer_amount::text$$) = '650.00', 'a retry returns the existing offer unchanged (no editing through the retry path)');

-- ---------------------------------------------------------------------------
-- 3. Who can see proposals; nobody can write them directly.
-- ---------------------------------------------------------------------------
select pg_temp.of_assert(pg_temp.of_query('poster', $$select count(*) from public.claims where gig_id = pg_temp.of_id('gig')$$)::int = 4, 'the poster sees all proposals on their gig');
select pg_temp.of_assert(pg_temp.of_query('poster', $$select offer_amount::text || '|' || message from public.claims where id = pg_temp.of_id('claim_b')$$) = '650.00|I can do it for 650 SEK because I bring the equipment.', 'the poster sees each offer amount and message');
select pg_temp.of_assert(pg_temp.of_query('helper_a', $$select count(*) from public.claims where gig_id = pg_temp.of_id('gig')$$)::int = 1, 'a helper sees only their own proposal, never competitors''');
select pg_temp.of_assert(pg_temp.of_query('stranger', $$select count(*) from public.claims$$)::int = 0, 'an unrelated user sees no proposals');
select pg_temp.of_assert(pg_temp.of_query('anon', $$select count(*) from public.claims$$)::int = 0, 'anonymous users see no proposals');
select pg_temp.of_denied('helper_a', $$update public.claims set offer_amount = 1 where id = pg_temp.of_id('claim_a')$$, 'a helper cannot edit an offer directly');
select pg_temp.of_denied('helper_a', $$update public.claims set state = 'selected' where id = pg_temp.of_id('claim_a')$$, 'a helper cannot select themselves directly');
select pg_temp.of_denied('helper_a', $$insert into public.claims (gig_id, provider_id, state, offer_amount) values (pg_temp.of_id('gig2'), pg_temp.of_id('helper_a'), 'pending', 1)$$, 'a helper cannot insert a claim directly');
select pg_temp.of_denied('helper_a', $$delete from public.claims where id = pg_temp.of_id('claim_a')$$, 'a helper cannot delete a claim directly');
select pg_temp.of_denied('poster', $$update public.claims set state = 'selected' where id = pg_temp.of_id('claim_b')$$, 'even the poster cannot select by direct write; only select_provider can');

-- ---------------------------------------------------------------------------
-- 4. Withdrawing an offer.
-- ---------------------------------------------------------------------------
select pg_temp.of_error('stranger', $$select public.withdraw_claim(pg_temp.of_id('gig'))$$, 'P0001', 'a user with no offer cannot withdraw', 'Offer not found');
select pg_temp.of_exec('helper_d', $$select public.withdraw_claim(pg_temp.of_id('gig'))$$);
select pg_temp.of_assert((select state = 'withdrawn' from public.claims where id = pg_temp.of_id('claim_d')), 'a helper can withdraw their own pending offer');
select pg_temp.of_assert((select state = 'pending' from public.claims where id = pg_temp.of_id('claim_a')), 'withdrawing only affects the caller''s own offer');
select pg_temp.of_error('helper_d', $$select public.withdraw_claim(pg_temp.of_id('gig'))$$, 'P0001', 'a withdrawn offer cannot be withdrawn again', 'Only a pending offer can be withdrawn');
select pg_temp.of_assert(pg_temp.of_query('helper_d', $$select (public.create_claim(pg_temp.of_id('gig'), 100)).state::text$$) = 'withdrawn', 'a withdrawn offer is never reopened by a retry');
select pg_temp.of_error('poster', $$select public.select_provider(pg_temp.of_id('gig'), pg_temp.of_id('claim_d'))$$, 'P0001', 'a withdrawn offer cannot be accepted', 'Claim not found or not actionable');

-- ---------------------------------------------------------------------------
-- 5. BEFORE acceptance: the private address is invisible to everyone but the
--    poster; there is no chat; the public view has only the general area.
-- ---------------------------------------------------------------------------
select pg_temp.of_assert(pg_temp.of_query('poster', $$select count(*) from public.gig_private_locations where gig_id = pg_temp.of_id('gig')$$)::int = 1, 'the poster can read their own private address');
select pg_temp.of_assert(pg_temp.of_query('helper_a', $$select count(*) from public.gig_private_locations$$)::int = 0, 'a pending helper cannot read the private address');
select pg_temp.of_assert(pg_temp.of_query('helper_b', $$select count(*) from public.gig_private_locations$$)::int = 0, 'another pending helper cannot read the private address');
select pg_temp.of_assert(pg_temp.of_query('helper_d', $$select count(*) from public.gig_private_locations$$)::int = 0, 'a withdrawn helper cannot read the private address');
select pg_temp.of_assert(pg_temp.of_query('stranger', $$select count(*) from public.gig_private_locations$$)::int = 0, 'an unrelated authenticated user cannot read the private address');
select pg_temp.of_denied('anon', $$select count(*) from public.gig_private_locations$$, 'an anonymous user cannot read the private address');
select pg_temp.of_assert(pg_temp.of_query('helper_a', $$select coalesce(bool_or(to_jsonb(g)::text like '%Examplegatan%'), false)::text from public.gigs g$$) = 'false', 'the gig row itself never carries the address');
select pg_temp.of_assert(pg_temp.of_query('stranger', $$select location_text from public.gigs where id = pg_temp.of_id('gig')$$) = 'Kävlinge', 'everyone else sees only the general area');
select pg_temp.of_denied('helper_a', $$insert into public.gig_private_locations (gig_id, address_text) values (pg_temp.of_id('gig2'), 'forged')$$, 'a client cannot write a private address directly');
select pg_temp.of_denied('poster', $$update public.gig_private_locations set address_text = 'forged' where gig_id = pg_temp.of_id('gig')$$, 'even the poster cannot overwrite it by direct write');
select pg_temp.of_denied('poster', $$delete from public.gig_private_locations where gig_id = pg_temp.of_id('gig')$$, 'nor delete it directly');
select pg_temp.of_denied('helper_a', $$insert into public.chat_messages (gig_id, sender_id, body) values (pg_temp.of_id('gig'), pg_temp.of_id('helper_a'), 'hello')$$, 'a helper cannot chat before being accepted');

-- ---------------------------------------------------------------------------
-- 6. Acceptance.
-- ---------------------------------------------------------------------------
select pg_temp.of_assert(pg_catalog.pg_get_function_identity_arguments('public.select_provider(uuid,uuid)'::regprocedure) = 'p_gig_id uuid, p_claim_id uuid', 'acceptance takes no client-supplied price');
select pg_temp.of_error('stranger', $$select public.select_provider(pg_temp.of_id('gig'), pg_temp.of_id('claim_b'))$$, '42501', 'a user cannot accept an offer on someone else''s gig');
select pg_temp.of_error('helper_b', $$select public.select_provider(pg_temp.of_id('gig'), pg_temp.of_id('claim_b'))$$, '42501', 'a helper cannot accept their own offer');
select pg_temp.of_error('poster', $$select public.select_provider(pg_temp.of_id('gig2'), pg_temp.of_id('claim_b'))$$, 'P0001', 'an offer cannot be accepted for the wrong gig', 'Claim not found or not actionable');
select pg_temp.of_assert((select bool_and(selected_provider_id is null and agreed_amount is null) from public.gigs where id in (pg_temp.of_id('gig'), pg_temp.of_id('gig2'))), 'failed acceptance attempts changed nothing');

select pg_temp.of_exec('poster', $$select public.select_provider(pg_temp.of_id('gig'), pg_temp.of_id('claim_b'))$$);
select pg_temp.of_assert((select selected_provider_id = pg_temp.of_id('helper_b') and agreed_amount = 650 and amount = 500 and status = 'active' from public.gigs where id = pg_temp.of_id('gig')), 'accepting records the helper and the OFFER as the agreed price, keeping the original budget');
select pg_temp.of_assert((select state = 'selected' from public.claims where id = pg_temp.of_id('claim_b')), 'the accepted offer becomes selected');
select pg_temp.of_assert((select count(*) = 2 and bool_and(state = 'rejected') from public.claims where id in (pg_temp.of_id('claim_a'), pg_temp.of_id('claim_c'))), 'competing pending offers are closed as rejected');
select pg_temp.of_assert((select state = 'withdrawn' from public.claims where id = pg_temp.of_id('claim_d')), 'a withdrawn offer stays withdrawn');
select pg_temp.of_assert((select count(*) from public.claims where gig_id = pg_temp.of_id('gig') and state = 'selected') = 1 and (select count(*) from public.claims where gig_id = pg_temp.of_id('gig') and state = 'pending') = 0, 'exactly one accepted offer and none left pending');
select pg_temp.of_error('poster', $$select public.select_provider(pg_temp.of_id('gig'), pg_temp.of_id('claim_a'))$$, 'P0001', 'a second acceptance is rejected', 'Provider already selected');
select pg_temp.of_error('poster', $$select public.select_provider(pg_temp.of_id('gig'), pg_temp.of_id('claim_b'))$$, 'P0001', 're-accepting the same offer is rejected too', 'Provider already selected');
select pg_temp.of_error('admin', $$update public.claims set state = 'selected' where id = pg_temp.of_id('claim_a')$$, '23505', 'the database itself refuses a second selected claim (concurrency backstop)');
select pg_temp.of_assert((select agreed_amount = 650 and selected_provider_id = pg_temp.of_id('helper_b') from public.gigs where id = pg_temp.of_id('gig')), 'the refused attempts left the agreement intact');
select pg_temp.of_error('helper_a', $$select public.withdraw_claim(pg_temp.of_id('gig'))$$, 'P0001', 'a rejected helper cannot withdraw', 'Only a pending offer can be withdrawn');
select pg_temp.of_error('stranger', $$select public.create_claim(pg_temp.of_id('gig'))$$, 'P0001', 'no new offers once a helper is accepted', 'Gig is not open for claims');
select pg_temp.of_denied('poster', $$update public.gigs set agreed_amount = 1 where id = pg_temp.of_id('gig')$$, 'the poster cannot rewrite the agreed price directly');
select pg_temp.of_denied('helper_b', $$update public.gigs set agreed_amount = 99999 where id = pg_temp.of_id('gig')$$, 'the helper cannot rewrite the agreed price directly');

-- ---------------------------------------------------------------------------
-- 7. AFTER acceptance: address release, public visibility, messaging.
-- ---------------------------------------------------------------------------
select pg_temp.of_assert(pg_temp.of_query('helper_b', $$select address_text from public.gig_private_locations where gig_id = pg_temp.of_id('gig')$$) = 'Examplegatan 12, 244 XX Kävlinge', 'the accepted helper can read the private address');
select pg_temp.of_assert(pg_temp.of_query('poster', $$select count(*) from public.gig_private_locations where gig_id = pg_temp.of_id('gig')$$)::int = 1, 'the poster still reads the private address');
select pg_temp.of_assert(pg_temp.of_query('helper_a', $$select count(*) from public.gig_private_locations$$)::int = 0, 'a rejected helper cannot read it');
select pg_temp.of_assert(pg_temp.of_query('helper_c', $$select count(*) from public.gig_private_locations$$)::int = 0, 'a non-selected helper cannot read it');
select pg_temp.of_assert(pg_temp.of_query('helper_d', $$select count(*) from public.gig_private_locations$$)::int = 0, 'a withdrawn helper cannot read it');
select pg_temp.of_assert(pg_temp.of_query('stranger', $$select count(*) from public.gig_private_locations$$)::int = 0, 'an unrelated user cannot read it');
select pg_temp.of_denied('anon', $$select count(*) from public.gig_private_locations$$, 'an anonymous user cannot read it');
select pg_temp.of_assert(pg_temp.of_query('helper_b', $$select coalesce(bool_or(to_jsonb(g)::text like '%Examplegatan%'), false)::text from public.gigs g$$) = 'false', 'even the accepted helper''s gig rows never embed the address');
select pg_temp.of_assert(not exists (select 1 from public.notifications where message ilike '%Examplegatan%' or type ilike '%Examplegatan%'), 'the address never appears in any notification');
select pg_temp.of_assert(pg_temp.of_query('stranger', $$select count(*) from public.gigs where id = pg_temp.of_id('gig')$$)::int = 0, 'an assigned gig is no longer visible to unrelated users');
select pg_temp.of_assert(pg_temp.of_query('anon', $$select count(*) from public.gigs where id = pg_temp.of_id('gig')$$)::int = 0, 'an assigned gig is no longer visible anonymously');
select pg_temp.of_assert(pg_temp.of_query('helper_b', $$select count(*) from public.gigs where id = pg_temp.of_id('gig')$$)::int = 1 and pg_temp.of_query('poster', $$select count(*) from public.gigs where id = pg_temp.of_id('gig')$$)::int = 1, 'the poster and accepted helper still see it');
select pg_temp.of_assert(pg_temp.of_query('helper_a', $$select count(*) from public.gigs where id = pg_temp.of_id('gig')$$)::int = 1, 'a helper who made an offer can still open the gig (to see it was not selected)');
select pg_temp.of_assert(pg_temp.of_query('stranger', $$select count(*) from public.gigs where id = pg_temp.of_id('gig2')$$)::int = 1 and pg_temp.of_query('anon', $$select count(*) from public.gigs where id = pg_temp.of_id('gig2')$$)::int = 1, 'an open, unassigned gig stays publicly visible');

-- Messaging reuses the gig-scoped chat.
select pg_temp.of_exec('helper_b', $$insert into public.chat_messages (gig_id, sender_id, body) values (pg_temp.of_id('gig'), pg_temp.of_id('helper_b'), 'Hi, see you Saturday!')$$);
select pg_temp.of_exec('poster', $$insert into public.chat_messages (gig_id, sender_id, body) values (pg_temp.of_id('gig'), pg_temp.of_id('poster'), 'Great, thanks.')$$);
select pg_temp.of_assert(pg_temp.of_query('poster', $$select count(*) from public.chat_messages where gig_id = pg_temp.of_id('gig')$$)::int = 2, 'the poster reads the gig conversation');
select pg_temp.of_assert(pg_temp.of_query('helper_b', $$select count(*) from public.chat_messages where gig_id = pg_temp.of_id('gig')$$)::int = 2, 'the accepted helper reads the gig conversation');
select pg_temp.of_assert(pg_temp.of_query('helper_a', $$select count(*) from public.chat_messages where gig_id = pg_temp.of_id('gig')$$)::int = 0, 'a rejected helper cannot read the conversation');
select pg_temp.of_assert(pg_temp.of_query('stranger', $$select count(*) from public.chat_messages$$)::int = 0, 'an unrelated user cannot read the conversation');
select pg_temp.of_assert(pg_temp.of_query('anon', $$select count(*) from public.chat_messages$$)::int = 0, 'an anonymous user cannot read the conversation');
select pg_temp.of_denied('helper_a', $$insert into public.chat_messages (gig_id, sender_id, body) values (pg_temp.of_id('gig'), pg_temp.of_id('helper_a'), 'let me in')$$, 'a rejected helper cannot post into the conversation');
select pg_temp.of_denied('stranger', $$insert into public.chat_messages (gig_id, sender_id, body) values (pg_temp.of_id('gig'), pg_temp.of_id('stranger'), 'hi')$$, 'an unrelated user cannot post into the conversation');
select pg_temp.of_denied('helper_b', $$insert into public.chat_messages (gig_id, sender_id, body) values (pg_temp.of_id('gig'), pg_temp.of_id('poster'), 'impersonation')$$, 'a participant cannot post as the other participant');
select pg_temp.of_denied('stranger', $$insert into public.chat_messages (gig_id, sender_id, body) values (pg_temp.of_id('gig2'), pg_temp.of_id('stranger'), 'dm')$$, 'there is no general DM path: chat exists only inside an assigned gig');

-- ---------------------------------------------------------------------------
-- 8. Notifications.
-- ---------------------------------------------------------------------------
select pg_temp.of_assert((select count(*) from public.notifications where recipient_id = pg_temp.of_id('poster') and type = 'claim_received' and gig_id = pg_temp.of_id('gig')) = 4, 'the poster is notified of each offer (one per helper)');
select pg_temp.of_assert(exists (select 1 from public.notifications where recipient_id = pg_temp.of_id('poster') and message = '@OfferHelperB sent an offer for "Yard Cleaning".'), 'the offer notification names the helper and the gig');
select pg_temp.of_assert((select count(*) from public.notifications where recipient_id = pg_temp.of_id('helper_b') and type = 'selected' and message = 'Your offer for "Yard Cleaning" was accepted.') = 1, 'the accepted helper is notified');
select pg_temp.of_assert((select count(*) from public.notifications where type = 'selected' and recipient_id in (pg_temp.of_id('helper_a'), pg_temp.of_id('helper_c'), pg_temp.of_id('helper_d'))) = 0, 'non-selected helpers get no extra notification');
select pg_temp.of_assert(pg_temp.of_query('poster', $$select count(*) from public.notifications$$)::int >= 4 and pg_temp.of_query('stranger', $$select count(*) from public.notifications$$)::int = 0, 'notifications stay private to their recipient');

-- ---------------------------------------------------------------------------
-- 9. Address access follows the lifecycle: kept while the work is live, gone
--    for the helper once the gig is resolved; the poster keeps their own.
-- ---------------------------------------------------------------------------
update public.gigs set status = 'in_progress' where id = pg_temp.of_id('gig');
select pg_temp.of_assert(pg_temp.of_query('helper_b', $$select count(*) from public.gig_private_locations$$)::int = 1, 'the helper keeps the address while the gig is in progress');
update public.gigs set status = 'awaiting_payment' where id = pg_temp.of_id('gig');
select pg_temp.of_assert(pg_temp.of_query('helper_b', $$select count(*) from public.gig_private_locations$$)::int = 1, 'and while awaiting payment');
update public.gigs set status = 'completed' where id = pg_temp.of_id('gig');
select pg_temp.of_assert(pg_temp.of_query('helper_b', $$select count(*) from public.gig_private_locations$$)::int = 0, 'the helper loses the address once the gig is completed');
select pg_temp.of_assert(pg_temp.of_query('poster', $$select count(*) from public.gig_private_locations$$)::int = 1, 'the poster keeps their own address');
select pg_temp.of_assert(pg_temp.of_query('helper_b', $$select count(*) from public.chat_messages where gig_id = pg_temp.of_id('gig')$$)::int = 2, 'the finished conversation stays readable to its participants');

-- ---------------------------------------------------------------------------
-- 10. Grants / regression of the direct-write hardening.
-- ---------------------------------------------------------------------------
select pg_temp.of_assert(not has_table_privilege('authenticated', 'public.claims', 'INSERT')
  and not has_table_privilege('authenticated', 'public.claims', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.claims', 'DELETE'), 'clients have no direct write grants on claims');
select pg_temp.of_assert(not has_table_privilege('authenticated', 'public.gigs', 'INSERT') and not has_table_privilege('authenticated', 'public.gigs', 'UPDATE'), 'gigs direct-write hardening is intact');
select pg_temp.of_assert(has_table_privilege('authenticated', 'public.gig_private_locations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.gig_private_locations', 'INSERT')
  and not has_table_privilege('authenticated', 'public.gig_private_locations', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.gig_private_locations', 'DELETE')
  and not has_table_privilege('anon', 'public.gig_private_locations', 'SELECT'), 'private addresses are select-only for authenticated and invisible to anon');
select pg_temp.of_assert(to_regprocedure('public.create_claim(uuid)') is null
  and to_regprocedure('public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[])') is null, 'the old overloads are gone, not left callable');
select pg_temp.of_assert(has_function_privilege('authenticated', 'public.create_claim(uuid,numeric,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.withdraw_claim(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_claim(uuid,numeric,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.withdraw_claim(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.select_provider(uuid,uuid)', 'EXECUTE'), 'offer RPCs are executable by authenticated users only');
select pg_temp.of_assert((select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_claim','withdraw_claim','select_provider','create_gig') and p.prosecdef and p.proconfig @> array['search_path=""']) = 4, 'the four functions are SECURITY DEFINER with an empty search_path');

reset role;
rollback;
