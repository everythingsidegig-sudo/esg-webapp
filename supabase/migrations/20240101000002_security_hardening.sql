-- Phase 1 only: authorization hardening of the schema created by 0001_init.sql.
-- No data deletion, table recreation, or lifecycle correctness changes.
begin;

-- These authorization helpers must be owned by a trusted role that bypasses
-- RLS. Fail rather than accidentally introducing recursion under another owner.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = current_user and (rolsuper or rolbypassrls)
  ) then
    raise exception 'Apply this migration as postgres or another trusted BYPASSRLS migration role';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles r on r.oid = p.proowner
    where n.nspname = 'public' and p.prosecdef
      and p.proname in (
        'create_claim', 'select_provider', 'request_start', 'approve_start',
        'submit_completion', 'submit_incomplete_choice', 'submit_payment_amount',
        'submit_feedback', 'publish_gig', 'cancel_gig', 'get_public_stats',
        'notify', 'sync_public_profile', 'handle_new_user'
      ) and not (r.rolsuper or r.rolbypassrls)
  ) then
    raise exception 'Review existing SECURITY DEFINER owners: expected trusted BYPASSRLS owners';
  end if;
  if exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('gigs', 'claims')
      and c.relforcerowsecurity
  ) then
    raise exception 'Review FORCE ROW LEVEL SECURITY on gigs/claims before applying this migration';
  end if;
end;
$$;

-- Prevent PUBLIC execution for future functions created by this migration role.
-- This is deliberately global for the creator: a schema-only REVOKE cannot
-- remove PostgreSQL's global default PUBLIC EXECUTE privilege.
alter default privileges revoke execute on functions from public, anon, authenticated;
-- Supabase may also have explicit per-schema default grants to API roles.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

create schema if not exists esg_private;
alter default privileges in schema esg_private
  revoke execute on functions from public, anon, authenticated;
revoke all on schema esg_private from public, anon, authenticated;
-- Only authenticated RLS policies need helpers; do not expose this schema in
-- Supabase's Data API. No client role receives CREATE privileges here.
grant usage on schema esg_private to authenticated;

create or replace function esg_private.has_own_claim(p_gig_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.claims c
    where c.gig_id = p_gig_id and c.provider_id = auth.uid()
  );
$$;

create or replace function esg_private.is_gig_poster(p_gig_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.gigs g
    where g.id = p_gig_id and g.poster_id = auth.uid()
  );
$$;

-- CREATE OR REPLACE preserves an existing function's owner. Ensure helpers
-- always use the trusted migration role validated above, even on schema drift.
alter function esg_private.has_own_claim(uuid) owner to current_user;
alter function esg_private.is_gig_poster(uuid) owner to current_user;

revoke all on function esg_private.has_own_claim(uuid),
  esg_private.is_gig_poster(uuid) from public, anon, authenticated;
-- Each helper answers only a current-caller authorization question.
-- Separate public/participant policies avoid any need for anonymous EXECUTE.
grant execute on function esg_private.has_own_claim(uuid),
  esg_private.is_gig_poster(uuid) to authenticated;

drop policy gigs_select on public.gigs;
create policy gigs_select on public.gigs for select to anon, authenticated using (
  status = 'active'
);
create policy gigs_select_participants on public.gigs for select to authenticated using (
  poster_id = auth.uid()
  or selected_provider_id = auth.uid()
  or esg_private.has_own_claim(id)
);

drop policy claims_select on public.claims;
create policy claims_select on public.claims for select to authenticated using (
  provider_id = auth.uid()
  or esg_private.is_gig_poster(gig_id)
);

-- RLS controls rows; column privileges control which fields clients can edit.
-- Remove both table-level and any pre-existing column-level UPDATE grants.
do $$
declare
  v_table text;
  v_columns text;
begin
  foreach v_table in array array['profiles', 'chat_messages', 'notifications'] loop
    select pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' order by a.attnum)
    into v_columns
    from pg_catalog.pg_attribute a
    where a.attrelid = pg_catalog.to_regclass('public.' || v_table)
      and a.attnum > 0 and not a.attisdropped;
    execute pg_catalog.format(
      'revoke update on table public.%I from public, anon, authenticated', v_table
    );
    execute pg_catalog.format(
      'revoke update (%s) on table public.%I from public, anon, authenticated',
      v_columns, v_table
    );
  end loop;
end;
$$;

