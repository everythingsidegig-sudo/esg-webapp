-- Phase 2C: direct-write hardening regression suite.
-- Run only against an isolated Supabase test database after 0001 through 0005.
-- All fixtures and temporary assertions roll back; no extensions required.
-- Run as postgres (or an equivalent trusted migration role), with errors fatal.
begin;

create temporary table dw_fixture (name text primary key, id uuid);
insert into dw_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['poster', 'provider']) as names(name);
insert into dw_fixture (name) select unnest(array['gig', 'draft_gig', 'extra_gig', 'claim']);
insert into dw_fixture (name, id) values ('gig_request', gen_random_uuid());
grant select, update on dw_fixture to anon, authenticated;

create function pg_temp.dw_id(p_name text) returns uuid
language sql stable as $$
  select id from pg_temp.dw_fixture where name = p_name;
$$;

create function pg_temp.dw_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'PASS: %', p_label;
end;
$$;

-- Native grant-check failures (revoked table/column privileges).
create function pg_temp.dw_denied(p_sql text, p_label text) returns void
language plpgsql security invoker as $$
begin
  begin
    execute p_sql;
  exception when insufficient_privilege then
    raise notice 'PASS: %', p_label;
    return;
  end;
  raise exception 'FAIL (expected permission/authorization denial): %', p_label;
end;
$$;

