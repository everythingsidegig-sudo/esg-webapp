-- Run only against an isolated Supabase test database after 0001 and 0002.
-- All fixtures and temporary assertions roll back; no extensions required.
-- Run as postgres (or an equivalent trusted migration role), with errors fatal.
begin;

create temporary table security_fixture (name text primary key, id uuid not null);
insert into security_fixture
select name, gen_random_uuid()
from unnest(array[
  'poster', 'provider', 'claimant', 'unrelated',
  'open', 'selected', 'draft', 'progress', 'payment', 'completed', 'other_draft',
  'claim_open', 'claim_selected_provider', 'claim_selected_other',
  'claim_progress_provider', 'claim_progress_other', 'claim_completed_other',
  'provider_message', 'poster_message', 'notification'
]) as names(name);
grant select on security_fixture to anon, authenticated;

create function pg_temp.fixture(p_name text) returns uuid
language sql stable as $$
  select id from pg_temp.security_fixture where name = p_name;
$$;

create function pg_temp.assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'PASS: %', p_label;
end;
$$;

create function pg_temp.expect_denied(p_sql text, p_label text) returns void
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

-- 0002 removes PUBLIC's default EXECUTE for functions created by this role.
-- These invoker-only assertions exist in this session and roll back below.
do $$
declare
  v_schema text;
begin
  select nspname into v_schema from pg_catalog.pg_namespace
  where oid = pg_catalog.pg_my_temp_schema();
  execute pg_catalog.format('grant usage on schema %I to anon, authenticated', v_schema);
end;
$$;
grant execute on function pg_temp.fixture(text), pg_temp.assert(boolean, text),
  pg_temp.expect_denied(text, text) to anon, authenticated;

insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
select id, 'authenticated', 'authenticated',
  'phase1-' || id::text || '@example.invalid',
  jsonb_build_object('username', 'phase1_' || replace(id::text, '-', '')), now(), now()
from security_fixture where name in ('poster', 'provider', 'claimant', 'unrelated');

-- auth.users trigger must create both private/public profile rows.
select pg_temp.assert(
  (select count(*) from public.profiles where id in (
    select id from security_fixture where name in ('poster','provider','claimant','unrelated')
  )) = 4, 'signup trigger still creates profiles'
);

insert into public.gigs (
  id, poster_id, service_type, title, description, amount, location_text,
  scheduled_at, status, selected_provider_id, resolution_path
)
select id,
  case when name = 'other_draft' then pg_temp.fixture('unrelated') else pg_temp.fixture('poster') end,
  'Other', 'Phase 1 test ' || name, 'Transactional security test', 10, 'Test area',
  now() + interval '1 day',
  case name when 'draft' then 'draft'::public.gig_status
    when 'other_draft' then 'draft'::public.gig_status
    when 'progress' then 'in_progress'::public.gig_status
    when 'payment' then 'awaiting_payment'::public.gig_status
    when 'completed' then 'completed'::public.gig_status
    else 'active'::public.gig_status end,
  case when name in ('selected','progress','payment','completed') then pg_temp.fixture('provider') end,
  case when name = 'payment' then 'complete'::public.resolution_path end
from security_fixture where name in ('open','selected','draft','progress','payment','completed','other_draft');

insert into public.claims (id, gig_id, provider_id, state) values
  (pg_temp.fixture('claim_open'), pg_temp.fixture('open'), pg_temp.fixture('claimant'), 'pending'),
  (pg_temp.fixture('claim_selected_provider'), pg_temp.fixture('selected'), pg_temp.fixture('provider'), 'selected'),
  (pg_temp.fixture('claim_selected_other'), pg_temp.fixture('selected'), pg_temp.fixture('claimant'), 'pending'),
  (pg_temp.fixture('claim_progress_provider'), pg_temp.fixture('progress'), pg_temp.fixture('provider'), 'selected'),
  (pg_temp.fixture('claim_progress_other'), pg_temp.fixture('progress'), pg_temp.fixture('claimant'), 'pending'),
  (pg_temp.fixture('claim_completed_other'), pg_temp.fixture('completed'), pg_temp.fixture('claimant'), 'pending');

