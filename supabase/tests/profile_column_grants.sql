-- Profile save: phone and the two OTHER text columns are writable by their owner (migration 0020), nothing else is.
-- Run only against an isolated Supabase test database after 0001 through 0020.
-- All fixtures roll back. Run as postgres (or an equivalent trusted role).
begin;

create temporary table po_fixture (name text primary key, id uuid);
insert into po_fixture (name, id) select name, gen_random_uuid() from unnest(array['alice','bob']) as n(name);
grant select, update on po_fixture to anon, authenticated;

create function pg_temp.po_id(p_name text) returns uuid
language sql stable as $$ select id from pg_temp.po_fixture where name = p_name; $$;
create function pg_temp.po_assert(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.po_switch(p_user text) returns void language plpgsql as $$
declare v_id uuid;
begin
  if p_user = 'admin' then return; end if;
  if p_user = 'anon' then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    set local role anon;
  else
    select id into v_id from pg_temp.po_fixture where name = p_user;
    perform set_config('request.jwt.claim.sub', v_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end;
$$;
create function pg_temp.po_query(p_user text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.po_switch(p_user);
  begin execute p_sql into v; exception when others then reset role; raise; end;
  reset role;
  return v;
end;
$$;
create function pg_temp.po_exec(p_user text, p_sql text) returns void language plpgsql as $$
begin
  perform pg_temp.po_switch(p_user);
  begin execute p_sql; exception when others then reset role; raise; end;
  reset role;
end;
$$;
create function pg_temp.po_error(p_user text, p_sql text, p_code text, p_label text) returns void
language plpgsql as $$
begin
  begin
    perform pg_temp.po_exec(p_user, p_sql);
  exception when others then
    if sqlstate <> p_code then raise exception 'FAIL: % (got % %)', p_label, sqlstate, sqlerrm; end if;
    raise notice 'PASS: %', p_label; return;
  end;
  raise exception 'FAIL (expected error %): %', p_code, p_label;
end;
$$;
create function pg_temp.po_denied(p_user text, p_sql text, p_label text) returns void
language plpgsql as $$ begin perform pg_temp.po_error(p_user, p_sql, '42501', p_label); end; $$;
-- A profile's saved state as one comparable string.
create function pg_temp.po_state(p_user text) returns text language sql as $$
  select skills::text || '|' || services::text || '|' || coalesce(skills_other_text, '-') || '|' || coalesce(services_other_text, '-')
  from public.profiles where id = pg_temp.po_id(p_user);
$$;
grant execute on all functions in schema pg_temp to anon, authenticated;

do $$
declare v_schema text;
begin
  select nspname into v_schema from pg_catalog.pg_namespace where oid = pg_catalog.pg_my_temp_schema();
  execute pg_catalog.format('grant usage on schema %I to anon, authenticated', v_schema);
end;
$$;

insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
select id, 'authenticated', 'authenticated', name || '-' || id::text || '@example.invalid',
  jsonb_build_object('username', 'PO' || name), now(), now()
from po_fixture;
select pg_temp.po_query('alice', $$select public.save_onboarding('POalice01', null, '1 Private Street', 55.7, 13.1, '["Cleaning"]'::jsonb, '["Handyman"]'::jsonb)::text$$);
select pg_temp.po_query('bob', $$select public.save_onboarding('RQbob0001', null, '2 Private Street', 55.7, 13.1, '["Cleaning"]'::jsonb, '["Handyman"]'::jsonb)::text$$);

-- ---------------------------------------------------------------------------
-- 1. The grant: exactly these two columns, to authenticated only.
-- ---------------------------------------------------------------------------
select pg_temp.po_assert(
  has_column_privilege('authenticated', 'public.profiles', 'phone', 'UPDATE')
  and has_column_privilege('authenticated', 'public.profiles', 'skills_other_text', 'UPDATE')
  and has_column_privilege('authenticated', 'public.profiles', 'services_other_text', 'UPDATE'),
  'authenticated may update phone, skills_other_text and services_other_text');
select pg_temp.po_assert(
  has_column_privilege('authenticated', 'public.profiles', 'username', 'UPDATE')
  and has_column_privilege('authenticated', 'public.profiles', 'photo_url', 'UPDATE')
  and has_column_privilege('authenticated', 'public.profiles', 'skills', 'UPDATE')
  and has_column_privilege('authenticated', 'public.profiles', 'services', 'UPDATE'),
  'the original four writable columns (0002) are unchanged');
select pg_temp.po_assert(
  not has_column_privilege('anon', 'public.profiles', 'phone', 'UPDATE')
  and not has_column_privilege('anon', 'public.profiles', 'skills_other_text', 'UPDATE')
  and not has_column_privilege('anon', 'public.profiles', 'services_other_text', 'UPDATE')
  and not has_table_privilege('anon', 'public.profiles', 'UPDATE'),
  'anon gets no update on profiles');
select pg_temp.po_assert(
  not has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
  and (select count(*) from pg_catalog.pg_attribute a
       where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped
         and has_column_privilege('authenticated', 'public.profiles', a.attname, 'UPDATE')
         and a.attname not in ('username', 'photo_url', 'skills', 'services', 'phone', 'skills_other_text', 'services_other_text')) = 0,
  'nothing beyond the seven expected columns became writable (counters, onboarding state, terms, helper location, private address)');
select pg_temp.po_assert(
  (select count(*) from pg_catalog.pg_attribute a
   where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.profiles', a.attname, 'UPDATE')) = 7,
  'the writable set is exactly the seven expected columns, none missing');
select pg_temp.po_denied('alice', $$update public.profiles set wom_count = 99 where id = pg_temp.po_id('alice')$$, 'a user still cannot write their own reputation counters');
select pg_temp.po_denied('alice', $$update public.profiles set skills_other_text = null, onboarding_completed_at = null where id = pg_temp.po_id('alice')$$, 'one ungranted column in the statement still denies the whole update');
select pg_temp.po_denied('alice', $$update public.profiles set phone = '5551234567', terms_accepted_at = null where id = pg_temp.po_id('alice')$$, 'the same holds for phone: an ungranted column beside it denies the whole update');
select pg_temp.po_denied('alice', $$update public.profiles set private_location_text = 'x' where id = pg_temp.po_id('alice')$$, 'the private address stays unwritable by direct update');
select pg_temp.po_denied('alice', $$update public.profiles set public_lat = 1, public_lng = 1 where id = pg_temp.po_id('alice')$$, 'helper coordinates stay unwritable (only set_helper_location may write them)');
select pg_temp.po_denied('anon', $$update public.profiles set skills_other_text = 'x'$$, 'anon cannot update the OTHER text');
select pg_temp.po_denied('anon', $$update public.profiles set phone = '5551234567'$$, 'anon cannot update phone');

-- ---------------------------------------------------------------------------
-- 2. Without the grant the app's save fails: the reported bug, reproduced inside this transaction.
-- ---------------------------------------------------------------------------
revoke update (phone, skills_other_text, services_other_text) on public.profiles from authenticated;
select pg_temp.po_denied('alice', $$update public.profiles set phone = '5551234567' where id = pg_temp.po_id('alice')$$,
  'before 0020: Settings -> Mobile number (an update of phone alone) is denied with 42501');
select pg_temp.po_denied('alice', $$update public.profiles set skills = '["Cleaning"]'::jsonb, services = '["Handyman"]'::jsonb, skills_other_text = null, services_other_text = null where id = pg_temp.po_id('alice')$$,
  'before 0020: a save that names the OTHER text columns is denied (42501) even when they are unchanged');
select pg_temp.po_exec('alice', $$update public.profiles set skills = '["Cleaning","Tutoring"]'::jsonb where id = pg_temp.po_id('alice')$$);
select pg_temp.po_assert(pg_temp.po_state('alice') = '["Cleaning", "Tutoring"]|["Handyman"]|-|-', 'before 0020: a save that omits them already worked, so the frontend fix is safe on its own');
grant update (phone, skills_other_text, services_other_text) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 3a. Settings -> Mobile number, exactly as src/app/settings/page.tsx writes it.
-- ---------------------------------------------------------------------------
select pg_temp.po_exec('alice', $$update public.profiles set phone = '5551234567' where id = pg_temp.po_id('alice')$$);
select pg_temp.po_assert((select phone from public.profiles where id = pg_temp.po_id('alice')) = '5551234567', 'a valid 10-digit phone saves');
select pg_temp.po_exec('alice', $$update public.profiles set phone = null where id = pg_temp.po_id('alice')$$);
select pg_temp.po_assert((select phone is null from public.profiles where id = pg_temp.po_id('alice')), 'clearing the phone (the app sends null for an empty field) saves');
select pg_temp.po_exec('alice', $$update public.profiles set phone = '5551234567' where id = pg_temp.po_id('alice')$$);
select pg_temp.po_error('alice', $$update public.profiles set phone = '555-123' where id = pg_temp.po_id('alice')$$, '22023', 'a malformed phone is rejected by the validation trigger, not saved');
select pg_temp.po_error('alice', $$update public.profiles set phone = '12345678901' where id = pg_temp.po_id('alice')$$, '22023', 'an 11-digit phone is rejected');
select pg_temp.po_assert((select phone from public.profiles where id = pg_temp.po_id('alice')) = '5551234567', 'rejected phone writes left the saved number untouched');
select pg_temp.po_exec('alice', $$update public.profiles set services = '["Handyman","Errands"]'::jsonb where id = pg_temp.po_id('alice')$$);
select pg_temp.po_assert((select phone from public.profiles where id = pg_temp.po_id('alice')) = '5551234567', 'an ordinary profile save that omits phone preserves it');
select pg_temp.po_exec('alice', $$update public.profiles set phone = null, services = '["Handyman"]'::jsonb where id = pg_temp.po_id('alice')$$);

-- ---------------------------------------------------------------------------
-- 3. Saving as the app now does.
-- ---------------------------------------------------------------------------
-- Ordinary profile save, columns omitted: values are preserved.
select pg_temp.po_exec('alice', $$update public.profiles set skills = '["Cleaning","Other"]'::jsonb, skills_other_text = 'Piano tuning' where id = pg_temp.po_id('alice')$$);
select pg_temp.po_assert(pg_temp.po_state('alice') = '["Cleaning", "Other"]|["Handyman"]|Piano tuning|-', 'OTHER skill with its text saves');
select pg_temp.po_exec('alice', $$update public.profiles set services = '["Handyman","Errands"]'::jsonb where id = pg_temp.po_id('alice')$$);
select pg_temp.po_assert(pg_temp.po_state('alice') = '["Cleaning", "Other"]|["Handyman", "Errands"]|Piano tuning|-', 'an ordinary save that omits the OTHER text preserves the existing text');
-- OTHER service with its text.
select pg_temp.po_exec('alice', $$update public.profiles set services = '["Handyman","Other"]'::jsonb, services_other_text = 'Dog walking' where id = pg_temp.po_id('alice')$$);
select pg_temp.po_assert(pg_temp.po_state('alice') = '["Cleaning", "Other"]|["Handyman", "Other"]|Piano tuning|Dog walking', 'OTHER service with its text saves, the skills text untouched');
-- Editing just one text is saved and leaves the other alone.
select pg_temp.po_exec('alice', $$update public.profiles set skills_other_text = 'Piano and organ tuning' where id = pg_temp.po_id('alice')$$);
select pg_temp.po_assert(pg_temp.po_state('alice') = '["Cleaning", "Other"]|["Handyman", "Other"]|Piano and organ tuning|Dog walking', 'editing only the OTHER skill text saves it and preserves the OTHER service text');
-- The full payload of the old page (both columns, unchanged) is accepted too.
select pg_temp.po_exec('alice', $$update public.profiles set skills = '["Cleaning","Other"]'::jsonb, services = '["Handyman","Other"]'::jsonb, skills_other_text = 'Piano and organ tuning', services_other_text = 'Dog walking' where id = pg_temp.po_id('alice')$$);
select pg_temp.po_assert(pg_temp.po_state('alice') = '["Cleaning", "Other"]|["Handyman", "Other"]|Piano and organ tuning|Dog walking', 'a save that names both OTHER text columns unchanged is accepted');

-- ---------------------------------------------------------------------------
-- 4. The validation trigger (0018) still guards every write to these columns.
-- ---------------------------------------------------------------------------
select pg_temp.po_error('alice', $$update public.profiles set skills_other_text = null where id = pg_temp.po_id('alice')$$, '22023', 'clearing the OTHER skill text while OTHER is still selected is rejected');
select pg_temp.po_error('alice', $$update public.profiles set services_other_text = '   ' where id = pg_temp.po_id('alice')$$, '22023', 'a blank OTHER service text while OTHER is still selected is rejected');
select pg_temp.po_error('alice', $$update public.profiles set skills = '["Cleaning","Other","Tutoring"]'::jsonb, skills_other_text = null where id = pg_temp.po_id('alice')$$, '22023', 'OTHER selected without text is rejected');
select pg_temp.po_error('bob', $$update public.profiles set skills = '["Cleaning","Other"]'::jsonb where id = pg_temp.po_id('bob')$$, '22023', 'selecting OTHER while omitting the text is rejected, never saved half-way');
select pg_temp.po_error('bob', $$update public.profiles set skills_other_text = 'Stray text' where id = pg_temp.po_id('bob')$$, '22023', 'OTHER text without OTHER selected is rejected');
select pg_temp.po_assert(pg_temp.po_state('bob') = '["Cleaning"]|["Handyman"]|-|-', 'the rejected writes left the profile untouched');
-- Unticking OTHER clears its text in the same statement.
select pg_temp.po_exec('alice', $$update public.profiles set skills = '["Cleaning"]'::jsonb, skills_other_text = null where id = pg_temp.po_id('alice')$$);
select pg_temp.po_assert(pg_temp.po_state('alice') = '["Cleaning"]|["Handyman", "Other"]|-|Dog walking', 'unticking OTHER with its text cleared saves, the service side untouched');

-- ---------------------------------------------------------------------------
-- 5. Row-level security still limits whose row can change.
-- ---------------------------------------------------------------------------
select pg_temp.po_exec('alice', $$update public.profiles set phone = '5559999999' where id = pg_temp.po_id('bob')$$);
select pg_temp.po_assert((select phone is null from public.profiles where id = pg_temp.po_id('bob')), 'a user cannot change another user''s phone (the row policy filters it out)');
select pg_temp.po_exec('alice', $$update public.profiles set services_other_text = 'Hijacked' where id = pg_temp.po_id('bob')$$);
select pg_temp.po_assert(pg_temp.po_state('bob') = '["Cleaning"]|["Handyman"]|-|-', 'a user cannot change another user''s OTHER text (the row policy filters it out)');

reset role;
rollback;
