-- Kiểm thử Giai đoạn 6.4 – vận tải hợp đồng: tạo, chặn trùng xe / lái xe, danh sách khách, ký, chạy, xong, thu tiền, lái xe xem, phân quyền, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'ua2@test.local'),
  ('00000000-0000-0000-0000-0000000000b4', 'ua4@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local'),
  ('00000000-0000-0000-0000-0000000000b5', 'lx@test.local');

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

-- ---------------------------------------------------------------- Điều hành A: nốt + chuyến
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.route_stops s join public.routes r on r.id = s.route_id where r.code = 'KHONG'), 2,
  'Tuyến mới tự có điểm đầu / điểm cuối, không phải khai trước');
select is((public.save_schedule(null, (select id from public.routes where code = 'HN-VT'), 'di', '07:00', '{1,2,3,4,5,6,7}', null, null, null)
           ->> 'created_trips')::int, 8, 'Thêm nốt 07:00 chiều đi: tạo 8 chuyến (hôm nay + 7 ngày)');
select throws_ok($$ select public.save_schedule(null, (select id from public.routes where code = 'HN-VT'), 'di', '07:00', '{1}', null, null, null) $$,
  '23505', null, 'Không trùng nốt cùng tuyến, chiều, giờ');
select lives_ok($$ select public.save_schedule(null, (select id from public.routes where code = 'HN-VT'), 've', '13:00', '{1,2,3,4,5,6,7}', null, null, null) $$,
  'Thêm nốt 13:00 chiều về');
select is((select count(*)::int from public.trips), 16, 'Có 16 chuyến');
select is((select extract(epoch from (arrive_at - depart_at))::int / 60 from public.trips limit 1), 300, 'Chuyến dài đúng 5 giờ');
select is((select to_char(depart_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI') from public.trips where direction = 'di' limit 1), '07:00',
  'Giờ xuất bến theo giờ Việt Nam');
select is(public.generate_trips(), 0, 'Bấm "Tạo chuyến" lần nữa không tạo trùng');
reset role;
insert into t.ids select 'T1', id from public.trips where direction = 'di' and service_date = app.local_today() + 1;
insert into t.ids select 'T2', id from public.trips where direction = 've' and service_date = app.local_today() + 1;
insert into t.ids select 'T3', id from public.trips where direction = 'di' and service_date = app.local_today() + 2;


select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b5', (select v from t.ids where k = 'A'), '0900000005', 'Lái Một', 'driver') $$, 'Tài khoản lái xe');
-- Chuyến 1 giờ nữa chạy (để báo xuất bến được)
update public.trips set depart_at = now() + interval '1 hour', arrive_at = now() + interval '6 hours' where id = (select v from t.ids where k = 'T1');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'D1'), jsonb_build_object('full_name', 'Lái Một', 'position', 'lai_xe',
  'joined_on', '2020-01-01', 'user_id', '00000000-0000-0000-0000-0000000000b5')) $$, 'Gắn tài khoản cho lái xe 1');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((public.assign_trip((select v from t.ids where k = 'T1'), (select v from t.ids where k = 'X1'),
  (select v from t.ids where k = 'D1'), null, (select v from t.ids where k = 'D3'), 'Thử') ->> 'saved'), 'true', 'Xếp xe + lái xe 1');
reset role;
-- Một vé đặt chỗ chưa trả tiền trên chuyến
insert into public.bookings (id, tenant_id, code) values ('77777777-7777-7777-7777-777777777771', (select v from t.ids where k = 'A'), 'TEST01');
insert into public.seat_inventory (id, tenant_id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx, price, status)
values ('77777777-7777-7777-7777-777777777772', (select v from t.ids where k = 'A'), '77777777-7777-7777-7777-777777777771',
        (select v from t.ids where k = 'T1'), 'A01', (select id from public.stops where code = 'HN'), (select id from public.stops where code = 'VT'), 0, 1, 100000, 'dat');



set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$ select public.save_charter(null, jsonb_build_object('customer_name', 'Cty ABC', 'customer_phone', '0911111111',
  'pickup_place', 'Biên Hòa', 'destination', 'Đà Lạt', 'start_at', now() + interval '2 hours', 'end_at', now() + interval '2 days',
  'passengers', 20, 'vehicle_id', (select v from t.ids where k = 'X1'), 'price', 5000000), '[]') $$, '23P01', null, 'Xe đang chạy tuyến cố định: chặn trùng');
select throws_ok($$ select public.save_charter(null, jsonb_build_object('customer_name', 'Cty ABC', 'customer_phone', '0911111111',
  'pickup_place', 'Biên Hòa', 'destination', 'Đà Lạt', 'start_at', now() + interval '2 hours', 'end_at', now() + interval '2 days',
  'passengers', 20, 'driver1_id', (select v from t.ids where k = 'D1'), 'price', 5000000), '[]') $$, '23P01', null, 'Lái xe đang có chuyến: chặn trùng');
select is((public.save_charter(null, jsonb_build_object('customer_name', 'Cty ABC', 'customer_phone', '0911111111',
  'pickup_place', 'Biên Hòa', 'destination', 'Đà Lạt', 'start_at', now() + interval '3 days', 'end_at', now() + interval '5 days',
  'passengers', 2, 'vehicle_id', (select v from t.ids where k = 'X2'), 'driver1_id', (select v from t.ids where k = 'D1'), 'price', 5000000),
  '[{"full_name": "Nguyễn A", "phone": "0912345678"}, {"full_name": "Trần B"}]') ->> 'code') like 'HD%', true, 'Tạo hợp đồng + 2 khách');