insert into public.chat_messages (id, gig_id, sender_id, body) values
  (pg_temp.fixture('provider_message'), pg_temp.fixture('progress'), pg_temp.fixture('provider'), 'Original provider message'),
  (pg_temp.fixture('poster_message'), pg_temp.fixture('progress'), pg_temp.fixture('poster'), 'Original poster message');
insert into public.notifications (id, recipient_id, gig_id, type, message) values
  (pg_temp.fixture('notification'), pg_temp.fixture('poster'), pg_temp.fixture('progress'), 'test', 'Original notification');

-- Catalog assertions catch both table grants and inherited column grants.
select pg_temp.assert(
  not has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
  and has_column_privilege('authenticated', 'public.profiles', 'skills', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'wom_count', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'lemon_count', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'money_made', 'UPDATE'),
  'profile UPDATE restricted to editable fields'
);
select pg_temp.assert(
  not has_table_privilege('authenticated', 'public.chat_messages', 'UPDATE')
  and has_column_privilege('authenticated', 'public.chat_messages', 'read_at', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.chat_messages', 'body', 'UPDATE'),
  'chat UPDATE restricted to read_at'
);
select pg_temp.assert(
  not has_function_privilege('anon', 'public.notify(uuid,uuid,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.notify(uuid,uuid,text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.sync_public_profile()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.sync_public_profile()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE'),
  'notification and trigger helpers not client executable'
);
select pg_temp.assert(
  not has_schema_privilege('anon', 'esg_private', 'CREATE')
  and not has_schema_privilege('authenticated', 'esg_private', 'CREATE'),
  'clients cannot replace authorization helpers'
);


reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
set local role anon;

select pg_temp.expect_denied('select public.create_claim(pg_temp.fixture(''open''))', 'anonymous cannot execute create_claim');
select pg_temp.expect_denied('select public.select_provider(pg_temp.fixture(''open''), pg_temp.fixture(''claim_open''))', 'anonymous cannot execute select_provider');
select pg_temp.expect_denied('select public.request_start(pg_temp.fixture(''selected''))', 'anonymous cannot execute request_start');
select pg_temp.expect_denied('select public.approve_start(pg_temp.fixture(''selected''))', 'anonymous cannot execute approve_start');
select pg_temp.expect_denied('select public.submit_completion(pg_temp.fixture(''progress''), ''complete'')', 'anonymous cannot execute submit_completion');
select pg_temp.expect_denied('select public.submit_incomplete_choice(pg_temp.fixture(''progress''), ''no_pay'')', 'anonymous cannot execute submit_incomplete_choice');
select pg_temp.expect_denied('select public.submit_payment_amount(pg_temp.fixture(''payment''), 10)', 'anonymous cannot execute submit_payment_amount');
select pg_temp.expect_denied('select public.submit_feedback(pg_temp.fixture(''completed''), ''wom'')', 'anonymous cannot execute submit_feedback');
select pg_temp.expect_denied('select public.publish_gig(pg_temp.fixture(''draft''))', 'anonymous cannot execute publish_gig');
select pg_temp.expect_denied('select public.cancel_gig(pg_temp.fixture(''open''))', 'anonymous cannot execute cancel_gig');
select pg_temp.expect_denied('select public.notify(pg_temp.fixture(''poster''), pg_temp.fixture(''open''), ''test'', ''forged'')', 'anonymous cannot invoke notification helper');
select pg_temp.expect_denied('update public.profiles set wom_count = 999 where id = pg_temp.fixture(''poster'')', 'anonymous cannot modify reputation');
select pg_temp.expect_denied('update public.chat_messages set read_at = now() where id = pg_temp.fixture(''provider_message'')', 'anonymous cannot modify chat');
select pg_temp.assert((select count(*) from public.gigs where id in (pg_temp.fixture('open'),pg_temp.fixture('selected'),pg_temp.fixture('draft'),pg_temp.fixture('progress'),pg_temp.fixture('payment'),pg_temp.fixture('completed'),pg_temp.fixture('other_draft'))) = 2, 'anonymous sees active gigs only; gigs SELECT does not recurse');
select pg_temp.assert((select count(*) from public.claims where id in (select id from pg_temp.security_fixture)) = 0, 'anonymous sees no claims; claims SELECT does not recurse');
select pg_temp.assert((select count(*) from public.public_profiles where id = pg_temp.fixture('poster') or id = pg_temp.fixture('provider')) = 2, 'public profiles remain readable');
select * from public.get_public_stats(pg_temp.fixture('provider'));
select pg_temp.expect_denied('select esg_private.has_own_claim(pg_temp.fixture(''progress''))', 'anonymous cannot invoke private claim helper');
select pg_temp.expect_denied('select esg_private.is_gig_poster(pg_temp.fixture(''progress''))', 'anonymous cannot invoke private poster helper');

reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
set local role authenticated;

select pg_temp.expect_denied('select public.create_claim(pg_temp.fixture(''open''))', 'authenticated role without JWT identity rejected by create_claim');
select pg_temp.expect_denied('select public.select_provider(pg_temp.fixture(''open''), pg_temp.fixture(''claim_open''))', 'authenticated role without JWT identity rejected by select_provider');
select pg_temp.expect_denied('select public.request_start(pg_temp.fixture(''selected''))', 'authenticated role without JWT identity rejected by request_start');
select pg_temp.expect_denied('select public.approve_start(pg_temp.fixture(''selected''))', 'authenticated role without JWT identity rejected by approve_start');
select pg_temp.expect_denied('select public.submit_completion(pg_temp.fixture(''progress''), ''complete'')', 'authenticated role without JWT identity rejected by submit_completion');
select pg_temp.expect_denied('select public.submit_incomplete_choice(pg_temp.fixture(''progress''), ''no_pay'')', 'authenticated role without JWT identity rejected by submit_incomplete_choice');
select pg_temp.expect_denied('select public.submit_payment_amount(pg_temp.fixture(''payment''), 10)', 'authenticated role without JWT identity rejected by submit_payment_amount');
select pg_temp.expect_denied('select public.submit_feedback(pg_temp.fixture(''completed''), ''wom'')', 'authenticated role without JWT identity rejected by submit_feedback');
select pg_temp.expect_denied('select public.publish_gig(pg_temp.fixture(''draft''))', 'authenticated role without JWT identity rejected by publish_gig');
select pg_temp.expect_denied('select public.cancel_gig(pg_temp.fixture(''open''))', 'authenticated role without JWT identity rejected by cancel_gig');

reset role;
select set_config('request.jwt.claim.sub', pg_temp.fixture('unrelated')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.fixture('unrelated'), 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.expect_denied('select public.select_provider(pg_temp.fixture(''open''), pg_temp.fixture(''claim_open''))', 'unrelated user cannot perform select_provider');
select pg_temp.expect_denied('select public.request_start(pg_temp.fixture(''selected''))', 'unrelated user cannot perform request_start');
select pg_temp.expect_denied('select public.approve_start(pg_temp.fixture(''selected''))', 'unrelated user cannot perform approve_start');
select pg_temp.expect_denied('select public.submit_completion(pg_temp.fixture(''progress''), ''complete'')', 'unrelated user cannot perform submit_completion');
select pg_temp.expect_denied('select public.submit_incomplete_choice(pg_temp.fixture(''progress''), ''no_pay'')', 'unrelated user cannot perform submit_incomplete_choice');
select pg_temp.expect_denied('select public.submit_payment_amount(pg_temp.fixture(''payment''), 10)', 'unrelated user cannot perform submit_payment_amount');
select pg_temp.expect_denied('select public.submit_feedback(pg_temp.fixture(''completed''), ''wom'')', 'unrelated user cannot perform submit_feedback');
select pg_temp.expect_denied('select public.publish_gig(pg_temp.fixture(''draft''))', 'unrelated user cannot perform publish_gig');
select pg_temp.expect_denied('select public.cancel_gig(pg_temp.fixture(''open''))', 'unrelated user cannot perform cancel_gig');
select pg_temp.expect_denied('select public.request_start(pg_temp.fixture(''open''))', 'NULL selected_provider_id cannot authorize an unrelated user');
select pg_temp.expect_denied('select public.notify(pg_temp.fixture(''poster''), pg_temp.fixture(''open''), ''test'', ''forged'')', 'authenticated client cannot invoke notification helper');
select pg_temp.expect_denied('update public.profiles set wom_count = 999 where id = pg_temp.fixture(''unrelated'')', 'own protected profile column denied: wom_count');
select pg_temp.expect_denied('update public.profiles set lemon_count = 999 where id = pg_temp.fixture(''unrelated'')', 'own protected profile column denied: lemon_count');
select pg_temp.expect_denied('update public.profiles set money_made = 999 where id = pg_temp.fixture(''unrelated'')', 'own protected profile column denied: money_made');
select pg_temp.expect_denied('update public.profiles set id = pg_temp.fixture(''poster'') where id = pg_temp.fixture(''unrelated'')', 'own protected profile column denied: id');
select pg_temp.expect_denied('update public.profiles set created_at = now() where id = pg_temp.fixture(''unrelated'')', 'own protected profile column denied: created_at');
with changed as (update public.profiles set photo_url = 'forged' where id = pg_temp.fixture('poster') returning id)
select pg_temp.assert(count(*) = 0, 'ordinary user cannot modify another profile') from changed;
select pg_temp.assert((select count(*) from public.gigs where id in (select id from pg_temp.security_fixture)) = 3, 'unrelated user sees public gigs plus own draft only');
select pg_temp.assert((select count(*) from public.claims where id in (select id from pg_temp.security_fixture)) = 0, 'unrelated user sees no other claims');
select pg_temp.assert((select count(*) from public.chat_messages where gig_id = pg_temp.fixture('progress')) = 0, 'unrelated user cannot read participant chat');
with changed as (update public.chat_messages set read_at = now() where id = pg_temp.fixture('provider_message') returning id)
select pg_temp.assert(count(*) = 0, 'unrelated user cannot mark participant chat read') from changed;
select pg_temp.expect_denied('insert into public.chat_messages (gig_id,sender_id,body) values (pg_temp.fixture(''progress''),pg_temp.fixture(''provider''),''forged'')', 'ordinary user cannot impersonate a chat sender');
select public.create_claim(pg_temp.fixture('open'));
select pg_temp.assert(
  (select count(*) from public.claims where gig_id=pg_temp.fixture('open')
    and provider_id=pg_temp.fixture('unrelated'))=1,
  'ordinary authenticated user retains legitimate claim permission'
);

reset role;
select set_config('request.jwt.claim.sub', pg_temp.fixture('claimant')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.fixture('claimant'), 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert((select count(*) from public.gigs where id in (select id from pg_temp.security_fixture)) = 4, 'unselected claimant sees active gigs and own claimed private gigs only');
select pg_temp.assert((select count(*) from public.claims where id in (select id from pg_temp.security_fixture)) = 4, 'claimant reads only own claims without recursion');
select pg_temp.assert((select count(*) from public.chat_messages where gig_id = pg_temp.fixture('progress')) = 0, 'unselected claimant cannot read chat');
select pg_temp.expect_denied('select public.request_start(pg_temp.fixture(''selected''))', 'unselected claimant cannot request start');
select pg_temp.expect_denied('select public.submit_completion(pg_temp.fixture(''progress''), ''complete'')', 'unselected claimant cannot submit completion');
select pg_temp.expect_denied('select public.submit_payment_amount(pg_temp.fixture(''payment''), 10)', 'unselected claimant cannot submit payment');
select pg_temp.expect_denied('select public.submit_feedback(pg_temp.fixture(''completed''), ''wom'')', 'unselected claimant cannot submit feedback');
with changed as (update public.chat_messages set read_at = now() where id = pg_temp.fixture('provider_message') returning id)
select pg_temp.assert(count(*) = 0, 'unselected claimant cannot modify read receipt') from changed;

reset role;
select set_config('request.jwt.claim.sub', pg_temp.fixture('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.fixture('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert((select count(*) from public.gigs where id in (select id from pg_temp.security_fixture)) = 6, 'poster reads own gigs in every status without recursion');
select pg_temp.assert((select count(*) from public.claims where id in (select id from pg_temp.security_fixture)) = 6, 'poster reads all claims on own gigs without recursion');
update public.profiles set photo_url='https://example.invalid/photo', skills='["Testing"]', services='["Other"]' where id=pg_temp.fixture('poster');
select pg_temp.assert((select skills = '["Testing"]'::jsonb and services = '["Other"]'::jsonb from public.profiles where id=pg_temp.fixture('poster')), 'legitimate profile edits succeed');
select pg_temp.assert((select skills = '["Testing"]'::jsonb from public.public_profiles where id=pg_temp.fixture('poster')), 'profile synchronization trigger still succeeds');
select pg_temp.expect_denied('update public.chat_messages set body=''forged'' where id=pg_temp.fixture(''provider_message'')', 'participant cannot modify chat body');
select pg_temp.expect_denied('update public.chat_messages set sender_id=pg_temp.fixture(''poster'') where id=pg_temp.fixture(''provider_message'')', 'participant cannot modify chat sender_id');
select pg_temp.expect_denied('update public.chat_messages set gig_id=pg_temp.fixture(''open'') where id=pg_temp.fixture(''provider_message'')', 'participant cannot modify chat gig_id');
select pg_temp.expect_denied('update public.chat_messages set id=pg_temp.fixture(''poster_message'') where id=pg_temp.fixture(''provider_message'')', 'participant cannot modify chat id');
select pg_temp.expect_denied('update public.chat_messages set created_at=now() where id=pg_temp.fixture(''provider_message'')', 'participant cannot modify chat created_at');
update public.chat_messages set read_at=now() where id=pg_temp.fixture('provider_message');
select pg_temp.assert((select read_at is not null from public.chat_messages where id=pg_temp.fixture('provider_message')), 'poster can mark provider message read');
update public.notifications set read=true where id=pg_temp.fixture('notification');
select pg_temp.assert((select read from public.notifications where id=pg_temp.fixture('notification')), 'notification read update succeeds');
select pg_temp.expect_denied('update public.notifications set message=''forged'' where id=pg_temp.fixture(''notification'')', 'notification content remains trusted');
select pg_temp.expect_denied('select public.request_start(pg_temp.fixture(''selected''))', 'poster cannot perform provider-only request_start');
select public.publish_gig(pg_temp.fixture('draft'));
select pg_temp.assert((select status='active' from public.gigs where id=pg_temp.fixture('draft')), 'poster can publish own draft');
select public.select_provider(pg_temp.fixture('open'), pg_temp.fixture('claim_open'));
select pg_temp.assert((select selected_provider_id=pg_temp.fixture('claimant') from public.gigs where id=pg_temp.fixture('open')), 'poster can select a legitimate claimant');
select public.submit_completion(pg_temp.fixture('progress'), 'complete');
select public.submit_payment_amount(pg_temp.fixture('payment'), 10);

reset role;
select set_config('request.jwt.claim.sub', pg_temp.fixture('provider')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.fixture('provider'), 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert((select count(*) from public.claims where id in (select id from pg_temp.security_fixture))=2, 'selected provider reads only own claims');
select pg_temp.assert((select count(*) from public.gigs where id in (pg_temp.fixture('selected'),pg_temp.fixture('progress'),pg_temp.fixture('payment'),pg_temp.fixture('completed')))=4, 'selected provider retains private gig visibility');
select public.request_start(pg_temp.fixture('selected'));
select pg_temp.assert((select start_requested_at is not null from public.gigs where id=pg_temp.fixture('selected')), 'selected provider can request start');
update public.chat_messages set read_at=now() where id=pg_temp.fixture('poster_message');
select pg_temp.assert((select read_at is not null from public.chat_messages where id=pg_temp.fixture('poster_message')), 'selected provider can mark poster message read');
insert into public.chat_messages (gig_id,sender_id,body)
values (pg_temp.fixture('progress'),pg_temp.fixture('provider'),'Legitimate provider message');
select pg_temp.assert(
  (select count(*) from public.chat_messages where gig_id=pg_temp.fixture('progress'))=3,
  'selected provider retains legitimate chat insert permission'
);
select pg_temp.expect_denied(
  'insert into public.chat_messages (gig_id,sender_id,body) values (pg_temp.fixture(''progress''),pg_temp.fixture(''poster''),''forged'')',
  'selected provider cannot insert a message impersonating the poster'
);
select pg_temp.expect_denied('update public.chat_messages set sender_id=pg_temp.fixture(''provider'') where id=pg_temp.fixture(''poster_message'')', 'selected provider cannot impersonate poster');
select pg_temp.expect_denied('select public.approve_start(pg_temp.fixture(''selected''))', 'provider cannot approve start');
select pg_temp.expect_denied('select public.publish_gig(pg_temp.fixture(''draft''))', 'provider cannot publish another user gig');
select public.submit_completion(pg_temp.fixture('progress'), 'complete');
select public.submit_payment_amount(pg_temp.fixture('payment'), 10);
select pg_temp.assert((select money_made=10 from public.profiles where id=pg_temp.fixture('provider')), 'trusted payment RPC can update earnings despite client counter restrictions');
select public.submit_feedback(pg_temp.fixture('completed'), 'wom');

reset role;
select set_config('request.jwt.claim.sub', pg_temp.fixture('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.fixture('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;

select public.approve_start(pg_temp.fixture('selected'));
select pg_temp.assert((select status='in_progress' from public.gigs where id=pg_temp.fixture('selected')), 'poster retains start approval permission');
select public.submit_feedback(pg_temp.fixture('completed'), 'wom');
select public.cancel_gig(pg_temp.fixture('draft'));
select pg_temp.assert((select status='cancelled' from public.gigs where id=pg_temp.fixture('draft')), 'poster retains cancellation permission');
reset role;
select pg_temp.assert(
  (select wom_count=1 from public.profiles where id=pg_temp.fixture('provider'))
  and (select wom_count=1 from public.profiles where id=pg_temp.fixture('poster')),
  'trusted feedback RPCs update reputation'
);
select pg_temp.assert(
  (select status='awaiting_payment' from public.gigs where id=pg_temp.fixture('progress'))
  and (select status='completed' from public.gigs where id=pg_temp.fixture('payment')),
  'legitimate completion and payment paths remain functional'
);
select pg_temp.assert(
  (select body='Original provider message' and sender_id=pg_temp.fixture('provider')
    from public.chat_messages where id=pg_temp.fixture('provider_message')),
  'denied chat changes leave message intact'
);
select pg_temp.assert(
  exists(select 1 from public.notifications where recipient_id=pg_temp.fixture('provider') and type='lets_go'),
  'internal notification helper still works through authorized RPCs'
);

-- Verify an already-established incomplete phase without changing its rules.
insert into security_fixture values ('incomplete',gen_random_uuid());
insert into public.gigs (
  id,poster_id,service_type,title,description,amount,status,
  selected_provider_id,incomplete_choice_phase
) values (
  pg_temp.fixture('incomplete'),pg_temp.fixture('poster'),'Other','Incomplete test',
  'Established phase',10,'in_progress',pg_temp.fixture('provider'),true
);
insert into public.gig_completions (gig_id,user_id,outcome) values
  (pg_temp.fixture('incomplete'),pg_temp.fixture('poster'),'incomplete'),
  (pg_temp.fixture('incomplete'),pg_temp.fixture('provider'),'incomplete');
select set_config('request.jwt.claim.sub',pg_temp.fixture('poster')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.fixture('poster'),'role','authenticated')::text,true);
set local role authenticated;
select public.submit_incomplete_choice(pg_temp.fixture('incomplete'),'no_pay');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.fixture('provider')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.fixture('provider'),'role','authenticated')::text,true);
set local role authenticated;
select public.submit_incomplete_choice(pg_temp.fixture('incomplete'),'no_pay');
select pg_temp.assert(
  (select status='incomplete' from public.gigs where id=pg_temp.fixture('incomplete')),
  'legitimate incomplete-choice RPC authorization remains functional'
);
reset role;
rollback;
