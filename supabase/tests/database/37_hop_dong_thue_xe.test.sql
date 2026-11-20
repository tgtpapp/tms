-- Kiểm thử Hợp đồng thuê xe: cấp số tự tăng theo năm, nhiều xe / 1 hợp đồng, sửa, chấm dứt, quyền (bán vé không xem CCCD chủ xe), cô lập nhà xe.
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
insert into public.tenant_settings (tenant_id, key, value) values ((select id from public.tenants where code = 'nha-xe-a'), 'lenh.hau_to', '"tgtp"');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.vehicle_types (id, code, name, reg_seats) values ('00000000-0000-0000-0000-0000000000e1', 'G16', 'Ghế 16', 16) $$, 'Loại xe');
select lives_ok($$ insert into public.vehicles (id, plate, vehicle_type_id, ownership) values ('00000000-0000-0000-0000-0000000000e2', '60F-000.01', '00000000-0000-0000-0000-0000000000e1', 'thue'),
  ('00000000-0000-0000-0000-0000000000e3', '60F-000.02', '00000000-0000-0000-0000-0000000000e1', 'thue') $$, '2 xe thuê');
select is(public.save_vehicle_lease(null, '{"signed_on":"2026-11-20","start_on":"2026-12-01","end_on":"2027-11-30","pay_day":5,"late_days":15,"tax_party":"B",
  "lessor":{"name":"Nguyễn Văn Chủ"},"items":[{"vehicle_id":"00000000-0000-0000-0000-0000000000e2","price":8000000},{"vehicle_id":"00000000-0000-0000-0000-0000000000e3","price":7500000}]}',
  '00000000-0000-0000-0000-00000000f001') ->> 'number', '001/2026/HĐTX-TGTP', 'Cấp số 001/2026/HĐTX-TGTP (CCCD chủ xe để sau)');
select is((select count(*)::int from public.vehicle_lease_items), 2, '1 hợp đồng 2 xe');
select is(public.save_vehicle_lease(null, '{"start_on":"2026-12-01","end_on":"2027-11-30","lessor":{"name":"X"},"items":[{"vehicle_id":"00000000-0000-0000-0000-0000000000e2"}]}',
  '00000000-0000-0000-0000-00000000f001') ->> 'number', '001/2026/HĐTX-TGTP', 'Gửi lại cùng mã không cấp số mới');
select is(public.save_vehicle_lease(null, '{"start_on":"2026-12-01","end_on":"2027-11-30","lessor":{"name":"Trần Thị B"},"items":[{"vehicle_id":"00000000-0000-0000-0000-0000000000e3","price":1}]}',
  null) ->> 'number', '002/2026/HĐTX-TGTP', 'Hợp đồng thứ 2: số 002');
select lives_ok($$ select public.save_vehicle_lease((select id from public.vehicle_leases where seq = 1), '{"signed_on":"2026-11-20","start_on":"2026-12-01","end_on":"2027-11-30",
  "lessor":{"name":"Nguyễn Văn Chủ","cccd":"079123456789"},"items":[{"vehicle_id":"00000000-0000-0000-0000-0000000000e2","price":8200000}]}', null) $$, 'Sửa: cập nhật CCCD, bớt 1 xe');
select is((select lessor ->> 'cccd' from public.vehicle_leases where seq = 1), '079123456789', 'Đã cập nhật CCCD chủ xe');
select is((select count(*)::int from public.vehicle_lease_items where lease_id = (select id from public.vehicle_leases where seq = 1)), 1, 'Còn 1 xe');
select throws_ok($$ select public.save_vehicle_lease(null, '{"start_on":"2026-12-01","end_on":"2026-01-01","lessor":{"name":"X"},"items":[{"vehicle_id":"00000000-0000-0000-0000-0000000000e2"}]}', null) $$, '22023', null, 'Chặn ngày kết thúc trước ngày bắt đầu');
select throws_ok($$ select public.save_vehicle_lease(null, '{"start_on":"2026-12-01","end_on":"2027-01-01","lessor":{"name":"X"},"items":[]}', null) $$, '22023', null, 'Phải có xe');
select lives_ok($$ select public.set_vehicle_lease_status((select id from public.vehicle_leases where seq = 2), 'cham_dut') $$, 'Chấm dứt hợp đồng');
select throws_ok($$ insert into public.vehicle_leases (year, seq, number, signed_on, start_on, end_on) values (2026, 9, 'x', '2026-01-01', '2026-01-01', '2026-02-01') $$, '42501', null, 'Không ghi thẳng bảng');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.vehicle_leases), 0, 'Bán vé không xem hợp đồng thuê xe (CCCD, tài khoản chủ xe)');
select throws_ok($$ select public.save_vehicle_lease(null, '{"start_on":"2026-12-01","end_on":"2027-01-01","lessor":{"name":"X"},"items":[{"vehicle_id":"00000000-0000-0000-0000-0000000000e2"}]}', null) $$, '42501', null, 'Bán vé không lập hợp đồng');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.vehicle_leases), 0, 'Nhà xe B không thấy hợp đồng của A');
select throws_ok($$ select public.save_vehicle_lease(null, '{"start_on":"2026-12-01","end_on":"2027-01-01","lessor":{"name":"X"},"items":[{"vehicle_id":"00000000-0000-0000-0000-0000000000e2"}]}', null) $$, 'P0002', null, 'Nhà xe B không lập hợp đồng cho xe của A');
select throws_ok($$ select public.set_vehicle_lease_status((select id from public.vehicle_leases limit 1), 'cham_dut') $$, 'P0002', null, 'Nhà xe B không chấm dứt hợp đồng của A');
reset role;
select is((select status from public.vehicle_leases where seq = 1), 'hieu_luc', 'Hợp đồng của A không bị B đổi');
select * from finish();
rollback;
