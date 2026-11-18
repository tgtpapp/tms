-- Kiểm thử Giai đoạn 3.2b: xe, giấy tờ (bản hiện hành / giấy cũ), tệp trong Storage, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'ua2@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');

create schema t;
create table t.ids (k text primary key, v uuid not null);
grant usage on schema t to authenticated;
grant select on t.ids to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
insert into t.ids select 'A', id from public.tenants where code = 'nha-xe-a';
insert into t.ids select 'B', id from public.tenants where code = 'nha-xe-b';
insert into t.ids values ('V', '11111111-1111-1111-1111-111111111111');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select v from t.ids where k = 'B'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');
select is((select value::text from public.tenant_settings where tenant_id = (select v from t.ids where k = 'A') and key = 'giay_to.canh_bao_truoc_ngay'),
  '30', 'Mặc định cảnh báo giấy tờ trước 30 ngày');
select is((select count(*)::int from public.document_types where code = 'bh_vat_chat'), 1, 'Có loại giấy Bảo hiểm vật chất xe');

-- ---------------------------------------------------------------- Chủ A: loại xe + xe
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats) values ('G29', 'Ghế ngồi 29 chỗ', 29) $$, 'Chủ A tạo loại xe');
select throws_ok($$ insert into public.vehicles (plate, vehicle_type_id) values ('ABC', (select id from public.vehicle_types where code = 'G29')) $$,
  '23514', null, 'Chặn biển số sai dạng');
select lives_ok($$ insert into public.vehicles (id, plate, vehicle_type_id, chassis_no, manufacture_year, ownership)
  values ((select v from t.ids where k = 'V'), '51B-123.45', (select id from public.vehicle_types where code = 'G29'), 'RLHABC12345678901', 2018, 'thue') $$,
  'Chủ A thêm xe 51B-123.45');
select throws_ok($$ insert into public.vehicles (plate, vehicle_type_id) values ('51b 12345', (select id from public.vehicle_types where code = 'G29')) $$,
  '23505', null, 'Chặn trùng biển số dù viết khác (51b 12345)');
select throws_ok($$ insert into public.vehicles (plate, vehicle_type_id, chassis_no) values ('51B-999.99', (select id from public.vehicle_types where code = 'G29'), 'rlhabc12345678901') $$,
  '23505', null, 'Chặn trùng số khung');

-- Tệp trong Storage: chỉ ghi được vào thư mục nhà xe mình
select lives_ok(format($$ insert into storage.objects (bucket_id, name) values ('giay-to', '%s/xe/%s/51B12345_kiem_dinh_1.jpg') $$,
  (select v from t.ids where k = 'A'), (select v from t.ids where k = 'V')), 'Chủ A tải ảnh giấy tờ vào thư mục nhà xe A');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('giay-to', '%s/xe/x/a.jpg') $$,
  (select v from t.ids where k = 'B')), '42501', null, 'Chủ A không ghi được vào thư mục nhà xe B');

-- Giấy tờ
select throws_ok($$ select public.add_vehicle_document((select v from t.ids where k = 'V'), 'kiem_dinh', 'KD1', null, null, null,
  app.local_today() + 10, '{}', '{}', null, null) $$, '22023', null, 'Phải có ảnh giấy tờ');
select throws_ok(format($$ select public.add_vehicle_document('%s', 'kiem_dinh', 'KD1', null, null, null, app.local_today() + 10, '{}',
  array['%s/xe/khac/a.jpg'], null, null) $$, (select v from t.ids where k = 'V'), (select v from t.ids where k = 'A')),
  '22023', null, 'Tệp phải nằm trong thư mục của đúng xe');
select throws_ok(format($$ select public.add_vehicle_document('%s', 'giay_la', 'X', null, null, null, null, '{}', array['%s/xe/%s/a.jpg'], null, null) $$,
  (select v from t.ids where k = 'V'), (select v from t.ids where k = 'A'), (select v from t.ids where k = 'V')),
  '22023', null, 'Chặn loại giấy không có trong danh mục');
select lives_ok(format($$ select public.add_vehicle_document('%1$s', 'kiem_dinh', 'KD1', 'Đăng kiểm 50-01V', null, null, app.local_today() + 10,
  '{"xe.cho_ngoi": 29}', array['%2$s/xe/%1$s/51B12345_kiem_dinh_1.jpg'], null, '22222222-2222-2222-2222-222222222222') $$,
  (select v from t.ids where k = 'V'), (select v from t.ids where k = 'A')), 'Lưu giấy kiểm định thứ nhất');
select lives_ok(format($$ select public.add_vehicle_document('%1$s', 'kiem_dinh', 'KD1', 'Đăng kiểm 50-01V', null, null, app.local_today() + 10,
  '{}', array['%2$s/xe/%1$s/51B12345_kiem_dinh_1.jpg'], null, '22222222-2222-2222-2222-222222222222') $$,
  (select v from t.ids where k = 'V'), (select v from t.ids where k = 'A')), 'Bấm lưu 2 lần (cùng mã yêu cầu) không tạo bản trùng');
