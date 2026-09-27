-- ESG: self-service account deletion (Danger zone on /profile).
--
-- Every marketplace table below references profiles(id) with Postgres's
-- default ON DELETE behavior (NO ACTION), while profiles.id itself cascades
-- from auth.users. That means deleting auth.users for a user who has ever
-- posted/claimed/messaged/completed a gig, or given/received feedback, or
-- been notified, would make Postgres attempt to cascade into profiles and
-- then fail outright on one of those NO ACTION constraints -- there is no
-- partial cascade, the whole statement is refused. Only an account with
-- zero marketplace history can have its auth.users/profiles rows removed
-- outright.
--
-- Policy (approved): a clean account is hard-deleted by the caller (a
-- server-side route, using the service-role Admin API) once this function
-- confirms it is safe to do so. An account with history is anonymized here
-- instead -- profile PII is scrubbed and profile_tags removed, but the row
-- itself, and every gig/claim/feedback row that references it, is left
-- intact so other users' marketplace history is never corrupted. wom_count/
-- lemon_count/money_made are deliberately left untouched: they represent
-- other users' recorded feedback about a real completed transaction, not
-- this user's personal data, and zeroing them would falsify someone else's
-- transaction history. The caller then permanently locks (rather than
-- deletes) the auth.users identity via the Admin API, since that row can't
-- be removed for the same referential-integrity reason.
--
-- This function takes no parameters and only ever reads/writes auth.uid()'s
-- own row: there is no id argument for a caller to substitute another
-- account into, by construction rather than by a runtime check.
begin;

create function public.delete_own_account()
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_has_history boolean;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;

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

revoke execute on function public.delete_own_account() from public, anon, authenticated;
grant execute on function public.delete_own_account() to authenticated;

commit;
