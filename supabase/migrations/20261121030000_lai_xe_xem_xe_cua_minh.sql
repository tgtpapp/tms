-- =====================================================================
-- Xe và Sửa chữa theo từng người (như Lái xe & nhân viên):
-- - Xe: ô Xem = mở mục, chỉ thấy xe MÌNH TỪNG CHẠY (có trong chuyến được xếp cho mình, mọi thời gian);
--   ô Xem tất cả (vehicle.view_all) = thấy mọi xe. Giấy tờ / tệp của xe theo đúng phạm vi đó.
-- - Sửa chữa: ô Xem = chỉ phiếu sửa chữa / bảo dưỡng của xe mình từng chạy (chỉ xem); Xem tất cả = mọi phiếu.
-- - Nhóm đang có ô Xem (trừ Lái xe và quyền riêng từng người) được thêm ô Xem tất cả → giữ nguyên như trước.
-- - Nhóm Lái xe được thêm ô Xem của Sửa chữa (chỉ thấy phiếu xe mình chạy).
-- =====================================================================
insert into public.permissions (code, module, name) values
  ('vehicle.view_all', 'vehicle', 'Xe: Xem tất cả'),
  ('repair.view_all', 'repair', 'Sửa chữa: Xem tất cả')
on conflict (code) do nothing;
select app.grant_permission_to_admins('vehicle.view_all');
select app.grant_permission_to_admins('repair.view_all');
insert into public.role_permissions (tenant_id, role_id, permission_code)
select rp.tenant_id, rp.role_id, rp.permission_code || '_all'
from public.role_permissions rp join public.roles r on r.tenant_id = rp.tenant_id and r.id = rp.role_id
where rp.permission_code in ('vehicle.view', 'repair.view') and r.code <> 'driver' and r.code not like 'rieng\_%'
on conflict do nothing;
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, 'repair.view' from public.roles r where r.code = 'driver'
on conflict do nothing;

-- Nhà xe mới: nhóm có ô Xem xe (trừ Lái xe) được Xem tất cả; Điều hành xem mọi phiếu sửa chữa; Lái xe xem phiếu xe mình
do $$
declare v text;
begin
  select pg_get_functiondef('app.seed_system_roles(uuid)'::regprocedure) into v;
  v := replace(v, '(''dispatcher'', ''repair.view''),', '(''dispatcher'', ''repair.view''), (''dispatcher'', ''repair.view_all''), (''driver'', ''repair.view''),');
  v := replace(v, 'when r.code = ''staff'' then array[''route.view'', ''vehicle.view'',', 'when r.code = ''staff'' then array[''route.view'', ''vehicle.view'', ''vehicle.view_all'',');
  v := replace(v, 'else array[''route.view'', ''vehicle.view'',', 'else array[''route.view'', ''vehicle.view'', ''vehicle.view_all'',');
  if (length(v) - length(replace(v, 'view_all', ''))) / 8 < 3 then raise exception 'Không sửa được seed_system_roles'; end if;
  execute v;
end;
$$;

/** Xe mình từng chạy (có trong chuyến được xếp cho mình) */
create function app.is_my_vehicle(p_vehicle_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.trip_crew c
                 join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id and m.user_id = auth.uid()
                 join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id
                 where c.tenant_id = app.current_tenant_id() and t.vehicle_id = p_vehicle_id)
$$;
revoke execute on function app.is_my_vehicle(uuid) from public, anon;
grant execute on function app.is_my_vehicle(uuid) to authenticated, service_role;

/** Chỉ được thấy xe của mình: có ô Xem xe nhưng không có Xem tất cả / Thêm / Sửa / Xóa xe */
create function app.vehicle_self_only()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select app.has_permission('vehicle.view') and not (app.has_permission('vehicle.view_all') or app.has_permission('vehicle.add')
         or app.has_permission('vehicle.edit') or app.has_permission('vehicle.delete'))
$$;
revoke execute on function app.vehicle_self_only() from public, anon;
grant execute on function app.vehicle_self_only() to authenticated, service_role;

drop policy vehicles_select on public.vehicles;
create policy vehicles_select on public.vehicles for select to authenticated
  using (tenant_id = app.current_tenant_id() and (not app.vehicle_self_only() or app.is_my_vehicle(id)));

-- Giấy tờ xe và tệp trong thư mục xe: theo đúng phạm vi xe được thấy
drop policy documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and ((app.can_read_documents(owner_kind) and (owner_kind <> 'xe' or not app.vehicle_self_only() or app.is_my_vehicle(vehicle_id)))
              or (owner_kind = 'nhan_su' and app.is_my_staff(staff_id::text))));
drop policy giay_to_select on storage.objects;
create policy giay_to_select on storage.objects for select to authenticated
  using (bucket_id = 'giay-to'
         and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and ((app.can_read_documents((storage.foldername(name))[2])
               and ((storage.foldername(name))[2] <> 'xe' or not app.vehicle_self_only()
                    or ((storage.foldername(name))[3] ~ '^[0-9a-f-]{36}$' and app.is_my_vehicle(((storage.foldername(name))[3])::uuid))))
              or ((storage.foldername(name))[2] = 'nhan_su' and app.is_my_staff((storage.foldername(name))[3]))));

-- Sửa chữa: Xem tất cả hoặc quyền Thêm / Sửa / Xóa = mọi phiếu; chỉ ô Xem = phiếu của xe mình từng chạy
drop policy repair_orders_select on public.repair_orders;
create policy repair_orders_select on public.repair_orders for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.has_permission('repair.view_all') or app.has_permission('repair.add') or app.has_permission('repair.edit') or app.has_permission('repair.delete')
              or (app.has_permission('repair.view') and app.is_my_vehicle(vehicle_id))));
drop policy repair_items_select on public.repair_items;
create policy repair_items_select on public.repair_items for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and exists (select 1 from public.repair_orders o where o.tenant_id = repair_items.tenant_id and o.id = repair_items.order_id));
