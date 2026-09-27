-- Account deletion regression suite.
-- Run only against an isolated Supabase test database after 0001 through 0009.
-- All fixtures and temporary assertions roll back; no extensions required.
-- Run as postgres (or an equivalent trusted migration role), with errors fatal.
begin;

create temporary table ad_fixture (name text primary key, id uuid);
insert into ad_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['clean', 'history', 'counterparty', 'chat_only', 'notify_only']) as n(name);
grant select, update on ad_fixture to anon, authenticated;

create function pg_temp.ad_id(p_name text) returns uuid
language sql stable as $$
  select id from pg_temp.ad_fixture where name = p_name;
$$;
create function pg_temp.ad_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.ad_error(p_sql text, p_code text, p_label text) returns void
language plpgsql security invoker as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_code then raise; end if;
    raise notice 'PASS: %', p_label; return;
  end;
  raise exception 'FAIL (expected error %): %', p_code, p_label;
end;
$$;

do $$
declare v_schema text;
begin
  select nspname into v_schema from pg_catalog.pg_namespace where oid = pg_catalog.pg_my_temp_schema();
  execute pg_catalog.format('grant usage on schema %I to anon, authenticated', v_schema);
end;
$$;
grant execute on all functions in schema pg_temp to anon, authenticated;

insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
select id, 'authenticated', 'authenticated', 'ad-' || id::text || '@example.invalid',
  jsonb_build_object('username', 'AD' || pg_catalog.replace(name, '_', '')), now(), now()
from ad_fixture;

