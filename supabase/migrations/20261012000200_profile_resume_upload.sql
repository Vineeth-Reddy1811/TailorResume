-- Save an extracted profile with the new default resume in one transaction.
-- No existing profile data is backfilled; a fresh profile is created on the
-- next resume upload, while previously learned skills are preserved.

drop function if exists public.replace_default_resume(text, text, text, bigint, text);

create function public.replace_default_resume(
  p_display_name text,
  p_original_file_name text,
  p_object_key text,
  p_file_size_bytes bigint,
  p_sha256 text,
  p_experience_profile jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_new_resume public.resumes%rowtype;
  v_replaced_resumes jsonb;
  v_current_profile jsonb;
  v_merged_skills jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if (storage.foldername(p_object_key))[1] is distinct from v_user_id::text then
    raise exception 'Resume object key must belong to the signed-in user';
  end if;
  if pg_catalog.jsonb_typeof(p_experience_profile) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_experience_profile -> 'facts') is distinct from 'array'
     or pg_catalog.jsonb_typeof(p_experience_profile -> 'verifiedSkills') is distinct from 'array'
     or p_experience_profile ->> 'sourceSha256' is distinct from p_sha256
     or pg_catalog.pg_column_size(p_experience_profile) > 1048576 then
    raise exception 'Invalid extracted resume profile';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 0));
  if exists (
    select 1 from public.tailoring_runs run
    join public.resumes resume on resume.id = run.source_resume_id and resume.user_id = run.user_id
    where run.user_id = v_user_id and resume.deleted_at is null
      and run.status in ('queued', 'running')
  ) then
    raise exception 'A tailoring run is using the current resume' using errcode = '55000';
  end if;

  select profile_data into v_current_profile
    from public.experience_profiles where user_id = v_user_id for update;
  if not found
     or pg_catalog.jsonb_typeof(v_current_profile -> 'verifiedSkills') is distinct from 'array' then
    raise exception 'Experience profile row is missing or invalid';
  end if;
  select coalesce(pg_catalog.jsonb_agg(skill order by skill ->> 'canonical'), '[]'::jsonb)
    into v_merged_skills
    from (
      select distinct on (pg_catalog.lower(item ->> 'canonical')) item as skill
      from (
        select value as item, 0 as priority
          from pg_catalog.jsonb_array_elements(v_current_profile -> 'verifiedSkills')
        union all
        select value as item, 1 as priority
          from pg_catalog.jsonb_array_elements(p_experience_profile -> 'verifiedSkills')
      ) candidates
      order by pg_catalog.lower(item ->> 'canonical'), priority desc
    ) unique_skills;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'object_key', object_key)), '[]'::jsonb)
    into v_replaced_resumes
    from public.resumes where user_id = v_user_id and deleted_at is null;
  update public.resumes set is_default = false
    where user_id = v_user_id and is_default and deleted_at is null;
  insert into public.resumes (
    user_id, display_name, original_file_name, object_key,
    file_size_bytes, sha256, is_default
  ) values (
    v_user_id, p_display_name, p_original_file_name, p_object_key,
    p_file_size_bytes, p_sha256, true
  ) returning * into v_new_resume;

  update public.experience_profiles
    set profile_data = p_experience_profile || pg_catalog.jsonb_build_object('verifiedSkills', v_merged_skills)
    where user_id = v_user_id;
  if not found then raise exception 'Experience profile row is missing'; end if;

  return jsonb_build_object('resume', to_jsonb(v_new_resume), 'replaced', v_replaced_resumes);
end;
$$;

revoke all on function public.replace_default_resume(text, text, text, bigint, text, jsonb) from public, anon;
grant execute on function public.replace_default_resume(text, text, text, bigint, text, jsonb) to authenticated;
