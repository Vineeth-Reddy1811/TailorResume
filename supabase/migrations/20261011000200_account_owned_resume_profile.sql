-- Allow each signed-in user to maintain only their own profile and resume
-- metadata. Resume objects remain private and use <user-id>/<opaque-name> keys.

insert into public.user_profiles (user_id, display_name)
select id, nullif(raw_user_meta_data ->> 'full_name', '')
from auth.users
on conflict (user_id) do nothing;

insert into public.experience_profiles (user_id)
select id from auth.users
on conflict (user_id) do nothing;

drop policy if exists "Users can update their experience profile" on public.experience_profiles;
create policy "Users can update their experience profile"
  on public.experience_profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can add their resumes" on public.resumes;
create policy "Users can add their resumes"
  on public.resumes for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (storage.foldername(object_key))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can update their resumes" on public.resumes;
create policy "Users can update their resumes"
  on public.resumes for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (storage.foldername(object_key))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their resumes" on public.resumes;
create policy "Users can delete their resumes"
  on public.resumes for delete to authenticated
  using ((select auth.uid()) = user_id);

grant update on public.experience_profiles to authenticated;
grant insert, update, delete on public.resumes to authenticated;

-- Change the user's active resume in one database transaction. The API uploads
-- the private object first and removes it if this transaction fails.
drop function if exists public.replace_default_resume(text, text, text, bigint, text);

create function public.replace_default_resume(
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
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if (storage.foldername(p_object_key))[1] is distinct from v_user_id::text then
    raise exception 'Resume object key must belong to the signed-in user';
  end if;

  -- Serialize replacement per account. Return exactly the rows this call
  -- replaced so the API can clean their private objects without racing a
  -- second simultaneous upload.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 0));
  select coalesce(
    jsonb_agg(jsonb_build_object('id', id, 'object_key', object_key)),
    '[]'::jsonb
  )
  into v_replaced_resumes
  from public.resumes
  where user_id = v_user_id
    and deleted_at is null;

  update public.resumes
  set is_default = false
  where user_id = v_user_id
    and is_default
    and deleted_at is null;

  insert into public.resumes (
    user_id, display_name, original_file_name, object_key,
    file_size_bytes, sha256, is_default
  ) values (
    v_user_id, p_display_name, p_original_file_name, p_object_key,
    p_file_size_bytes, p_sha256, true
  )
  returning * into v_new_resume;

  return jsonb_build_object(
    'resume', to_jsonb(v_new_resume),
    'replaced', v_replaced_resumes
  );
end;
$$;

revoke all on function public.replace_default_resume(text, text, text, bigint, text) from public, anon;
grant execute on function public.replace_default_resume(text, text, text, bigint, text) to authenticated;
