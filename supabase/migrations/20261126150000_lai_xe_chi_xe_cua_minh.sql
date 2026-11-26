-- =====================================================================
-- Lái xe / phụ xe chỉ thấy xe của mình (xe có trong chuyến được xếp cho mình), kể cả khi nhóm lỡ được tích "Xe: Xem tất cả";
-- chỉ người có quyền Thêm / Sửa / Xóa xe mới thấy mọi xe. Hợp đồng thuê xe / hợp tác kinh doanh là thông tin nội bộ:
-- lái xe không xem được (kể cả xe mình chạy). Không đổi bảng.
-- =====================================================================

/** Người dùng là lái xe / phụ xe (hồ sơ nhân sự) và không có quyền quản lý xe */
create function app.is_driver_account()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.staff_members m where m.tenant_id = app.current_tenant_id() and m.user_id = auth.uid() and m.position in ('lai_xe', 'phu_xe'))
     and not (app.has_permission('vehicle.add') or app.has_permission('vehicle.edit') or app.has_permission('vehicle.delete'))
$$;
revoke execute on function app.is_driver_account() from public, anon;
grant execute on function app.is_driver_account() to authenticated, service_role;

create or replace function app.vehicle_self_only()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select app.has_permission('vehicle.view') and (app.is_driver_account()
         or not (app.has_permission('vehicle.view_all') or app.has_permission('vehicle.add')
                 or app.has_permission('vehicle.edit') or app.has_permission('vehicle.delete')))
$$;

drop policy documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (doc_type <> 'hop_dong_thue' or not app.is_driver_account())
         and ((app.can_read_documents(owner_kind) and (owner_kind <> 'xe' or not app.vehicle_self_only() or app.is_my_vehicle(vehicle_id)))
              or (owner_kind = 'nhan_su' and app.is_my_staff(staff_id::text))
              or (owner_kind = 'xe' and app.is_my_vehicle(vehicle_id))));

-- Lái xe không có ô Xem xe: cũng chỉ thấy xe mình (dùng cho App lái xe, báo đổ dầu), không thấy mọi xe qua API
drop policy vehicles_select on public.vehicles;
create policy vehicles_select on public.vehicles for select to authenticated
  using (tenant_id = app.current_tenant_id() and (not (app.vehicle_self_only() or app.is_driver_account()) or app.is_my_vehicle(id)));
