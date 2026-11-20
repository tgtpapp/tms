-- Kiểm thử Hợp đồng lao động: số 001 tự tăng theo năm, không trùng, không dùng lại số đã hủy, 1 HĐ / người / năm,
-- chống bấm 2 lần, quyền (người lao động xem HĐ của mình), cô lập nhà xe.
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
select lives_ok($$ insert into public.tenant_settings (key, value) values ('lenh.hau_to', '"TP"') $$, 'Ký hiệu nhà xe');
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Đỗ Thị Yên","joined_on":"2024-01-01","position":"nhan_vien"}') $$, 'Nhân viên 1');
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa02', '{"full_name":"Bán vé A","joined_on":"2024-01-01","position":"nhan_vien","user_id":"00000000-0000-0000-0000-0000000000b3"}') $$, 'Nhân viên 2 có tài khoản');
select is(public.save_labor_contract(null, '00000000-0000-0000-0000-00000000aa01', 'xac_dinh', '2026-01-01', '2026-12-31', 7000000, 'Bán vé', null, null, '{}', '00000000-0000-0000-0000-0000000000f1') ->> 'number',
  '001/2026/HĐLĐ-TP', 'Hợp đồng đầu tiên 001');
select is(public.save_labor_contract(null, '00000000-0000-0000-0000-00000000aa01', 'xac_dinh', '2026-01-01', '2026-12-31', 7000000, 'Bán vé', null, null, '{}', '00000000-0000-0000-0000-0000000000f1') ->> 'number',
  '001/2026/HĐLĐ-TP', 'Bấm 2 lần không cấp số mới');
select throws_ok($$ select public.save_labor_contract(null, '00000000-0000-0000-0000-00000000aa01', 'xac_dinh', '2026-02-01', '2026-12-31', 1, null, null, null, '{}', null) $$,
  '23505', null, 'Mỗi người mỗi năm 1 hợp đồng');
select is(public.save_labor_contract(null, '00000000-0000-0000-0000-00000000aa02', 'thoi_vu', '2026-03-01', '2026-08-31', 6000000, null, null, null, '{}', null) ->> 'number',
  '002/2026/HĐLĐ-TP', 'Người thứ hai 002');
select is(public.save_labor_contract(null, '00000000-0000-0000-0000-00000000aa01', 'khong_xac_dinh', '2027-01-01', '2027-12-31', 8000000, null, null, null, '{}', null) ->> 'number',
  '001/2027/HĐLĐ-TP', 'Năm mới bắt đầu lại 001');
select is((select end_on from public.labor_contracts where number = '001/2027/HĐLĐ-TP'), null::date, 'Không xác định thời hạn: không có ngày kết thúc');
select lives_ok(format('select public.cancel_labor_contract(%L, %L)', (select id from public.labor_contracts where number = '002/2026/HĐLĐ-TP'), 'Lập sai'), 'Hủy hợp đồng');
select is(public.save_labor_contract(null, '00000000-0000-0000-0000-00000000aa02', 'thoi_vu', '2026-03-01', '2026-08-31', 6000000, null, null, null, '{}', null) ->> 'number',
  '003/2026/HĐLĐ-TP', 'Số đã hủy không cấp lại; lập lại được cho người đó');
select lives_ok(format('select public.save_labor_contract(%L, %L, %L, %L, %L, %s, null, null, null, %L, null)', (select id from public.labor_contracts where number = '001/2026/HĐLĐ-TP'),
  '00000000-0000-0000-0000-00000000aa01', 'xac_dinh', '2026-01-01', '2026-12-31', 7500000, '{"an_trua":500000}'), 'Sửa lương, giữ số');
select is((select salary from public.labor_contracts where number = '001/2026/HĐLĐ-TP'), 7500000::bigint, 'Lương đã sửa');
select throws_ok(format('select public.save_labor_contract(%L, %L, %L, %L, %L, 1, null, null, null, %L, null)', (select id from public.labor_contracts where number = '001/2026/HĐLĐ-TP'),
  '00000000-0000-0000-0000-00000000aa01', 'xac_dinh', '2027-01-01', '2027-12-31', '{}'), '22023', null, 'Không đổi năm sau khi cấp số');
select throws_ok($$ delete from public.labor_contracts $$, '42501', null, 'Trình duyệt không xóa hợp đồng');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.labor_contracts), 2, 'Người lao động thấy hợp đồng của chính mình (cả bản đã hủy)');
select is((select count(*)::int from public.labor_contracts where staff_id = '00000000-0000-0000-0000-00000000aa01'), 0, 'Không thấy hợp đồng người khác');
select throws_ok($$ select public.save_labor_contract(null, '00000000-0000-0000-0000-00000000aa02', 'xac_dinh', '2028-01-01', '2028-12-31', 1, null, null, null, '{}', null) $$, '42501', null, 'Bán vé không lập hợp đồng');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.labor_contracts), 0, 'Nhà xe B không thấy hợp đồng của A');
select throws_ok($$ select public.save_labor_contract(null, '00000000-0000-0000-0000-00000000aa01', 'xac_dinh', '2026-01-01', '2026-12-31', 1, null, null, null, '{}', null) $$, 'P0002', null, 'Nhà xe B không lập HĐ cho người của A');
reset role;
-- Không tự lập / sửa hợp đồng của chính mình (kể cả có quyền)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa09', '{"full_name":"Chủ A","joined_on":"2024-01-01","position":"nhan_vien","user_id":"00000000-0000-0000-0000-0000000000b1"}') $$, 'Hồ sơ của chính Chủ A');
select throws_ok($$ select public.save_labor_contract(null, '00000000-0000-0000-0000-00000000aa09', 'xac_dinh', '2026-01-01', '2026-12-31', 1, null, null, null, '{}', null) $$, '42501', null, 'Không tự lập hợp đồng của chính mình');
reset role;
-- Sang năm mới tự lập hợp đồng cho mọi nhân viên đang làm (như app cũ)
set local role service_role;
select is(app.svc_renew_labor_contracts(2028), 3, 'Năm 2028: tự lập HĐ cho 3 nhân viên đang làm');
select is(app.svc_renew_labor_contracts(2028), 0, 'Chạy lại không lập trùng');
reset role;
select is((select number || '|' || kind || '|' || start_on || '|' || coalesce(end_on::text, '-') || '|' || salary from public.labor_contracts
           where year = 2028 and staff_id = '00000000-0000-0000-0000-00000000aa01'),
  '001/2028/HĐLĐ-TP|khong_xac_dinh|2028-01-01|-|8000000', 'Người có HĐ năm trước: số 001, giữ loại HĐ và lương của HĐ gần nhất');
select is((select kind || '|' || start_on || '|' || end_on from public.labor_contracts where year = 2028 and staff_id = '00000000-0000-0000-0000-00000000aa02'),
  'thoi_vu|2028-01-01|2028-12-31', 'HĐ có thời hạn: 01/01 → 31/12');
select is((select count(*)::int from public.labor_contracts where year = 2028 and tenant_id = (select id from public.tenants where code = 'nha-xe-b')), 0, 'Không lập lẫn sang nhà xe B');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select app.svc_renew_labor_contracts(2029) $$, '42501', null, 'Người dùng không gọi được việc định kỳ');
reset role;
select * from finish();
rollback;
