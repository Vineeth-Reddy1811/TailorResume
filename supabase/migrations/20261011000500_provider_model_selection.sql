alter table public.provider_connections
  add column if not exists selected_model text;

drop function if exists public.get_my_provider_connections();
create function public.get_my_provider_connections()
returns table(
  provider text,
  provider_account_label text,
  connected_at timestamptz,
  last_verified_at timestamptz,
  selected_model text
)
language sql
stable
security definer
set search_path = ''
as $$
  select connection.provider, connection.provider_account_label,
         connection.updated_at, connection.last_verified_at,
         connection.selected_model
  from public.provider_connections as connection
  where connection.user_id = (select auth.uid())
    and connection.provider in ('anthropic', 'xai')
  order by connection.provider;
$$;

drop function if exists public.save_my_provider_connection(text, text, text, text, text, integer);
create function public.save_my_provider_connection(
  p_provider text,
  p_provider_account_label text,
  p_credential_ciphertext text,
  p_credential_iv text,
  p_credential_auth_tag text,
  p_key_version integer,
  p_selected_model text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_provider not in ('anthropic', 'xai') then raise exception 'Unsupported provider'; end if;
  if length(p_credential_ciphertext) < 1 or length(p_credential_ciphertext) > 4096
     or length(p_credential_iv) <> 16 or length(p_credential_auth_tag) <> 24
     or p_key_version <> 1 then
    raise exception 'Invalid encrypted credential';
  end if;
  if p_selected_model is null or length(p_selected_model) < 1 or length(p_selected_model) > 200 then
    raise exception 'Invalid provider model';
  end if;

  insert into public.provider_connections (
    user_id, provider, provider_account_label, credential_ciphertext,
    credential_iv, credential_auth_tag, key_version, last_verified_at,
    selected_model
  ) values (
    v_user_id, p_provider, left(nullif(p_provider_account_label, ''), 200),
    p_credential_ciphertext, p_credential_iv, p_credential_auth_tag,
    p_key_version, now(), p_selected_model
  )
  on conflict (user_id, provider) do update set
    provider_account_label = excluded.provider_account_label,
    credential_ciphertext = excluded.credential_ciphertext,
    credential_iv = excluded.credential_iv,
    credential_auth_tag = excluded.credential_auth_tag,
    key_version = excluded.key_version,
    last_verified_at = now(),
    selected_model = excluded.selected_model;
end;
$$;

create or replace function public.set_my_provider_model(
  p_provider text,
  p_selected_model text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_updated integer;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_provider not in ('anthropic', 'xai') then raise exception 'Unsupported provider'; end if;
  if p_selected_model is null or length(p_selected_model) < 1 or length(p_selected_model) > 200 then
    raise exception 'Invalid provider model';
  end if;

  update public.provider_connections
  set selected_model = p_selected_model
  where user_id = v_user_id and provider = p_provider;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then raise exception 'Provider connection not found'; end if;
end;
$$;

revoke all on function public.get_my_provider_connections() from public, anon;
revoke all on function public.save_my_provider_connection(text, text, text, text, text, integer, text) from public, anon;
revoke all on function public.set_my_provider_model(text, text) from public, anon;
grant execute on function public.get_my_provider_connections() to authenticated;
grant execute on function public.save_my_provider_connection(text, text, text, text, text, integer, text) to authenticated;
grant execute on function public.set_my_provider_model(text, text) to authenticated;
