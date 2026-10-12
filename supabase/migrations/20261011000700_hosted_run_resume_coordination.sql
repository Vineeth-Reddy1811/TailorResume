-- Serialize hosted run creation with resume replacement and removal so a
-- queued job always retains the source resume it selected.

create or replace function public.replace_default_resume(
  p_display_name text,
  p_original_file_name text,
  p_object_key text,
  p_file_size_bytes bigint,
  p_sha256 text
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
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if (storage.foldername(p_object_key))[1] is distinct from v_user_id::text then
    raise exception 'Resume object key must belong to the signed-in user';
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
  return jsonb_build_object('resume', to_jsonb(v_new_resume), 'replaced', v_replaced_resumes);
end;
$$;

create or replace function public.create_hosted_tailoring_run(
  p_user_id uuid,
  p_run_id uuid,
  p_source_resume_id uuid,
  p_job_description text,
  p_provider text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.tailoring_runs%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));
  if not exists (
    select 1 from public.resumes
    where id = p_source_resume_id and user_id = p_user_id
      and is_default and deleted_at is null
  ) then
    raise exception 'Default resume changed' using errcode = 'P0002';
  end if;
  insert into public.tailoring_runs (
    id, user_id, source_resume_id, status, job_description,
    provider, model, ai_consent_at
  ) values (
    p_run_id, p_user_id, p_source_resume_id, 'queued', p_job_description,
    p_provider, p_model, pg_catalog.now()
  ) returning * into v_run;
  return pg_catalog.to_jsonb(v_run);
end;
$$;

revoke all on function public.create_hosted_tailoring_run(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.create_hosted_tailoring_run(uuid, uuid, uuid, text, text, text) to service_role;

create or replace function public.mark_hosted_resume_deleted(
  p_user_id uuid,
  p_resume_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resume public.resumes%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));
  select * into v_resume from public.resumes
    where id = p_resume_id and user_id = p_user_id for update;
  if not found then raise exception 'Resume not found' using errcode = 'P0002'; end if;
  if exists (
    select 1 from public.tailoring_runs
    where user_id = p_user_id and source_resume_id = p_resume_id
      and status in ('queued', 'running')
  ) then
    raise exception 'A tailoring run is using this resume' using errcode = '55000';
  end if;
  update public.resumes
    set is_default = false, deleted_at = coalesce(deleted_at, pg_catalog.now())
    where id = p_resume_id and user_id = p_user_id
    returning * into v_resume;
  return pg_catalog.to_jsonb(v_resume);
end;
$$;

revoke all on function public.mark_hosted_resume_deleted(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mark_hosted_resume_deleted(uuid, uuid) to service_role;
