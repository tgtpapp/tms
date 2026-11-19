-- Kiểm thử Giai đoạn 6.5 – Zalo: chỉ xếp tin khi đã kết nối + bật mẫu, mỗi vé / kiện 1 tin, phân quyền, mã truy cập không lộ, cô lập nhà xe.
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
select throws_ok($$ select public.save_schedule(null, (select id from public.routes where code = 'KHONG'), 'di', '07:00', '{1,2,3,4,5,6,7}', null, null, null) $$,
  '22023', null, 'Tuyến chưa có thời gian chạy thì không thêm nốt');
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
-- ---------------------------------------------------------------- Cấu hình mẫu ZNS
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select throws_ok($$ select public.save_zalo_template('ve', '123', true) $$, '42501', null, 'Bán vé không cấu hình Zalo được');
select throws_ok($$ select public.zalo_status() $$, '42501', null, 'Bán vé không xem trạng thái Zalo');
select is((select count(*)::int from public.zalo_messages), 0, 'Bán vé không xem nhật ký tin');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select public.save_zalo_template('ve', 'mã sai!', true) $$, '22023', null, 'Mã mẫu sai định dạng bị chặn');
select lives_ok($$ select public.save_zalo_template('ve', '301234', true) $$, 'Chủ A đặt mẫu xác nhận vé');
select lives_ok($$ select public.save_zalo_template('hang', '301235', true) $$, 'Chủ A đặt mẫu báo hàng đến');
select is((select count(*)::int from public.zalo_templates), 2, 'Có 2 mẫu');
select is(public.zalo_status() ->> 'connected', 'false', 'Chưa kết nối OA');
select throws_ok($$ select * from public.zalo_connections $$, '42501', null, 'Trình duyệt không đọc được mã truy cập Zalo');
select throws_ok($$ select public.svc_zalo_claim((select v from t.ids where k = 'A'), 10) $$, '42501', null, 'Người dùng không gọi được hàm nội bộ');
reset role;

-- Chưa kết nối OA: bán vé không xếp tin
insert into public.bookings (id, tenant_id, code, customer_phone) values ('77777777-7777-7777-7777-777777777771', (select v from t.ids where k = 'A'), 'TEST01', '0911111111');
insert into public.seat_inventory (tenant_id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx, price, status)
values ((select v from t.ids where k = 'A'), '77777777-7777-7777-7777-777777777771', (select v from t.ids where k = 'T1'), 'A01',
        (select id from public.stops where code = 'HN'), (select id from public.stops where code = 'VT'), 0, 1, 100000, 'dat');
select is((select count(*)::int from public.zalo_messages), 0, 'Chưa kết nối OA thì không xếp tin');

-- Kết nối OA (Edge Function ghi bằng service_role)
insert into public.zalo_connections (tenant_id, oa_id, oa_name, access_token, refresh_token, access_expires_at)
values ((select v from t.ids where k = 'A'), '999', 'Nhà xe A OA', 'acc', 'ref', now() + interval '1 day');

-- Vé 2 ghế: chỉ 1 tin; giữ ghế chưa xếp, xác nhận mới xếp
insert into public.bookings (id, tenant_id, code, customer_phone) values ('77777777-7777-7777-7777-777777777781', (select v from t.ids where k = 'A'), 'TEST02', '0912 345 678');
insert into public.seat_inventory (tenant_id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx, price, status, hold_until)
select (select v from t.ids where k = 'A'), '77777777-7777-7777-7777-777777777781', (select v from t.ids where k = 'T1'), s,
        (select id from public.stops where code = 'HN'), (select id from public.stops where code = 'VT'), 0, 1, 100000, 'giu', now() + interval '5 minutes'
