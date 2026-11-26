-- App lái xe – Sửa chữa: lái xe thấy phiếu sửa chữa của xe mình chạy (chuyến được xếp) VÀ phiếu có ghi tên mình là lái xe
-- (cột driver_id của phiếu, thêm ngày 25/11). Xe ghi tên mình trên phiếu sửa chữa cũng tính là xe của mình (để hiện biển số).
-- Không đổi bảng; chỉ thay hàm app.is_my_vehicle và chính sách xem phiếu sửa chữa.
create or replace function app.is_my_vehicle(p_vehicle_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.trip_crew c
                 join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id and m.user_id = auth.uid()
                 join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id
                 where c.tenant_id = app.current_tenant_id() and t.vehicle_id = p_vehicle_id)
      or exists (select 1 from public.repair_orders o
                 join public.staff_members m on m.tenant_id = o.tenant_id and m.id = o.driver_id and m.user_id = auth.uid()
                 where o.tenant_id = app.current_tenant_id() and o.vehicle_id = p_vehicle_id)
$$;

drop policy repair_orders_select on public.repair_orders;
create policy repair_orders_select on public.repair_orders for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.has_permission('repair.view_all') or app.has_permission('repair.add') or app.has_permission('repair.edit') or app.has_permission('repair.delete')
              or (app.has_permission('repair.view') and (app.is_my_vehicle(vehicle_id) or app.is_my_staff(driver_id::text)))));
