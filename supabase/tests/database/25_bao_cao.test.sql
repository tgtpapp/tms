-- Kiểm thử báo cáo vận tải / bán vé: quyền, cấu trúc, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'bv@test.local'), ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select id from public.tenants where code = 'nha-xe-a'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats, reg_berths) values ('G16', 'Ghế 16', 16, 0) $$, 'Loại xe');
select lives_ok($$ insert into public.vehicles (plate, vehicle_type_id) values ('60F-004.39', (select id from public.vehicle_types)) $$, 'Xe');
select lives_ok($$ select public.save_fuel(null, jsonb_build_object('kind', 'ngoai', 'entry_date', '2026-10-04', 'vehicle_id', (select id from public.vehicles), 'liters', 40, 'unit_price', 22000)) $$, 'Đổ dầu');
select lives_ok($$ select public.import_vehicle_km(jsonb_build_array(jsonb_build_object('vehicle_id', (select id from public.vehicles), 'run_date', '2026-10-04', 'km', 250))) $$, 'Km GPS');
select is((public.report_transport('2026-10-01', '2026-10-31') -> 'vehicles' -> 0 ->> 'km_gps')::numeric, 250::numeric, 'Báo cáo vận tải: km GPS theo xe');
select is((public.report_transport('2026-10-01', '2026-10-31') -> 'vehicles' -> 0 ->> 'fuel_l')::numeric, 40::numeric, 'Báo cáo vận tải: lít dầu theo xe');
select is(jsonb_array_length(public.report_transport('2026-11-01', '2026-11-30') -> 'vehicles'), 0, 'Ngoài kỳ không có số liệu');
select is((public.report_sales('2026-10-01', '2026-10-31') -> 'total' ->> 'tickets')::int, 0, 'Báo cáo bán vé chạy được');
select throws_ok($$ select public.report_sales('2026-10-31', '2026-10-01') $$, '22023', null, 'Khoảng ngày sai bị chặn');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select throws_ok($$ select public.report_transport('2026-10-01', '2026-10-31') $$, '42501', null, 'Bán vé không xem báo cáo');
select throws_ok($$ select public.report_sales('2026-10-01', '2026-10-31') $$, '42501', null, 'Bán vé không xem báo cáo bán vé');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is(jsonb_array_length(public.report_transport('2026-10-01', '2026-10-31') -> 'vehicles'), 0, 'Nhà xe B không thấy số liệu của A');
reset role;
select * from finish();
rollback;