select is((select contract_no from public.charters), '0001/HĐVC', 'Số hợp đồng tự đánh 0001/HĐVC');
select is((select signed_on from public.charters), app.local_today(), 'Ngày ký mặc định hôm nay');
select is((public.save_charter((select id from public.charters), jsonb_build_object('customer_name', 'Cty ABC', 'customer_phone', '0911111111',
  'pickup_place', 'Biên Hòa', 'destination', 'Đà Lạt', 'start_at', now() + interval '3 days', 'end_at', now() + interval '5 days',
  'passengers', 2, 'vehicle_id', (select v from t.ids where k = 'X2'), 'driver1_id', (select v from t.ids where k = 'D1'), 'price', 5000000,
  'contract_no', '0015/HĐVC-TP', 'signed_on', '2026-11-01', 'distance_km', 320, 'toll_by', 'A', 'meals_by', 'B', 'round_trip', false),
  '[{"full_name": "Nguyễn A", "phone": "0912345678"}, {"full_name": "Trần B"}]') ->> 'contract_no'), '0015/HĐVC-TP', 'Sửa số hợp đồng, ngày ký, cự ly');
select is((select row(distance_km, toll_by, meals_by, round_trip, signed_on)::text from public.charters), '(320,A,B,f,2026-11-01)', 'Lưu trường bổ sung');
select throws_ok($$ select public.save_charter((select id from public.charters), jsonb_build_object('customer_name', 'Cty ABC', 'customer_phone', '0911111111',
  'pickup_place', 'Biên Hòa', 'destination', 'Đà Lạt', 'start_at', now() + interval '3 days', 'end_at', now() + interval '5 days',
  'passengers', 1, 'vehicle_id', (select v from t.ids where k = 'X2'), 'driver1_id', (select v from t.ids where k = 'D1'), 'price', 5000000),
  '[{"full_name": "Nguyễn A"}, {"full_name": "Trần B"}]') $$, '22023', null, 'Danh sách khách vượt số khách');
select is(public.charter_payment((select id from public.charters), 2000000, 'chuyen_khoan', 'Đặt cọc'), 2000000::bigint, 'Thu đặt cọc 2 triệu');
select throws_ok($$ select public.charter_payment((select id from public.charters), 4000000, 'tien_mat', null) $$, '22023', null, 'Không thu vượt giá hợp đồng');
select throws_ok($$ select public.set_charter_status((select id from public.charters), 'dang_chay', null) $$, '22023', null, 'Chưa ký thì chưa chạy');
select lives_ok($$ select public.set_charter_status((select id from public.charters), 'da_ky', null) $$, 'Ký hợp đồng');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select is((select count(*)::int from public.charter_passengers), 2, 'Lái xe thấy danh sách khách hợp đồng của mình');
select lives_ok($$ select public.set_charter_status((select id from public.charters), 'dang_chay', null) $$, 'Lái xe báo bắt đầu chạy');
select lives_ok($$ select public.set_charter_status((select id from public.charters), 'xong', null) $$, 'Lái xe báo xong');
select throws_ok($$ select public.charter_payment((select id from public.charters), 1000, 'tien_mat', null) $$, '42501', null, 'Lái xe không ghi thu hợp đồng');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select is((select count(*)::int from public.charters), 0, 'Bán vé không xem hợp đồng');
reset role;
select set_config('t.c', (select id::text from public.charters), true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.charters), 0, 'Chủ B không thấy hợp đồng nhà xe A');
select throws_ok($$ select public.set_charter_status(current_setting('t.c')::uuid, 'huy', 'x') $$, 'P0002', null, 'Chủ B: không tìm thấy');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is(public.import_legacy_charters(jsonb_build_array(jsonb_build_object('contract_no', '0003/HĐVC', 'customer_name', 'Đoàn cũ',
  'pickup_place', 'Biên Hòa', 'destination', 'Vũng Tàu', 'start_at', '2026-01-02T06:00:00+07', 'end_at', '2026-01-02T20:00:00+07', 'price', 3000000,
  'passengers', jsonb_build_array(jsonb_build_object('full_name', 'Lê C', 'birth_year', 1990))))) - 'errors', '{"created":1,"same":0}'::jsonb, 'Chuyển hợp đồng app cũ (thiếu SĐT)');
select is((select status from public.charters where contract_no = '0003/HĐVC'), 'xong', 'Hợp đồng đã qua là Xong');
select is((select count(*)::int from public.charter_passengers p join public.charters c on c.id = p.charter_id where c.contract_no = '0003/HĐVC'), 1, 'Có danh sách khách');
select is(public.import_legacy_charters(jsonb_build_array(jsonb_build_object('contract_no', '0003/HĐVC', 'customer_name', 'Đoàn cũ',
  'pickup_place', 'Biên Hòa', 'destination', 'Vũng Tàu', 'start_at', '2026-01-02T06:00:00+07', 'end_at', '2026-01-02T20:00:00+07', 'price', 3000000))) ->> 'same',
  '1', 'Nhập lại không trùng');
reset role;

select * from finish();
rollback;
