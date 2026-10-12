-- User-owned TailorResume data. Resume files live in the private
-- `resume-files` Storage bucket; Postgres stores ownership and metadata.

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.experience_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  profile_data jsonb not null default '{"facts": [], "verifiedSkills": []}'::jsonb
    check (jsonb_typeof(profile_data) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  original_file_name text not null,
  object_key text not null unique,
  file_size_bytes bigint not null check (file_size_bytes between 1 and 15728640),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, user_id)
);

create unique index if not exists resumes_one_default_per_user
  on public.resumes (user_id)
  where is_default and deleted_at is null;

create index if not exists resumes_user_created_idx
  on public.resumes (user_id, created_at desc)
  where deleted_at is null;

create table if not exists public.tailoring_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_resume_id uuid,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled', 'expired')),
  job_description text,
  provider text check (provider is null or provider in ('chatgpt', 'anthropic', 'xai')),
  model text,
  result_data jsonb,
  output_object_key text unique,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  check (job_description is null or length(job_description) <= 30000),
  unique (id, user_id),
  foreign key (source_resume_id, user_id)
    references public.resumes (id, user_id)
    on delete set null (source_resume_id)
);

create index if not exists tailoring_runs_user_created_idx
  on public.tailoring_runs (user_id, created_at desc);

create index if not exists tailoring_runs_expiry_idx
  on public.tailoring_runs (expires_at)
  where status in ('queued', 'running', 'succeeded', 'failed', 'canceled');

create index if not exists tailoring_runs_queue_idx
  on public.tailoring_runs (created_at)
  where status = 'queued';

create table if not exists public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('chatgpt', 'anthropic', 'xai')),
  provider_account_label text,
  credential_ciphertext text,
  credential_iv text,
  credential_auth_tag text,
  key_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_verified_at timestamptz,
  unique (user_id, provider),
  check (
    (credential_ciphertext is null and credential_iv is null and credential_auth_tag is null and key_version is null)
    or
    (credential_ciphertext is not null and credential_iv is not null and credential_auth_tag is not null and key_version is not null)
  )
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_profiles_set_updated_at on public.user_profiles;
create trigger user_profiles_set_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();

drop trigger if exists experience_profiles_set_updated_at on public.experience_profiles;
create trigger experience_profiles_set_updated_at
  before update on public.experience_profiles
  for each row execute function public.set_updated_at();

drop trigger if exists tailoring_runs_set_updated_at on public.tailoring_runs;
create trigger tailoring_runs_set_updated_at
  before update on public.tailoring_runs
  for each row execute function public.set_updated_at();

drop trigger if exists provider_connections_set_updated_at on public.provider_connections;
create trigger provider_connections_set_updated_at
  before update on public.provider_connections
  for each row execute function public.set_updated_at();

create or replace function public.create_tailorresume_user_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (user_id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (user_id) do nothing;

  insert into public.experience_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_tailorresume on auth.users;
create trigger on_auth_user_created_tailorresume
  after insert on auth.users
  for each row execute function public.create_tailorresume_user_rows();

alter table public.user_profiles enable row level security;
alter table public.experience_profiles enable row level security;
alter table public.resumes enable row level security;
alter table public.tailoring_runs enable row level security;
alter table public.provider_connections enable row level security;

drop policy if exists "Users can read their profile" on public.user_profiles;
create policy "Users can read their profile"
  on public.user_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can update their profile" on public.user_profiles;
create policy "Users can update their profile"
  on public.user_profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can read their experience profile" on public.experience_profiles;
create policy "Users can read their experience profile"
  on public.experience_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their resumes" on public.resumes;
create policy "Users can read their resumes"
  on public.resumes for select to authenticated
  using ((select auth.uid()) = user_id and deleted_at is null);

drop policy if exists "Users can read their tailoring runs" on public.tailoring_runs;
create policy "Users can read their tailoring runs"
  on public.tailoring_runs for select to authenticated
  using ((select auth.uid()) = user_id);

-- Provider credentials are accessed only by the server after it verifies the
-- caller. There are intentionally no policies or grants for browser roles.
revoke all on public.user_profiles, public.experience_profiles,
  public.resumes, public.tailoring_runs, public.provider_connections
  from anon, authenticated;
grant all on public.provider_connections to service_role;

grant select, update on public.user_profiles to authenticated;
grant select on public.experience_profiles to authenticated;
grant select on public.resumes to authenticated;
grant select on public.tailoring_runs to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resume-files',
  'resume-files',
  false,
  15728640,
  array['application/vnd.openxmlformats-officedocument.wordprocessingml.document']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read their resume objects" on storage.objects;
create policy "Users can read their resume objects"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'resume-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can upload their resume objects" on storage.objects;
create policy "Users can upload their resume objects"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'resume-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their resume objects" on storage.objects;
create policy "Users can delete their resume objects"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'resume-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
