-- =====================================================================
-- Giấy tờ xuất trình khi cơ quan chức năng kiểm tra (như app cũ "Việc của tôi"):
-- người lái xem được giấy tờ và ảnh giấy tờ của XE MÌNH CHẠY (có trong chuyến được xếp cho mình), kể cả khi không có quyền Xe.
-- Giấy tờ cá nhân của mình đã xem được từ trước (is_my_staff).
-- =====================================================================
drop policy documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and ((app.can_read_documents(owner_kind) and (owner_kind <> 'xe' or not app.vehicle_self_only() or app.is_my_vehicle(vehicle_id)))
              or (owner_kind = 'nhan_su' and app.is_my_staff(staff_id::text))
              or (owner_kind = 'xe' and app.is_my_vehicle(vehicle_id))));

drop policy giay_to_select on storage.objects;
create policy giay_to_select on storage.objects for select to authenticated
  using (bucket_id = 'giay-to'
         and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and ((app.can_read_documents((storage.foldername(name))[2])
               and ((storage.foldername(name))[2] <> 'xe' or not app.vehicle_self_only()
                    or ((storage.foldername(name))[3] ~ '^[0-9a-f-]{36}$' and app.is_my_vehicle(((storage.foldername(name))[3])::uuid))))
              or ((storage.foldername(name))[2] = 'nhan_su' and app.is_my_staff((storage.foldername(name))[3]))
              or ((storage.foldername(name))[2] = 'xe' and (storage.foldername(name))[3] ~ '^[0-9a-f-]{36}$'
                  and app.is_my_vehicle(((storage.foldername(name))[3])::uuid))));

-- Kho tệp mới (Google Drive): cùng quy tắc theo tên tệp
drop policy if exists f_giay_to_select on public.file_store;
create policy f_giay_to_select on public.file_store for select to authenticated
  using ((storage.foldername(name))[1] = app.current_tenant_id()::text
         and ((app.can_read_documents((storage.foldername(name))[2])
               and ((storage.foldername(name))[2] <> 'xe' or not app.vehicle_self_only()
                    or ((storage.foldername(name))[3] ~ '^[0-9a-f-]{36}$' and app.is_my_vehicle(((storage.foldername(name))[3])::uuid))))
              or ((storage.foldername(name))[2] = 'nhan_su' and app.is_my_staff((storage.foldername(name))[3]))
              or ((storage.foldername(name))[2] = 'xe' and (storage.foldername(name))[3] ~ '^[0-9a-f-]{36}$'
                  and app.is_my_vehicle(((storage.foldername(name))[3])::uuid))));
