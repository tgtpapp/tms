-- =====================================================================
-- Sửa lỗi App lái xe – Sửa chữa luôn trống: tài khoản lái xe được gán nhóm Lái xe theo CHI NHÁNH (phạm vi branch),
-- còn chính sách xem phiếu sửa chữa kiểm tra quyền ở phạm vi CẢ NHÀ XE → lái xe không bao giờ thấy phiếu nào.
-- Phiếu của xe mình chạy / ghi tên mình là việc của chính người đó, không phụ thuộc chi nhánh: chỉ cần có ô "Sửa chữa: Xem"
-- ở bất kỳ phạm vi nào. Xem mọi phiếu (Xem tất cả / Thêm / Sửa / Xóa) vẫn theo phạm vi cả nhà xe như cũ. Không đổi bảng.
-- =====================================================================

/** Có quyền ở bất kỳ phạm vi nào (cả nhà xe / chi nhánh / phòng vé), không bị chặn riêng */
create function app.has_permission_anywhere(p_perm text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.user_roles ur
                 join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
                 where ur.tenant_id = app.current_tenant_id() and ur.user_id = auth.uid() and rp.permission_code = p_perm)
     and not exists (select 1 from public.user_permission_denies d
                     where d.tenant_id = app.current_tenant_id() and d.user_id = auth.uid() and d.permission_code = p_perm)
$$;
revoke execute on function app.has_permission_anywhere(text) from public, anon;
grant execute on function app.has_permission_anywhere(text) to authenticated, service_role;

drop policy repair_orders_select on public.repair_orders;
create policy repair_orders_select on public.repair_orders for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.has_permission('repair.view_all') or app.has_permission('repair.add') or app.has_permission('repair.edit') or app.has_permission('repair.delete')
              or (app.has_permission_anywhere('repair.view') and (app.is_my_vehicle(vehicle_id) or app.is_my_staff(driver_id::text)))));
