-- Tell the poster when the helper adds proof photos.
--
-- Redefines add_proof_photo() (migration 0035) with one added step: after a new photo is recorded, the
-- poster gets a "photos added" update that opens the gig, where the photos are. It is sent once per
-- batch -- not again while an earlier one for the same gig is unread -- and not for a retry of a photo
-- that is already saved. Everything else in the function, its signature and its grants are unchanged.
begin;

create or replace function public.add_proof_photo(p_gig_id uuid, p_path text) returns public.gig_proof_photos
language plpgsql security definer set search_path = '' as $$
declare
  c_max constant int := 5;
  v_gig public.gigs;
  v_row public.gig_proof_photos;
  v_existed boolean;
  v_name text;
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

  v_existed := exists (select 1 from public.gig_proof_photos where storage_path = p_path);
  insert into public.gig_proof_photos (gig_id, uploader_id, storage_path)
  values (p_gig_id, auth.uid(), p_path)
  on conflict (storage_path) do update set storage_path = excluded.storage_path
  returning * into v_row;

  -- Tell the poster, once per batch: not for a retry of a photo that is already saved, and not while
  -- an earlier "photos added" update for this gig is still unread (five photos is one nudge, not five).
  if not v_existed and not exists (
    select 1 from public.notifications
    where recipient_id = v_gig.poster_id and gig_id = p_gig_id and type = 'proof_photos' and not read
  ) then
    select username into v_name from public.public_profiles where id = auth.uid();
    perform public.notify(v_gig.poster_id, p_gig_id, 'proof_photos',
      '@' || coalesce(v_name, 'Your helper') || ' added photos of the finished work for "' || v_gig.title || '".');
  end if;
  return v_row;
end;
$$;

commit;
