-- Kiểm thử Văn bản: cấp số 001 tự tăng theo loại × năm, không trùng, không dùng lại số đã hủy, chống bấm 2 lần,
-- không đổi năm / loại sau khi cấp số, quyền, cô lập nhà xe.
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
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Nguyễn Văn Điều","joined_on":"2024-01-01","position":"nhan_vien"}') $$, 'Nhân viên');
select is(public.save_official_doc(null, 'qd_bo_nhiem', '2026-03-01', 'Về việc bổ nhiệm người điều hành', '00000000-0000-0000-0000-00000000aa01', '{}', '00000000-0000-0000-0000-0000000000f1') ->> 'number',
  '001/2026/QĐ-TP', 'Quyết định đầu tiên: 001');
select is(public.save_official_doc(null, 'qd_bo_nhiem', '2026-03-01', 'Về việc bổ nhiệm người điều hành', '00000000-0000-0000-0000-00000000aa01', '{}', '00000000-0000-0000-0000-0000000000f1') ->> 'number',
  '001/2026/QĐ-TP', 'Bấm 2 lần (cùng mã yêu cầu) không cấp số mới');
select is(public.save_official_doc(null, 'qd_atgt', '2026-04-01', 'Về việc thành lập Ban ATGT', null, '{}', null) ->> 'number', '002/2026/QĐ-TP', 'Các mẫu quyết định dùng chung dãy QĐ');
select is(public.save_official_doc(null, 'cong_van', '2026-04-02', 'V/v đăng ký tuyến', null, '{}', null) ->> 'number', '001/2026/CV-TP', 'Công văn dãy riêng, bắt đầu 001');
select is(public.save_official_doc(null, 'thong_bao', '2026-04-02', 'Thông báo nghỉ lễ', null, '{}', null) ->> 'number', '001/2026/TB-TP', 'Thông báo dãy riêng');
select is(public.save_official_doc(null, 'quyet_dinh', '2027-01-02', 'Về việc khen thưởng', null, '{}', null) ->> 'number', '001/2027/QĐ-TP', 'Sang năm mới bắt đầu lại 001');
select lives_ok(format('select public.cancel_official_doc(%L, %L)', (select id from public.official_docs where number = '002/2026/QĐ-TP'), 'Soạn nhầm'), 'Hủy văn bản');
select is(public.save_official_doc(null, 'quyet_dinh', '2026-05-01', 'Về việc điều động', null, '{}', null) ->> 'number', '003/2026/QĐ-TP', 'Số đã hủy không cấp lại');
select is((select count(*)::int from public.official_docs where code = 'QD' and year = 2026), 3, 'Sổ giữ cả văn bản đã hủy');
select throws_ok(format('select public.save_official_doc(%L, %L, %L, %L, null, %L, null)', (select id from public.official_docs where number = '003/2026/QĐ-TP'), 'quyet_dinh', '2027-02-01', 'Đổi năm', '{}'),
  '22023', null, 'Không đổi năm ký sau khi đã cấp số');
select throws_ok(format('select public.save_official_doc(%L, %L, %L, %L, null, %L, null)', (select id from public.official_docs where number = '003/2026/QĐ-TP'), 'cong_van', '2026-05-01', 'Đổi loại', '{}'),
  '22023', null, 'Không đổi loại sau khi đã cấp số');
select lives_ok(format('select public.save_official_doc(%L, %L, %L, %L, null, %L, null)', (select id from public.official_docs where number = '003/2026/QĐ-TP'), 'quyet_dinh', '2026-05-03', 'Về việc điều động lái xe', '{"dieu":["a"]}'),
  'Sửa nội dung, giữ số');
select is((select number from public.official_docs where title = 'Về việc điều động lái xe'), '003/2026/QĐ-TP', 'Sửa không đổi số');
select throws_ok(format('select public.save_official_doc(%L, %L, %L, %L, null, %L, null)', (select id from public.official_docs where number = '002/2026/QĐ-TP'), 'qd_atgt', '2026-04-01', 'Sửa', '{}'),
  '22023', null, 'Văn bản đã hủy không sửa được');
select throws_ok($$ delete from public.official_docs $$, '42501', null, 'Trình duyệt không xóa được văn bản');
select throws_ok($$ insert into public.official_docs (template, code, year, seq, number, signed_on, title) values ('cong_van', 'CV', 2026, 2, 'x', '2026-01-01', 'x') $$, '42501', null, 'Trình duyệt không tự ghi số');
reset role;
-- Cùng lúc có số lớn hơn bộ đếm (dữ liệu cũ): cấp số nhảy qua, không trùng
update public.doc_counters set last_no = 0 where code = 'CV' and year = 2026;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is(public.save_official_doc(null, 'cong_van', '2026-06-01', 'V/v khác', null, '{}', null) ->> 'number', '002/2026/CV-TP', 'Bộ đếm lệch vẫn không cấp trùng');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select throws_ok($$ select public.save_official_doc(null, 'cong_van', '2026-06-01', 'x', null, '{}', null) $$, '42501', null, 'Bán vé không soạn văn bản');
select is((select count(*)::int from public.official_docs), 0, 'Bán vé không xem sổ văn bản');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.official_docs), 0, 'Nhà xe B không thấy văn bản của A');
select throws_ok(format('select public.cancel_official_doc(%L, %L)', (select id from public.official_docs limit 1), 'x'), 'P0002', null, 'Nhà xe B không hủy được (không tìm thấy)');
select is(public.save_official_doc(null, 'cong_van', '2026-04-02', 'V/v B', null, '{}', null) ->> 'number', '001/2026/CV', 'Nhà xe B dãy riêng; chưa có ký hiệu thì bỏ phần cuối');
reset role;
select is((select count(*)::int from public.official_docs where status = 'hieu_luc' and number like '%-TP'), 6, 'Nhà xe A còn 6 văn bản hiệu lực');
select * from finish();
rollback;
