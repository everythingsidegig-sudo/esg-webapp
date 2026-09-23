-- Gig Tags regression suite.
-- Run only against an isolated Supabase test database after 0001 through 0006.
-- All fixtures and temporary assertions roll back; no extensions required.
-- Run as postgres (or an equivalent trusted migration role), with errors fatal.
begin;

create temporary table gt_fixture (name text primary key, id uuid);
insert into gt_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['poster', 'provider', 'retry_request']) as n(name);
insert into gt_fixture (name) select unnest(array['gig', 'dup_gig', 'notag_gig', 'retry_gig', 'draft_gig']);
grant select, update on gt_fixture to anon, authenticated;

create function pg_temp.gt_id(p_name text) returns uuid
language sql stable as $$
  select id from pg_temp.gt_fixture where name = p_name;
$$;
create function pg_temp.gt_tag(p_category text, p_name text) returns uuid
language sql stable as $$
  select id from public.tags where service_type = p_category and name = p_name;
$$;
create function pg_temp.gt_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.gt_denied(p_sql text, p_label text) returns void
language plpgsql security invoker as $$
begin
  begin
    execute p_sql;
  exception when insufficient_privilege then
    raise notice 'PASS: %', p_label; return;
  end;
  raise exception 'FAIL (expected permission/authorization denial): %', p_label;
end;
$$;
create function pg_temp.gt_error(p_sql text, p_code text, p_label text) returns void
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
-- Thin wrapper mirroring onboarding_post_gig.sql's pg_temp.post helper, so
-- tag-focused calls don't need deeply nested single-quote escaping.
create function pg_temp.gt_create(p_request uuid, p_service text default 'Cleaning', p_tags uuid[] default '{}'::uuid[])
returns public.gigs language sql security invoker as $$
  select public.create_gig(p_request, p_service, 'Tag test gig', 'Tag test description', 25, 'fixed',
    now() + interval '1 day', 'Test area', 12.34, -56.78, null, true, p_tags);
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
select id, 'authenticated', 'authenticated', 'gt-' || id::text || '@example.invalid',
  jsonb_build_object('username', case name when 'poster' then 'PosterTags' else 'ProviderTags' end), now(), now()
from gt_fixture where name in ('poster', 'provider');

