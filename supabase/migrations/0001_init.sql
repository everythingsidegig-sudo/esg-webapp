-- ESG MVP schema: tables, RLS policies, and state-transition RPC functions.
-- Design notes:
--   * profiles holds private fields (lemon_count, money_made, services); public_profiles
--     is a separate real table (kept in sync by trigger) holding only public-safe columns,
--     so RLS can allow public_profiles to be read by anyone without ever exposing private
--     columns through the same row.
--   * All state-changing actions (claim, select, start handshake, complete/incomplete,
--     payment amounts, feedback) go through SECURITY DEFINER functions rather than raw
--     table writes from the client, so invariants are enforced server-side and atomically.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type gig_status as enum (
  'draft', 'active', 'in_progress', 'awaiting_payment',
  'completed', 'incomplete', 'disputed', 'cancelled'
);
create type price_type as enum ('fixed', 'negotiable');
create type claim_state as enum ('pending', 'selected', 'rejected', 'withdrawn');
create type completion_outcome as enum ('complete', 'incomplete');
create type incomplete_choice as enum ('partial_pay', 'no_pay');
create type feedback_type as enum ('wom', 'lemon', 'skip');
create type resolution_path as enum ('complete', 'partial_pay');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  photo_url text,
  skills jsonb not null default '[]'::jsonb,
  services jsonb not null default '[]'::jsonb,
  wom_count int not null default 0,
  lemon_count int not null default 0,
  money_made numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create table public_profiles (
  id uuid primary key references profiles(id) on delete cascade,
  username text not null,
  photo_url text,
  skills jsonb not null default '[]'::jsonb,
  wom_count int not null default 0
);

create table gigs (
  id uuid primary key default gen_random_uuid(),
  poster_id uuid not null references profiles(id),
  service_type text not null,
  title text not null,
  description text not null,
  photo_url text,
  amount numeric(12,2) not null check (amount > 0),
  price_type price_type not null default 'fixed',
  scheduled_at timestamptz,
  location_text text,
  lat double precision,
  lng double precision,
  status gig_status not null default 'draft',
  selected_provider_id uuid references profiles(id),
  start_requested_at timestamptz,
  start_approved_at timestamptz,
  resolution_path resolution_path,
  incomplete_choice_phase boolean not null default false,
  amount_paid numeric(12,2),
  amount_received numeric(12,2),
  created_at timestamptz not null default now()
);

create table claims (
  id uuid primary key default gen_random_uuid(),
  gig_id uuid not null references gigs(id) on delete cascade,
  provider_id uuid not null references profiles(id),
  state claim_state not null default 'pending',
  created_at timestamptz not null default now(),
  unique (gig_id, provider_id)
);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  gig_id uuid not null references gigs(id) on delete cascade,
  sender_id uuid not null references profiles(id),
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create table gig_completions (
  gig_id uuid not null references gigs(id) on delete cascade,
  user_id uuid not null references profiles(id),
  outcome completion_outcome not null,
  created_at timestamptz not null default now(),
  primary key (gig_id, user_id)
);

create table gig_incomplete_choices (
  gig_id uuid not null references gigs(id) on delete cascade,
  user_id uuid not null references profiles(id),
  choice incomplete_choice not null,
  created_at timestamptz not null default now(),
  primary key (gig_id, user_id)
);

create table feedback (
  id uuid primary key default gen_random_uuid(),
  gig_id uuid not null references gigs(id) on delete cascade,
  from_id uuid not null references profiles(id),
  to_id uuid not null references profiles(id),
  type feedback_type not null,
  created_at timestamptz not null default now(),
  unique (gig_id, from_id)
);

create table disputes (
  id uuid primary key default gen_random_uuid(),
  gig_id uuid not null unique references gigs(id) on delete cascade,
  trigger_type text not null,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references profiles(id),
  gig_id uuid references gigs(id) on delete cascade,
  type text not null,
  message text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index on gigs (status);
create index on gigs (poster_id);
create index on gigs (selected_provider_id);
create index on claims (gig_id);
create index on claims (provider_id);
create index on chat_messages (gig_id, created_at);
create index on notifications (recipient_id, read);

-- ---------------------------------------------------------------------------
-- Keep public_profiles in sync with profiles (public-safe columns only)
-- ---------------------------------------------------------------------------
create function sync_public_profile() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public_profiles (id, username, photo_url, skills, wom_count)
  values (new.id, new.username, new.photo_url, new.skills, new.wom_count)
  on conflict (id) do update set
    username = excluded.username,
    photo_url = excluded.photo_url,
    skills = excluded.skills,
    wom_count = excluded.wom_count;
  return new;
end;
$$;

create trigger trg_sync_public_profile
after insert or update on profiles
for each row execute function sync_public_profile();

-- Auto-create profile + public_profile rows when a new auth user signs up.
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8)));
  return new;
