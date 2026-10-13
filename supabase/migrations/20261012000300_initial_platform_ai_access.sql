-- Add a small, invite-code-gated allowance for centrally funded OpenAI runs.
-- The invitation and OpenAI API key remain server-side configuration.

alter table public.tailoring_runs
  add column if not exists credential_source text not null default 'user'
    check (credential_source in ('user', 'platform'));

create table if not exists public.platform_ai_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  runs_granted integer not null check (runs_granted between 1 and 3),
  runs_used integer not null default 0 check (runs_used >= 0 and runs_used <= runs_granted),
  redeemed_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

alter table public.platform_ai_access enable row level security;
revoke all on public.platform_ai_access from public, anon, authenticated;

create or replace function public.redeem_platform_ai_invite(
  p_user_id uuid,
  p_runs_granted integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access public.platform_ai_access%rowtype;
  v_created boolean := false;
  v_rows bigint;
begin
  if p_runs_granted < 1 or p_runs_granted > 3 then
    raise exception 'Invalid platform AI run allowance' using errcode = '22023';
  end if;

  insert into public.platform_ai_access (user_id, runs_granted)
  values (p_user_id, p_runs_granted)
  on conflict (user_id) do nothing;
  get diagnostics v_rows = row_count;
  v_created := v_rows = 1;

  select * into v_access from public.platform_ai_access where user_id = p_user_id;
  return pg_catalog.jsonb_build_object(
    'newlyRedeemed', v_created,
    'runsGranted', v_access.runs_granted,
    'runsUsed', v_access.runs_used,
    'runsRemaining', v_access.runs_granted - v_access.runs_used
  );
end;
$$;

create or replace function public.create_platform_ai_tailoring_run(
  p_user_id uuid,
  p_run_id uuid,
  p_source_resume_id uuid,
  p_job_description text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.tailoring_runs%rowtype;
  v_access public.platform_ai_access%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  if not exists (
    select 1 from public.resumes
    where id = p_source_resume_id and user_id = p_user_id
      and is_default and deleted_at is null
  ) then
    raise exception 'Default resume changed' using errcode = 'P0002';
  end if;

  select * into v_access
    from public.platform_ai_access
    where user_id = p_user_id
    for update;
  if not found or v_access.runs_used >= v_access.runs_granted then
    raise exception 'No platform AI runs remaining' using errcode = 'P0001';
  end if;

  insert into public.tailoring_runs (
    id, user_id, source_resume_id, status, job_description,
    provider, model, credential_source, ai_consent_at
  ) values (
    p_run_id, p_user_id, p_source_resume_id, 'queued', p_job_description,
    'openai', p_model, 'platform', pg_catalog.now()
  ) returning * into v_run;

  update public.platform_ai_access
    set runs_used = runs_used + 1, updated_at = pg_catalog.now()
    where user_id = p_user_id;

  return pg_catalog.to_jsonb(v_run);
end;
$$;

revoke all on function public.redeem_platform_ai_invite(uuid, integer) from public, anon, authenticated;
grant execute on function public.redeem_platform_ai_invite(uuid, integer) to service_role;
revoke all on function public.create_platform_ai_tailoring_run(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_platform_ai_tailoring_run(uuid, uuid, uuid, text, text) to service_role;
