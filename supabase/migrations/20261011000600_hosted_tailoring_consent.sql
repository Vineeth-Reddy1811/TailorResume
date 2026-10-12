alter table public.tailoring_runs
  add column if not exists ai_consent_at timestamptz;

-- Keep provider spend bounded: each account can have at most one queued or
-- running tailoring job. The unique index makes this atomic across requests.
create unique index if not exists tailoring_runs_one_active_per_user
  on public.tailoring_runs (user_id)
  where status in ('queued', 'running');
