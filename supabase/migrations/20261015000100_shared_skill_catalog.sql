-- Shared, persistent vocabulary learned from job descriptions.
-- Only the server's service role can read or update this catalog. Inactive
-- rows form the review queue and are not used for matching until activated.

create table if not exists public.skill_catalog (
  id uuid primary key default gen_random_uuid(),
  canonical text not null check (length(canonical) between 2 and 80),
  normalized_key text not null unique check (length(normalized_key) between 2 and 120),
  aliases text[] not null default '{}',
  category text not null check (length(category) between 2 and 80),
  role_area text not null check (length(role_area) between 2 and 80),
  definition text not null default '' check (length(definition) <= 240),
  status text not null default 'pending' check (status in ('active', 'pending', 'rejected')),
  review_reason text,
  source_count integer not null default 1 check (source_count > 0),
  first_seen_at timestamptz not null default pg_catalog.now(),
  last_seen_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create index if not exists skill_catalog_status_area_idx
  on public.skill_catalog (status, role_area, canonical);

alter table public.skill_catalog enable row level security;
revoke all on public.skill_catalog from public, anon, authenticated;
grant select, insert, update on public.skill_catalog to service_role;

drop trigger if exists skill_catalog_set_updated_at on public.skill_catalog;
create trigger skill_catalog_set_updated_at
  before update on public.skill_catalog
  for each row execute function public.set_updated_at();
