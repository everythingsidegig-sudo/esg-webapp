-- Show the written comments left with a Lemon on a member's public profile.
--
-- Until now feedback comments (migration 0025) were visible only to their author (the feedback table's
-- own-rows policy). Product decision: a comment left with a Lemon is shown on the profile of the person
-- it is about. Deliberately minimal:
--   * Only comments left with a lemon, and only the text and the date -- never who wrote it or which
--     gig it was about, so neither the commenter nor the job is exposed.
--   * The Lemon COUNT stays private; profiles still show only the WOM percentage.
--   * Signed-in members only (the profile route already requires an account).
--   * The latest 10, newest first.
-- Nothing existing is changed: this is a new read-only function.
begin;

create function public.get_public_lemon_comments(p_profile_id uuid)
returns table(comment text, created_at timestamptz)
language sql security definer set search_path = '' stable as $$
  select f.comment, f.created_at
  from public.feedback f
  where f.to_id = p_profile_id and f.type = 'lemon' and f.comment is not null
  order by f.created_at desc
  limit 10;
$$;

revoke execute on function public.get_public_lemon_comments(uuid) from public, anon, authenticated;
grant execute on function public.get_public_lemon_comments(uuid) to authenticated;

commit;