end;
$$;

create trigger trg_handle_new_user
after insert on auth.users
for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table profiles enable row level security;
alter table public_profiles enable row level security;
alter table gigs enable row level security;
alter table claims enable row level security;
alter table chat_messages enable row level security;
alter table gig_completions enable row level security;
alter table gig_incomplete_choices enable row level security;
alter table feedback enable row level security;
alter table disputes enable row level security;
alter table notifications enable row level security;

-- profiles: owner-only, full row (private fields live here)
create policy "profiles_select_own" on profiles for select using (id = auth.uid());
create policy "profiles_update_own" on profiles for update using (id = auth.uid());

-- public_profiles: readable by anyone (anon included), never writable directly
create policy "public_profiles_select_all" on public_profiles for select using (true);

-- gigs: public can see Active gigs; participants (poster/selected provider/claimant) see their own regardless of status
create policy "gigs_select" on gigs for select using (
  status = 'active'
  or poster_id = auth.uid()
  or selected_provider_id = auth.uid()
  or exists (select 1 from claims c where c.gig_id = gigs.id and c.provider_id = auth.uid())
);
create policy "gigs_insert_own" on gigs for insert with check (
  poster_id = auth.uid() and status in ('draft', 'active') and selected_provider_id is null
);
-- Direct client edits are only allowed pre-selection (editing a Draft/Active gig's own fields).
-- Once selected_provider_id is set, every further transition must go through a SECURITY DEFINER
-- RPC (those bypass RLS as the function/table owner) — this policy's WITH CHECK forbids a client
-- from setting selected_provider_id (or any post-selection field) directly.
create policy "gigs_update_own_draft_or_active_edit" on gigs for update using (
  poster_id = auth.uid() and status in ('draft', 'active') and selected_provider_id is null
) with check (
  poster_id = auth.uid() and status in ('draft', 'active') and selected_provider_id is null
);
create policy "gigs_delete_own_draft" on gigs for delete using (
  poster_id = auth.uid() and status = 'draft'
);

-- claims: visible to the gig's poster and the claiming provider; writes go through RPCs only
create policy "claims_select" on claims for select using (
  provider_id = auth.uid()
  or exists (select 1 from gigs g where g.id = claims.gig_id and g.poster_id = auth.uid())
);

-- chat_messages: only poster + selected provider on that gig, and only while the gig is active/in_progress
create policy "chat_select" on chat_messages for select using (
  exists (
    select 1 from gigs g where g.id = chat_messages.gig_id
    and (g.poster_id = auth.uid() or g.selected_provider_id = auth.uid())
  )
);
create policy "chat_insert" on chat_messages for insert with check (
  sender_id = auth.uid()
  and exists (
    select 1 from gigs g where g.id = chat_messages.gig_id
    and g.status in ('active', 'in_progress')
    and (g.poster_id = auth.uid() or g.selected_provider_id = auth.uid())
    and g.selected_provider_id is not null
  )
);
create policy "chat_update_own_read" on chat_messages for update using (
  exists (
    select 1 from gigs g where g.id = chat_messages.gig_id
    and (g.poster_id = auth.uid() or g.selected_provider_id = auth.uid())
  )
);

-- gig_completions / gig_incomplete_choices: hidden from the other party; writes via RPC only
create policy "completions_select_own" on gig_completions for select using (user_id = auth.uid());
create policy "incomplete_choices_select_own" on gig_incomplete_choices for select using (user_id = auth.uid());

-- feedback: only the giver can read their own submission; writes via RPC only
create policy "feedback_select_own" on feedback for select using (from_id = auth.uid());

-- disputes: visible to the gig's poster/selected provider
create policy "disputes_select" on disputes for select using (
  exists (
    select 1 from gigs g where g.id = disputes.gig_id
    and (g.poster_id = auth.uid() or g.selected_provider_id = auth.uid())
  )
);

-- notifications: owner-only, can mark read
create policy "notifications_select_own" on notifications for select using (recipient_id = auth.uid());
create policy "notifications_update_own" on notifications for update using (recipient_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Helper: internal notification insert (not exposed directly to clients)
-- ---------------------------------------------------------------------------
create function notify(p_recipient uuid, p_gig uuid, p_type text, p_message text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into notifications (recipient_id, gig_id, type, message)
  values (p_recipient, p_gig, p_type, p_message);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: create_claim — Provider claims a fixed-price Active gig at the posted price
-- ---------------------------------------------------------------------------
create function create_claim(p_gig_id uuid) returns claims
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gig gigs;
  v_claim claims;
begin
  select * into v_gig from gigs where id = p_gig_id for update;
  if v_gig is null then
    raise exception 'Gig not found';
  end if;
  if v_gig.status <> 'active' then
    raise exception 'Gig is not open for claims';
  end if;
  if v_gig.poster_id = auth.uid() then
    raise exception 'You cannot claim your own gig';
  end if;

  insert into claims (gig_id, provider_id, state)
  values (p_gig_id, auth.uid(), 'pending')
  on conflict (gig_id, provider_id) do update set state = 'pending'
  returning * into v_claim;

  perform notify(v_gig.poster_id, p_gig_id, 'claim_received', 'You have a new claim on "' || v_gig.title || '"');
  return v_claim;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: select_provider — Poster selects one claimant; Chat opens immediately
-- ---------------------------------------------------------------------------
create function select_provider(p_gig_id uuid, p_claim_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gig gigs;
  v_claim claims;
begin
  select * into v_gig from gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.poster_id <> auth.uid() then
    raise exception 'Not authorized';
  end if;
  if v_gig.status <> 'active' then
    raise exception 'Gig is not in a selectable state';
  end if;

  select * into v_claim from claims where id = p_claim_id and gig_id = p_gig_id and state = 'pending';
  if v_claim is null then
    raise exception 'Claim not found or not actionable';
  end if;

  update claims set state = 'selected' where id = p_claim_id;
  update gigs set selected_provider_id = v_claim.provider_id where id = p_gig_id;

  perform notify(v_claim.provider_id, p_gig_id, 'selected', 'You were selected for "' || v_gig.title || '". Chat is now open.');
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: request_start — selected Provider requests to start work
-- ---------------------------------------------------------------------------
create function request_start(p_gig_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gig gigs;
begin
  select * into v_gig from gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.selected_provider_id <> auth.uid() then
    raise exception 'Not authorized';
  end if;
  if v_gig.status <> 'active' then
    raise exception 'Gig is not awaiting start';
  end if;

  update gigs set start_requested_at = now() where id = p_gig_id;
  perform notify(v_gig.poster_id, p_gig_id, 'start_requested', 'Your provider requested to start "' || v_gig.title || '"');
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: approve_start — Poster approves ("LET'S GO"); gig goes In Progress
-- ---------------------------------------------------------------------------
create function approve_start(p_gig_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gig gigs;
begin
  select * into v_gig from gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.poster_id <> auth.uid() then
    raise exception 'Not authorized';
  end if;
  if v_gig.status <> 'active' or v_gig.start_requested_at is null then
    raise exception 'Gig is not awaiting start approval';
  end if;

  update gigs set status = 'in_progress', start_approved_at = now() where id = p_gig_id;
  perform notify(v_gig.selected_provider_id, p_gig_id, 'lets_go', '"' || v_gig.title || '" is now In Progress. Let''s go!');
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: submit_completion — either party marks Complete/Incomplete
-- ---------------------------------------------------------------------------
create function submit_completion(p_gig_id uuid, p_outcome completion_outcome) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gig gigs;
  v_poster_outcome completion_outcome;
  v_provider_outcome completion_outcome;
begin
  select * into v_gig from gigs where id = p_gig_id for update;
  if v_gig is null or auth.uid() not in (v_gig.poster_id, v_gig.selected_provider_id) then
    raise exception 'Not authorized';
  end if;
  if v_gig.status <> 'in_progress' then
    raise exception 'Gig is not In Progress';
  end if;

  insert into gig_completions (gig_id, user_id, outcome) values (p_gig_id, auth.uid(), p_outcome)
  on conflict (gig_id, user_id) do update set outcome = excluded.outcome;

  select outcome into v_poster_outcome from gig_completions where gig_id = p_gig_id and user_id = v_gig.poster_id;
  select outcome into v_provider_outcome from gig_completions where gig_id = p_gig_id and user_id = v_gig.selected_provider_id;

  if v_poster_outcome is null or v_provider_outcome is null then
    return; -- waiting on the other party
  end if;

  if v_poster_outcome = 'complete' and v_provider_outcome = 'complete' then
    update gigs set status = 'awaiting_payment', resolution_path = 'complete' where id = p_gig_id;
    perform notify(v_gig.poster_id, p_gig_id, 'awaiting_payment', 'Both sides marked "' || v_gig.title || '" complete. Enter the payment amount.');
    perform notify(v_gig.selected_provider_id, p_gig_id, 'awaiting_payment', 'Both sides marked "' || v_gig.title || '" complete. Enter the payment amount.');
  elsif v_poster_outcome = 'incomplete' and v_provider_outcome = 'incomplete' then
    update gigs set incomplete_choice_phase = true where id = p_gig_id;
    perform notify(v_gig.poster_id, p_gig_id, 'choose_pay_type', 'Both sides marked "' || v_gig.title || '" incomplete. Choose Partial Pay or No Pay.');
    perform notify(v_gig.selected_provider_id, p_gig_id, 'choose_pay_type', 'Both sides marked "' || v_gig.title || '" incomplete. Choose Partial Pay or No Pay.');
  else
    update gigs set status = 'disputed' where id = p_gig_id;
    insert into disputes (gig_id, trigger_type) values (p_gig_id, 'completion_status_mismatch');
    perform notify(v_gig.poster_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (completion status mismatch).');
    perform notify(v_gig.selected_provider_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (completion status mismatch).');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: submit_incomplete_choice — when both sides marked Incomplete
-- ---------------------------------------------------------------------------
create function submit_incomplete_choice(p_gig_id uuid, p_choice incomplete_choice) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gig gigs;
  v_poster_choice incomplete_choice;
  v_provider_choice incomplete_choice;
begin
  select * into v_gig from gigs where id = p_gig_id for update;
  if v_gig is null or auth.uid() not in (v_gig.poster_id, v_gig.selected_provider_id) then
    raise exception 'Not authorized';
  end if;
  if v_gig.status <> 'in_progress' then
    raise exception 'Gig is not awaiting incomplete resolution';
  end if;

  insert into gig_incomplete_choices (gig_id, user_id, choice) values (p_gig_id, auth.uid(), p_choice)
  on conflict (gig_id, user_id) do update set choice = excluded.choice;

  select choice into v_poster_choice from gig_incomplete_choices where gig_id = p_gig_id and user_id = v_gig.poster_id;
  select choice into v_provider_choice from gig_incomplete_choices where gig_id = p_gig_id and user_id = v_gig.selected_provider_id;

  if v_poster_choice is null or v_provider_choice is null then
    return;
  end if;

  if v_poster_choice = 'no_pay' and v_provider_choice = 'no_pay' then
    update gigs set status = 'incomplete' where id = p_gig_id;
    perform notify(v_gig.poster_id, p_gig_id, 'incomplete', '"' || v_gig.title || '" resolved as Incomplete (No Pay).');
    perform notify(v_gig.selected_provider_id, p_gig_id, 'incomplete', '"' || v_gig.title || '" resolved as Incomplete (No Pay).');
  elsif v_poster_choice = 'partial_pay' and v_provider_choice = 'partial_pay' then
    update gigs set status = 'awaiting_payment', resolution_path = 'partial_pay' where id = p_gig_id;
    perform notify(v_gig.poster_id, p_gig_id, 'awaiting_payment', 'Both sides agreed to Partial Pay on "' || v_gig.title || '". Enter the payment amount.');
    perform notify(v_gig.selected_provider_id, p_gig_id, 'awaiting_payment', 'Both sides agreed to Partial Pay on "' || v_gig.title || '". Enter the payment amount.');
  else
    update gigs set status = 'disputed' where id = p_gig_id;
    insert into disputes (gig_id, trigger_type) values (p_gig_id, 'incomplete_pay_type_mismatch');
    perform notify(v_gig.poster_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (partial pay / no pay mismatch).');
    perform notify(v_gig.selected_provider_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (partial pay / no pay mismatch).');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: submit_payment_amount — Poster enters Amount Paid, Provider enters Amount Received
-- ---------------------------------------------------------------------------
create function submit_payment_amount(p_gig_id uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gig gigs;
  v_final_status gig_status;
begin
  select * into v_gig from gigs where id = p_gig_id for update;
  if v_gig is null or auth.uid() not in (v_gig.poster_id, v_gig.selected_provider_id) then
    raise exception 'Not authorized';
  end if;
  if v_gig.status <> 'awaiting_payment' then
    raise exception 'Gig is not awaiting payment entry';
  end if;
  if p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;

  if auth.uid() = v_gig.poster_id then
    update gigs set amount_paid = p_amount where id = p_gig_id;
  else
    update gigs set amount_received = p_amount where id = p_gig_id;
  end if;

  select * into v_gig from gigs where id = p_gig_id;
  if v_gig.amount_paid is null or v_gig.amount_received is null then
    return; -- waiting on the other party
  end if;

  if v_gig.amount_paid = v_gig.amount_received then
    v_final_status := case when v_gig.resolution_path = 'complete' then 'completed' else 'incomplete' end;
    update gigs set status = v_final_status where id = p_gig_id;
    if v_final_status = 'completed' or v_gig.resolution_path = 'partial_pay' then
      update profiles set money_made = money_made + v_gig.amount_received where id = v_gig.selected_provider_id;
    end if;
    perform notify(v_gig.poster_id, p_gig_id, 'resolved', '"' || v_gig.title || '" resolved as ' || v_final_status || '.');
    perform notify(v_gig.selected_provider_id, p_gig_id, 'resolved', '"' || v_gig.title || '" resolved as ' || v_final_status || '.');
  else
    update gigs set status = 'disputed' where id = p_gig_id;
    insert into disputes (gig_id, trigger_type) values (p_gig_id, 'payment_amount_mismatch');
    perform notify(v_gig.poster_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (payment amount mismatch).');
    perform notify(v_gig.selected_provider_id, p_gig_id, 'disputed', '"' || v_gig.title || '" is under dispute (payment amount mismatch).');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: submit_feedback — WOM / Lemon / Skip, one per side, final
-- ---------------------------------------------------------------------------
create function submit_feedback(p_gig_id uuid, p_type feedback_type) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gig gigs;
  v_to_id uuid;
begin
  select * into v_gig from gigs where id = p_gig_id for update;
  if v_gig is null or auth.uid() not in (v_gig.poster_id, v_gig.selected_provider_id) then
    raise exception 'Not authorized';
  end if;
  if v_gig.status not in ('completed', 'incomplete') then
    raise exception 'Gig is not resolved yet';
  end if;

  v_to_id := case when auth.uid() = v_gig.poster_id then v_gig.selected_provider_id else v_gig.poster_id end;

  insert into feedback (gig_id, from_id, to_id, type) values (p_gig_id, auth.uid(), v_to_id, p_type)
  on conflict (gig_id, from_id) do nothing;

  if p_type = 'wom' then
    update profiles set wom_count = wom_count + 1 where id = v_to_id;
  elsif p_type = 'lemon' then
    update profiles set lemon_count = lemon_count + 1 where id = v_to_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: mark_gig_active — publish a Draft gig
-- ---------------------------------------------------------------------------
create function publish_gig(p_gig_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gig gigs;
begin
  select * into v_gig from gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.poster_id <> auth.uid() then
    raise exception 'Not authorized';
  end if;
  if v_gig.status <> 'draft' then
    raise exception 'Gig is not a draft';
  end if;
  update gigs set status = 'active' where id = p_gig_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: cancel_gig — Poster cancels a Draft/Active (no-claims-selected) gig
-- ---------------------------------------------------------------------------
create function cancel_gig(p_gig_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gig gigs;
begin
  select * into v_gig from gigs where id = p_gig_id for update;
  if v_gig is null or v_gig.poster_id <> auth.uid() then
    raise exception 'Not authorized';
  end if;
  if v_gig.status <> 'active' or v_gig.selected_provider_id is not null then
    raise exception 'Gig cannot be cancelled in its current state';
  end if;
  update gigs set status = 'cancelled' where id = p_gig_id;
  update claims set state = 'rejected' where gig_id = p_gig_id and state = 'pending';
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: get_public_stats — aggregate-only public stats (no row-level private data ever exposed)
-- ---------------------------------------------------------------------------
create function get_public_stats(p_profile_id uuid) returns table(gigs_worked_count bigint, wom_count int)
language sql security definer set search_path = public, pg_temp stable as $$
  select
    (select count(*) from gigs where selected_provider_id = p_profile_id and status in ('completed', 'incomplete')),
    (select p.wom_count from profiles p where p.id = p_profile_id);
$$;

-- ---------------------------------------------------------------------------
-- Realtime: enable replication on tables the UI subscribes to
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table gigs;
alter publication supabase_realtime add table chat_messages;
alter publication supabase_realtime add table notifications;
alter publication supabase_realtime add table claims;

-- ---------------------------------------------------------------------------
-- Storage buckets: profile photos and gig photos (public read, owner-only write)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('profile-photos', 'profile-photos', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('gig-photos', 'gig-photos', true)
  on conflict (id) do nothing;

create policy "profile_photos_public_read" on storage.objects for select using (bucket_id = 'profile-photos');
create policy "profile_photos_owner_write" on storage.objects for insert with check (
  bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "profile_photos_owner_update" on storage.objects for update using (
  bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "gig_photos_public_read" on storage.objects for select using (bucket_id = 'gig-photos');
create policy "gig_photos_owner_write" on storage.objects for insert with check (
  bucket_id = 'gig-photos' and (storage.foldername(name))[1] = auth.uid()::text
);
