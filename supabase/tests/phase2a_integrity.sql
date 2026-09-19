-- Phase 2A regression suite. Isolated test database only, after 0001/0002/0003.
-- Requires postgres/trusted admin. All fixtures and helper grants roll back.
begin;
create temporary table phase2_fixture (name text primary key, id uuid not null);
create temporary table phase2_snapshot (name text primary key, payload jsonb not null);
insert into phase2_fixture
select name,gen_random_uuid() from unnest(array[
  'poster','a','b','outsider','open','reverse','closed','draft','rejected','withdrawn',
  'fb_wom','fb_lemon','fb_skip','fb_incomplete','fb_unresolved','other_open',
  'claim_a','claim_b','reverse_a','reverse_b','rejected_a','withdrawn_a','wrong_claim'
]) as names(name);
grant select,update on phase2_fixture to anon,authenticated;
grant select,insert on phase2_snapshot to anon,authenticated;
create function pg_temp.phase2_id(p_name text) returns uuid language sql stable as $$
  select id from pg_temp.phase2_fixture where name=p_name;
$$;
create function pg_temp.phase2_assert(p_ok boolean,p_label text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %',p_label; end if;
  raise notice 'PASS: %',p_label;
end;
$$;
create function pg_temp.phase2_expect_error(p_sql text,p_code text,p_label text,p_message text default null)
returns void language plpgsql security invoker as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_code or (p_message is not null and sqlerrm <> p_message) then raise; end if;
    raise notice 'PASS: %',p_label;
    return;
  end;
  raise exception 'FAIL (expected controlled error): %',p_label;
end;
$$;
do $$
declare v_schema text;
begin
  select nspname into v_schema from pg_catalog.pg_namespace where oid=pg_catalog.pg_my_temp_schema();
  execute pg_catalog.format('grant usage on schema %I to anon,authenticated',v_schema);
end;
$$;
grant execute on function pg_temp.phase2_id(text),pg_temp.phase2_assert(boolean,text),
  pg_temp.phase2_expect_error(text,text,text,text) to anon,authenticated;

insert into auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
select id,'authenticated','authenticated','phase2-'||id::text||'@example.invalid',
  jsonb_build_object('username','phase2_'||replace(id::text,'-','')),now(),now()
from phase2_fixture where name in ('poster','a','b','outsider');
insert into public.gigs(id,poster_id,service_type,title,description,amount,status,selected_provider_id)
select id,
  case when name='other_open' then pg_temp.phase2_id('outsider') else pg_temp.phase2_id('poster') end,
  'Other','Phase2 '||name,'Integrity test',10,
  case when name='draft' then 'draft'::public.gig_status
    when name in ('closed','fb_wom','fb_lemon','fb_skip') then 'completed'::public.gig_status
    when name='fb_incomplete' then 'incomplete'::public.gig_status
    else 'active'::public.gig_status end,
  case when name in ('closed','fb_wom','fb_lemon','fb_skip','fb_incomplete','fb_unresolved')
    then pg_temp.phase2_id('a') end
from phase2_fixture where name in (
  'open','reverse','closed','draft','rejected','withdrawn',
  'fb_wom','fb_lemon','fb_skip','fb_incomplete','fb_unresolved','other_open'
);
insert into public.claims(id,gig_id,provider_id,state) values
  (pg_temp.phase2_id('reverse_a'),pg_temp.phase2_id('reverse'),pg_temp.phase2_id('a'),'pending'),
  (pg_temp.phase2_id('reverse_b'),pg_temp.phase2_id('reverse'),pg_temp.phase2_id('b'),'pending'),
  (pg_temp.phase2_id('rejected_a'),pg_temp.phase2_id('rejected'),pg_temp.phase2_id('a'),'rejected'),
  (pg_temp.phase2_id('withdrawn_a'),pg_temp.phase2_id('withdrawn'),pg_temp.phase2_id('a'),'withdrawn'),
  (pg_temp.phase2_id('wrong_claim'),pg_temp.phase2_id('other_open'),pg_temp.phase2_id('a'),'pending');

reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
set local role anon;
select pg_temp.phase2_expect_error('select public.create_claim(pg_temp.phase2_id(''open''))','42501','anonymous claim denied');
select pg_temp.phase2_expect_error('select public.select_provider(pg_temp.phase2_id(''reverse''),pg_temp.phase2_id(''reverse_a''))','42501','anonymous selection denied');
select pg_temp.phase2_expect_error('select public.submit_feedback(pg_temp.phase2_id(''fb_wom''),''wom'')','42501','anonymous feedback denied');
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
set local role authenticated;
select pg_temp.phase2_expect_error('select public.create_claim(pg_temp.phase2_id(''open''))','42501','missing JWT identity claim denied');
select pg_temp.phase2_expect_error('select public.select_provider(pg_temp.phase2_id(''reverse''),pg_temp.phase2_id(''reverse_a''))','42501','missing JWT identity selection denied');
select pg_temp.phase2_expect_error('select public.submit_feedback(pg_temp.phase2_id(''fb_wom''),''wom'')','42501','missing JWT identity feedback denied');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('outsider')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('outsider'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.phase2_expect_error('select public.select_provider(pg_temp.phase2_id(''reverse''),pg_temp.phase2_id(''reverse_a''))','42501','non-poster selection denied');
select pg_temp.phase2_expect_error('select public.submit_feedback(pg_temp.phase2_id(''fb_wom''),''wom'')','42501','unrelated feedback denied');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('poster')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('poster'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.phase2_expect_error('select public.create_claim(pg_temp.phase2_id(''open''))','P0001','poster cannot claim own gig');
select pg_temp.phase2_expect_error('select public.select_provider(pg_temp.phase2_id(''reverse''),pg_temp.phase2_id(''wrong_claim''))','P0001','claim from another gig cannot be selected','Claim not found or not actionable');
select pg_temp.phase2_expect_error('select public.select_provider(pg_temp.phase2_id(''rejected''),pg_temp.phase2_id(''rejected_a''))','P0001','rejected claim cannot be selected');
select pg_temp.phase2_expect_error('select public.select_provider(pg_temp.phase2_id(''withdrawn''),pg_temp.phase2_id(''withdrawn_a''))','P0001','withdrawn claim cannot be selected');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('a')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('a'),'role','authenticated')::text,true);
set local role authenticated;
insert into phase2_snapshot values('original_claim',to_jsonb(public.create_claim(pg_temp.phase2_id('open'))));
update phase2_fixture set id=(select (payload->>'id')::uuid from phase2_snapshot where name='original_claim') where name='claim_a';
select pg_temp.phase2_assert((select count(*) from public.claims where gig_id=pg_temp.phase2_id('open') and provider_id=pg_temp.phase2_id('a'))=1,'new eligible claim creates one row');
select pg_temp.phase2_assert((select state='pending' from public.claims where id=pg_temp.phase2_id('claim_a')),'new claim is pending');
select pg_temp.phase2_assert(to_jsonb(public.create_claim(pg_temp.phase2_id('open')))=(select payload from phase2_snapshot where name='original_claim'),'pending retry preserves entire claim 1');
select pg_temp.phase2_assert(to_jsonb(public.create_claim(pg_temp.phase2_id('open')))=(select payload from phase2_snapshot where name='original_claim'),'pending retry preserves entire claim 2');
select pg_temp.phase2_assert(to_jsonb(public.create_claim(pg_temp.phase2_id('open')))=(select payload from phase2_snapshot where name='original_claim'),'pending retry preserves entire claim 3');
select pg_temp.phase2_assert(to_jsonb(public.create_claim(pg_temp.phase2_id('open')))=(select payload from phase2_snapshot where name='original_claim'),'pending retry preserves entire claim 4');
select pg_temp.phase2_assert((select count(*) from public.claims where gig_id=pg_temp.phase2_id('open') and provider_id=pg_temp.phase2_id('a'))=1,'pending retries do not duplicate rows');
select pg_temp.phase2_assert((public.create_claim(pg_temp.phase2_id('rejected'))).state='rejected','rejected claim remains rejected on reclaim');
select pg_temp.phase2_assert((public.create_claim(pg_temp.phase2_id('withdrawn'))).state='withdrawn','withdrawn claim remains withdrawn on reclaim');
select pg_temp.phase2_expect_error('select public.create_claim(pg_temp.phase2_id(''closed''))','P0001','new claim on completed gig rejected','Gig is not open for claims');
select pg_temp.phase2_expect_error('select public.create_claim(pg_temp.phase2_id(''draft''))','P0001','new claim on draft rejected');
reset role;
select pg_temp.phase2_assert((select count(*) from public.notifications where gig_id=pg_temp.phase2_id('open') and type='claim_received')=1,'pending retries emit only one claim notification');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('b')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('b'),'role','authenticated')::text,true);
set local role authenticated;
insert into phase2_snapshot values('second_claim',to_jsonb(public.create_claim(pg_temp.phase2_id('open'))));
update phase2_fixture set id=(select (payload->>'id')::uuid from phase2_snapshot where name='second_claim') where name='claim_b';
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('poster')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('poster'),'role','authenticated')::text,true);
set local role authenticated;
select public.select_provider(pg_temp.phase2_id('open'),pg_temp.phase2_id('claim_a'));
select pg_temp.phase2_assert((select selected_provider_id=pg_temp.phase2_id('a') and status='active' and start_requested_at is null and start_approved_at is null from public.gigs where id=pg_temp.phase2_id('open')),'initial selection sets provider and preserves timestamps/status');
select pg_temp.phase2_assert((select state='selected' from public.claims where id=pg_temp.phase2_id('claim_a')),'correct claim becomes selected');
select pg_temp.phase2_assert((select state='pending' from public.claims where id=pg_temp.phase2_id('claim_b')),'other claim is not selected');
select pg_temp.phase2_expect_error('select public.select_provider(pg_temp.phase2_id(''open''),pg_temp.phase2_id(''claim_a''))','P0001','same-provider retry returns controlled error','Provider already selected');
select pg_temp.phase2_expect_error('select public.select_provider(pg_temp.phase2_id(''open''),pg_temp.phase2_id(''claim_b''))','P0001','different provider cannot replace selection','Provider already selected');
select pg_temp.phase2_assert((select selected_provider_id=pg_temp.phase2_id('a') from public.gigs where id=pg_temp.phase2_id('open')),'retry leaves original provider selected');
select pg_temp.phase2_assert((select count(*) from public.claims where gig_id=pg_temp.phase2_id('open') and state='selected')=1,'only one selected claim after competing retries');
select pg_temp.phase2_assert((select state='pending' from public.claims where id=pg_temp.phase2_id('claim_b')),'failed replacement leaves second claimant unchanged');
reset role;
select pg_temp.phase2_assert((select count(*) from public.notifications where gig_id=pg_temp.phase2_id('open') and type='selected')=1,'selection retries do not duplicate notifications');
select pg_temp.phase2_expect_error('update public.claims set state=''selected'' where id=pg_temp.phase2_id(''claim_b'')','23505','unique index prevents a second selected claim even for trusted writers');
select pg_temp.phase2_assert((select count(*) from public.claims where gig_id=pg_temp.phase2_id('open') and state='selected')=1,'failed invariant violation rolls back second selected state');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('a')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('a'),'role','authenticated')::text,true);
set local role authenticated;
insert into phase2_snapshot values('selected_claim',to_jsonb(public.create_claim(pg_temp.phase2_id('open'))));
select pg_temp.phase2_assert((public.create_claim(pg_temp.phase2_id('open'))).state='selected','selected-provider retry cannot reset state');
select pg_temp.phase2_assert(to_jsonb(public.create_claim(pg_temp.phase2_id('open')))=(select payload from phase2_snapshot where name='selected_claim'),'selected retry preserves id/timestamp/state');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('b')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('b'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.phase2_assert(to_jsonb(public.create_claim(pg_temp.phase2_id('open')))=(select payload from phase2_snapshot where name='second_claim'),'existing pending retry after selection is unchanged');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('outsider')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('outsider'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.phase2_expect_error('select public.create_claim(pg_temp.phase2_id(''open''))','P0001','new claimant cannot claim after provider selection','Gig is not open for claims');
reset role;
select pg_temp.phase2_assert((select count(*) from public.claims where gig_id=pg_temp.phase2_id('open'))=2,'selection closes new claims without creating extra rows');
select pg_temp.phase2_assert((select count(*) from public.notifications where gig_id=pg_temp.phase2_id('open') and type='claim_received')=2,'selected/pending retries create no extra claim notifications');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('poster')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('poster'),'role','authenticated')::text,true);
set local role authenticated;
select public.select_provider(pg_temp.phase2_id('reverse'),pg_temp.phase2_id('reverse_b'));
select pg_temp.phase2_expect_error('select public.select_provider(pg_temp.phase2_id(''reverse''),pg_temp.phase2_id(''reverse_a''))','P0001','reverse competing selection order rejects replacement','Provider already selected');
select pg_temp.phase2_assert((select selected_provider_id=pg_temp.phase2_id('b') from public.gigs where id=pg_temp.phase2_id('reverse')),'first committed selection wins in reverse ordering');
select pg_temp.phase2_assert((select count(*) from public.claims where gig_id=pg_temp.phase2_id('reverse') and state='selected')=1,'reverse retry ordering still has one selected claim');
reset role;
update public.gigs set status='in_progress',start_requested_at=now(),start_approved_at=now() where id=pg_temp.phase2_id('open');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('a')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('a'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.phase2_assert((public.create_claim(pg_temp.phase2_id('open'))).state='selected','progressed-gig selected retry is read-only');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('poster')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('poster'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.phase2_expect_error('select public.select_provider(pg_temp.phase2_id(''open''),pg_temp.phase2_id(''claim_a''))','P0001','selection retry after start cannot change lifecycle state','Provider already selected');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('poster')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('poster'),'role','authenticated')::text,true);
set local role authenticated;
select public.submit_feedback(pg_temp.phase2_id('fb_wom'),'wom');
select pg_temp.phase2_assert((select count(*) from public.feedback where gig_id=pg_temp.phase2_id('fb_wom') and from_id=pg_temp.phase2_id('poster'))=1,'first WOM creates one feedback row');
insert into phase2_snapshot values('feedback_wom',(select to_jsonb(x) from public.feedback x where gig_id=pg_temp.phase2_id('fb_wom') and from_id=pg_temp.phase2_id('poster')));
select public.submit_feedback(pg_temp.phase2_id('fb_wom'),'wom');
select public.submit_feedback(pg_temp.phase2_id('fb_wom'),'wom');
select public.submit_feedback(pg_temp.phase2_id('fb_wom'),'wom');
select public.submit_feedback(pg_temp.phase2_id('fb_wom'),'lemon');
select pg_temp.phase2_assert((select to_jsonb(x) from public.feedback x where gig_id=pg_temp.phase2_id('fb_wom') and from_id=pg_temp.phase2_id('poster'))=(select payload from phase2_snapshot where name='feedback_wom'),'opposite feedback retry preserves original entire record');
reset role;
select pg_temp.phase2_assert((select wom_count=1 and lemon_count=0 from public.profiles where id=pg_temp.phase2_id('a')),'WOM increments exactly once; opposite retry never increments Lemon');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('poster')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('poster'),'role','authenticated')::text,true);
set local role authenticated;
select public.submit_feedback(pg_temp.phase2_id('fb_lemon'),'lemon');
select public.submit_feedback(pg_temp.phase2_id('fb_lemon'),'lemon');
select public.submit_feedback(pg_temp.phase2_id('fb_lemon'),'wom');
select pg_temp.phase2_assert((select count(*)=1 and bool_and(type='lemon') from public.feedback where gig_id=pg_temp.phase2_id('fb_lemon')),'Lemon retries retain one original Lemon');
reset role;
select pg_temp.phase2_assert((select wom_count=1 and lemon_count=1 from public.profiles where id=pg_temp.phase2_id('a')),'Lemon increments once and opposite retry cannot add WOM');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('poster')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('poster'),'role','authenticated')::text,true);
set local role authenticated;
select public.submit_feedback(pg_temp.phase2_id('fb_skip'),'skip');
select public.submit_feedback(pg_temp.phase2_id('fb_skip'),'wom');
select public.submit_feedback(pg_temp.phase2_id('fb_skip'),'lemon');
select pg_temp.phase2_assert((select count(*)=1 and bool_and(type='skip') from public.feedback where gig_id=pg_temp.phase2_id('fb_skip')),'skip is immutable and retries cannot replace it');
reset role;
select pg_temp.phase2_assert((select wom_count=1 and lemon_count=1 from public.profiles where id=pg_temp.phase2_id('a')),'skip retries never change counters');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('a')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('a'),'role','authenticated')::text,true);
set local role authenticated;
select public.submit_feedback(pg_temp.phase2_id('fb_wom'),'lemon');
select public.submit_feedback(pg_temp.phase2_id('fb_wom'),'wom');
reset role;
select pg_temp.phase2_assert((select wom_count=0 and lemon_count=1 from public.profiles where id=pg_temp.phase2_id('poster')),'provider feedback increments correct recipient once');
select pg_temp.phase2_assert((select count(*) from public.feedback where gig_id=pg_temp.phase2_id('fb_wom'))=2,'each participant retains one independent feedback record');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('poster')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('poster'),'role','authenticated')::text,true);
set local role authenticated;
select public.submit_feedback(pg_temp.phase2_id('fb_incomplete'),'wom');
select public.submit_feedback(pg_temp.phase2_id('fb_incomplete'),'wom');
select pg_temp.phase2_expect_error('select public.submit_feedback(pg_temp.phase2_id(''fb_unresolved''),''wom'')','P0001','feedback remains blocked before resolution','Gig is not resolved yet');
reset role;
select set_config('request.jwt.claim.sub',pg_temp.phase2_id('b')::text,true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.phase2_id('b'),'role','authenticated')::text,true);
set local role authenticated;
select pg_temp.phase2_expect_error('select public.submit_feedback(pg_temp.phase2_id(''fb_wom''),''wom'')','42501','unselected nonparticipant feedback denied');
reset role;
select pg_temp.phase2_assert((select wom_count=2 and lemon_count=1 from public.profiles where id=pg_temp.phase2_id('a')),'incomplete-gig feedback remains valid and idempotent');
select pg_temp.phase2_assert((select wom_count=2 from public.public_profiles where id=pg_temp.phase2_id('a')),'trusted feedback counters still synchronize to public profile');
select pg_temp.phase2_assert((select count(*) from public.feedback where gig_id=pg_temp.phase2_id('fb_unresolved'))=0,'failed unresolved feedback creates no record');
select pg_temp.phase2_assert(has_function_privilege('authenticated','public.create_claim(uuid)','EXECUTE') and not has_function_privilege('anon','public.create_claim(uuid)','EXECUTE'),'Phase 1 execution boundary retained for create_claim');
select pg_temp.phase2_assert(has_function_privilege('authenticated','public.select_provider(uuid,uuid)','EXECUTE') and not has_function_privilege('anon','public.select_provider(uuid,uuid)','EXECUTE'),'Phase 1 execution boundary retained for select_provider');
select pg_temp.phase2_assert(has_function_privilege('authenticated','public.submit_feedback(uuid,public.feedback_type)','EXECUTE') and not has_function_privilege('anon','public.submit_feedback(uuid,public.feedback_type)','EXECUTE'),'Phase 1 execution boundary retained for submit_feedback');
select pg_temp.phase2_assert(not has_function_privilege('authenticated','public.notify(uuid,uuid,text,text)','EXECUTE') and not has_schema_privilege('anon','esg_private','USAGE'),'Phase 1 internal/private helper boundaries retained');
rollback;
