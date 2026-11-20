-- Kiểm thử Đóng BHXH & lương chuyển khoản theo tháng: lưu / sửa, quyền, cô lập nhà xe.
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
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Đỗ Thị Yên","joined_on":"2024-01-01","position":"nhan_vien"}') $$, 'Nhân viên');
select is(public.save_pay_month('2026-11-15', '[{"staff_id":"00000000-0000-0000-0000-00000000aa01","has_bhxh":true,"transfer_pay":7000000,"bhxh_pay":5310000}]'), 1, 'Lưu tháng 11');
select is((select month::text from public.staff_pay_months), '2026-11-01', 'Tháng lưu theo ngày 01');
select lives_ok($$ select public.save_pay_month('2026-11-01', '[{"staff_id":"00000000-0000-0000-0000-00000000aa01","has_bhxh":false,"transfer_pay":7500000,"bhxh_pay":0}]') $$, 'Sửa tháng 11');
select is((select transfer_pay from public.staff_pay_months), 7500000::bigint, 'Đã sửa lương chuyển khoản');
select is((select count(*)::int from public.staff_pay_months), 1, 'Không sinh dòng trùng');
select throws_ok($$ insert into public.staff_pay_months (staff_id, month) values ('00000000-0000-0000-0000-00000000aa01', '2026-10-01') $$, '42501', null, 'Trình duyệt không ghi thẳng bảng lương');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.staff_pay_months), 0, 'Bán vé không xem lương');
select throws_ok($$ select public.save_pay_month('2026-11-01', '[]') $$, '42501', null, 'Bán vé không sửa lương');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.staff_pay_months), 0, 'Nhà xe B không thấy lương của A');
select throws_ok($$ select public.save_pay_month('2026-11-01', '[{"staff_id":"00000000-0000-0000-0000-00000000aa01","transfer_pay":1}]') $$, 'P0002', null, 'Nhà xe B không ghi được cho nhân viên của A');
reset role;
select * from finish();
rollback;