select is((select count(*)::int from public.documents), 1, 'Chỉ có 1 giấy');
select lives_ok(format($$ select public.add_vehicle_document('%1$s', 'kiem_dinh', 'KD2', null, null, null, app.local_today() + 200,
  '{}', array['%2$s/xe/%1$s/51B12345_kiem_dinh_2.jpg'], null, null) $$,
  (select v from t.ids where k = 'V'), (select v from t.ids where k = 'A')), 'Thêm bản kiểm định mới');
select is((select doc_no from public.documents where is_current and doc_type = 'kiem_dinh'), 'KD2', 'Bản mới là bản hiện hành');
select is((select count(*)::int from public.documents where not is_current), 1, 'Bản cũ vẫn giữ lại (giấy cũ)');
select lives_ok(format($$ select public.add_vehicle_document('%1$s', 'bh_vat_chat', 'VC-01', 'Bảo hiểm X', null, app.local_today(),
  app.local_today() + 365, '{"so_tien_bao_hiem": 1200000000, "muc_khau_tru": 500000}', array['%2$s/xe/%1$s/51B12345_bh_vat_chat_1.jpg'], null, null) $$,
  (select v from t.ids where k = 'V'), (select v from t.ids where k = 'A')), 'Lưu bảo hiểm vật chất xe');
select lives_ok($$ select public.update_document((select id from public.documents where doc_no = 'VC-01'), 'VC-01A', 'Bảo hiểm X',
  null, app.local_today(), app.local_today() + 365, '{"so_tien_bao_hiem": 1300000000}', null) $$, 'Sửa thông tin giấy tờ');
select is((select (data ->> 'so_tien_bao_hiem')::bigint from public.documents where doc_no = 'VC-01A'), 1300000000::bigint, 'Đã lưu thông tin sửa');
select throws_ok($$ select public.update_document((select id from public.documents where doc_no = 'VC-01A'), 'X', null, null,
  app.local_today(), app.local_today() - 1, '{}', null) $$, '23514', null, 'Chặn ngày hết hạn trước ngày hiệu lực');
select throws_ok($$ update public.documents set doc_no = 'Z' $$, '42501', null, 'Trình duyệt không sửa thẳng bảng giấy tờ');
select ok(exists (select 1 from public.audit_logs where entity = 'documents'), 'Nhật ký ghi thao tác giấy tờ');
reset role;

-- ---------------------------------------------------------------- Bán vé A: xem được, không sửa được
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.vehicles), 1, 'Bán vé xem được xe');
select is((select count(*)::int from public.documents where is_current), 2, 'Bán vé xem được giấy tờ xe hiện hành');
select is((select count(*)::int from storage.objects where bucket_id = 'giay-to'), 1, 'Bán vé xem được ảnh giấy tờ xe');
select throws_ok(format($$ select public.add_vehicle_document('%1$s', 'phu_hieu', 'PH', null, null, null, null, '{}',
  array['%2$s/xe/%1$s/a.jpg'], null, null) $$, (select v from t.ids where k = 'V'), (select v from t.ids where k = 'A')),
  '42501', null, 'Bán vé không thêm được giấy tờ');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('giay-to', '%s/xe/%s/b.jpg') $$,
  (select v from t.ids where k = 'A'), (select v from t.ids where k = 'V')), '42501', null, 'Bán vé không tải được ảnh giấy tờ');
with u as (update public.vehicles set color = 'Đỏ' returning 1)
select is(count(*)::int, 0, 'Bán vé không sửa được xe') from u;
reset role;

-- ---------------------------------------------------------------- Chủ B: không thấy gì của nhà xe A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.vehicles), 0, 'Chủ B không thấy xe nhà xe A');
select is((select count(*)::int from public.documents), 0, 'Chủ B không thấy giấy tờ nhà xe A');
select is((select count(*)::int from storage.objects where bucket_id = 'giay-to'), 0, 'Chủ B không thấy ảnh giấy tờ nhà xe A');
select throws_ok(format($$ select public.add_vehicle_document('%1$s', 'phu_hieu', 'PH', null, null, null, null, '{}',
  array['%2$s/xe/%1$s/a.jpg'], null, null) $$, (select v from t.ids where k = 'V'), (select v from t.ids where k = 'B')),
  'P0002', null, 'Chủ B thêm giấy cho xe nhà xe A thì báo không tìm thấy');
select throws_ok($$ select public.update_document((select id from public.documents limit 1), 'X', null, null, null, null, '{}', null) $$,
  'P0002', null, 'Chủ B sửa giấy nhà xe A thì báo không tìm thấy');
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats) values ('G29', 'Loại B', 29) $$, 'Chủ B tạo loại xe');
select lives_ok($$ insert into public.vehicles (plate, vehicle_type_id) values ('51B-123.45', (select id from public.vehicle_types where code = 'G29')) $$,
  'Nhà xe B có thể có xe cùng biển số ở hệ thống riêng của mình');
reset role;

select ok(not has_function_privilege('anon', 'public.add_vehicle_document(uuid, text, text, text, date, date, date, jsonb, text[], text, uuid)', 'EXECUTE'),
  'Khách (anon) không gọi được add_vehicle_document');

select * from finish();
rollback;