from unnest(array['A02', 'A03']) s;
select is((select count(*)::int from public.zalo_messages), 0, 'Đang giữ ghế chưa gửi tin');
update public.seat_inventory set status = 'dat', hold_until = null where booking_id = '77777777-7777-7777-7777-777777777781';
select is((select count(*)::int from public.zalo_messages where kind = 've'), 1, 'Xác nhận vé 2 ghế: 1 tin');
select is((select phone from public.zalo_messages where kind = 've'), '0912345678', 'SĐT chuẩn hóa');
update public.seat_inventory set status = 'da_tt', paid_at = now() where booking_id = '77777777-7777-7777-7777-777777777781';
select is((select count(*)::int from public.zalo_messages where kind = 've'), 1, 'Thanh toán sau không gửi thêm tin');

-- Hàng đến nơi: báo người nhận 1 lần
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select lives_ok($$ select public.create_shipment(jsonb_build_object('trip_id', (select v from t.ids where k = 'T1'),
  'from_stop_id', (select id from public.stops where code = 'HN'), 'to_stop_id', (select id from public.stops where code = 'VT'),
  'sender_phone', '0911111111', 'receiver_name', 'Chị Lan', 'receiver_phone', '0922222222', 'description', 'Thùng trái cây',
  'fee', 50000, 'fee_payer', 'nguoi_gui'), 'tien_mat', '88888888-8888-8888-8888-888888888881') $$, 'Nhận hàng');
select is((select count(*)::int from public.zalo_messages), 0, 'Nhận hàng chưa báo (bán vé không xem được nhật ký)');
reset role;
select is((select count(*)::int from public.zalo_messages where kind = 'hang'), 0, 'Mới nhận hàng: chưa xếp tin');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select lives_ok($$ select public.set_shipment_status((select id from public.shipments), 'den', null, null) $$, 'Lái xe báo hàng đã đến');
reset role;
select is((select phone from public.zalo_messages where kind = 'hang'), '0922222222', 'Hàng đến: xếp tin cho người nhận');

-- Tắt mẫu: không xếp tin mới
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.save_zalo_template('ve', '301234', false) $$, 'Tắt mẫu vé');
select is(public.zalo_status() ->> 'connected', 'true', 'Đã kết nối OA');
select is((public.zalo_status() ->> 'waiting')::int, 2, '2 tin chờ gửi');
select is((select count(*)::int from public.zalo_messages), 2, 'Chủ A xem được nhật ký tin');
reset role;
insert into public.bookings (id, tenant_id, code, customer_phone) values ('77777777-7777-7777-7777-777777777791', (select v from t.ids where k = 'A'), 'TEST03', '0913333333');
insert into public.seat_inventory (tenant_id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx, price, status, paid_at)
values ((select v from t.ids where k = 'A'), '77777777-7777-7777-7777-777777777791', (select v from t.ids where k = 'T1'), 'A04',
        (select id from public.stops where code = 'HN'), (select id from public.stops where code = 'VT'), 0, 1, 100000, 'da_tt', now());
select is((select count(*)::int from public.zalo_messages where kind = 've'), 1, 'Mẫu tắt thì không xếp tin');

-- Hàm nội bộ nhận tin: không nhận trùng
set local role service_role;
select is((select count(*)::int from public.svc_zalo_claim((select v from t.ids where k = 'A'), 10)), 2, 'Nhận 2 tin để gửi');
select is((select count(*)::int from public.svc_zalo_claim((select v from t.ids where k = 'A'), 10)), 0, 'Lần nhận sau không lấy lại tin đang gửi');
reset role;
update public.zalo_messages set status = 'loi', error = 'thử' where kind = 'hang';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is(public.zalo_retry_failed(), 1, 'Gửi lại 1 tin lỗi');
select lives_ok($$ select public.zalo_disconnect() $$, 'Ngắt kết nối OA');
select is(public.zalo_status() ->> 'connected', 'false', 'Đã ngắt');
reset role;

-- Nhà xe B không thấy gì của A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.zalo_messages), 0, 'Nhà xe B không thấy tin của A');
select is((select count(*)::int from public.zalo_templates), 0, 'Nhà xe B không thấy mẫu của A');
select is(public.zalo_status() ->> 'connected', 'false', 'Nhà xe B chưa kết nối');
reset role;

select * from finish();
rollback;
