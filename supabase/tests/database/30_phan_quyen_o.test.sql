-- Kiểm thử phân quyền theo ô Xem / Thêm / Sửa / Xóa và kiêm nhiệm nhiều nhóm (quyền cộng dồn).
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'nv@test.local'), ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select id from public.tenants where code = 'nha-xe-a'), '0900000004', 'Nhân viên A', null) $$, 'Nhân viên A chưa có nhóm');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

select ok((select count(*) from public.permissions where code like '%.manage' or code in ('ticket.sell', 'user.read', 'audit.read')) = 0, 'Không còn mã quyền gộp cũ');
select ok((select count(*) from public.permissions where code in ('vehicle.view', 'vehicle.add', 'vehicle.edit', 'vehicle.delete', 'settings.view', 'settings.edit', 'report.view')) = 7, 'Có các ô quyền mới');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select ok(app.has_permission('vehicle.delete') and app.has_permission('settings.edit'), 'Chủ có tất cả các ô');
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats, reg_berths) values ('G16', 'Ghế 16', 16, 0) $$, 'Loại xe');
select lives_ok($$ select public.create_role('chi_them_xe', 'Chỉ thêm xe', array['vehicle.view', 'vehicle.add']) $$, 'Nhóm chỉ Xem + Thêm xe');
select lives_ok($$ select public.create_role('xoa_xe', 'Xóa xe', array['vehicle.delete']) $$, 'Nhóm chỉ Xóa xe');
select lives_ok($$ select public.assign_role('00000000-0000-0000-0000-0000000000b3', (select id from public.roles where code = 'chi_them_xe')) $$, 'Gán nhóm 1');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select lives_ok($$ insert into public.vehicles (plate, vehicle_type_id) values ('60F-004.39', (select id from public.vehicle_types)) $$, 'Có ô Thêm: thêm được xe');
update public.vehicles set color = 'Đỏ' where plate = '60F-004.39';
select is((select color from public.vehicles where plate = '60F-004.39'), null, 'Không có ô Sửa: không sửa được');
select throws_ok(format('select public.delete_record(%L, %L)', 'vehicle', (select id from public.vehicles limit 1)), '42501', null, 'Không có ô Xóa: không xóa được');
select throws_ok($$ select public.save_staff(gen_random_uuid(), '{"full_name":"X","joined_on":"2026-01-01"}') $$, '42501', null, 'Không có quyền nhân viên: không thêm được');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.assign_role('00000000-0000-0000-0000-0000000000b3', (select id from public.roles where code = 'xoa_xe')) $$, 'Kiêm nhiệm: gán thêm nhóm 2');
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Lái xe Y","joined_on":"2026-01-01"}') $$, 'Chủ thêm nhân viên');
select lives_ok($$ select public.create_role('sua_nv', 'Sửa nhân viên', array['staff.view', 'staff.edit']) $$, 'Nhóm sửa nhân viên');
select lives_ok($$ select public.assign_role('00000000-0000-0000-0000-0000000000b3', (select id from public.roles where code = 'sua_nv')) $$, 'Kiêm nhiệm: nhóm 3');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select lives_ok(format('select public.delete_record(%L, %L)', 'vehicle', (select id from public.vehicles limit 1)), 'Quyền cộng dồn: có ô Xóa từ nhóm 2 → xóa được');
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Lái xe Y sửa","joined_on":"2026-01-01"}') $$, 'Có ô Sửa nhân viên: sửa được người đã có');
select throws_ok($$ select public.save_staff(gen_random_uuid(), '{"full_name":"Mới","joined_on":"2026-01-01"}') $$, '42501', null, 'Không có ô Thêm nhân viên: không thêm người mới');
select is((select count(*)::int from public.staff_private), 1, 'Có ô Xem nhân viên: xem được hồ sơ riêng');
select throws_ok($$ select public.create_role('x', 'X', array['vehicle.edit']) $$, '42501', null, 'Không có quyền Vai trò: không tạo nhóm');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.roles where code in ('chi_them_xe', 'xoa_xe', 'sua_nv')), 0, 'Nhà xe B không thấy nhóm quyền của A');
select throws_ok(format('select public.assign_role(%L, %L)', '00000000-0000-0000-0000-0000000000b3', (select id from public.roles where code = 'owner')), 'P0002', null, 'Nhà xe B không gán quyền cho người của A');
reset role;
select * from finish();
rollback;
