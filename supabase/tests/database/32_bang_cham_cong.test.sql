-- Kiểm thử Bảng chấm công: phòng ban, tiền tài, lương cố định, cài đặt chấm công, tháng đầu chạy của lái xe, quyền, cô lập nhà xe.
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
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Đỗ Thị Yên","joined_on":"2024-01-01","position":"nhan_vien","department":"Văn phòng"}') $$, 'Nhân viên có phòng ban');
select is((select department from public.staff_members where id = '00000000-0000-0000-0000-00000000aa01'), 'Văn phòng', 'Lưu phòng ban');
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Đỗ Thị Yên","joined_on":"2024-01-01","position":"nhan_vien"}') $$, 'Sửa hồ sơ không gửi phòng ban');
select is((select department from public.staff_members where id = '00000000-0000-0000-0000-00000000aa01'), 'Văn phòng', 'Không gửi phòng ban thì giữ nguyên');
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa02', '{"full_name":"Lái Một","joined_on":"2024-01-01","position":"lai_xe"}') $$, 'Lái xe');
select lives_ok($$ select public.set_staff_department('00000000-0000-0000-0000-00000000aa02', 'Lái xe') $$, 'Nhập phòng ban từ app cũ');
select lives_ok($$ select public.set_staff_department('00000000-0000-0000-0000-00000000aa02', 'Khác') $$, 'Nhập lại');
select is((select department from public.staff_members where id = '00000000-0000-0000-0000-00000000aa02'), 'Lái xe', 'Chỉ điền khi đang trống');
select is(public.save_pay_month('2026-11-01', '[{"staff_id":"00000000-0000-0000-0000-00000000aa01","has_bhxh":true,"transfer_pay":7000000,"bhxh_pay":5310000,"fixed_pay":9000000}]'), 1, 'Lưu lương cố định');
select is((select fixed_pay from public.staff_pay_months), 9000000::bigint, 'Lương cố định đã lưu');
select lives_ok($$ select public.save_timesheet_settings('{"cong_tuyen":{"x|di":1.5},"cp_khac_lx":4,"bh14":true,"cong_chuan":26}') $$, 'Lưu cài đặt chấm công');
select is((select value from public.tenant_settings where key = 'cham_cong.cp_khac_lx'), '4'::jsonb, 'Đã lưu % chi phí khác');
select throws_ok($$ select public.save_timesheet_settings('{"cp_khac_lx":150}') $$, '22023', null, 'Chặn % sai');
select throws_ok($$ select public.save_timesheet_settings('{"cong_tuyen":{"x":-1}}') $$, '22023', null, 'Chặn công/chuyến âm');
select lives_ok($$ select public.save_timesheet_settings('{"tien_tai":{"16":150000,"29":180000}}') $$, 'Lưu tiền tài theo số chỗ');
select is((select value from public.tenant_settings where key = 'cham_cong.tien_tai'), '{"16":150000,"29":180000}'::jsonb, 'Đã lưu tiền tài 16 / 29 chỗ');
select throws_ok($$ select public.save_timesheet_settings('{"tien_tai":{"abc":1}}') $$, '22023', null, 'Chặn số chỗ sai');
select throws_ok($$ select public.save_timesheet_settings('{"khac":1}') $$, '22023', null, 'Chặn khóa lạ');
select is((select count(*)::int from public.driver_first_months()), 0, 'Chưa có chuyến nào');
select is((select count(distinct permission_code)::int from public.my_permissions() where permission_code like 'timesheet.%'), 3, 'Chủ có đủ quyền chấm công');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select throws_ok($$ select public.save_timesheet_settings('{"bh14":false}') $$, '42501', null, 'Bán vé không sửa cài đặt chấm công');
select throws_ok($$ select public.set_staff_department('00000000-0000-0000-0000-00000000aa01', 'X') $$, '42501', null, 'Bán vé không sửa phòng ban');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.tenant_settings where key like 'cham_cong.%'), 0, 'Nhà xe B không thấy cài đặt chấm công của A');
select lives_ok($$ select public.set_staff_department('00000000-0000-0000-0000-00000000aa01', 'Y') $$, 'Nhà xe B gọi với người của A');
reset role;
select is((select department from public.staff_members where id = '00000000-0000-0000-0000-00000000aa01'), 'Văn phòng', 'Nhà xe B không sửa được phòng ban của A');
select ok(exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.code = 'driver' and rp.permission_code = 'timesheet.view'), 'Lái xe có quyền xem bảng chấm công của mình');
select ok(not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.code = 'driver' and rp.permission_code = 'timesheet.view_all'), 'Lái xe không xem bảng chấm công người khác');
-- Lương của tôi: lái xe / nhân viên chỉ thấy dòng lương của chính mình
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b5', 'lx@test.local');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b5', (select id from public.tenants where code = 'nha-xe-a'), '0900000005', 'Đỗ Thị Yên', 'staff') $$, 'Tài khoản nhân viên');
update public.staff_members set user_id = '00000000-0000-0000-0000-0000000000b5' where id = '00000000-0000-0000-0000-00000000aa01';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select is((select count(*)::int from public.staff_pay_months), 1, 'Nhân viên thấy dòng lương của mình');
select is((select fixed_pay from public.staff_pay_months), 9000000::bigint, 'Đúng lương của mình');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.staff_pay_months), 0, 'Bán vé không thấy lương người khác');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.staff_pay_months), 0, 'Nhà xe B không thấy lương nhà xe A');
reset role;
select * from finish();
rollback;
