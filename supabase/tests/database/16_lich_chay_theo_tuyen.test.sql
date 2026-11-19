-- Kiểm thử lịch chạy theo tuyến (save_timetable): tạo giờ hàng loạt, ngày chẵn/lẻ, sửa, bỏ giờ, trùng giờ, phân quyền, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'ua2@test.local'),
  ('00000000-0000-0000-0000-0000000000b4', 'ua4@test.local'),
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
insert into t.ids values ('D1', '33333333-3333-3333-3333-333333333331'), ('D2', '33333333-3333-3333-3333-333333333332'),
                         ('D3', '33333333-3333-3333-3333-333333333333'), ('X1', '66666666-6666-6666-6666-666666666661'),
                         ('X2', '66666666-6666-6666-6666-666666666662');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Điều hành A', 'dispatcher') $$, 'Điều hành A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b4', (select v from t.ids where k = 'A'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');
select is((select value::text from public.tenant_settings where tenant_id = (select v from t.ids where k = 'A') and key = 'chuyen.tao_truoc_ngay'),
  '7', 'Mặc định tạo chuyến trước 7 ngày');

-- ---------------------------------------------------------------- Chủ A: dữ liệu nền
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ update public.tenant_settings set value = '400' where key = 'chuyen.tao_truoc_ngay' $$, '22023', null,
  'Tạo chuyến trước tối đa 365 ngày');
select lives_ok($$ insert into public.stops (code, name, kind) values ('HN', 'BX Hố Nai', 'ben_xe'), ('VT', 'BX Vũng Tàu', 'ben_xe') $$, 'Điểm dừng');
select lives_ok($$ insert into public.routes (code, name, distance_km) values ('HN-VT', 'Hố Nai – Vũng Tàu', 110), ('KHONG', 'Tuyến chưa có giờ', 50) $$, 'Tuyến');
select lives_ok($$ select public.set_route_stops((select id from public.routes where code = 'HN-VT'), jsonb_build_array(
  jsonb_build_object('stop_id', (select id from public.stops where code = 'HN'), 'minutes_from_start', 0),
  jsonb_build_object('stop_id', (select id from public.stops where code = 'VT'), 'minutes_from_start', 300))) $$, 'Tuyến chạy 5 giờ');
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats, reg_berths) values ('GN40', 'Giường nằm 40', 2, 40), ('G29', 'Ghế 29', 29, 0) $$, 'Loại xe');
select lives_ok($$ insert into public.vehicles (id, plate, vehicle_type_id, manufacture_year) values
  ((select v from t.ids where k = 'X1'), '51B-111.11', (select id from public.vehicle_types where code = 'G29'), 2020),
  ((select v from t.ids where k = 'X2'), '51B-222.22', (select id from public.vehicle_types where code = 'GN40'), 2020) $$, 'Hai xe');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'D1'), '{"full_name": "Lái Một", "position": "lai_xe", "joined_on": "2020-01-01"}') $$, 'Lái xe 1');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'D2'), '{"full_name": "Lái Hai", "position": "lai_xe", "joined_on": "2020-01-01"}') $$, 'Lái xe 2');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'D3'), '{"full_name": "Phụ Ba", "position": "phu_xe", "joined_on": "2020-01-01"}') $$, 'Phụ xe');
-- Giấy tờ đầy đủ cho xe 1 và GPLX hạng D2 cho lái xe 1, D cho lái xe 2
select lives_ok(format($$ select public.add_vehicle_document('%1$s', '%3$s', 'S', null, null, null, app.local_today() + 365, '{}',
  array['%2$s/xe/%1$s/a.jpg'], null, null) $$, (select v from t.ids where k = 'X1'), (select v from t.ids where k = 'A'), c), 'Giấy ' || c)
  from unnest(array['kiem_dinh', 'bh_tnds', 'phu_hieu']) c;
select lives_ok(format($$ select public.add_staff_document('%1$s', 'gplx', '1', null, '2025-06-01', null, app.local_today() + 365,
  '{"hang": "%3$s"}', array['%2$s/nhan_su/%1$s/a.jpg'], null, null) $$, (select v from t.ids where k = k2), (select v from t.ids where k = 'A'), h),
  'GPLX ' || h) from (values ('D1', 'D2'), ('D2', 'D')) x(k2, h);
select lives_ok(format($$ select public.add_staff_document('%1$s', 'kham_suc_khoe', null, null, null, null, app.local_today() + 365,
  '{}', array['%2$s/nhan_su/%1$s/k.jpg'], null, null) $$, (select v from t.ids where k = k2), (select v from t.ids where k = 'A')),
  'Khám sức khỏe ' || k2) from (values ('D1'), ('D2')) x(k2);
reset role;


