-- Find a Helper: optional distance filtering. Adds a separate, explicit
-- opt-in public/approximate helper location. The private onboarding address
-- columns are never read, copied, exposed, or used here. Additive on top of
-- 0001-0007; does not modify 0007_profile_tags.sql.
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
-- Source columns on profiles. New columns receive no column-level UPDATE
-- grant by default (Postgres privileges are opt-in per column), so they are
-- already unwritable by anon/authenticated the moment they're created —
-- no additional revoke is needed, only the validated RPC below grants access.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column public_location_text text,
  add column public_lat double precision,
  add column public_lng double precision;

-- Public-safe mirror, same columns, kept in sync by the existing trigger.
alter table public.public_profiles
  add column public_location_text text,
  add column public_lat double precision,
  add column public_lng double precision;

create or replace function public.sync_public_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.public_profiles (id, username, photo_url, skills, wom_count, public_location_text, public_lat, public_lng)
  values (new.id, new.username, new.photo_url, new.skills, new.wom_count, new.public_location_text, new.public_lat, new.public_lng)
  on conflict (id) do update set
    username = excluded.username,
    photo_url = excluded.photo_url,
    skills = excluded.skills,
    wom_count = excluded.wom_count,
    public_location_text = excluded.public_location_text,
    public_lat = excluded.public_lat,
    public_lng = excluded.public_lng;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_helper_location(): the only write path. Passing all three arguments
-- as null clears the location (opts out of distance-based discovery).
-- Otherwise location_text is required and, if coordinates are supplied,
-- both must be present and in range; rounded to 2 decimals, matching the
-- precision create_gig() already uses for public gig coordinates.
-- ---------------------------------------------------------------------------
create function public.set_helper_location(p_location_text text, p_lat double precision, p_lng double precision)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare v_profile public.profiles;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform public.ensure_profile();

  if p_location_text is null and p_lat is null and p_lng is null then
    update public.profiles set public_location_text = null, public_lat = null, public_lng = null
      where id = auth.uid() returning * into v_profile;
    return v_profile;
  end if;

  if p_location_text is null or pg_catalog.length(pg_catalog.btrim(p_location_text)) not between 1 and 200 then
    raise exception 'Enter a general area of 1–200 characters.' using errcode = '22023'; end if;
  if (p_lat is null) <> (p_lng is null) or (p_lat is not null and
    (not (p_lat between -90 and 90) or not (p_lng between -180 and 180))) then
    raise exception 'Invalid location coordinates.' using errcode = '22023'; end if;

  update public.profiles set
    public_location_text = pg_catalog.btrim(p_location_text),
    public_lat = case when p_lat is null then null else pg_catalog.round(p_lat::numeric, 2)::double precision end,
    public_lng = case when p_lng is null then null else pg_catalog.round(p_lng::numeric, 2)::double precision end
    where id = auth.uid() returning * into v_profile;
  return v_profile;
end;
$$;

revoke execute on function public.set_helper_location(text, double precision, double precision) from public, anon, authenticated;
grant execute on function public.set_helper_location(text, double precision, double precision) to authenticated;

commit;
