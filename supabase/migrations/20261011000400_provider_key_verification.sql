-- Persist the timestamp only after the API has verified the key against the
-- provider's model catalogue. This migration is additive so applied 003 stays
-- immutable.

create or replace function public.save_my_provider_connection(
  p_provider text,
  p_provider_account_label text,
  p_credential_ciphertext text,
  p_credential_iv text,
  p_credential_auth_tag text,
  p_key_version integer
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

  insert into public.provider_connections (
    user_id, provider, provider_account_label, credential_ciphertext,
    credential_iv, credential_auth_tag, key_version, last_verified_at
  ) values (
    v_user_id, p_provider, left(nullif(p_provider_account_label, ''), 200),
    p_credential_ciphertext, p_credential_iv, p_credential_auth_tag, p_key_version, now()
  )
  on conflict (user_id, provider) do update set
    provider_account_label = excluded.provider_account_label,
    credential_ciphertext = excluded.credential_ciphertext,
    credential_iv = excluded.credential_iv,
    credential_auth_tag = excluded.credential_auth_tag,
    key_version = excluded.key_version,
    last_verified_at = now();
end;
$$;

revoke all on function public.save_my_provider_connection(text, text, text, text, text, integer) from public, anon;
grant execute on function public.save_my_provider_connection(text, text, text, text, text, integer) to authenticated;
