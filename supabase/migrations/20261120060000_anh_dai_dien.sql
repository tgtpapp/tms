-- =====================================================================
-- Ảnh đại diện của nhân viên / lái xe (như trường avatar của app cũ).
-- Tệp: giay-to/<nhà xe>/anh_dai_dien/<staff_id>.jpg (ảnh vuông đã thu nhỏ).
-- Xem: mọi người trong cùng nhà xe (danh sách nhân viên vốn đã xem được).
-- Tải / đổi / bỏ: người quản lý nhân sự, hoặc chính nhân viên đó.
-- =====================================================================
create or replace function app.can_write_avatar(p_file text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_file ~ '^[0-9a-f-]{36}\.jpg$'
     and exists (select 1 from public.staff_members
                 where tenant_id = app.current_tenant_id() and id::text = substr(p_file, 1, 36))
     and (app.has_permission('staff.manage') or app.is_my_staff(substr(p_file, 1, 36)))
$$;
revoke execute on function app.can_write_avatar(text) from public, anon;
grant execute on function app.can_write_avatar(text) to authenticated, service_role;

create policy anh_dai_dien_select on storage.objects for select to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'anh_dai_dien');
create policy anh_dai_dien_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
              and (storage.foldername(name))[2] = 'anh_dai_dien' and app.can_write_avatar(storage.filename(name)));
create policy anh_dai_dien_update on storage.objects for update to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'anh_dai_dien' and app.can_write_avatar(storage.filename(name)))
  with check (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
              and (storage.foldername(name))[2] = 'anh_dai_dien' and app.can_write_avatar(storage.filename(name)));
create policy anh_dai_dien_delete on storage.objects for delete to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'anh_dai_dien' and app.can_write_avatar(storage.filename(name)));
