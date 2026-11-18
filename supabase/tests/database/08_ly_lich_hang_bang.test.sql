-- Kiểm thử Giai đoạn 3.3b: lý lịch hành nghề (bảo mật, chính người đó xem được), hạng GPLX theo loại xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- ---------------------------------------------------------------- Hạng GPLX (hàm thuần)
select is(app.required_license(29, 0, 0), 'D2', 'Xe 29 chỗ (28 khách) cần hạng D2');
select is(app.required_license(30, 0, 0), 'D2', 'Xe 30 chỗ (29 khách) cần hạng D2');
select is(app.required_license(31, 0, 0), 'D', 'Xe 31 chỗ (30 khách) cần hạng D');
select is(app.required_license(16, 0, 0), 'D1', 'Xe 16 chỗ cần hạng D1');
select is(app.required_license(2, 40, 0), 'D', 'Xe giường nằm cần hạng D');
select is(app.required_license(7, 0, 0), 'B', 'Xe 7 chỗ cần hạng B');
select ok(app.license_covers('D', 'D2'), 'Hạng D lái được xe hạng D2');
select ok(not app.license_covers('D2', 'D'), 'Hạng D2 không lái được xe hạng D');
select ok(app.license_covers('DE', 'D'), 'Hạng DE lái được xe hạng D');
select is(app.normalize_license('E', '2020-01-01'), 'D', 'GPLX hạng E cũ quy đổi thành D');
select is(app.normalize_license('d', '2020-01-01'), 'D2', 'GPLX hạng D cũ quy đổi thành D2');
select is(app.normalize_license('D', '2025-06-01'), 'D', 'GPLX hạng D mới giữ nguyên');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'ua2@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'ua3@test.local'),
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
insert into t.ids values ('S1', '33333333-3333-3333-3333-333333333331');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select v from t.ids where k = 'A'), '0900000004', 'Lái xe Tài', 'driver') $$, 'Lái xe A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

-- ---------------------------------------------------------------- Chủ A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats) values ('G29', 'Ghế 29 chỗ', 29) $$, 'Loại xe 29 chỗ');
select lives_ok($$ insert into public.vehicle_types (code, name, body_style, reg_seats, reg_berths) values ('GN40', 'Giường nằm 40', 'giuong_nam', 2, 40) $$, 'Loại xe giường nằm');
select lives_ok($$ insert into public.vehicles (plate, vehicle_type_id) values ('60B-111.22', (select id from public.vehicle_types where code = 'G29')) $$, 'Xe 60B-111.22');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'S1'), jsonb_build_object('full_name', 'Nguyễn Văn Tài',
  'position', 'lai_xe', 'joined_on', '2020-03-15', 'user_id', '00000000-0000-0000-0000-0000000000b3')) $$, 'Hồ sơ lái xe');

select is((select count(*)::int from public.license_matrix() where not ok and reason = 'Chưa có GPLX hoặc chưa nhập hạng'), 2,
  'Chưa có GPLX thì không lái được loại xe nào');
select lives_ok(format($$ select public.add_staff_document('%1$s', 'gplx', '790123456789', null, '2025-03-01', null, app.local_today() + 400,
  '{"hang": "D2"}', array['%2$s/nhan_su/%1$s/gplx_1.jpg'], null, null) $$, (select v from t.ids where k = 'S1'), (select v from t.ids where k = 'A')),
  'GPLX hạng D2');
select ok((select ok from public.license_matrix() where vehicle_type_id = (select id from public.vehicle_types where code = 'G29')),
  'Hạng D2 lái được xe 29 chỗ');
select is((select reason from public.license_matrix() where vehicle_type_id = (select id from public.vehicle_types where code = 'GN40')),
  'Cần hạng D, đang có hạng D2', 'Hạng D2 không lái được xe giường nằm');

-- Lý lịch
select throws_ok($$ select public.save_staff_record(null, (select v from t.ids where k = 'S1'), 'vi_pham', app.local_today() + 1,
  null, 'Chạy quá tốc độ', null, '{}', '{}', null) $$, '22023', null, 'Ngày lý lịch không được sau hôm nay');
select lives_ok($$ select public.save_staff_record(null, (select v from t.ids where k = 'S1'), 'vi_pham', '2026-10-01',
  'QĐ-123', 'Chạy quá tốc độ 15 km/h', '60b 11122', '{"so_tien": 4000000, "tru_diem": 4}', '{}', '44444444-4444-4444-4444-444444444444') $$,
  'Ghi vi phạm, biển số viết khác vẫn nhận ra xe');
select lives_ok($$ select public.save_staff_record(null, (select v from t.ids where k = 'S1'), 'vi_pham', '2026-10-01',
  'QĐ-123', 'Chạy quá tốc độ 15 km/h', null, '{}', '{}', '44444444-4444-4444-4444-444444444444') $$, 'Bấm lưu 2 lần không tạo trùng');
select is((select count(*)::int from public.staff_records), 1, 'Có 1 dòng lý lịch');
select is((select vehicle_id from public.staff_records), (select id from public.vehicles where plate = '60B-111.22'), 'Đã gắn đúng xe');
select lives_ok($$ select public.save_staff_record((select id from public.staff_records), null, null, '2026-10-02',
  'QĐ-123', 'Chạy quá tốc độ 15 km/h (sửa ngày)', '60B-111.22', '{"so_tien": 4000000}', '{}', null) $$, 'Sửa dòng lý lịch');
select is((select occurred_on::text from public.staff_records), '2026-10-02', 'Đã sửa ngày');
select ok(not exists (select 1 from public.audit_logs where detail::text like '%quá tốc độ%'), 'Nhật ký không chép nội dung lý lịch');
reset role;

-- ---------------------------------------------------------------- Bán vé A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.staff_records), 0, 'Bán vé không thấy lý lịch');
select is((select count(*)::int from public.license_matrix()), 2, 'Bán vé / điều hành xem được bảng hạng bằng – loại xe');
select throws_ok($$ select public.save_staff_record(null, (select v from t.ids where k = 'S1'), 'khen_thuong', '2026-10-01',
  null, 'Thưởng', null, '{}', '{}', null) $$, '42501', null, 'Bán vé không ghi được lý lịch');
reset role;

-- ---------------------------------------------------------------- Lái xe Tài
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.staff_records), 1, 'Lái xe xem được lý lịch của mình');
reset role;

-- ---------------------------------------------------------------- Chủ B
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.staff_records), 0, 'Chủ B không thấy lý lịch nhà xe A');
select is((select count(*)::int from public.license_matrix()), 0, 'Chủ B không thấy bảng hạng bằng nhà xe A');
select throws_ok($$ select public.save_staff_record(null, (select v from t.ids where k = 'S1'), 'ky_luat', '2026-10-01',
  null, 'X', null, '{}', '{}', null) $$, 'P0002', null, 'Chủ B ghi lý lịch cho nhân viên nhà xe A thì báo không tìm thấy');
select throws_ok($$ select public.save_staff_record('55555555-5555-5555-5555-555555555555', null, null, '2026-10-01',
  null, 'X', null, '{}', '{}', null) $$, 'P0002', null, 'Chủ B sửa lý lịch không có thì báo không tìm thấy');
reset role;

select ok(not has_function_privilege('anon', 'public.license_matrix()', 'EXECUTE'), 'Khách (anon) không gọi được license_matrix');

select * from finish();
rollback;
