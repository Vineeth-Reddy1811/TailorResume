-- Serialize owner approvals and prevent active aliases from becoming ambiguous.
-- Shared AI-learned entries remain pending until this function approves them.

create or replace function public.review_skill_catalog_entry(
  p_normalized_key text,
  p_canonical text,
  p_aliases text[],
  p_alias_keys text[],
  p_category text,
  p_role_area text,
  p_definition text,
  p_status text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  pending_entry public.skill_catalog%rowtype;
begin
  if p_status not in ('active', 'rejected') then
    raise exception 'invalid_review_status';
  end if;

  -- All approvals take the same transaction-scoped lock, so simultaneous
  -- requests cannot both approve overlapping aliases after checking old data.
  perform pg_advisory_xact_lock(hashtextextended('tailorresume.skill_catalog.alias_review', 0));

  select * into pending_entry
  from public.skill_catalog
  where normalized_key = p_normalized_key and status = 'pending'
  for update;

  if not found then
    raise exception 'pending_entry_changed';
  end if;

  if p_status = 'active' and exists (
    select 1
    from public.skill_catalog existing
    where existing.status = 'active'
      and existing.normalized_key <> p_normalized_key
      and (
        p_alias_keys && array[existing.normalized_key]
        or exists (
          select 1
          from unnest(existing.aliases) as existing_alias(value)
          where lower(regexp_replace(regexp_replace(trim(existing_alias.value), '[^a-zA-Z0-9+#.]+', ' ', 'g'), '\s+', ' ', 'g')) = any(p_alias_keys)
        )
      )
  ) then
    raise exception 'catalog_alias_conflict';
  end if;

  update public.skill_catalog
  set canonical = p_canonical,
      aliases = p_aliases,
      category = p_category,
      role_area = p_role_area,
      definition = p_definition,
      status = p_status,
      review_reason = case when p_status = 'rejected' then 'Rejected by catalog owner.' else null end
  where normalized_key = p_normalized_key;
end;
$$;

revoke all on function public.review_skill_catalog_entry(text, text, text[], text[], text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.review_skill_catalog_entry(text, text, text[], text[], text, text, text, text)
  to service_role;
