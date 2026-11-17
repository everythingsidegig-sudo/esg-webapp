-- Registration "Services Selection" (spec v2.0): a shared 23-category catalog and two INDEPENDENT sets of
-- selections per member -- OFFER ("Services to Make Money") and NEED ("Services I Need Help").
--
--   * service_categories / services / subservices: the catalog (stable text ids, enabled flags). Filled by
--     migration 0041, which is generated from src/lib/service-catalog.ts. Readable by everyone, writable
--     by no one through the API.
--   * user_service_selections: one row per selected subservice, or per "Other" custom entry (one per
--     service and branch). Only its owner can read it: NEED is never exposed, and OFFER reaches other
--     members only through the two read-only functions below.
--   * service_selection_revisions: a counter per member and branch, so a save from a stale screen is
--     refused instead of silently overwriting a newer one.
--   * save_service_selections(): atomic, idempotent REPLACEMENT of one branch's selections. It validates
--     every id against the enabled catalog, trims and bounds custom text, and never touches the other
--     branch. "All" is not stored: it is just every subservice of a service.
--   * find_providers_by_service(): provider discovery. Matches OFFER selections only, by stable id, at
--     category, service or subservice level. It skips custom "Other" text (no mapping/moderation rule
--     exists yet), services that require verification (spec AC-17), and closed accounts.
--   * get_public_offered_services(): what a member offers, for their public profile (OFFER only).
begin;

create type public.service_selection_type as enum ('OFFER', 'NEED');

create table public.service_categories (
  id text primary key,
  name text not null,
  sort_order integer not null,
  enabled boolean not null default true
);
create table public.services (
  id text primary key,
  category_id text not null references public.service_categories(id),
  name text not null,
  sort_order integer not null,
  enabled boolean not null default true,
  -- Needs a licence or other verification: can be recorded, but is not matched in helper search yet.
  requires_verification boolean not null default false
);
create table public.subservices (
  id text primary key,
  service_id text not null references public.services(id),
  name text not null,
  sort_order integer not null,
  enabled boolean not null default true
);
create index services_category_idx on public.services (category_id, sort_order);
create index subservices_service_idx on public.subservices (service_id, sort_order);

alter table public.service_categories enable row level security;
alter table public.services enable row level security;
alter table public.subservices enable row level security;
revoke all on table public.service_categories, public.services, public.subservices from public, anon, authenticated;
grant select on table public.service_categories, public.services, public.subservices to anon, authenticated;
create policy "service_categories_read" on public.service_categories for select to anon, authenticated using (true);
create policy "services_read" on public.services for select to anon, authenticated using (true);
create policy "subservices_read" on public.subservices for select to anon, authenticated using (true);

create table public.user_service_selections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  selection_type public.service_selection_type not null,
  category_id text not null references public.service_categories(id),
  service_id text not null references public.services(id),
  subservice_id text references public.subservices(id),
  is_custom boolean not null default false,
  custom_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint selection_shape check (
    (not is_custom and subservice_id is not null and custom_text is null)
    or (is_custom and subservice_id is null and custom_text is not null
        and custom_text = pg_catalog.btrim(custom_text) and pg_catalog.char_length(custom_text) between 1 and 100)
  )
);
-- Uniqueness of (member, branch, subservice) for predefined selections, and one "Other" per service and branch.
create unique index user_service_selections_standard_uq on public.user_service_selections (user_id, selection_type, subservice_id)
  where subservice_id is not null;
create unique index user_service_selections_custom_uq on public.user_service_selections (user_id, selection_type, service_id)
  where is_custom;
-- Provider discovery looks up OFFER rows by id at each level.
create index user_service_selections_offer_sub_idx on public.user_service_selections (subservice_id) where selection_type = 'OFFER';
create index user_service_selections_offer_service_idx on public.user_service_selections (service_id) where selection_type = 'OFFER';
create index user_service_selections_offer_category_idx on public.user_service_selections (category_id) where selection_type = 'OFFER';

create table public.service_selection_revisions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  selection_type public.service_selection_type not null,
  revision integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, selection_type)
);

