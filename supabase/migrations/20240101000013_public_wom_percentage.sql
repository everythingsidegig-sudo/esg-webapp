-- ESG-PROVIDER-001 / ESG-FDBK-001: the public profile is missing the WOM
-- percentage (only the raw count exists today). Add it to get_public_stats()
-- as a safe, pre-computed value -- lemon_count itself (the denominator's
-- other half) stays a private column and is never returned here, matching
-- FDBK-001's "Lemon count private only" visibility rule.
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

-- Adding a column to the RETURNS TABLE changes the function's return type,
-- which CREATE OR REPLACE refuses -- drop and recreate instead.
drop function if exists public.get_public_stats(uuid);

create function public.get_public_stats(p_profile_id uuid)
returns table(gigs_worked_count bigint, wom_count int, wom_percentage int)
language sql security definer set search_path = '' stable as $$
  select
    (select count(*) from public.gigs where selected_provider_id = p_profile_id and status in ('completed', 'incomplete')),
    (select p.wom_count from public.profiles p where p.id = p_profile_id),
    (select case when p.wom_count + p.lemon_count > 0
      then pg_catalog.round(p.wom_count::numeric / (p.wom_count + p.lemon_count) * 100)::int
      else null end
     from public.profiles p where p.id = p_profile_id);
$$;

revoke execute on function public.get_public_stats(uuid) from public, anon, authenticated;
grant execute on function public.get_public_stats(uuid) to anon, authenticated;

commit;
