\pset pager off
-- Đóng vai 1 tài khoản lái xe đã chạy xe 60H-126.63 (không in tên), chỉ đọc, rollback
begin;
select set_config('tam.uid', (select m.user_id::text from public.staff_members m
  join public.trip_crew c on c.tenant_id = m.tenant_id and c.staff_id = m.id join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id
  join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id where v.plate = '60H-126.63' and m.user_id is not null and m.position = 'lai_xe' limit 1), true) is not null co_tai_khoan;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('tam.uid'), 'role', 'authenticated')::text, true) is not null;
set local role authenticated;
select app.current_tenant_id() is not null co_tenant, app.has_permission('repair.view') repair_view, app.has_permission('repair.view_all') view_all,
  app.has_permission('repair.add') r_add, app.is_driver_account() la_lai_xe,
  app.is_my_vehicle((select id from public.vehicles where plate = '60H-126.63')) xe_cua_minh,
  (select count(*) from public.vehicles) xe_thay, (select count(*) from public.repair_orders) phieu_thay,
  (select count(*) from public.repair_orders o join public.vehicles v on v.id = o.vehicle_id where v.plate = '60H-126.63') phieu_126;
rollback;
-- Quyền nhóm Lái xe
select r.code, r.name, array_agg(rp.permission_code order by rp.permission_code) filter (where rp.permission_code like 'repair%' or rp.permission_code like 'vehicle%') quyen
from public.roles r left join public.role_permissions rp on rp.tenant_id = r.tenant_id and rp.role_id = r.id where r.code = 'driver' group by r.code, r.name;
select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'repair_orders_select';
