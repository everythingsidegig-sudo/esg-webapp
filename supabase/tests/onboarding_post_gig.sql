-- Isolated test database only, migrations 0001 through 0004. All fixtures roll back.
begin;
create temporary table journey_fixture(name text primary key,id uuid not null);
create temporary table journey_snapshot(payload jsonb not null);
insert into journey_fixture select name,gen_random_uuid()
from unnest(array['poster','other','request','second','gig','draft']) names(name);
grant select,update on journey_fixture to anon,authenticated;
grant select,insert on journey_snapshot to anon,authenticated;
create function pg_temp.journey_id(p_name text) returns uuid language sql stable as $$
  select id from pg_temp.journey_fixture where name=p_name;
$$;
create function pg_temp.journey_assert(p_ok boolean,p_label text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %',p_label; end if;
  raise notice 'PASS: %',p_label;
end;
$$;
create function pg_temp.journey_error(p_sql text,p_code text,p_label text)
returns void language plpgsql security invoker as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlstate<>p_code then raise; end if;
    raise notice 'PASS: %',p_label; return;
  end;
  raise exception 'FAIL (expected error): %',p_label;
end;
$$;
-- This file runs standalone (0001-0004, via --onboarding) or layered under
-- Phase 2C (0001-0005, via --phase2c). A handful of assertions have a
-- guarantee that holds either way but a SQLSTATE that legitimately differs
-- by which migrations are applied; accept any of several codes for those.
create function pg_temp.journey_error_any(p_sql text,p_codes text[],p_label text)
returns void language plpgsql security invoker as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlstate<>all(p_codes) then raise; end if;
    raise notice 'PASS: %',p_label; return;
  end;
  raise exception 'FAIL (expected error): %',p_label;
end;
$$;
create function pg_temp.post(p_request uuid,p_service text default 'Other',p_title text default 'Journey gig',
  p_description text default 'Help with a task',p_amount numeric default 25,p_price text default 'fixed',
  p_date timestamptz default now()+interval '1 day',p_area text default 'Test neighborhood',
  p_lat double precision default 12.345678,p_lng double precision default -45.678912,
  p_photo text default null,p_publish boolean default true)
returns public.gigs language sql security invoker as $$
  select public.create_gig(p_request,p_service,p_title,p_description,p_amount,p_price,p_date,p_area,p_lat,p_lng,p_photo,p_publish);
$$;
do $$
declare v_schema text;
begin
  select nspname into v_schema from pg_catalog.pg_namespace where oid=pg_catalog.pg_my_temp_schema();
  execute pg_catalog.format('grant usage on schema %I to anon,authenticated',v_schema);
end;
$$;
grant execute on all functions in schema pg_temp to anon,authenticated;
insert into auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
select id,'authenticated','authenticated','journey-'||id::text||'@example.invalid',
  jsonb_build_object('username',case name when 'poster' then 'PosterJourney' else 'OtherJourney' end),now(),now()
from journey_fixture where name in ('poster','other');

set local role anon;
select pg_temp.journey_error('select public.ensure_profile()','42501','anonymous profile command denied');
select pg_temp.journey_error('select public.save_onboarding(''PosterJourney'',null,''123 Private Street'',12.345678,-45.678912,''["Tech Help"]'',''["Cleaning"]'')','42501','anonymous setup denied');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''request''))','42501','anonymous creation denied');
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
set local role authenticated;
select pg_temp.journey_error('select public.ensure_profile()','42501','missing identity profile denied');
select pg_temp.journey_error('select public.save_onboarding(''PosterJourney'',null,''123 Private Street'',12.345678,-45.678912,''["Tech Help"]'',''["Cleaning"]'')','42501','missing identity setup denied');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''request''))','42501','missing identity creation denied');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.journey_id('poster')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.journey_id('poster'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.journey_assert((select id=pg_temp.journey_id('poster') from public.ensure_profile()),'ensure profile returns current caller');
select pg_temp.journey_assert((select count(*)=1 from public.profiles where id=pg_temp.journey_id('poster')),'private profile exists exactly once');
select pg_temp.journey_assert((select count(*)=1 from public.public_profiles where id=pg_temp.journey_id('poster')),'public profile exists exactly once');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''request''))','22023','posting requires completed setup');
select public.save_onboarding('PosterJourney',null,'123 Private Street',12.345678,-45.678912,'["Tech Help"]','["Cleaning"]');
select pg_temp.journey_assert((select private_location_text='123 Private Street' and private_lat=12.345678 and private_lng=-45.678912 and onboarding_completed_at is not null from public.profiles where id=auth.uid()),'setup saves private address coordinates and completion');
select pg_temp.journey_assert((select skills='["Tech Help"]'::jsonb and services='["Cleaning"]'::jsonb and wom_count=0 and lemon_count=0 and money_made=0 from public.profiles where id=auth.uid()),'setup saves categories without touching trusted counters');
select pg_temp.journey_assert((select skills='["Tech Help"]'::jsonb from public.public_profiles where id=auth.uid()),'public profile synchronization preserved');
select pg_temp.journey_assert((select count(*)=0 from information_schema.columns where table_schema='public' and table_name='public_profiles' and column_name in ('private_location_text','private_lat','private_lng','onboarding_completed_at','services')),'private setup fields excluded from public table');
select pg_temp.journey_error('update public.profiles set onboarding_completed_at=now() where id=auth.uid()','42501','clients cannot forge setup completion');
select pg_temp.journey_error('update public.profiles set private_location_text=''forged'' where id=auth.uid()','42501','private location writes use validated command');
select pg_temp.journey_error('insert into public.gigs(poster_id,service_type,title,description,amount,status) values(auth.uid(),''Other'',''Bypass'',''Bypass'',1,''active'')','42501','direct client gig insert cannot bypass validation');
select pg_temp.journey_error('select public.save_onboarding(p_username := ''short'',p_photo_url := null,p_location_text := ''Private area'',p_lat := null,p_lng := null,p_skills := ''[]''::jsonb,p_services := ''[]''::jsonb)','22023','invalid username rejected');
select pg_temp.journey_error('select public.save_onboarding(p_username := ''PosterJourney'',p_photo_url := null,p_location_text := '' '',p_lat := null,p_lng := null,p_skills := ''[]''::jsonb,p_services := ''[]''::jsonb)','22023','blank private location rejected');
select pg_temp.journey_error('select public.save_onboarding(p_username := ''PosterJourney'',p_photo_url := null,p_location_text := ''Private area'',p_lat := ''NaN''::double precision,p_lng := null,p_skills := ''[]''::jsonb,p_services := ''[]''::jsonb)','22023','invalid private coordinates rejected');
select pg_temp.journey_error('select public.save_onboarding(p_username := ''PosterJourney'',p_photo_url := null,p_location_text := ''Private area'',p_lat := null,p_lng := null,p_skills := ''{}''::jsonb,p_services := ''[]''::jsonb)','22023','nonarray skills rejected');
select pg_temp.journey_error('select public.save_onboarding(p_username := ''PosterJourney'',p_photo_url := null,p_location_text := ''Private area'',p_lat := null,p_lng := null,p_skills := ''[]''::jsonb,p_services := ''["Invalid"]''::jsonb)','22023','unknown services rejected');
select pg_temp.journey_error('select public.save_onboarding(p_username := ''PosterJourney'',p_photo_url := null,p_location_text := ''Private area'',p_lat := null,p_lng := null,p_skills := ''["Tech Help","Tech Help"]''::jsonb,p_services := ''[]''::jsonb)','22023','duplicate categories rejected');
select pg_temp.journey_error('select public.save_onboarding(p_username := ''PosterJourney'',p_photo_url := ''javascript:bad'',p_location_text := ''Private area'',p_lat := null,p_lng := null,p_skills := ''[]''::jsonb,p_services := ''[]''::jsonb)','22023','invalid profile photo URL rejected');
select pg_temp.journey_error('select public.save_onboarding(p_username := ''OtherJourney'',p_photo_url := null,p_location_text := ''Private area'',p_lat := null,p_lng := null,p_skills := ''[]''::jsonb,p_services := ''[]''::jsonb)','23505','duplicate username rejected');
select pg_temp.journey_assert((select private_location_text='123 Private Street' and skills='["Tech Help"]'::jsonb and services='["Cleaning"]'::jsonb from public.profiles where id=auth.uid()),'failed setup does not overwrite saved values');
update journey_fixture set id=(pg_temp.post(pg_temp.journey_id('request'))).id where name='gig';
insert into journey_snapshot select to_jsonb(g) from public.gigs g where id=pg_temp.journey_id('gig');
select pg_temp.journey_assert((select count(*)=1 from public.gigs where creation_request_id=pg_temp.journey_id('request') and poster_id=auth.uid()),'one gig created for request');
select pg_temp.journey_assert((select status='active' and selected_provider_id is null and start_requested_at is null and start_approved_at is null and amount_paid is null and amount_received is null from public.gigs where id=pg_temp.journey_id('gig')),'initial open state has no provider or workflow data');
select pg_temp.journey_assert((select created_at=now() and scheduled_at>now() and price_type='fixed' from public.gigs where id=pg_temp.journey_id('gig')),'server timestamp schedule and fixed price correct');
select pg_temp.journey_assert((select lat=12.35 and lng=-45.68 and location_text='Test neighborhood' from public.gigs where id=pg_temp.journey_id('gig')),'public gig coordinates are approximate and address is separate');
select pg_temp.journey_assert((select count(*)=0 from public.claims where gig_id=pg_temp.journey_id('gig')),'new gig has no claims');
select pg_temp.journey_assert((select to_jsonb(g)=(select payload from journey_snapshot) from pg_temp.post(pg_temp.journey_id('request')) g),'creation retry 1 returns first unchanged row');
select pg_temp.journey_assert((select to_jsonb(g)=(select payload from journey_snapshot) from pg_temp.post(pg_temp.journey_id('request')) g),'creation retry 2 returns first unchanged row');
select pg_temp.journey_assert((select to_jsonb(g)=(select payload from journey_snapshot) from pg_temp.post(pg_temp.journey_id('request')) g),'creation retry 3 returns first unchanged row');
select pg_temp.journey_assert((select count(*)=1 from public.gigs where creation_request_id=pg_temp.journey_id('request')),'retries never duplicate gig');
-- Standalone (0001-0004), this is denied by the keep_creation_request trigger
-- itself (22023). Layered under Phase 2C (0001-0005), gigs' client UPDATE
-- grant is revoked entirely, so the same statement is now denied at the grant
-- level (42501) before ever reaching that trigger. Either way the immutability
-- guarantee holds, so both codes are accepted here.
select pg_temp.journey_error_any('update public.gigs set creation_request_id=null where id=pg_temp.journey_id(''gig'')',array['22023','42501'],'ordinary edits cannot erase creation retry key');
select pg_temp.journey_assert((select count(*)=1 from public.gigs where creation_request_id=pg_temp.journey_id('request')),'denied key update leaves retry identity intact');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_service := ''Invalid'')','22023','unknown service rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_title := '' '')','22023','missing title rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_title := null)','22023','NULL title rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_description := '''')','22023','missing description rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_amount := 0)','22023','zero price rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_amount := -1)','22023','negative price rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_amount := ''NaN''::numeric)','22023','NaN price rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_amount := ''Infinity''::numeric)','22023','infinite price rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_amount := 1.001)','22023','extra price precision rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_price := ''invalid'')','22023','invalid price type rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_price := ''negotiable'')','22023','unsupported negotiable price rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_date := now()-interval ''1 day'')','22023','past schedule rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_date := null)','22023','missing public schedule rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_date := ''infinity''::timestamptz)','22023','infinite schedule rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_area := '' '')','22023','missing public area rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_lat := 91)','22023','out of range latitude rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_lng := -181)','22023','out of range longitude rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_lat := ''NaN''::double precision)','22023','NaN public coordinate rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_lat := null)','22023','unpaired coordinates rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_photo := ''javascript:bad'')','22023','invalid gig photo URL rejected');
select pg_temp.journey_error('select pg_temp.post(pg_temp.journey_id(''second''),p_publish := null)','22023','NULL publish choice rejected');
select pg_temp.journey_error('select pg_temp.post(null)','22023','missing creation request rejected');
update journey_fixture set id=(pg_temp.post(pg_temp.journey_id('draft'),p_date:=null,p_publish:=false,p_lat:=null,p_lng:=null)).id where name='draft';
select pg_temp.journey_assert((select status='draft' and selected_provider_id is null from public.gigs where id=pg_temp.journey_id('draft')),'existing save-as-draft option preserved');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.journey_id('other')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.journey_id('other'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.journey_assert((select count(*)=0 from public.profiles where id=pg_temp.journey_id('poster')),'other user cannot read private onboarding address');
select pg_temp.journey_assert((select count(*)=1 from public.gigs where id=pg_temp.journey_id('gig')),'new gig appears in public browse for other account');
select pg_temp.journey_assert((select count(*)=0 from public.gigs where id=pg_temp.journey_id('draft')),'draft remains private');
-- Seed pre-catalog legacy labels the way they would already exist in older
-- data. Phase 2C's validation trigger fires for any ordinary role, so this
-- fixture write (simulating historical data, not a client request) uses
-- session_replication_role to bypass it, matching standard practice for
-- loading data that predates a newly added trigger.
reset role;
set local session_replication_role = replica;
update public.profiles set skills='["Legacy custom skill"]',services='["Legacy custom service"]' where id=pg_temp.journey_id('other');
set local session_replication_role = default;
set local role authenticated;
select public.save_onboarding('OtherJourney',null,'Other private area',null,null,'["Legacy custom skill"]','["Legacy custom service"]');
select pg_temp.journey_assert((select skills='["Legacy custom skill"]'::jsonb and services='["Legacy custom service"]'::jsonb from public.ensure_profile()),'returning users retain existing custom categories');
select public.save_onboarding('OtherJourney',null,'Other private area',null,null,'[]','[]');
select pg_temp.journey_assert((pg_temp.post(pg_temp.journey_id('request'))).poster_id=auth.uid(),'same request ID on another account cannot impersonate poster');
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
set local role authenticated;
set local role anon;
select pg_temp.journey_assert((select count(*)=1 from public.gigs where id=pg_temp.journey_id('gig')),'new active gig visible to signed-out browse');
select pg_temp.journey_assert((select count(*)=0 from public.profiles where id=pg_temp.journey_id('poster')),'anonymous user cannot read private address');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.journey_id('poster')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.journey_id('poster'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.journey_assert((select skills='["Tech Help"]'::jsonb and services='["Cleaning"]'::jsonb from public.ensure_profile()),'saved selections survive restored identity');
select pg_temp.journey_assert((select count(*)=1 from public.gigs where id=pg_temp.journey_id('gig') and poster_id=auth.uid()),'created gig remains in poster activity after restored identity');
reset role;
select pg_temp.journey_assert((select count(*)=0 from pg_proc where pronamespace='public'::regnamespace and proname='create_gig' and 'p_poster_id'=any(proargnames)),'creation API does not accept poster identity');
select pg_temp.journey_assert(not has_function_privilege('authenticated','esg_private.keep_creation_request()','execute'),'internal request helper cannot be directly invoked');
select pg_temp.journey_assert((select bool_and(proconfig @> array['search_path=""']) from pg_proc where pronamespace='public'::regnamespace and proname in ('ensure_profile','save_onboarding','create_gig')),'new RPCs have safe search paths');
delete from public.public_profiles where id=pg_temp.journey_id('other');
select set_config('request.jwt.claim.sub',pg_temp.journey_id('other')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.journey_id('other'),'role','authenticated')::text,true);
set local role authenticated;
select public.ensure_profile();
select pg_temp.journey_assert((select count(*)=1 from public.public_profiles where id=auth.uid()),'missing public profile can be recovered without leaking private fields');
reset role;
insert into auth.users(id,email,raw_user_meta_data) values(gen_random_uuid(),'recovery@example.invalid',jsonb_build_object('username','RecoveryJourney'));
insert into journey_fixture select 'recovery',id from auth.users where email='recovery@example.invalid';
delete from public.profiles where id=pg_temp.journey_id('recovery');
select set_config('request.jwt.claim.sub',pg_temp.journey_id('recovery')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.journey_id('recovery'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.journey_assert((select id=auth.uid() and onboarding_completed_at is null from public.ensure_profile()),'missing private profile recovered for current authenticated user');
select pg_temp.journey_assert((select count(*)=1 from public.public_profiles where id=auth.uid()),'recovered private profile creates public counterpart');
reset role;
rollback;