grant update (username, photo_url, skills, services) on public.profiles to authenticated;
grant update (read_at) on public.chat_messages to authenticated;
grant update (read) on public.notifications to authenticated;
-- Existing owner/participant RLS policies continue to restrict these updates.
-- Trusted function owners keep their ability to update counters and messages.

create or replace function public.create_claim(p_gig_id uuid) returns public.claims
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_claim public.claims;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null then
    raise exception 'Gig not found';
  end if;
  if v_gig.status <> 'active' then
    raise exception 'Gig is not open for claims';
  end if;
  if v_gig.poster_id = auth.uid() then
    raise exception 'You cannot claim your own gig';
  end if;

  insert into public.claims (gig_id, provider_id, state)
  values (p_gig_id, auth.uid(), 'pending')
  on conflict (gig_id, provider_id) do update set state = 'pending'
  returning * into v_claim;

  perform public.notify(v_gig.poster_id, p_gig_id, 'claim_received', 'You have a new claim on "' || v_gig.title || '"');
  return v_claim;
end;
$$;

create or replace function public.select_provider(p_gig_id uuid, p_claim_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_claim public.claims;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' then
    raise exception 'Gig is not in a selectable state';
  end if;

  select * into v_claim from public.claims where id = p_claim_id and gig_id = p_gig_id and state = 'pending';
  if v_claim is null then
    raise exception 'Claim not found or not actionable';
  end if;

  update public.claims set state = 'selected' where id = p_claim_id;
  update public.gigs set selected_provider_id = v_claim.provider_id where id = p_gig_id;

  perform public.notify(v_claim.provider_id, p_gig_id, 'selected', 'You were selected for "' || v_gig.title || '". Chat is now open.');
end;
$$;

create or replace function public.request_start(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.selected_provider_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' then
    raise exception 'Gig is not awaiting start';
  end if;

  update public.gigs set start_requested_at = now() where id = p_gig_id;
  perform public.notify(v_gig.poster_id, p_gig_id, 'start_requested', 'Your provider requested to start "' || v_gig.title || '"');
end;
$$;

create or replace function public.approve_start(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' or v_gig.start_requested_at is null then
    raise exception 'Gig is not awaiting start approval';
  end if;

  update public.gigs set status = 'in_progress', start_approved_at = now() where id = p_gig_id;
  perform public.notify(v_gig.selected_provider_id, p_gig_id, 'lets_go', '"' || v_gig.title || '" is now In Progress. Let''s go!');
end;
$$;

create or replace function public.submit_completion(p_gig_id uuid, p_outcome public.completion_outcome) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_poster_outcome public.completion_outcome;
  v_provider_outcome public.completion_outcome;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null or (auth.uid() is distinct from v_gig.poster_id and auth.uid() is distinct from v_gig.selected_provider_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'in_progress' then
    raise exception 'Gig is not In Progress';
  end if;

  insert into public.gig_completions (gig_id, user_id, outcome) values (p_gig_id, auth.uid(), p_outcome)
  on conflict (gig_id, user_id) do update set outcome = excluded.outcome;

  select outcome into v_poster_outcome from public.gig_completions where gig_id = p_gig_id and user_id = v_gig.poster_id;
  select outcome into v_provider_outcome from public.gig_completions where gig_id = p_gig_id and user_id = v_gig.selected_provider_id;

  if v_poster_outcome is null or v_provider_outcome is null then
    return; -- waiting on the other party
  end if;

  if v_poster_outcome = 'complete' and v_provider_outcome = 'complete' then
    update public.gigs set status = 'awaiting_payment', resolution_path = 'complete' where id = p_gig_id;
    perform public.notify(v_gig.poster_id, p_gig_id, 'awaiting_payment', 'Both sides marked "' || v_gig.title || '" complete. Enter the payment amount.');
    perform public.notify(v_gig.selected_provider_id, p_gig_id, 'awaiting_payment', 'Both sides marked "' || v_gig.title || '" complete. Enter the payment amount.');
  elsif v_poster_outcome = 'incomplete' and v_provider_outcome = 'incomplete' then
    update public.gigs set incomplete_choice_phase = true where id = p_gig_id;
    perform public.notify(v_gig.poster_id, p_gig_id, 'choose_pay_type', 'Both sides marked "' || v_gig.title || '" incomplete. Choose Partial Pay or No Pay.');
    perform public.notify(v_gig.selected_provider_id, p_gig_id, 'choose_pay_type', 'Both sides marked "' || v_gig.title || '" incomplete. Choose Partial Pay or No Pay.');
  else
    update public.gigs set status = 'disputed' where id = p_gig_id;
    insert into public.disputes (gig_id, trigger_type) values (p_gig_id, 'completion_status_mismatch');
    perform public.notify(v_gig.poster_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (completion status mismatch).');
    perform public.notify(v_gig.selected_provider_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (completion status mismatch).');
  end if;
end;
$$;

create or replace function public.submit_incomplete_choice(p_gig_id uuid, p_choice public.incomplete_choice) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_poster_choice public.incomplete_choice;
  v_provider_choice public.incomplete_choice;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null or (auth.uid() is distinct from v_gig.poster_id and auth.uid() is distinct from v_gig.selected_provider_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'in_progress' then
    raise exception 'Gig is not awaiting incomplete resolution';
  end if;

  insert into public.gig_incomplete_choices (gig_id, user_id, choice) values (p_gig_id, auth.uid(), p_choice)
  on conflict (gig_id, user_id) do update set choice = excluded.choice;

  select choice into v_poster_choice from public.gig_incomplete_choices where gig_id = p_gig_id and user_id = v_gig.poster_id;
  select choice into v_provider_choice from public.gig_incomplete_choices where gig_id = p_gig_id and user_id = v_gig.selected_provider_id;

  if v_poster_choice is null or v_provider_choice is null then
    return;
  end if;

  if v_poster_choice = 'no_pay' and v_provider_choice = 'no_pay' then
    update public.gigs set status = 'incomplete' where id = p_gig_id;
    perform public.notify(v_gig.poster_id, p_gig_id, 'incomplete', '"' || v_gig.title || '" resolved as Incomplete (No Pay).');
    perform public.notify(v_gig.selected_provider_id, p_gig_id, 'incomplete', '"' || v_gig.title || '" resolved as Incomplete (No Pay).');
  elsif v_poster_choice = 'partial_pay' and v_provider_choice = 'partial_pay' then
    update public.gigs set status = 'awaiting_payment', resolution_path = 'partial_pay' where id = p_gig_id;
    perform public.notify(v_gig.poster_id, p_gig_id, 'awaiting_payment', 'Both sides agreed to Partial Pay on "' || v_gig.title || '". Enter the payment amount.');
    perform public.notify(v_gig.selected_provider_id, p_gig_id, 'awaiting_payment', 'Both sides agreed to Partial Pay on "' || v_gig.title || '". Enter the payment amount.');
  else
    update public.gigs set status = 'disputed' where id = p_gig_id;
    insert into public.disputes (gig_id, trigger_type) values (p_gig_id, 'incomplete_pay_type_mismatch');
    perform public.notify(v_gig.poster_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (partial pay / no pay mismatch).');
    perform public.notify(v_gig.selected_provider_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (partial pay / no pay mismatch).');
  end if;
end;
$$;

create or replace function public.submit_payment_amount(p_gig_id uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_final_status public.gig_status;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null or (auth.uid() is distinct from v_gig.poster_id and auth.uid() is distinct from v_gig.selected_provider_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'awaiting_payment' then
    raise exception 'Gig is not awaiting payment entry';
  end if;
  if p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;

  if auth.uid() = v_gig.poster_id then
    update public.gigs set amount_paid = p_amount where id = p_gig_id;
  else
    update public.gigs set amount_received = p_amount where id = p_gig_id;
  end if;

  select * into v_gig from public.gigs where id = p_gig_id;
  if v_gig.amount_paid is null or v_gig.amount_received is null then
    return; -- waiting on the other party
  end if;

  if v_gig.amount_paid = v_gig.amount_received then
    v_final_status := case when v_gig.resolution_path = 'complete' then 'completed' else 'incomplete' end;
    update public.gigs set status = v_final_status where id = p_gig_id;
    if v_final_status = 'completed' or v_gig.resolution_path = 'partial_pay' then
      update public.profiles set money_made = money_made + v_gig.amount_received where id = v_gig.selected_provider_id;
    end if;
    perform public.notify(v_gig.poster_id, p_gig_id, 'resolved', '"' || v_gig.title || '" resolved as ' || v_final_status || '.');
    perform public.notify(v_gig.selected_provider_id, p_gig_id, 'resolved', '"' || v_gig.title || '" resolved as ' || v_final_status || '.');
  else
    update public.gigs set status = 'disputed' where id = p_gig_id;
    insert into public.disputes (gig_id, trigger_type) values (p_gig_id, 'payment_amount_mismatch');
    perform public.notify(v_gig.poster_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (payment amount mismatch).');
    perform public.notify(v_gig.selected_provider_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (payment amount mismatch).');
  end if;
end;
$$;

create or replace function public.submit_feedback(p_gig_id uuid, p_type public.feedback_type) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
  v_to_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null or (auth.uid() is distinct from v_gig.poster_id and auth.uid() is distinct from v_gig.selected_provider_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status not in ('completed', 'incomplete') then
    raise exception 'Gig is not resolved yet';
  end if;

  v_to_id := case when auth.uid() = v_gig.poster_id then v_gig.selected_provider_id else v_gig.poster_id end;

  insert into public.feedback (gig_id, from_id, to_id, type) values (p_gig_id, auth.uid(), v_to_id, p_type)
  on conflict (gig_id, from_id) do nothing;

  if p_type = 'wom' then
    update public.profiles set wom_count = wom_count + 1 where id = v_to_id;
  elsif p_type = 'lemon' then
    update public.profiles set lemon_count = lemon_count + 1 where id = v_to_id;
  end if;
end;
$$;

create or replace function public.publish_gig(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'draft' then
    raise exception 'Gig is not a draft';
  end if;
  update public.gigs set status = 'active' where id = p_gig_id;
end;
$$;

create or replace function public.cancel_gig(p_gig_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_gig public.gigs;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.poster_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status <> 'active' or v_gig.selected_provider_id is not null then
    raise exception 'Gig cannot be cancelled in its current state';
  end if;
  update public.gigs set status = 'cancelled' where id = p_gig_id;
  update public.claims set state = 'rejected' where gig_id = p_gig_id and state = 'pending';
end;
$$;

create or replace function public.get_public_stats(p_profile_id uuid) returns table(gigs_worked_count bigint, wom_count int)
language sql security definer set search_path = '' stable as $$
  select
    (select count(*) from public.gigs where selected_provider_id = p_profile_id and status in ('completed', 'incomplete')),
    (select p.wom_count from public.profiles p where p.id = p_profile_id);
$$;

-- Explicit permissions on every SECURITY DEFINER function in 0001.
revoke execute on function
  public.create_claim(uuid),
  public.select_provider(uuid, uuid),
  public.request_start(uuid),
  public.approve_start(uuid),
  public.submit_completion(uuid, public.completion_outcome),
  public.submit_incomplete_choice(uuid, public.incomplete_choice),
  public.submit_payment_amount(uuid, numeric),
  public.submit_feedback(uuid, public.feedback_type),
  public.publish_gig(uuid),
  public.cancel_gig(uuid)
from public, anon, authenticated;

grant execute on function
  public.create_claim(uuid),
  public.select_provider(uuid, uuid),
  public.request_start(uuid),
  public.approve_start(uuid),
  public.submit_completion(uuid, public.completion_outcome),
  public.submit_incomplete_choice(uuid, public.incomplete_choice),
  public.submit_payment_amount(uuid, numeric),
  public.submit_feedback(uuid, public.feedback_type),
  public.publish_gig(uuid),
  public.cancel_gig(uuid)
to authenticated;

-- Preserve the aggregate-only guest-facing public stats API.
revoke execute on function public.get_public_stats(uuid) from public, anon, authenticated;
grant execute on function public.get_public_stats(uuid) to anon, authenticated;

-- Trigger execution is unaffected by revoking clients' direct EXECUTE.
-- RPCs execute as their trusted owner and can still call notify internally.
revoke execute on function public.notify(uuid, uuid, text, text),
  public.sync_public_profile(), public.handle_new_user()
from public, anon, authenticated;

-- Fully qualify internal helper/trigger references with an empty search_path.
create or replace function public.sync_public_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.public_profiles (id, username, photo_url, skills, wom_count)
  values (new.id, new.username, new.photo_url, new.skills, new.wom_count)
  on conflict (id) do update set
    username = excluded.username,
    photo_url = excluded.photo_url,
    skills = excluded.skills,
    wom_count = excluded.wom_count;
  return new;
end;
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8)));
  return new;
end;
$$;

create or replace function public.notify(p_recipient uuid, p_gig uuid, p_type text, p_message text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (recipient_id, gig_id, type, message)
  values (p_recipient, p_gig, p_type, p_message);
end;
$$;

commit;
