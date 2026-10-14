-- ESG-AUTH-004 v1.0: account deletion must run an eligibility pre-check and
-- refuse deletion while real blockers exist, rather than only distinguishing
-- "has any history" (anonymize) from "clean" (hard delete) as 0009 did.
--
-- Blocking, per §5 of the spec, mapped onto this schema's actual gig_status
-- values: a Selected/Pre-Start or Start-pending relationship is 'active' with
-- selected_provider_id set; "In Progress" covers both 'in_progress' and
-- 'awaiting_payment' (completion/payment not yet resolved); an Open Dispute
-- is 'disputed'. Historical 'completed'/'cancelled'/'incomplete' gigs and
-- Draft/unselected-claim gigs are explicitly non-blocking per the spec and
-- are left for 0009's existing anonymize-or-hard-delete cleanup.
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
-- 1. check_deletion_eligibility(): read-only, called by the client before
--    showing either the Outstanding Gigs popup or the deletion warning
--    screen. Counts are informational (for the popup's summary line);
--    `eligible` is the authoritative gate.
-- ---------------------------------------------------------------------------
create function public.check_deletion_eligibility()
returns table(eligible boolean, active_gigs_count bigint, open_disputes_count bigint)
language sql security definer set search_path = '' stable as $$
  select
    (count(*) filter (
      where (g.status = 'active' and g.selected_provider_id is not null) or g.status in ('in_progress', 'awaiting_payment')
    ) = 0) and (count(*) filter (where g.status = 'disputed') = 0),
    count(*) filter (
      where (g.status = 'active' and g.selected_provider_id is not null) or g.status in ('in_progress', 'awaiting_payment')
    ),
    count(*) filter (where g.status = 'disputed')
  from public.gigs g
  where auth.uid() is not null and (g.poster_id = auth.uid() or g.selected_provider_id = auth.uid());
$$;
revoke execute on function public.check_deletion_eligibility() from public, anon, authenticated;
grant execute on function public.check_deletion_eligibility() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. delete_own_account(): same anonymize-or-signal-hard-delete policy as
--    0009, now gated by the same blocking check above. BR-DEL-009: no
--    "delete anyway" path exists even at this layer -- a blocked account
--    cannot be deleted no matter how the client got here.
-- ---------------------------------------------------------------------------
create or replace function public.delete_own_account()
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_has_history boolean;
  v_blocked boolean;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;

  select not eligible into v_blocked from public.check_deletion_eligibility();
  if v_blocked then
    raise exception 'You have Gigs that need attention. Resolve any active Gigs, incomplete Gig activity, or open Disputes before deleting your account.'
      using errcode = '22023';
  end if;

  select exists (
    select 1 from public.gigs where poster_id = v_uid or selected_provider_id = v_uid
    union all
    select 1 from public.claims where provider_id = v_uid
    union all
    select 1 from public.chat_messages where sender_id = v_uid
    union all
    select 1 from public.gig_completions where user_id = v_uid
    union all
    select 1 from public.gig_incomplete_choices where user_id = v_uid
    union all
    select 1 from public.feedback where from_id = v_uid or to_id = v_uid
    union all
    select 1 from public.notifications where recipient_id = v_uid
  ) into v_has_history;

  if v_has_history then
    update public.profiles set
      username = 'deleted' || pg_catalog.substr(v_uid::text, 1, 8),
      photo_url = null,
      skills = '[]'::jsonb,
      services = '[]'::jsonb,
      private_location_text = null,
      private_lat = null,
      private_lng = null,
      public_location_text = null,
      public_lat = null,
      public_lng = null
      where id = v_uid;
    delete from public.profile_tags where profile_id = v_uid;
  end if;

  return v_has_history;
end;
$$;

commit;
