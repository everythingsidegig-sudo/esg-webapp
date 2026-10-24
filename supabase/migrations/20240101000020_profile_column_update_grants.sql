-- Bug: two pages write profile columns directly to public.profiles, but the only
-- column-level UPDATE grant (0002) covers username, photo_url, skills and
-- services. Columns added later were never granted, so PostgREST answers every
-- such save with 42501 "permission denied for table profiles":
--   * phone (added by 0014): Settings -> Mobile number
--       supabase.from("profiles").update({ phone })           (src/app/settings/page.tsx)
--   * skills_other_text, services_other_text (added by 0015): My Profile -> Update
--     profile, when OTHER is chosen or its text is edited     (src/app/profile/page.tsx)
--
-- Grants UPDATE on exactly those three columns to authenticated. Nothing else
-- changes: anon still has no UPDATE, no other column becomes writable, the
-- profiles_update_own row policy (id = auth.uid()) still limits the rows, and
-- trg_validate_profile_edit (0014/0018) plus profiles_phone_format (0014) still
-- validate every write to these columns.
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

grant update (phone, skills_other_text, services_other_text) on public.profiles to authenticated;

commit;