-- ---------------------------------------------------------------------------
-- 1. Authentication required; no id argument exists for a caller to target
--    another account with (enforced by the function's own signature).
-- ---------------------------------------------------------------------------
select pg_temp.ad_error('select public.delete_own_account()', '42501', 'anonymous/unauthenticated caller cannot delete any account');
select pg_temp.ad_assert(
  (select pg_catalog.pg_get_function_identity_arguments(oid) = '' from pg_catalog.pg_proc where proname = 'delete_own_account'),
  'delete_own_account() takes no parameters: there is no user_id argument a client could substitute another account into'
);

-- ---------------------------------------------------------------------------
-- 2. Clean account (no marketplace history at all): reports safe to
--    hard-delete, and does not touch the profile itself -- the caller (a
--    server-side route, via the Admin API) performs the actual removal.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', pg_temp.ad_id('clean')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.ad_id('clean'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.save_onboarding('CleanUser1', null, '1 Clean Street', 10.0, 20.0, '["Cleaning"]', '["Other"]');
select public.set_helper_location('Clean Area', 10.0, 20.0);
select pg_temp.ad_assert(
  (select public.delete_own_account() = false),
  'clean account (no gigs/claims/messages/feedback/notifications): reports no marketplace history'
);
select pg_temp.ad_assert(
  (select username = 'CleanUser1' and skills = '["Cleaning"]'::jsonb and public_location_text = 'Clean Area'
     from public.profiles where id = pg_temp.ad_id('clean')),
  'clean account: delete_own_account() leaves the profile untouched (nothing to anonymize; the caller deletes it outright)'
);
reset role;

-- ---------------------------------------------------------------------------
-- 3. Account with marketplace history: onboard two users, then seed a
--    completed gig + claim + feedback directly (bypassing the full RPC
--    lifecycle, which is already covered by other suites) so 'history' is a
--    poster/feedback recipient and 'counterparty' is a selected
--    provider/claimant/feedback sender -- exercising every EXISTS branch
--    except chat/notifications, covered separately below.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', pg_temp.ad_id('history')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.ad_id('history'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.save_onboarding('HistoryUser1', null, '2 History Street', 30.0, 40.0, '["Cleaning"]', '[]');
select public.set_helper_location('History Area', 30.0, 40.0);
reset role;

select set_config('request.jwt.claim.sub', pg_temp.ad_id('counterparty')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.ad_id('counterparty'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.save_onboarding('Counterparty1', null, '3 Counter Street', 50.0, 60.0, '["Cleaning"]', '[]');
reset role;

create temporary table ad_gig (id uuid);
insert into ad_gig select gen_random_uuid();
insert into public.gigs (id, poster_id, service_type, title, description, amount, status, selected_provider_id)
select id, pg_temp.ad_id('history'), 'Cleaning', 'Test gig', 'Test description', 20, 'completed', pg_temp.ad_id('counterparty')
from ad_gig;
insert into public.claims (gig_id, provider_id, state)
select id, pg_temp.ad_id('counterparty'), 'selected' from ad_gig;
insert into public.feedback (gig_id, from_id, to_id, type)
select id, pg_temp.ad_id('counterparty'), pg_temp.ad_id('history'), 'wom' from ad_gig;

select set_config('request.jwt.claim.sub', pg_temp.ad_id('history')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.ad_id('history'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.ad_assert(
  (select public.delete_own_account() = true),
  'account with history (posted a gig, received feedback): reports marketplace history'
);
select pg_temp.ad_assert(
  (select username ~ '^deleted[0-9a-f]{8}$' and photo_url is null and skills = '[]'::jsonb and services = '[]'::jsonb
     and private_location_text is null and private_lat is null and private_lng is null
     and public_location_text is null and public_lat is null and public_lng is null
     from public.profiles where id = pg_temp.ad_id('history')),
  'account with history: profile is anonymized in place (username scrubbed to a pseudonymous placeholder, all PII/location cleared)'
);
reset role;

select pg_temp.ad_assert(
  (select count(*) = 0 from public.profile_tags where profile_id = pg_temp.ad_id('history')),
  'account with history: profile_tags removed for the deleted account'
);
select pg_temp.ad_assert(
  (select count(*) = 1 from public.gigs where id in (select id from ad_gig) and poster_id = pg_temp.ad_id('history')),
  'the gig itself is left completely intact -- not deleted, not reassigned'
);
select pg_temp.ad_assert(
  (select count(*) = 1 from public.feedback where gig_id in (select id from ad_gig) and from_id = pg_temp.ad_id('counterparty') and to_id = pg_temp.ad_id('history')),
  'the feedback row is left completely intact, preserving the counterparty''s recorded transaction history'
);
select pg_temp.ad_assert(
  (select username = 'Counterparty1' and private_location_text = '3 Counter Street' from public.profiles where id = pg_temp.ad_id('counterparty')),
  'deleting the history account never touches the counterparty''s own profile -- proves the function only ever acts on auth.uid()''s own row'
);

-- ---------------------------------------------------------------------------
-- 4. selected_provider_id / claims.provider_id / feedback.from_id alone (no
--    gig authored) is also detected as history, for the counterparty side.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', pg_temp.ad_id('counterparty')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.ad_id('counterparty'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.ad_assert(
  (select public.delete_own_account() = true),
  'account selected as a provider / claimant / feedback sender (never posted a gig itself): still reports marketplace history'
);
reset role;

-- ---------------------------------------------------------------------------
-- 5. chat_messages alone establishes history, independent of gigs/claims.
-- ---------------------------------------------------------------------------
insert into public.chat_messages (gig_id, sender_id, body)
select id, pg_temp.ad_id('chat_only'), 'hello' from ad_gig;
select set_config('request.jwt.claim.sub', pg_temp.ad_id('chat_only')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.ad_id('chat_only'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.ad_assert(
  (select public.delete_own_account() = true),
  'a chat message alone (no gig posted/claimed) is enough to establish marketplace history'
);
reset role;

-- ---------------------------------------------------------------------------
-- 6. notifications alone establishes history, even with no gig_id at all.
-- ---------------------------------------------------------------------------
insert into public.notifications (recipient_id, gig_id, type, message)
values (pg_temp.ad_id('notify_only'), null, 'info', 'test notification');
select set_config('request.jwt.claim.sub', pg_temp.ad_id('notify_only')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.ad_id('notify_only'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.ad_assert(
  (select public.delete_own_account() = true),
  'a notification alone (no associated gig) is enough to establish marketplace history'
);
reset role;

-- ---------------------------------------------------------------------------
-- 7. Direct-write and grant-level protections around the new function.
-- ---------------------------------------------------------------------------
select pg_temp.ad_assert(
  has_function_privilege('authenticated', 'public.delete_own_account()', 'EXECUTE'),
  'authenticated can call delete_own_account()'
);
select pg_temp.ad_assert(
  not has_function_privilege('anon', 'public.delete_own_account()', 'EXECUTE'),
  'anon cannot call delete_own_account()'
);

-- ---------------------------------------------------------------------------
-- 8. Regression: prior migrations' protections remain intact.
-- ---------------------------------------------------------------------------
select pg_temp.ad_assert(not has_table_privilege('authenticated', 'public.gigs', 'UPDATE'), 'Phase 2C: gigs UPDATE grant still revoked');
select pg_temp.ad_assert(not has_table_privilege('authenticated', 'public.profile_tags', 'INSERT'), 'profile_tags still has no client write grant');

reset role;
rollback;
