-- Close a deleted account's open gigs.
--
-- delete_own_account() anonymizes an account that has history, and already cancels the private
-- requests it posted. Ordinary open gigs it posted (status active with no helper selected, or saved for
-- finding helpers) were left as they were, so they stayed on the public list and could still be
-- claimed under the anonymous "deleted..." name. This redefines the function from its current body
-- (migration 0019, the last to change it) with one added step that cancels those gigs and declines
-- their pending offers. Nothing else changes, and the signature and grants are the same.
begin;

create or replace function public.delete_own_account()
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_has_history boolean;
  v_blocked boolean;
  v_gig public.gigs;
  v_open boolean;
  v_name text;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;

  select not eligible into v_blocked from public.check_deletion_eligibility();
  if v_blocked then
    raise exception 'You have Gigs that need attention. Resolve any active Gigs, incomplete Gig activity, or open Disputes before deleting your account.'
      using errcode = '22023';
  end if;

  select exists (
    select 1 from public.gigs where poster_id = v_uid or selected_provider_id = v_uid or requested_helper_id = v_uid
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
    -- Requests this account posted: cancel them and tell the requested helper.
    for v_gig in
      select * from public.gigs
      where poster_id = v_uid and requested_helper_id is not null and status = 'active' and selected_provider_id is null
      order by id for update
    loop
      v_open := not exists (
        select 1 from public.claims
        where gig_id = v_gig.id and provider_id = v_gig.requested_helper_id and state in ('withdrawn', 'rejected')
      );
      update public.gigs set status = 'cancelled' where id = v_gig.id;
      update public.claims set state = 'rejected' where gig_id = v_gig.id and state = 'pending';
      if v_open then
        perform public.notify(v_gig.requested_helper_id, v_gig.id, 'request_withdrawn',
          'The request "' || v_gig.title || '" was cancelled because the poster closed their account.');
      end if;
    end loop;

    -- Open gigs this account posted for everyone (or saved for finding helpers): close them so they
    -- do not stay on the public list, claimable, under a deleted account. Pending offers are declined,
    -- exactly as cancel_gig() does. Gigs with a helper selected never get here: they block deletion
    -- above. The gig rows stay in place as history, like the rest of this account's activity.
    update public.claims set state = 'rejected'
    where state = 'pending' and gig_id in (
      select id from public.gigs
      where poster_id = v_uid and status in ('active', 'saved_non_public') and selected_provider_id is null
    );
    update public.gigs set status = 'cancelled'
    where poster_id = v_uid and status in ('active', 'saved_non_public') and selected_provider_id is null;

    -- Requests addressed to this account: close them out and tell the poster.
    for v_gig in
      select * from public.gigs
      where requested_helper_id = v_uid and poster_id <> v_uid and status = 'active' and selected_provider_id is null
      order by id for update
    loop
      v_open := not exists (
        select 1 from public.claims
        where gig_id = v_gig.id and provider_id = v_uid and state in ('withdrawn', 'rejected')
      );
      if v_open then
        update public.claims set state = 'withdrawn' where gig_id = v_gig.id and provider_id = v_uid and state = 'pending';
        if not found then
          insert into public.claims (gig_id, provider_id, state, offer_amount)
          values (v_gig.id, v_uid, 'withdrawn', v_gig.amount);
        end if;
        perform public.notify(v_gig.poster_id, v_gig.id, 'request_declined',
          'The helper closed their account, so your request "' || v_gig.title || '" was closed. You can post it publicly or cancel it.');
      end if;
    end loop;

    perform pg_catalog.set_config('esg.bypass_profile_validation', 'on', true);
    update public.profiles set
      username = 'deleted' || pg_catalog.substr(v_uid::text, 1, 8),
      photo_url = null,
      skills = '[]'::jsonb,
      services = '[]'::jsonb,
      skills_other_text = null,
      services_other_text = null,
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