alter table public.user_service_selections enable row level security;
alter table public.service_selection_revisions enable row level security;
revoke all on table public.user_service_selections, public.service_selection_revisions from public, anon, authenticated;
grant select on table public.user_service_selections, public.service_selection_revisions to authenticated;
create policy "own_selections_read" on public.user_service_selections for select to authenticated using (user_id = auth.uid());
create policy "own_revisions_read" on public.service_selection_revisions for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- save_service_selections(): replace ONE branch's selections, atomically.
--   p_subservice_ids: the checked subservices (ids). "All" is never sent.
--   p_custom: [{"service_id": "c12s05", "text": "..."}], at most one per service.
--   p_expected_revision: the revision the screen was loaded with; a mismatch is refused.
-- Returns the new revision.
-- ---------------------------------------------------------------------------
create function public.save_service_selections(
  p_type public.service_selection_type, p_subservice_ids text[], p_custom jsonb default '[]'::jsonb, p_expected_revision integer default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c_max_subservices constant int := 600;
  c_max_custom constant int := 100;
  v_uid uuid := auth.uid();
  v_rev integer;
  v_ids text[];
  v_bad text;
  v_item jsonb;
  v_service_id text;
  v_text text;
  v_seen text[] := '{}';
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_type is null then
    raise exception 'Choose which list to save.' using errcode = '22023';
  end if;
  perform 1 from public.profiles where id = v_uid;
  if not found then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  -- Serialize saves for this member and branch, then check the screen was not stale.
  insert into public.service_selection_revisions (user_id, selection_type) values (v_uid, p_type) on conflict do nothing;
  select revision into v_rev from public.service_selection_revisions where user_id = v_uid and selection_type = p_type for update;
  if p_expected_revision is not null and p_expected_revision <> v_rev then
    raise exception 'Your services were changed on another device. Reload to see the latest, then try again.' using errcode = '22023';
  end if;

  v_ids := coalesce((select pg_catalog.array_agg(distinct x) from pg_catalog.unnest(coalesce(p_subservice_ids, '{}'::text[])) as x), '{}'::text[]);
  if pg_catalog.cardinality(v_ids) > c_max_subservices then
    raise exception 'That is too many services to save at once.' using errcode = '22023';
  end if;
  select x into v_bad from pg_catalog.unnest(v_ids) as x
  where not exists (
    select 1 from public.subservices u
    join public.services s on s.id = u.service_id
    join public.service_categories c on c.id = s.category_id
    where u.id = x and u.enabled and s.enabled and c.enabled
  ) limit 1;
  if v_bad is not null then
    raise exception 'One of the services you chose is no longer available. Reload and choose again.' using errcode = '22023';
  end if;

  p_custom := coalesce(p_custom, '[]'::jsonb);
  if pg_catalog.jsonb_typeof(p_custom) <> 'array' or pg_catalog.jsonb_array_length(p_custom) > c_max_custom then
    raise exception 'Those custom entries could not be saved.' using errcode = '22023';
  end if;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_custom) loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      raise exception 'Those custom entries could not be saved.' using errcode = '22023';
    end if;
    v_service_id := v_item ->> 'service_id';
    v_text := nullif(pg_catalog.btrim(v_item ->> 'text'), '');
    if v_text is null then
      raise exception 'Enter text for each "Other" you checked.' using errcode = '22023';
    end if;
    if pg_catalog.char_length(v_text) > 100 then
      raise exception 'Keep each "Other" to 100 characters or fewer.' using errcode = '22023';
    end if;
    if v_service_id is null or v_service_id = any (v_seen) or not exists (
      select 1 from public.services s join public.service_categories c on c.id = s.category_id
      where s.id = v_service_id and s.enabled and c.enabled
    ) then
      raise exception 'One of your "Other" entries is not under an available service.' using errcode = '22023';
    end if;
    v_seen := v_seen || v_service_id;
  end loop;

  -- Everything validated: replace this branch (and only this branch).
  delete from public.user_service_selections where user_id = v_uid and selection_type = p_type;
  insert into public.user_service_selections (user_id, selection_type, category_id, service_id, subservice_id)
  select v_uid, p_type, s.category_id, s.id, u.id
  from pg_catalog.unnest(v_ids) as x
  join public.subservices u on u.id = x
  join public.services s on s.id = u.service_id;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_custom) loop
    insert into public.user_service_selections (user_id, selection_type, category_id, service_id, is_custom, custom_text)
    select v_uid, p_type, s.category_id, s.id, true, pg_catalog.btrim(v_item ->> 'text')
    from public.services s where s.id = v_item ->> 'service_id';
  end loop;

  update public.service_selection_revisions set revision = revision + 1, updated_at = pg_catalog.now()
  where user_id = v_uid and selection_type = p_type
  returning revision into v_rev;
  return v_rev;
end;
$$;

-- ---------------------------------------------------------------------------
-- find_providers_by_service(): who offers this? OFFER selections only, by stable id.
--   p_level: 'category' | 'service' | 'subservice'.
-- ---------------------------------------------------------------------------
create function public.find_providers_by_service(p_level text, p_id text)
returns table(provider_id uuid)
language sql security definer set search_path = '' stable as $$
  select distinct s.user_id
  from public.user_service_selections s
  join public.subservices u on u.id = s.subservice_id
  join public.services sv on sv.id = s.service_id
  join public.service_categories c on c.id = s.category_id
  where s.selection_type = 'OFFER'
    and not s.is_custom
    and u.enabled and sv.enabled and c.enabled
    and not sv.requires_verification
    and (case p_level when 'category' then s.category_id = p_id
                      when 'service' then s.service_id = p_id
                      when 'subservice' then s.subservice_id = p_id
                      else false end)
    and not esg_private.account_unavailable(s.user_id)
  limit 500;
$$;

-- ---------------------------------------------------------------------------
-- get_public_offered_services(): a member's OFFER selections, for their public profile.
-- ---------------------------------------------------------------------------
create function public.get_public_offered_services(p_profile_id uuid)
returns table(category_id text, service_id text, subservice_id text, custom_text text)
language sql security definer set search_path = '' stable as $$
  select s.category_id, s.service_id, s.subservice_id, s.custom_text
  from public.user_service_selections s
  where s.user_id = p_profile_id and s.selection_type = 'OFFER'
    and not esg_private.account_unavailable(s.user_id)
  order by s.category_id, s.service_id, s.subservice_id nulls last;
$$;

revoke execute on function public.save_service_selections(public.service_selection_type, text[], jsonb, integer),
  public.find_providers_by_service(text, text), public.get_public_offered_services(uuid) from public, anon, authenticated;
grant execute on function public.save_service_selections(public.service_selection_type, text[], jsonb, integer) to authenticated;
grant execute on function public.find_providers_by_service(text, text), public.get_public_offered_services(uuid) to anon, authenticated;

commit;
