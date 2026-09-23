-- Gig Tags: predefined, category-scoped multi-select tags per gig.
-- Additive on top of Phase 2C (0005). Does not modify 0005 or any prior
-- migration. `service_type` remains the single required category; tags are
-- optional structured discovery metadata, never user-created free text.
begin;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = current_user and (rolsuper or rolbypassrls)
  ) then
    raise exception 'Apply this migration as postgres or another trusted BYPASSRLS migration role';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Catalog table: admin/migration-managed, never client-writable.
-- ---------------------------------------------------------------------------
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  service_type text not null check (service_type = any(array['Yard Work','Moving Help','Cleaning','Handyman','Delivery','Pet Care','Tech Help','Other'])),
  name text not null,
  created_at timestamptz not null default now(),
  unique (service_type, name)
);

-- Junction table. Composite PK makes a duplicate (gig_id, tag_id) row
-- structurally impossible; ON DELETE CASCADE cleans up a deleted gig's tags.
create table public.gig_tags (
  gig_id uuid not null references public.gigs(id) on delete cascade,
  tag_id uuid not null references public.tags(id),
  primary key (gig_id, tag_id)
);

alter table public.tags enable row level security;
alter table public.gig_tags enable row level security;

-- tags: public read (it's a fixed catalog, no privacy concern); no write policy.
create policy tags_select_all on public.tags for select to anon, authenticated using (true);

-- gig_tags: visible exactly where the parent gig is visible. Split into two
-- policies, mirroring gigs_select / gigs_select_participants exactly: anon
-- has no EXECUTE grant on esg_private.has_own_claim, so a single combined
-- policy scoped "to anon, authenticated" would fail privilege checking for
-- anon even though that branch would never be reached at runtime for it.
create policy gig_tags_select_public on public.gig_tags for select to anon, authenticated using (
  exists (select 1 from public.gigs g where g.id = gig_tags.gig_id and g.status = 'active')
);
create policy gig_tags_select_participants on public.gig_tags for select to authenticated using (
  exists (
    select 1 from public.gigs g
    where g.id = gig_tags.gig_id
      and (g.poster_id = auth.uid() or g.selected_provider_id = auth.uid() or esg_private.has_own_claim(g.id))
  )
);

-- RLS already default-denies INSERT/UPDATE/DELETE with no matching policy;
-- revoke the underlying grants too, matching 0002/0005's defense-in-depth style.
revoke insert, update, delete on table public.tags, public.gig_tags from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed catalog (approved list). Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------
insert into public.tags (service_type, name) values
  ('Cleaning','Deep Cleaning'), ('Cleaning','Kitchen'), ('Cleaning','Bathroom'), ('Cleaning','Apartment'), ('Cleaning','Move-out'),
  ('Yard Work','Lawn Mowing'), ('Yard Work','Leaf Removal'), ('Yard Work','Hedge Trimming'), ('Yard Work','Weeding'), ('Yard Work','Garden Cleanup'),
  ('Moving Help','Loading/Unloading'), ('Moving Help','Packing'), ('Moving Help','Furniture Assembly'), ('Moving Help','Apartment Move'), ('Moving Help','Heavy Items'),
  ('Handyman','Furniture Assembly'), ('Handyman','Repairs'), ('Handyman','Mounting/Hanging'), ('Handyman','Painting'), ('Handyman','Plumbing'), ('Handyman','Electrical'),
  ('Delivery','Groceries'), ('Delivery','Furniture'), ('Delivery','Package/Parcel'), ('Delivery','Heavy Item'),
  ('Pet Care','Dog Walking'), ('Pet Care','Pet Sitting'), ('Pet Care','Feeding Visits'), ('Pet Care','Overnight Care'),
  ('Tech Help','Computer Setup'), ('Tech Help','Wi-Fi/Network'), ('Tech Help','Smart Home'), ('Tech Help','Troubleshooting'), ('Tech Help','Software Install'),
  ('Other','Errand'), ('Other','Event Help'), ('Other','Organization'), ('Other','General Help')
on conflict (service_type, name) do nothing;

-- ---------------------------------------------------------------------------
-- create_gig(): a 13th parameter changes the function's identity (Postgres
-- identifies functions by name + argument-type list), so CREATE OR REPLACE
-- with a different arg list would silently create a second overload and
-- leave the original 12-arg, tag-unaware function callable. Drop it first.
-- ---------------------------------------------------------------------------
drop function public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean);

create function public.create_gig(p_request_id uuid,p_service_type text,p_title text,
  p_description text,p_amount numeric,p_price_type text,p_scheduled_at timestamptz,
  p_location_text text,p_lat double precision,p_lng double precision,
  p_photo_url text default null,p_publish boolean default true,p_tag_ids uuid[] default '{}'::uuid[])
