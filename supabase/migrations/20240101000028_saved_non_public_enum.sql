-- Find Help, Gig Saving & Provider Profile Swiping v1.0: "Save & Find Helpers Nearby" saves a
-- gig privately instead of publishing it. gig_status is a real Postgres enum, and a new value
-- can never be used in the same transaction that adds it -- so this migration ONLY adds the
-- value. Every function/policy that references it lives in the next migration (20240101000029),
-- applied afterward as its own transaction.
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

alter type public.gig_status add value 'saved_non_public' after 'draft';

commit;