-- Business-rule failures raised explicitly (e.g. the validation trigger's 22023).
create function pg_temp.dw_error(p_sql text, p_code text, p_label text) returns void
language plpgsql security invoker as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_code then raise; end if;
    raise notice 'PASS: %', p_label;
    return;
  end;
  raise exception 'FAIL (expected error %): %', p_code, p_label;
end;
$$;

do $$
declare
  v_schema text;
begin
  select nspname into v_schema from pg_catalog.pg_namespace
  where oid = pg_catalog.pg_my_temp_schema();
  execute pg_catalog.format('grant usage on schema %I to anon, authenticated', v_schema);
end;
$$;
grant execute on all functions in schema pg_temp to anon, authenticated;

insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
select id, 'authenticated', 'authenticated',
  'dw-' || id::text || '@example.invalid',
  jsonb_build_object('username', case name when 'poster' then 'PosterHardened' else 'ProviderHardened' end),
  now(), now()
from dw_fixture where name in ('poster', 'provider');

-- ---------------------------------------------------------------------------
-- 1. profiles: direct writes cannot bypass save_onboarding()'s validation.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', pg_temp.dw_id('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.dw_id('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.dw_error('update public.profiles set username=''ab'' where id=auth.uid()', '22023', 'direct write rejects too-short username');
select pg_temp.dw_error('update public.profiles set username=''bad name!'' where id=auth.uid()', '22023', 'direct write rejects invalid username characters');
select pg_temp.dw_error('update public.profiles set photo_url=''javascript:bad'' where id=auth.uid()', '22023', 'direct write rejects non-http photo URL');
select pg_temp.dw_error('update public.profiles set photo_url=''https://x.invalid/'' || repeat(''a'',2048) where id=auth.uid()', '22023', 'direct write rejects oversized photo URL');
select pg_temp.dw_error('update public.profiles set skills=''["NotACategory"]'' where id=auth.uid()', '22023', 'direct write rejects skill outside the catalog');
select pg_temp.dw_error('update public.profiles set services=''["Cleaning","Cleaning"]'' where id=auth.uid()', '22023', 'direct write rejects duplicate category');
select pg_temp.dw_error('update public.profiles set skills=''{}''::jsonb where id=auth.uid()', '22023', 'direct write rejects non-array skills');
select pg_temp.dw_assert(
  (select username <> 'ab' and username <> 'bad name!' and skills = '[]'::jsonb and services = '[]'::jsonb from public.profiles where id = pg_temp.dw_id('poster')),
  'no rejected direct write left a partial change'
);

-- Legitimate direct writes (the fields src/app/profile/page.tsx genuinely edits) still work.
update public.profiles set username = 'PosterHardened', skills = '["Cleaning"]', services = '["Other"]' where id = auth.uid();
select pg_temp.dw_assert(
  (select username = 'PosterHardened' and skills = '["Cleaning"]'::jsonb and services = '["Other"]'::jsonb from public.profiles where id = pg_temp.dw_id('poster')),
  'legitimate username/skills/services direct edit still succeeds'
);
select pg_temp.dw_assert(
  (select skills = '["Cleaning"]'::jsonb from public.public_profiles where id = pg_temp.dw_id('poster')),
  'profile synchronization trigger still fires after a validated direct edit'
);
-- Photo-only direct write (src/app/profile/page.tsx uploadPhoto) leaves the other columns untouched.
update public.profiles set photo_url = 'https://example.invalid/photo.jpg' where id = auth.uid();
select pg_temp.dw_assert(
  (select photo_url = 'https://example.invalid/photo.jpg' and username = 'PosterHardened' and skills = '["Cleaning"]'::jsonb from public.profiles where id = pg_temp.dw_id('poster')),
  'photo-only direct edit succeeds without disturbing unrelated validated columns'
);
-- save_onboarding() itself is unaffected: still validates, still succeeds.
select pg_temp.dw_error('select public.save_onboarding(''ab'',null,''Area'',null,null,''[]'',''[]'')', '22023', 'save_onboarding still rejects an invalid username');
select public.save_onboarding('PosterHardened', 'https://example.invalid/photo.jpg', 'Test private area', 12.34, -56.78, '["Cleaning"]', '["Other"]');
select pg_temp.dw_assert(
  (select onboarding_completed_at is not null and private_location_text = 'Test private area' from public.profiles where id = auth.uid()),
  'save_onboarding continues to complete setup'
);

-- ensure_profile()'s repair path issues its own `username = username` no-op
-- UPDATE when public_profiles is missing; confirm the new validation trigger's
-- per-column change-detection doesn't interfere with that no-op write.
reset role;
delete from public.public_profiles where id = pg_temp.dw_id('poster');
select set_config('request.jwt.claim.sub', pg_temp.dw_id('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.dw_id('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.dw_assert((select id = auth.uid() from public.ensure_profile()), 'ensure_profile repair path succeeds despite the validation trigger');
select pg_temp.dw_assert((select count(*) = 1 from public.public_profiles where id = pg_temp.dw_id('poster')), 'public profile repaired by the no-op username write');

-- ---------------------------------------------------------------------------
-- 2. gigs: protected fields cannot be modified through the client role.
-- ---------------------------------------------------------------------------
select pg_temp.dw_assert(
  not has_table_privilege('authenticated', 'public.gigs', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.gigs', 'amount', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.gigs', 'description', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.gigs', 'service_type', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.gigs', 'price_type', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.gigs', 'lat', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.gigs', 'lng', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.gigs', 'status', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.gigs', 'selected_provider_id', 'UPDATE'),
  'gigs UPDATE grant fully revoked for the client role'
);

update dw_fixture set id = (public.create_gig(
  pg_temp.dw_id('gig_request'), 'Cleaning', 'Hardening gig', 'Regression gig for Phase 2C', 25, 'fixed',
  now() + interval '1 day', 'Test area', 12.34, -56.78, null, true
)).id where name = 'gig';
select pg_temp.dw_assert((select status = 'active' and amount = 25 from public.gigs where id = pg_temp.dw_id('gig')), 'create_gig still creates an active gig');

select pg_temp.dw_denied('update public.gigs set amount=999999 where id=pg_temp.dw_id(''gig'')', 'poster cannot directly rewrite amount');
select pg_temp.dw_denied('update public.gigs set description=''forged'' where id=pg_temp.dw_id(''gig'')', 'poster cannot directly rewrite description');
select pg_temp.dw_denied('update public.gigs set service_type=''Other'' where id=pg_temp.dw_id(''gig'')', 'poster cannot directly rewrite service_type');
select pg_temp.dw_denied('update public.gigs set price_type=''negotiable'' where id=pg_temp.dw_id(''gig'')', 'poster cannot directly rewrite price_type');
select pg_temp.dw_denied('update public.gigs set lat=12.3456789, lng=-56.789123 where id=pg_temp.dw_id(''gig'')', 'poster cannot directly rewrite full-precision coordinates');
select pg_temp.dw_denied('update public.gigs set scheduled_at=now()+interval ''2 days'' where id=pg_temp.dw_id(''gig'')', 'poster cannot directly rewrite scheduled_at');
select pg_temp.dw_denied('update public.gigs set photo_url=''https://forged.invalid/x.jpg'' where id=pg_temp.dw_id(''gig'')', 'poster cannot directly rewrite photo_url');
select pg_temp.dw_denied('update public.gigs set status=''cancelled'' where id=pg_temp.dw_id(''gig'')', 'poster cannot directly rewrite status');
select pg_temp.dw_denied('update public.gigs set amount_paid=1 where id=pg_temp.dw_id(''gig'')', 'poster cannot directly rewrite amount_paid');
select pg_temp.dw_assert(
  (select amount = 25 and description = 'Regression gig for Phase 2C' and service_type = 'Cleaning' and price_type = 'fixed'
     and lat = 12.34 and lng = -56.78 and status = 'active' and amount_paid is null
   from public.gigs where id = pg_temp.dw_id('gig')),
  'no rejected direct gig write left a partial change'
);

-- ---------------------------------------------------------------------------
-- 3. Existing lifecycle RPCs continue working end-to-end (SECURITY DEFINER
--    functions run as their trusted owner, unaffected by the gigs grant revoke).
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', pg_temp.dw_id('provider')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.dw_id('provider'), 'role', 'authenticated')::text, true);
set local role authenticated;
update dw_fixture set id = (public.create_claim(pg_temp.dw_id('gig'))).id where name = 'claim';
select pg_temp.dw_assert((select state = 'pending' from public.claims where id = pg_temp.dw_id('claim')), 'provider can still claim an active gig');

reset role;
select set_config('request.jwt.claim.sub', pg_temp.dw_id('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.dw_id('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.select_provider(pg_temp.dw_id('gig'), pg_temp.dw_id('claim'));
select pg_temp.dw_assert((select selected_provider_id = pg_temp.dw_id('provider') from public.gigs where id = pg_temp.dw_id('gig')), 'poster can still select a provider');

reset role;
select set_config('request.jwt.claim.sub', pg_temp.dw_id('provider')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.dw_id('provider'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.request_start(pg_temp.dw_id('gig'));

reset role;
select set_config('request.jwt.claim.sub', pg_temp.dw_id('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.dw_id('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.approve_start(pg_temp.dw_id('gig'));
select public.submit_completion(pg_temp.dw_id('gig'), 'complete');
select pg_temp.dw_assert((select status = 'in_progress' from public.gigs where id = pg_temp.dw_id('gig')), 'approve_start still moves the gig to in_progress');

reset role;
select set_config('request.jwt.claim.sub', pg_temp.dw_id('provider')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.dw_id('provider'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.submit_completion(pg_temp.dw_id('gig'), 'complete');
select pg_temp.dw_assert((select status = 'awaiting_payment' from public.gigs where id = pg_temp.dw_id('gig')), 'submit_completion still resolves to awaiting_payment once both sides agree');
select public.submit_payment_amount(pg_temp.dw_id('gig'), 25);

reset role;
select set_config('request.jwt.claim.sub', pg_temp.dw_id('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.dw_id('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.submit_payment_amount(pg_temp.dw_id('gig'), 25);
select pg_temp.dw_assert((select status = 'completed' from public.gigs where id = pg_temp.dw_id('gig')), 'matching payment amounts still resolve the gig as completed');
select public.submit_feedback(pg_temp.dw_id('gig'), 'wom');
-- profiles_select_own limits each client role to its own row; read cross-user
-- state as the trusted role (matches how the earlier phase1/phase2a suites do it).
reset role;
select pg_temp.dw_assert((select money_made = 25 from public.profiles where id = pg_temp.dw_id('provider')), 'trusted earnings update still works despite gigs grant revocation');

select set_config('request.jwt.claim.sub', pg_temp.dw_id('provider')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.dw_id('provider'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.submit_feedback(pg_temp.dw_id('gig'), 'wom');
reset role;
select pg_temp.dw_assert(
  (select wom_count = 1 from public.profiles where id = pg_temp.dw_id('poster'))
  and (select wom_count = 1 from public.profiles where id = pg_temp.dw_id('provider')),
  'submit_feedback still updates trusted reputation counters both ways'
);

reset role;
select set_config('request.jwt.claim.sub', pg_temp.dw_id('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.dw_id('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;
update dw_fixture set id = (public.create_gig(
  gen_random_uuid(), 'Handyman', 'Draft gig', 'Draft for publish_gig regression', 15, 'fixed',
  null, 'Test area', null, null, null, false
)).id where name = 'draft_gig';
select public.publish_gig(pg_temp.dw_id('draft_gig'));
select pg_temp.dw_assert((select status = 'active' from public.gigs where id = pg_temp.dw_id('draft_gig')), 'publish_gig still promotes a draft to active');

update dw_fixture set id = (public.create_gig(
  gen_random_uuid(), 'Delivery', 'Cancel-me gig', 'Gig for cancel_gig regression', 15, 'fixed',
  now() + interval '1 day', 'Test area', null, null, null, true
)).id where name = 'extra_gig';
select public.cancel_gig(pg_temp.dw_id('extra_gig'));
select pg_temp.dw_assert((select status = 'cancelled' from public.gigs where id = pg_temp.dw_id('extra_gig')), 'cancel_gig still cancels an unclaimed active gig');

-- ---------------------------------------------------------------------------
-- 4. Existing concurrency/idempotency protections still pass.
-- ---------------------------------------------------------------------------
-- create_gig's retry-by-request-id idempotency still returns the original row.
select pg_temp.dw_assert(
  (select id from public.create_gig(
    pg_temp.dw_id('gig_request'), 'Cleaning', 'Hardening gig', 'Regression gig for Phase 2C', 25, 'fixed',
    now() + interval '1 day', 'Test area', 12.34, -56.78, null, true
  )) = pg_temp.dw_id('gig'),
  'create_gig retry with the same request ID returns the original row'
);
select pg_temp.dw_assert(
  (select count(*) from public.gigs where creation_request_id = pg_temp.dw_id('gig_request')) = 1,
  'create_gig retry never creates a duplicate row'
);
-- creation_request_id remains immutable, now denied at the grant level (see the
-- matching update in supabase/tests/onboarding_post_gig.sql for the 22023-era assertion).
select pg_temp.dw_denied('update public.gigs set creation_request_id=null where id=pg_temp.dw_id(''gig'')', 'creation_request_id remains immutable (grant-denied)');

-- The one-selected-claim-per-gig unique index is a DB-level invariant, not a
-- grant; check it directly as the trusted role so an (unrelated) RLS insert
-- policy denial can't be mistaken for the constraint itself.
reset role;
select pg_temp.dw_error(
  'insert into public.claims (gig_id, provider_id, state) values (pg_temp.dw_id(''gig''), pg_temp.dw_id(''poster''), ''selected'')',
  '23505', 'claims_one_selected_per_gig unique index still enforced'
);

reset role;
rollback;