returns public.gigs language plpgsql security definer set search_path = '' as $$
declare v_gig public.gigs; v_tag_ids uuid[];
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_request_id is null then raise exception 'Missing creation request.' using errcode='22023'; end if;
  -- Serializes retries per account and orders creation after profile setup.
  perform 1 from public.profiles where id=auth.uid() and onboarding_completed_at is not null for update;
  if not found then raise exception 'Finish your profile setup before posting.' using errcode='22023'; end if;
  select * into v_gig from public.gigs where poster_id=auth.uid() and creation_request_id=p_request_id;
  if found then return v_gig; end if;
  if p_service_type is null or p_service_type <> all(array['Yard Work','Moving Help','Cleaning','Handyman','Delivery','Pet Care','Tech Help','Other']) then
    raise exception 'Choose a valid service type.' using errcode='22023'; end if;
  if p_title is null or pg_catalog.length(pg_catalog.btrim(p_title)) not between 1 and 120 then
    raise exception 'Enter a title of 1–120 characters.' using errcode='22023'; end if;
  if p_description is null or pg_catalog.length(pg_catalog.btrim(p_description)) not between 1 and 280 then
    raise exception 'Enter a description of 1–280 characters.' using errcode='22023'; end if;
  if p_amount is null or not (p_amount>0 and p_amount<=9999999999.99) or p_amount<>pg_catalog.round(p_amount,2) then
    raise exception 'Enter a positive amount with at most two decimal places.' using errcode='22023'; end if;
  if p_price_type is distinct from 'fixed' then
    raise exception 'This POC supports fixed-price gigs only.' using errcode='22023'; end if;
  if p_publish is null or (p_publish and p_scheduled_at is null)
    or (p_scheduled_at is not null and (not pg_catalog.isfinite(p_scheduled_at) or p_scheduled_at<=pg_catalog.now())) then
    raise exception 'Pick a future date/time before posting.' using errcode='22023'; end if;
  if p_location_text is null or pg_catalog.length(pg_catalog.btrim(p_location_text)) not between 1 and 200 then
    raise exception 'Enter a general area of 1–200 characters.' using errcode='22023'; end if;
  if (p_lat is null) <> (p_lng is null) or (p_lat is not null and
    (not (p_lat between -90 and 90) or not (p_lng between -180 and 180))) then
    raise exception 'Invalid location coordinates.' using errcode='22023'; end if;
  if p_photo_url is not null and (pg_catalog.length(p_photo_url)>2048 or p_photo_url !~ '^https?://') then
    raise exception 'Invalid photo URL.' using errcode='22023'; end if;
  -- Tags: optional, deduplicated, capped, and every id must exist and match
  -- the gig's own service_type. Empty/NULL input is always valid (no tags).
  v_tag_ids := coalesce(
    (select pg_catalog.array_agg(distinct picked) from pg_catalog.unnest(p_tag_ids) as picked),
    array[]::uuid[]
  );
  if pg_catalog.array_length(v_tag_ids,1) > 8 then
    raise exception 'Choose at most 8 tags.' using errcode='22023'; end if;
  if exists (
    select 1 from pg_catalog.unnest(v_tag_ids) as picked
    where not exists (select 1 from public.tags tg where tg.id = picked and tg.service_type = p_service_type)
  ) then
    raise exception 'Choose tags that exist and match the selected category.' using errcode='22023'; end if;
  insert into public.gigs(poster_id,creation_request_id,service_type,title,description,
    amount,price_type,scheduled_at,location_text,lat,lng,photo_url,status)
  values(auth.uid(),p_request_id,p_service_type,pg_catalog.btrim(p_title),pg_catalog.btrim(p_description),
    p_amount,'fixed',p_scheduled_at,pg_catalog.btrim(p_location_text),
    pg_catalog.round(p_lat::numeric,2)::double precision,pg_catalog.round(p_lng::numeric,2)::double precision,
    p_photo_url,case when p_publish then 'active'::public.gig_status else 'draft'::public.gig_status end)
  returning * into v_gig;
  insert into public.gig_tags (gig_id, tag_id)
  select v_gig.id, picked from pg_catalog.unnest(v_tag_ids) as picked
  on conflict do nothing;
  return v_gig;
end;
$$;

revoke execute on function public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[])
  from public, anon, authenticated;
grant execute on function public.create_gig(uuid,text,text,text,numeric,text,timestamptz,text,double precision,double precision,text,boolean,uuid[])
  to authenticated;

commit;
