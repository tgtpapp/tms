-- =====================================================================
-- Ảnh xe (như ảnh đại diện nhân viên): giay-to/<nhà xe>/anh_xe/<vehicle_id>.jpg (ảnh vuông đã thu nhỏ).
-- Xem: mọi người trong cùng nhà xe. Tải / đổi / bỏ: người có quyền Sửa xe.
-- =====================================================================
create function app.can_write_vehicle_photo(p_file text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_file ~ '^[0-9a-f-]{36}\.jpg$'
     and exists (select 1 from public.vehicles
                 where tenant_id = app.current_tenant_id() and id::text = substr(p_file, 1, 36))
     and app.has_permission('vehicle.edit')
$$;
revoke execute on function app.can_write_vehicle_photo(text) from public, anon;
grant execute on function app.can_write_vehicle_photo(text) to authenticated, service_role;

create policy anh_xe_select on storage.objects for select to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'anh_xe');
create policy anh_xe_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
              and (storage.foldername(name))[2] = 'anh_xe' and app.can_write_vehicle_photo(storage.filename(name)));
create policy anh_xe_update on storage.objects for update to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'anh_xe' and app.can_write_vehicle_photo(storage.filename(name)))
  with check (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
              and (storage.foldername(name))[2] = 'anh_xe' and app.can_write_vehicle_photo(storage.filename(name)));
create policy anh_xe_delete on storage.objects for delete to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'anh_xe' and app.can_write_vehicle_photo(storage.filename(name)));
