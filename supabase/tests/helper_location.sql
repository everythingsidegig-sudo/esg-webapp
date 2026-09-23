-- Find a Helper: distance filtering regression suite.
-- Run only against an isolated Supabase test database after 0001 through 0008.
-- All fixtures and temporary assertions roll back; no extensions required.
-- Run as postgres (or an equivalent trusted migration role), with errors fatal.
begin;

create temporary table hl_fixture (name text primary key, id uuid);
insert into hl_fixture (name, id)
select name, gen_random_uuid()
from unnest(array['helper']) as n(name);
grant select, update on hl_fixture to anon, authenticated;

create function pg_temp.hl_id(p_name text) returns uuid
language sql stable as $$
  select id from pg_temp.hl_fixture where name = p_name;
$$;
create function pg_temp.hl_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.hl_denied(p_sql text, p_label text) returns void
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
create function pg_temp.hl_error(p_sql text, p_code text, p_label text) returns void
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
select id, 'authenticated', 'authenticated', 'hl-' || id::text || '@example.invalid',
  jsonb_build_object('username', 'HelperLoc'), now(), now()
from hl_fixture where name = 'helper';

reset role;
select set_config('request.jwt.claim.sub', pg_temp.hl_id('helper')::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.hl_id('helper'), 'role', 'authenticated')::text, true);
set local role authenticated;
-- Onboard with a PRIVATE address, distinct from any helper location, to prove
-- the two are never conflated.
select public.save_onboarding('HelperLoc', null, '123 Private Street', 40.712776, -74.005974, '["Cleaning"]', '[]');

-- ---------------------------------------------------------------------------
-- 1. Private coordinates are never copied, exposed, or used by this feature.
-- ---------------------------------------------------------------------------
select pg_temp.hl_assert(
  (select public_lat is null and public_lng is null and public_location_text is null from public.public_profiles where id = pg_temp.hl_id('helper')),
  'public_profiles.public_lat/lng stay null after onboarding alone; the private address is never auto-copied'
);
select pg_temp.hl_assert(
  (select private_lat = 40.712776 and private_lng = -74.005974 from public.profiles where id = pg_temp.hl_id('helper')),
  'private coordinates remain exactly what save_onboarding stored (full precision, never rounded), untouched by this migration'
);

-- ---------------------------------------------------------------------------
-- 2. set_helper_location() validation.
-- ---------------------------------------------------------------------------
select pg_temp.hl_error('select public.set_helper_location('' '', null, null)', '22023', 'blank location text rejected');
select pg_temp.hl_error(pg_catalog.format('select public.set_helper_location(%L, null, null)', pg_catalog.repeat('x', 201)), '22023', 'oversized location text rejected');
select pg_temp.hl_error('select public.set_helper_location(''Area'', 91, 0)', '22023', 'out-of-range latitude rejected');
select pg_temp.hl_error('select public.set_helper_location(''Area'', 0, 181)', '22023', 'out-of-range longitude rejected');
select pg_temp.hl_error('select public.set_helper_location(''Area'', 12.34, null)', '22023', 'unpaired coordinates rejected (lat without lng)');
select pg_temp.hl_error('select public.set_helper_location(''Area'', null, -56.78)', '22023', 'unpaired coordinates rejected (lng without lat)');
select pg_temp.hl_assert(
  (select public_lat is null and public_lng is null and public_location_text is null from public.profiles where id = pg_temp.hl_id('helper')),
  'no rejected call left a partial helper location'
);

-- ---------------------------------------------------------------------------
-- 3. Opt-in: valid save rounds coordinates to the same precision create_gig() uses.
-- ---------------------------------------------------------------------------
select public.set_helper_location('  Downtown Area  ', 40.7127837, -74.0059413);
select pg_temp.hl_assert(
  (select public_location_text = 'Downtown Area' and public_lat = 40.71 and public_lng = -74.01 from public.profiles where id = pg_temp.hl_id('helper')),
  'saved location is trimmed and rounded to 2 decimals (~1.1km precision), matching gig coordinate rounding'
);
select pg_temp.hl_assert(
  (select public_location_text = 'Downtown Area' and public_lat = 40.71 and public_lng = -74.01 from public.public_profiles where id = pg_temp.hl_id('helper')),
  'the public mirror is kept in sync by the existing trigger'
);
select pg_temp.hl_assert(
  (select private_lat = 40.712776 and private_lng = -74.005974 and private_location_text = '123 Private Street' from public.profiles where id = pg_temp.hl_id('helper')),
  'opting in to helper location does not alter the private onboarding address'
);

-- Location text without coordinates (manual area, no geolocation) is valid,
-- mirroring save_onboarding's own optional-coordinate behavior.
select public.set_helper_location('Manual area only', null, null);
select pg_temp.hl_assert(
  (select public_location_text = 'Manual area only' and public_lat is null and public_lng is null from public.profiles where id = pg_temp.hl_id('helper')),
  'text-only helper location (no coordinates) is accepted, matching save_onboarding''s own pattern'
);

-- ---------------------------------------------------------------------------
-- 4. Opt-out: clearing removes the location entirely.
-- ---------------------------------------------------------------------------
select public.set_helper_location('Downtown Area', 40.7127837, -74.0059413);
select public.set_helper_location(null, null, null);
select pg_temp.hl_assert(
  (select public_location_text is null and public_lat is null and public_lng is null from public.profiles where id = pg_temp.hl_id('helper')),
  'clearing (all three null) opts out and removes the stored location'
);
select pg_temp.hl_assert(
  (select public_location_text is null and public_lat is null and public_lng is null from public.public_profiles where id = pg_temp.hl_id('helper')),
  'the public mirror reflects the opt-out too'
);

-- ---------------------------------------------------------------------------
-- 5. Direct writes to the new columns are denied; caller can only touch their own row.
-- ---------------------------------------------------------------------------
select pg_temp.hl_denied(
  pg_catalog.format('update public.profiles set public_lat=1, public_lng=1 where id=%L', pg_temp.hl_id('helper')),
  'authenticated cannot directly write their own public_lat/lng, bypassing set_helper_location validation'
);
select pg_temp.hl_denied(
  pg_catalog.format('update public.profiles set public_location_text=''forged'' where id=%L', pg_temp.hl_id('helper')),
  'authenticated cannot directly write public_location_text'
);
select pg_temp.hl_assert(
  not has_column_privilege('authenticated', 'public.profiles', 'public_lat', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'public_lng', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'public_location_text', 'UPDATE'),
  'no client column grant exists for any of the three new fields'
);
select pg_temp.hl_assert(
  not has_column_privilege('authenticated', 'public.profiles', 'private_lat', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'private_lng', 'UPDATE'),
  'private coordinate columns remain equally unwritable (unchanged by this migration)'
);

-- ---------------------------------------------------------------------------
-- 6. Regression: Phase 2C / gig_tags / profile_tags protections remain intact.
-- ---------------------------------------------------------------------------
select pg_temp.hl_assert(not has_table_privilege('authenticated', 'public.gigs', 'UPDATE'), 'Phase 2C: gigs UPDATE grant still revoked');
select pg_temp.hl_assert(not has_table_privilege('authenticated', 'public.tags', 'INSERT'), 'gig tags catalog still has no client write grant');
select pg_temp.hl_assert(not has_table_privilege('authenticated', 'public.profile_tags', 'INSERT'), 'profile_tags still has no client write grant');

reset role;
rollback;