reset role;
select set_config('request.jwt.claim.sub', pg_temp.gt_id('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.gt_id('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.save_onboarding('PosterTags', null, 'Test private area', 12.34, -56.78, '["Cleaning"]', '["Other"]');

-- ---------------------------------------------------------------------------
-- 1. Valid multiple tags.
-- ---------------------------------------------------------------------------
update gt_fixture set id = (pg_temp.gt_create(
  gen_random_uuid(), 'Cleaning',
  array[pg_temp.gt_tag('Cleaning','Deep Cleaning'), pg_temp.gt_tag('Cleaning','Kitchen')]::uuid[]
)).id where name = 'gig';
select pg_temp.gt_assert((select count(*) = 2 from public.gig_tags where gig_id = pg_temp.gt_id('gig')), 'valid multi-tag creation stores both tags');
select pg_temp.gt_assert(
  (select pg_catalog.array_agg(t.name order by t.name) from public.gig_tags gt join public.tags t on t.id = gt.tag_id where gt.gig_id = pg_temp.gt_id('gig'))
    = array['Deep Cleaning','Kitchen'],
  'stored tags match the selected names'
);

-- ---------------------------------------------------------------------------
-- 2. Duplicate tag ids are silently deduplicated (approved decision).
-- ---------------------------------------------------------------------------
update gt_fixture set id = (pg_temp.gt_create(
  gen_random_uuid(), 'Cleaning',
  array[pg_temp.gt_tag('Cleaning','Bathroom'), pg_temp.gt_tag('Cleaning','Bathroom')]::uuid[]
)).id where name = 'dup_gig';
select pg_temp.gt_assert((select count(*) from public.gig_tags where gig_id = pg_temp.gt_id('dup_gig')) = 1, 'duplicate tag ids in the input collapse to one stored row');

-- ---------------------------------------------------------------------------
-- 3. Tag/category mismatch and nonexistent tag ids are rejected.
-- ---------------------------------------------------------------------------
select pg_temp.gt_error(
  pg_catalog.format('select pg_temp.gt_create(gen_random_uuid(), ''Cleaning'', array[%L]::uuid[])', pg_temp.gt_tag('Yard Work','Lawn Mowing')),
  '22023', 'tag from a different category is rejected'
);
select pg_temp.gt_error(
  'select pg_temp.gt_create(gen_random_uuid(), ''Cleaning'', array[gen_random_uuid()]::uuid[])',
  '22023', 'nonexistent tag id is rejected'
);

-- ---------------------------------------------------------------------------
-- 4. Maximum tag count (8) is enforced. Distinct fake ids are enough: the
-- count check runs before existence/category validation.
-- ---------------------------------------------------------------------------
select pg_temp.gt_error(
  'select pg_temp.gt_create(gen_random_uuid(), ''Cleaning'', array(select gen_random_uuid() from pg_catalog.generate_series(1,9)))',
  '22023', 'more than 8 tags is rejected'
);
update gt_fixture set id = (pg_temp.gt_create(
  gen_random_uuid(), 'Handyman',
  array[pg_temp.gt_tag('Handyman','Furniture Assembly'), pg_temp.gt_tag('Handyman','Repairs'), pg_temp.gt_tag('Handyman','Mounting/Hanging'),
        pg_temp.gt_tag('Handyman','Painting'), pg_temp.gt_tag('Handyman','Plumbing'), pg_temp.gt_tag('Handyman','Electrical')]::uuid[]
)).id where name = 'draft_gig';
select pg_temp.gt_assert((select count(*) from public.gig_tags where gig_id = pg_temp.gt_id('draft_gig')) = 6, 'exactly-at-catalog-size selection (below the cap) succeeds');

-- ---------------------------------------------------------------------------
-- 5. Backward compatibility: omitting tags entirely still works.
-- ---------------------------------------------------------------------------
update gt_fixture set id = (public.create_gig(gen_random_uuid(), 'Cleaning', 'No tags gig', 'Description', 10, 'fixed',
  now() + interval '1 day', 'Test area', null, null)).id where name = 'notag_gig';
select pg_temp.gt_assert((select status = 'active' from public.gigs where id = pg_temp.gt_id('notag_gig')), 'gig created without tags still works normally');
select pg_temp.gt_assert((select count(*) from public.gig_tags where gig_id = pg_temp.gt_id('notag_gig')) = 0, 'omitting tags creates zero gig_tags rows (existing-gig shape)');

-- ---------------------------------------------------------------------------
-- 6. create_gig()'s retry-by-request-id idempotency does not duplicate gig_tags.
-- ---------------------------------------------------------------------------
update gt_fixture set id = (pg_temp.gt_create(
  pg_temp.gt_id('retry_request'), 'Cleaning',
  array[pg_temp.gt_tag('Cleaning','Apartment'), pg_temp.gt_tag('Cleaning','Move-out')]::uuid[]
)).id where name = 'retry_gig';
select pg_temp.gt_assert((select count(*) from public.gig_tags where gig_id = pg_temp.gt_id('retry_gig')) = 2, 'first creation stores both tags');
select pg_temp.gt_assert(
  (select id from pg_temp.gt_create(pg_temp.gt_id('retry_request'), 'Cleaning',
    array[pg_temp.gt_tag('Cleaning','Apartment'), pg_temp.gt_tag('Cleaning','Move-out')]::uuid[])) = pg_temp.gt_id('retry_gig'),
  'retry with the same request id returns the original gig'
);
select pg_temp.gt_assert((select count(*) from public.gigs where creation_request_id = pg_temp.gt_id('retry_request')) = 1, 'retry never duplicates the gig row');
select pg_temp.gt_assert((select count(*) from public.gig_tags where gig_id = pg_temp.gt_id('retry_gig')) = 2, 'retry never duplicates gig_tags rows');

-- ---------------------------------------------------------------------------
-- 7. Direct writes to the catalog and junction table are denied.
-- ---------------------------------------------------------------------------
select pg_temp.gt_denied('insert into public.tags (service_type, name) values (''Cleaning'',''Hacked Tag'')', 'authenticated cannot insert an arbitrary catalog tag');
select pg_temp.gt_denied('update public.tags set name=''Hacked'' where service_type=''Cleaning'' and name=''Kitchen''', 'authenticated cannot rewrite a catalog tag name');
select pg_temp.gt_denied('delete from public.tags where service_type=''Cleaning''', 'authenticated cannot delete catalog tags');
select pg_temp.gt_denied(
  pg_catalog.format('insert into public.gig_tags (gig_id, tag_id) values (%L, %L)', pg_temp.gt_id('gig'), pg_temp.gt_tag('Cleaning','Apartment')),
  'authenticated cannot directly attach a tag to a gig, bypassing create_gig validation'
);
select pg_temp.gt_denied(
  pg_catalog.format('delete from public.gig_tags where gig_id = %L', pg_temp.gt_id('gig')),
  'authenticated cannot directly remove a gig''s tags'
);
select pg_temp.gt_assert(
  not has_table_privilege('authenticated', 'public.tags', 'INSERT')
  and not has_table_privilege('authenticated', 'public.tags', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.tags', 'DELETE')
  and not has_table_privilege('authenticated', 'public.gig_tags', 'INSERT')
  and not has_table_privilege('authenticated', 'public.gig_tags', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.gig_tags', 'DELETE'),
  'tags and gig_tags have no client write grant at all'
);

-- ---------------------------------------------------------------------------
-- 8. Phase 2C's gigs direct-write protections remain intact under 0006.
-- ---------------------------------------------------------------------------
select pg_temp.gt_denied(pg_catalog.format('update public.gigs set amount=999999 where id=%L', pg_temp.gt_id('gig')), 'Phase 2C: poster still cannot directly rewrite gig amount');
select pg_temp.gt_denied(pg_catalog.format('update public.gigs set service_type=%L where id=%L', 'Other', pg_temp.gt_id('gig')), 'Phase 2C: poster still cannot directly rewrite service_type');
select pg_temp.gt_denied(pg_catalog.format('update public.gigs set status=%L where id=%L', 'cancelled', pg_temp.gt_id('gig')), 'Phase 2C: poster still cannot directly rewrite status');

-- ---------------------------------------------------------------------------
-- 9. gig_tags visibility mirrors gig visibility (draft gig's tags are private).
-- ---------------------------------------------------------------------------
reset role;
update public.gigs set status = 'draft' where id = pg_temp.gt_id('draft_gig');
select pg_temp.gt_assert((select count(*) from public.gig_tags where gig_id = pg_temp.gt_id('draft_gig')) = 6, 'trusted role still sees a draft gig''s tags');
set local role anon;
select pg_temp.gt_assert((select count(*) from public.gig_tags where gig_id = pg_temp.gt_id('draft_gig')) = 0, 'anonymous cannot see an unpublished draft''s tags');
select pg_temp.gt_assert((select count(*) from public.gig_tags where gig_id = pg_temp.gt_id('gig')) = 2, 'anonymous can see an active gig''s tags');
select pg_temp.gt_assert((select count(*) > 30 from public.tags), 'anonymous can read the public tag catalog');

-- ---------------------------------------------------------------------------
-- 10. Existing lifecycle RPCs still work end-to-end on a tagged gig.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', pg_temp.gt_id('provider')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.gt_id('provider'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.create_claim(pg_temp.gt_id('gig'));

reset role;
select set_config('request.jwt.claim.sub', pg_temp.gt_id('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.gt_id('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.select_provider(pg_temp.gt_id('gig'), (select id from public.claims where gig_id = pg_temp.gt_id('gig') and provider_id = pg_temp.gt_id('provider')));

reset role;
select set_config('request.jwt.claim.sub', pg_temp.gt_id('provider')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.gt_id('provider'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.request_start(pg_temp.gt_id('gig'));

reset role;
select set_config('request.jwt.claim.sub', pg_temp.gt_id('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.gt_id('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.approve_start(pg_temp.gt_id('gig'));
select public.submit_completion(pg_temp.gt_id('gig'), 'complete');

reset role;
select set_config('request.jwt.claim.sub', pg_temp.gt_id('provider')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.gt_id('provider'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.submit_completion(pg_temp.gt_id('gig'), 'complete');
select public.submit_payment_amount(pg_temp.gt_id('gig'), 25);

reset role;
select set_config('request.jwt.claim.sub', pg_temp.gt_id('poster')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.gt_id('poster'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.submit_payment_amount(pg_temp.gt_id('gig'), 25);
select pg_temp.gt_assert((select status = 'completed' from public.gigs where id = pg_temp.gt_id('gig')), 'full lifecycle RPC chain still resolves a tagged gig to completed');
select pg_temp.gt_assert((select count(*) from public.gig_tags where gig_id = pg_temp.gt_id('gig')) = 2, 'a gig''s tags survive its full lifecycle unchanged');

reset role;
rollback;