set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((public.save_timetable((select id from public.routes where code = 'HN-VT'), 'di', null, null, null, jsonb_build_array(
  jsonb_build_object('depart_time', '05:00', 'registered_time', '05:00', 'trip_no', '01', 'day_rule', 'thu', 'days', '[1,2,3,4,5,6,7]'::jsonb, 'business_type', 'tuyen_co_dinh'),
  jsonb_build_object('depart_time', '06:00', 'day_rule', 'chan'),
  jsonb_build_object('depart_time', '07:00', 'day_rule', 'le')), null) ->> 'saved')::int, 3, 'Lưu 3 giờ chạy một lần');
select is((select count(*)::int from public.schedules where direction = 'di' and is_active), 3, 'Có 3 nốt chiều đi');
select is((select bool_and(extract(day from service_date)::int % 2 = 0) from public.trips t join public.schedules s on s.id = t.schedule_id
  where s.depart_time = '06:00'), true, 'Giờ 06:00 chỉ chạy ngày chẵn');
select is((select bool_and(extract(day from service_date)::int % 2 = 1) from public.trips t join public.schedules s on s.id = t.schedule_id
  where s.depart_time = '07:00'), true, 'Giờ 07:00 chỉ chạy ngày lẻ');
select is((select count(*)::int from public.trips t join public.schedules s on s.id = t.schedule_id where s.depart_time = '05:00'), 8,
  'Giờ 05:00 chạy hằng ngày: 8 chuyến (hôm nay + 7 ngày)');
select throws_ok($$ select public.save_timetable((select id from public.routes where code = 'HN-VT'), 'di', null, null, null,
  '[{"depart_time": "05:00"}]', null) $$, '23505', null, 'Trùng giờ đã có');
select throws_ok($$ select public.save_timetable((select id from public.routes where code = 'HN-VT'), 'di', null, null, null,
  '[{"depart_time": "25:00"}]', null) $$, '22023', null, 'Giờ sai');
-- Sửa 05:00 sang ngày lẻ: chuyến ngày chẵn từ mai bị hủy (chưa bán, chưa xếp)
select lives_ok(format($$ select public.save_timetable((select id from public.routes where code = 'HN-VT'), 'di', null, null, null,
  '[{"id": "%s", "depart_time": "05:00", "trip_no": "09", "day_rule": "le"}]', null) $$,
  (select id from public.schedules where depart_time = '05:00')), 'Đổi 05:00 sang ngày lẻ, số tài 09');
select is((select trip_no from public.schedules where depart_time = '05:00'), '09', 'Đã đổi số tài');
select is((select count(*)::int from public.trips t join public.schedules s on s.id = t.schedule_id
  where s.depart_time = '05:00' and t.status = 'mo' and t.service_date > app.local_today() and extract(day from t.service_date)::int % 2 = 0), 0,
  'Chuyến ngày chẵn từ mai của 05:00 đã hủy');
-- Bỏ giờ 07:00
select is((public.save_timetable((select id from public.routes where code = 'HN-VT'), 'di', null, null, null, '[]',
  array[(select id from public.schedules where depart_time = '07:00')]) ->> 'stopped')::int, 1, 'Bỏ giờ 07:00');
select is((select count(*)::int from public.trips t join public.schedules s on s.id = t.schedule_id
  where s.depart_time = '07:00' and t.status = 'mo' and t.service_date > app.local_today()), 0, 'Chuyến 07:00 từ mai đã hủy');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select throws_ok($$ select public.save_timetable((select id from public.routes where code = 'HN-VT'), 'di', null, null, null, '[]', null) $$,
  '42501', null, 'Bán vé không sửa lịch chạy');
reset role;
select set_config('t.route', (select id::text from public.routes where code = 'HN-VT'), true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.save_timetable(current_setting('t.route')::uuid, 'di', null, null, null, '[]', null) $$,
  'P0002', null, 'Chủ B sửa lịch chạy tuyến nhà xe A: không tìm thấy');
reset role;

-- Tuyến mới chưa khai điểm dừng / thời gian: vẫn lưu được giờ chạy ngay
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.routes (code, name, distance_km) values ('BHVT', 'Biên Hòa - Vũng Tàu', 112) $$, 'Tạo tuyến chỉ có tên + cự ly');
select is((select string_agg(st.name, ' → ' order by rs.seq) from public.route_stops rs join public.stops st on st.id = rs.stop_id
           join public.routes r on r.id = rs.route_id where r.code = 'BHVT'), 'Biên Hòa → Vũng Tàu', 'Tự có điểm đầu / cuối theo tên tuyến');
select is((select max(minutes_from_start) from public.route_stops rs join public.routes r on r.id = rs.route_id where r.code = 'BHVT'), 170,
  'Tự ước tính thời gian chạy 112 km ≈ 170 phút');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((public.save_timetable((select id from public.routes where code = 'BHVT'), 've', null, null, null,
  jsonb_build_array(jsonb_build_object('depart_time', '10:00')), null) ->> 'saved')::int, 1, 'Lưu giờ chạy chiều về ngay, không phải khai gì thêm');
select ok((select count(*) > 0 from public.trips t join public.routes r on r.id = t.route_id where r.code = 'BHVT' and t.direction = 've'), 'Đã tạo chuyến chiều về');
reset role;

select * from finish();
rollback;
