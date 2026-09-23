-- Find a Helper MVP: profile_tags regression suite.
-- Run only against an isolated Supabase test database after 0001 through 0007.
-- All fixtures and temporary assertions roll back; no extensions required.
-- Run as postgres (or an equivalent trusted migration role), with errors fatal.
begin;

create temporary table pt_fixture (name text primary key, id uuid);
insert into pt_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['helper', 'other']) as n(name);
grant select, update on pt_fixture to anon, authenticated;

create function pg_temp.pt_id(p_name text) returns uuid
language sql stable as $$
  select id from pg_temp.pt_fixture where name = p_name;
$$;
create function pg_temp.pt_tag(p_category text, p_name text) returns uuid
language sql stable as $$
  select id from public.tags where service_type = p_category and name = p_name;
$$;
create function pg_temp.pt_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.pt_denied(p_sql text, p_label text) returns void
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
create function pg_temp.pt_error(p_sql text, p_code text, p_label text) returns void
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
select id, 'authenticated', 'authenticated', 'pt-' || id::text || '@example.invalid',
  jsonb_build_object('username', case name when 'helper' then 'HelperTags' else 'OtherTags' end), now(), now()
from pt_fixture where name in ('helper', 'other');

reset role;
select set_config('request.jwt.claim.sub', pg_temp.pt_id('helper')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.pt_id('helper'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.save_onboarding('HelperTags', null, 'Test private area', 12.34, -56.78, '["Cleaning","Handyman"]', '[]');

-- ---------------------------------------------------------------------------
-- 1. set_helper_tags() validation.
-- ---------------------------------------------------------------------------
select pg_temp.pt_error('select public.set_helper_tags(''Not A Category'', array[]::uuid[])', '22023', 'invalid category rejected');
select pg_temp.pt_error('select public.set_helper_tags(''Delivery'', array[]::uuid[])', '22023', 'category not in the caller''s skills rejected');
select pg_temp.pt_error(
  'select public.set_helper_tags(''Cleaning'', array[gen_random_uuid()])', '22023', 'nonexistent tag id rejected'
);
select pg_temp.pt_error(
  pg_catalog.format('select public.set_helper_tags(''Cleaning'', array[%L]::uuid[])', pg_temp.pt_tag('Handyman', 'Plumbing')),
  '22023', 'tag from a different category is rejected'
);
select pg_temp.pt_error(
  'select public.set_helper_tags(''Cleaning'', array(select gen_random_uuid() from pg_catalog.generate_series(1,9)))',
  '22023', 'more than 8 tags is rejected'
);
select pg_temp.pt_assert((select count(*) from public.profile_tags where profile_id = pg_temp.pt_id('helper')) = 0, 'no rejected call left a partial change');

-- ---------------------------------------------------------------------------
-- 2. Valid multi-tag save, duplicate ids deduplicated.
-- ---------------------------------------------------------------------------
select public.set_helper_tags('Cleaning', array[
  pg_temp.pt_tag('Cleaning', 'Deep Cleaning'), pg_temp.pt_tag('Cleaning', 'Kitchen'), pg_temp.pt_tag('Cleaning', 'Kitchen')
]);
select pg_temp.pt_assert((select count(*) from public.profile_tags where profile_id = pg_temp.pt_id('helper')) = 2, 'valid save stores deduplicated tags (2, not 3)');
select pg_temp.pt_assert(
  (select pg_catalog.array_agg(t.name order by t.name) from public.profile_tags pt join public.tags t on t.id = pt.tag_id where pt.profile_id = pg_temp.pt_id('helper'))
    = array['Deep Cleaning','Kitchen'],
  'stored tags match the selected names'
);

-- ---------------------------------------------------------------------------
-- 3. Saving a second category does not touch the first category's tags.
-- ---------------------------------------------------------------------------
select public.set_helper_tags('Handyman', array[pg_temp.pt_tag('Handyman', 'Plumbing'), pg_temp.pt_tag('Handyman', 'Electrical')]);
select pg_temp.pt_assert((select count(*) from public.profile_tags where profile_id = pg_temp.pt_id('helper')) = 4, 'a second category adds to, not replaces, the first');
select pg_temp.pt_assert(
  (select count(*) from public.profile_tags pt join public.tags t on t.id = pt.tag_id where pt.profile_id = pg_temp.pt_id('helper') and t.service_type = 'Cleaning') = 2,
  'Cleaning tags remain intact after saving Handyman tags'
);

-- ---------------------------------------------------------------------------
-- 4. Re-saving the same category replaces (not unions) its own tags only.
-- ---------------------------------------------------------------------------
select public.set_helper_tags('Cleaning', array[pg_temp.pt_tag('Cleaning', 'Bathroom')]);
select pg_temp.pt_assert(
  (select pg_catalog.array_agg(t.name) from public.profile_tags pt join public.tags t on t.id = pt.tag_id where pt.profile_id = pg_temp.pt_id('helper') and t.service_type = 'Cleaning')
    = array['Bathroom'],
  'resaving a category fully replaces its previous tags'
);
select pg_temp.pt_assert(
  (select count(*) from public.profile_tags pt join public.tags t on t.id = pt.tag_id where pt.profile_id = pg_temp.pt_id('helper') and t.service_type = 'Handyman') = 2,
  'resaving Cleaning leaves Handyman tags untouched'
);

-- ---------------------------------------------------------------------------
-- 5. Direct writes to profile_tags are denied; catalog matching semantics
--    the frontend relies on (skills containment) behave as expected.
-- ---------------------------------------------------------------------------
select pg_temp.pt_denied(
  pg_catalog.format('insert into public.profile_tags (profile_id, tag_id) values (%L, %L)', pg_temp.pt_id('helper'), pg_temp.pt_tag('Cleaning', 'Apartment')),
  'authenticated cannot directly attach a tag to a profile, bypassing set_helper_tags validation'
);
select pg_temp.pt_denied(
  pg_catalog.format('update public.profile_tags set tag_id = %L where profile_id = %L', pg_temp.pt_tag('Cleaning', 'Apartment'), pg_temp.pt_id('helper')),
  'authenticated cannot directly rewrite a profile_tags row'
);
select pg_temp.pt_denied(
  pg_catalog.format('delete from public.profile_tags where profile_id = %L', pg_temp.pt_id('helper')),
  'authenticated cannot directly delete a profile''s tags'
);
select pg_temp.pt_assert(
  not has_table_privilege('authenticated', 'public.profile_tags', 'INSERT')
  and not has_table_privilege('authenticated', 'public.profile_tags', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.profile_tags', 'DELETE'),
  'profile_tags has no client write grant at all'
);
select pg_temp.pt_assert(
  (select skills ? 'Cleaning' from public.public_profiles where id = pg_temp.pt_id('helper')),
  'the containment check Find a Helper uses (skills ? category) matches this profile'
);

-- ---------------------------------------------------------------------------
-- 6. Public read: anon can see profile_tags and the catalog, and a legacy
--    profile (skills present, zero profile_tags rows) remains matchable.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', pg_temp.pt_id('other')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.pt_id('other'), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.save_onboarding('OtherTags', null, 'Other private area', null, null, '["Cleaning"]', '[]');
select pg_temp.pt_assert(
  (select skills ? 'Cleaning' from public.public_profiles where id = pg_temp.pt_id('other')),
  'legacy-style profile (skills set, never called set_helper_tags) still matches the category filter'
);
select pg_temp.pt_assert((select count(*) from public.profile_tags where profile_id = pg_temp.pt_id('other')) = 0, 'legacy-style profile has zero profile_tags rows');

reset role;
set local role anon;
select pg_temp.pt_assert((select count(*) from public.profile_tags where profile_id = pg_temp.pt_id('helper')) = 3, 'anonymous can read another profile''s specialization tags');
select pg_temp.pt_assert((select count(*) > 30 from public.tags), 'anonymous can read the shared tag catalog');
select pg_temp.pt_assert((select skills ? 'Cleaning' from public.public_profiles where id = pg_temp.pt_id('helper')), 'anonymous can evaluate the category-match condition');

-- ---------------------------------------------------------------------------
-- 7. Phase 2C / gig_tags protections remain intact under 0007.
-- ---------------------------------------------------------------------------
select pg_temp.pt_assert(not has_table_privilege('authenticated', 'public.gigs', 'UPDATE'), 'Phase 2C: gigs UPDATE grant still revoked');
select pg_temp.pt_assert(not has_table_privilege('authenticated', 'public.tags', 'INSERT'), 'gig tags catalog still has no client write grant');

reset role;
rollback;
