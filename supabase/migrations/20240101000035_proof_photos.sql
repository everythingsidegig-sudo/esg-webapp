-- Proof / supporting photos from the helper, after they mark a gig complete.
--
--   * A PRIVATE storage bucket, 'proof-photos'. Unlike gig-photos and profile-photos (public read), a
--     photo taken while doing a job -- often at someone's home -- is readable only by the two people on
--     the gig. Files live at <gig id>/<uploader id>/<file>.
--   * gig_proof_photos: one row per photo. Written only by add_proof_photo() / remove_proof_photo();
--     the poster and the selected helper can read the rows.
--   * add_proof_photo(): only the selected helper, only once they have marked the gig complete, only
--     while the gig is in progress or finished, at most five photos, and only a file in their own
--     folder for this gig.
-- No existing function, table or policy is changed.
begin;

insert into storage.buckets (id, name, public) values ('proof-photos', 'proof-photos', false)
on conflict (id) do nothing;

-- Read: the poster and the selected helper of the gig named by the first folder.
create policy "proof_photos_participants_read" on storage.objects for select to authenticated using (
  bucket_id = 'proof-photos' and exists (
    select 1 from public.gigs g
    where g.id::text = (storage.foldername(name))[1]
      and (g.poster_id = auth.uid() or g.selected_provider_id = auth.uid())
  )
);
-- Upload: only the selected helper, only into their own folder under that gig.
create policy "proof_photos_helper_write" on storage.objects for insert to authenticated with check (
  bucket_id = 'proof-photos'
  and (storage.foldername(name))[2] = auth.uid()::text
  and exists (
    select 1 from public.gigs g
    where g.id::text = (storage.foldername(name))[1]
      and g.selected_provider_id = auth.uid()
      and g.status in ('in_progress', 'awaiting_payment', 'completed', 'incomplete')
  )
);
-- Remove: the uploader's own files.
create policy "proof_photos_owner_delete" on storage.objects for delete to authenticated using (
  bucket_id = 'proof-photos' and (storage.foldername(name))[2] = auth.uid()::text
);

create table public.gig_proof_photos (
  id uuid primary key default gen_random_uuid(),
  gig_id uuid not null references public.gigs(id) on delete cascade,
  uploader_id uuid not null references public.profiles(id),
  storage_path text not null unique,
  created_at timestamptz not null default now()
);
create index gig_proof_photos_gig_idx on public.gig_proof_photos (gig_id, created_at);

alter table public.gig_proof_photos enable row level security;
revoke all on table public.gig_proof_photos from public, anon, authenticated;
grant select on table public.gig_proof_photos to authenticated;
create policy "proof_photos_select_participants" on public.gig_proof_photos for select to authenticated using (
  exists (
    select 1 from public.gigs g
    where g.id = gig_proof_photos.gig_id and (g.poster_id = auth.uid() or g.selected_provider_id = auth.uid())
  )
);

create function public.add_proof_photo(p_gig_id uuid, p_path text) returns public.gig_proof_photos
language plpgsql security definer set search_path = '' as $$
declare
  c_max constant int := 5;
  v_gig public.gigs;
  v_row public.gig_proof_photos;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_gig from public.gigs where id = p_gig_id for update;
  if not found or v_gig.selected_provider_id is distinct from auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_gig.status not in ('in_progress', 'awaiting_payment', 'completed', 'incomplete') then
    raise exception 'Photos can be added once the gig has started.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.gig_completions where gig_id = p_gig_id and user_id = auth.uid() and outcome = 'complete') then
    raise exception 'Mark the gig complete before adding photos.' using errcode = '22023';
  end if;
  if p_path is null or pg_catalog.length(p_path) > 300
     or p_path !~ ('^' || p_gig_id::text || '/' || auth.uid()::text || '/[A-Za-z0-9._-]+$') then
    raise exception 'Invalid photo.' using errcode = '22023';
  end if;
  if (select pg_catalog.count(*) from public.gig_proof_photos where gig_id = p_gig_id and uploader_id = auth.uid()) >= c_max then
    raise exception 'You can add up to 5 photos.' using errcode = '22023';
  end if;

  insert into public.gig_proof_photos (gig_id, uploader_id, storage_path)
  values (p_gig_id, auth.uid(), p_path)
  on conflict (storage_path) do update set storage_path = excluded.storage_path
  returning * into v_row;
  return v_row;
end;
$$;

create function public.remove_proof_photo(p_photo_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  delete from public.gig_proof_photos where id = p_photo_id and uploader_id = auth.uid();
  if not found then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
end;
$$;

-- Authenticated users only; never anon or PUBLIC.
revoke execute on function public.add_proof_photo(uuid, text), public.remove_proof_photo(uuid) from public, anon, authenticated;
grant execute on function public.add_proof_photo(uuid, text), public.remove_proof_photo(uuid) to authenticated;

commit;
