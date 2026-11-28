-- Kiểm thử Quyết định thôi việc: dãy số riêng 001/năm/QĐTV-<hậu tố>, chuyển hồ sơ sang Nghỉ việc (cần staff.edit), cô lập nhà xe.
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
select lives_ok($$ insert into public.tenant_settings (key, value) values ('lenh.hau_to', '"TGTP"') $$, 'Hậu tố');
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Nguyễn Văn Nghỉ","joined_on":"2024-01-01","position":"lai_xe"}') $$, 'Nhân viên');
select is(public.save_official_doc(null, 'quyet_dinh', '2026-03-01', 'Về việc khác', null, '{}', null) ->> 'number', '001/2026/QĐ-TGTP', 'Quyết định khác');
select is(public.save_official_doc(null, 'qd_thoi_viec', '2026-03-02', 'Về việc chấm dứt hợp đồng lao động', '00000000-0000-0000-0000-00000000aa01',
  '{"ngay_nghi":"2026-04-01"}', null) ->> 'number', '001/2026/QĐTV-TGTP', 'Quyết định thôi việc: dãy riêng bắt đầu 001');
select is(public.save_official_doc(null, 'qd_thoi_viec', '2026-03-05', 'Về việc chấm dứt hợp đồng lao động', '00000000-0000-0000-0000-00000000aa01', '{}', null) ->> 'number',
  '002/2026/QĐTV-TGTP', 'Tự tăng 002');
select is(public.save_official_doc(null, 'quyet_dinh', '2026-03-06', 'Về việc khác 2', null, '{}', null) ->> 'number', '002/2026/QĐ-TGTP', 'Dãy QĐ không bị ảnh hưởng');
select is(public.save_official_doc(null, 'hd_bai_xe', '2026-03-07', 'Thuê bãi đậu xe', null, '{"vai_tro":"thue","ben_ten":"Bến xe Biên Hòa"}', null) ->> 'number',
  '001/2026/HĐBX-TGTP', 'Hợp đồng thuê bãi đậu xe: dãy riêng HĐBX');
select is(public.save_official_doc(null, 'hd_bai_xe', '2026-03-08', 'Thuê bãi đậu xe 2', null, '{}', null) ->> 'number', '002/2026/HĐBX-TGTP', 'HĐBX tự tăng 002');
select throws_ok(format('select public.save_official_doc(%L, %L, %L, %L, null, %L, null)', (select id from public.official_docs where number = '001/2026/QĐTV-TGTP'), 'quyet_dinh', '2026-03-02', 'Đổi loại', '{}'),
  '22023', null, 'Không đổi sang loại khác sau khi cấp số');
select throws_ok($$ select public.mark_staff_left('00000000-0000-0000-0000-00000000aa01', '2023-12-31') $$, '22023', null, 'Ngày nghỉ trước ngày vào làm bị từ chối');
select lives_ok($$ select public.mark_staff_left('00000000-0000-0000-0000-00000000aa01', '2026-04-01') $$, 'Chuyển hồ sơ sang Nghỉ việc');
select is((select left_on::text || '|' || is_active::text from public.staff_members where id = '00000000-0000-0000-0000-00000000aa01'), '2026-04-01|false', 'Hồ sơ đã nghỉ việc');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select throws_ok($$ select public.mark_staff_left('00000000-0000-0000-0000-00000000aa01', '2026-04-01') $$, '42501', null, 'Bán vé không sửa hồ sơ nhân viên');
select throws_ok($$ select public.save_official_doc(null, 'qd_thoi_viec', '2026-06-01', 'x', null, '{}', null) $$, '42501', null, 'Bán vé không soạn quyết định');
select throws_ok($$ select public.save_official_doc(null, 'hd_bai_xe', '2026-06-01', 'x', null, '{}', null) $$, '42501', null, 'Bán vé không soạn hợp đồng bãi xe');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.mark_staff_left('00000000-0000-0000-0000-00000000aa01', '2026-04-01') $$, 'P0002', null, 'Nhà xe khác: không tìm thấy nhân viên');
select is((select count(*)::int from public.official_docs), 0, 'Nhà xe khác không xem sổ của nhà xe A');
select is(public.save_official_doc(null, 'qd_thoi_viec', '2026-03-02', 'Về việc chấm dứt hợp đồng lao động', null, '{}', null) ->> 'number', '001/2026/QĐTV', 'Nhà xe B dãy riêng 001');
reset role;
select * from finish();
rollback;
