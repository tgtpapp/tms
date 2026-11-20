-- Kiểm thử Ảnh xe: người có quyền Sửa xe tải được, tên tệp chuẩn, bán vé không ghi, nhà xe khác không ghi.
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
select lives_ok($$ insert into public.vehicle_types (id, code, name, reg_seats) values ('00000000-0000-0000-0000-0000000000e1', 'G16', 'Ghế 16', 16) $$, 'Loại xe');
select lives_ok($$ insert into public.vehicles (id, plate, vehicle_type_id) values ('00000000-0000-0000-0000-0000000000e2', '60F-000.01', '00000000-0000-0000-0000-0000000000e1') $$, 'Xe');
select ok(app.can_write_vehicle_photo('00000000-0000-0000-0000-0000000000e2.jpg'), 'Chủ tải được ảnh xe');
select ok(not app.can_write_vehicle_photo('00000000-0000-0000-0000-0000000000e2.png'), 'Chỉ nhận tên tệp .jpg chuẩn');
select ok(not app.can_write_vehicle_photo('00000000-0000-0000-0000-000000000099.jpg'), 'Không tải ảnh cho xe không có');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select ok(not app.can_write_vehicle_photo('00000000-0000-0000-0000-0000000000e2.jpg'), 'Bán vé không đổi ảnh xe');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select ok(not app.can_write_vehicle_photo('00000000-0000-0000-0000-0000000000e2.jpg'), 'Nhà xe B không ghi ảnh xe của A');
reset role;
select * from finish();
rollback;
