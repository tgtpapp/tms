-- Kiểm thử Giai đoạn 6.3 – gửi hàng: tạo phiếu, chống lặp, cước, thu hộ, giao hàng (tổ lái), trả thu hộ, hủy hoàn cước, sổ cái, phân quyền, cô lập nhà xe.
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
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select is((public.create_shipment(jsonb_build_object('trip_id', (select v from t.ids where k = 'T1'),
  'from_stop_id', (select id from public.stops where code = 'HN'), 'to_stop_id', (select id from public.stops where code = 'VT'),
  'sender_phone', '0911 111 111', 'receiver_name', 'Chị Lan', 'receiver_phone', '0922222222', 'description', 'Thùng trái cây',
  'packages', 2, 'fee', 50000, 'fee_payer', 'nguoi_gui', 'cod_amount', 300000), 'tien_mat', '88888888-8888-8888-8888-888888888881') ->> 'repeated'),
  'false', 'Nhận hàng, thu cước 50.000, thu hộ 300.000');
select is((public.create_shipment('{}', 'tien_mat', '88888888-8888-8888-8888-888888888881') ->> 'repeated'), 'true', 'Bấm 2 lần không tạo trùng');
select throws_ok($$ select public.create_shipment(jsonb_build_object('from_stop_id', (select id from public.stops where code = 'HN'),
  'to_stop_id', (select id from public.stops where code = 'VT'), 'sender_phone', '123', 'receiver_phone', '0922222222', 'description', 'X',
  'fee', 1000, 'fee_payer', 'nguoi_gui'), 'tien_mat', null) $$, '22023', null, 'SĐT sai bị chặn');
select is((select sum(debit - credit) from public.ledger_lines where account = 'tien_mat')::int, 50000, 'Cước vào quỹ người nhận hàng');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select is((select count(*)::int from public.shipments), 1, 'Lái xe thấy hàng trên chuyến mình');
select lives_ok($$ select public.set_shipment_status((select id from public.shipments), 'den', null, null) $$, 'Lái xe báo hàng đã đến');
select is(public.deliver_shipment((select id from public.shipments), 'Chị Lan', 'tien_mat'), 300000::bigint, 'Giao hàng, lái xe thu hộ 300.000');
select is(public.deliver_shipment((select id from public.shipments), 'Chị Lan', 'tien_mat'), 0::bigint, 'Giao lần 2 không thu thêm');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select is(public.pay_out_cod((select id from public.shipments where cod_amount > 0), 'chuyen_khoan'), 300000, 'Trả thu hộ cho người gửi');
select is(public.pay_out_cod((select id from public.shipments where cod_amount > 0), 'chuyen_khoan'), 0, 'Trả lần 2 không trả thêm');
select lives_ok($$ select public.create_shipment(jsonb_build_object('from_stop_id', (select id from public.stops where code = 'HN'),
  'to_stop_id', (select id from public.stops where code = 'VT'), 'sender_phone', '0911111111', 'receiver_phone', '0933333333', 'description', 'Giấy tờ',
  'fee', 30000, 'fee_payer', 'nguoi_nhan'), null, '88888888-8888-8888-8888-888888888882') $$, 'Người nhận trả cước');
select is(public.deliver_shipment((select id from public.shipments where request_id = '88888888-8888-8888-8888-888888888882'), null, 'tien_mat'),
  30000::bigint, 'Giao + thu cước người nhận');
select lives_ok($$ select public.create_shipment(jsonb_build_object('from_stop_id', (select id from public.stops where code = 'HN'),
  'to_stop_id', (select id from public.stops where code = 'VT'), 'sender_phone', '0911111111', 'receiver_phone', '0944444444', 'description', 'Túi',
  'fee', 20000, 'fee_payer', 'nguoi_gui'), 'tien_mat', '88888888-8888-8888-8888-888888888883') $$, 'Phiếu thứ 3');
select throws_ok($$ select public.set_shipment_status((select id from public.shipments where request_id = '88888888-8888-8888-8888-888888888883'), 'huy', null, '') $$,
  '22023', null, 'Hủy phải có lý do');
select lives_ok($$ select public.set_shipment_status((select id from public.shipments where request_id = '88888888-8888-8888-8888-888888888883'), 'huy', null, 'Khách đổi ý') $$,
  'Hủy phiếu, hoàn cước');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select sum(credit - debit) from public.ledger_lines where account = 'doanh_thu_hang')::int, 80000, 'Doanh thu hàng = 50.000 + 30.000 (phiếu hủy đã hoàn)');
select is((select sum(credit - debit) from public.ledger_lines where account = 'thu_ho')::int, 0, 'Thu hộ đã trả hết');
select is((select sum(debit) - sum(credit) from public.ledger_lines)::int, 0, 'Sổ cái cân');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.shipments), 0, 'Chủ B không thấy hàng nhà xe A');
select throws_ok($$ select public.deliver_shipment('88888888-8888-8888-8888-888888888881', null, 'tien_mat') $$, 'P0002', null, 'Chủ B: không tìm thấy');
reset role;

-- Nơi gửi / nơi nhận chưa có: bán vé thêm mới được (chữ in hoa), gõ lại không tạo trùng, nhà xe khác không thấy
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select set_config('t.ct', public.parcel_stop('chợ  long thành')::text, true);
select is((select name from public.stops where id = current_setting('t.ct')::uuid), 'CHỢ LONG THÀNH', 'Thêm nơi mới, chữ in hoa');
select is(public.parcel_stop('Chợ Long Thành'), current_setting('t.ct')::uuid, 'Gõ lại tên đã có: dùng lại, không tạo trùng');
select throws_ok($$ select public.parcel_stop(' ') $$, '22023', null, 'Phải có tên');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.stops where id = current_setting('t.ct')::uuid), 0, 'Nhà xe khác không thấy nơi mới');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select throws_ok($$ select public.parcel_stop('Bến mới') $$, '42501', null, 'Lái xe (không có quyền nhận hàng) không thêm được');
reset role;


-- Sửa phiếu gửi hàng: đã thu cước thì ghi chênh lệch (thu thêm / hoàn bớt), sổ cái vẫn cân
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select lives_ok($$ select public.create_shipment(jsonb_build_object('from_stop_id', (select id from public.stops where code = 'HN'),
  'to_stop_id', (select id from public.stops where code = 'VT'), 'sender_phone', '0911111111', 'receiver_phone', '0955555555', 'description', 'Bao gạo',
  'packages', 1, 'fee', 40000, 'fee_payer', 'nguoi_gui'), 'tien_mat', '88888888-8888-8888-8888-888888888884') $$, 'Phiếu 4: thu cước 40.000');
select set_config('t.p4', (select id::text from public.shipments where request_id = '88888888-8888-8888-8888-888888888884'), true);
select set_config('t.sp', jsonb_build_object('sender_name', 'Anh Ba', 'sender_phone', '0911111111', 'receiver_name', 'Cô Tư', 'receiver_phone', '0955555555',
  'description', 'Bao gạo 25kg', 'packages', 2, 'fee', 50000, 'fee_payer', 'nguoi_gui', 'cod_amount', 0, 'note', 'Hàng nặng')::text, true);
select is(public.update_shipment(current_setting('t.p4')::uuid, current_setting('t.sp')::jsonb, 'tien_mat') ->> 'chenh_lech', '10000', 'Sửa cước 40.000 → 50.000: thu thêm 10.000');
select is((select description || '|' || packages || '|' || fee || '|' || receiver_name from public.shipments where id = current_setting('t.p4')::uuid),
  'Bao gạo 25kg|2|50000|Cô Tư', 'Thông tin phiếu đã sửa');
select is(public.update_shipment(current_setting('t.p4')::uuid, current_setting('t.sp')::jsonb || '{"fee": 35000}', 'tien_mat') ->> 'chenh_lech', '-15000', 'Giảm cước còn 35.000: hoàn bớt 15.000');
select throws_ok($$ select public.update_shipment(current_setting('t.p4')::uuid, current_setting('t.sp')::jsonb || '{"fee_payer": "nguoi_nhan", "fee": 35000}', 'tien_mat') $$,
  '22023', null, 'Đã thu cước thì không đổi sang người nhận trả');
select throws_ok($$ select public.update_shipment(current_setting('t.p4')::uuid, current_setting('t.sp')::jsonb || '{"fee": 36000}', null) $$,
  '22023', null, 'Có tiền chênh lệch phải chọn cách thu / hoàn');
select lives_ok($$ select public.create_shipment(jsonb_build_object('from_stop_id', (select id from public.stops where code = 'HN'),
  'to_stop_id', (select id from public.stops where code = 'VT'), 'sender_phone', '0911111111', 'receiver_phone', '0966666666', 'description', 'Hộp',
  'fee', 20000, 'fee_payer', 'nguoi_nhan'), null, '88888888-8888-8888-8888-888888888885') $$, 'Phiếu 5: người nhận trả');
select is(public.update_shipment((select id from public.shipments where request_id = '88888888-8888-8888-8888-888888888885'),
  jsonb_build_object('sender_phone', '0911111111', 'receiver_phone', '0966666666', 'description', 'Hộp', 'packages', 1, 'fee', 25000, 'fee_payer', 'nguoi_nhan'), null) ->> 'chenh_lech',
  '0', 'Người nhận trả: sửa cước không động sổ');
select is(public.update_shipment((select id from public.shipments where request_id = '88888888-8888-8888-8888-888888888885'),
  jsonb_build_object('sender_phone', '0911111111', 'receiver_phone', '0966666666', 'description', 'Hộp', 'packages', 1, 'fee', 25000, 'fee_payer', 'nguoi_gui'), 'chuyen_khoan') ->> 'chenh_lech',
  '25000', 'Đổi sang người gửi trả: thu cước ngay');
select ok((select fee_paid_at is not null from public.shipments where request_id = '88888888-8888-8888-8888-888888888885'), 'Phiếu 5 đã thu cước');
select throws_ok($$ select public.update_shipment('88888888-8888-8888-8888-888888888881'::uuid, '{}', 'tien_mat') $$, 'P0002', null, 'Mã không có: không tìm thấy');
select throws_ok($$ select public.update_shipment((select id from public.shipments where status = 'giao' limit 1), current_setting('t.sp')::jsonb, 'tien_mat') $$,
  '22023', null, 'Phiếu đã giao không sửa được');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select sum(credit - debit) from public.ledger_lines where account = 'doanh_thu_hang')::int, 80000 + 35000 + 25000, 'Doanh thu hàng khớp sau khi sửa');
select is((select sum(debit) - sum(credit) from public.ledger_lines)::int, 0, 'Sổ cái vẫn cân');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.update_shipment(current_setting('t.p4')::uuid, current_setting('t.sp')::jsonb, 'tien_mat') $$, 'P0002', null, 'Chủ B sửa phiếu nhà xe A: không tìm thấy');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select throws_ok($$ select public.update_shipment(current_setting('t.p4')::uuid, current_setting('t.sp')::jsonb, 'tien_mat') $$, 'P0002', null, 'Lái xe không sửa được phiếu');
reset role;

-- ---------------------------------------------------------------- Dời phiếu sang xe (chuyến) khác, kể cả tuyến khác / ngày khác
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.create_shipment(jsonb_build_object('trip_id', (select v from t.ids where k = 'T1'), 'from_stop_id', (select id from public.stops where code = 'HN'),
  'to_stop_id', (select id from public.stops where code = 'VT'), 'sender_phone', '0911111111', 'receiver_phone', '0966666666', 'description', 'Thùng dời',
  'fee', 20000, 'fee_payer', 'nguoi_nhan'), null, '88888888-8888-8888-8888-888888888899') $$, 'Phiếu dời: tạo ở chuyến T1');
select lives_ok($$ select public.set_shipment_status((select id from public.shipments where request_id = '88888888-8888-8888-8888-888888888899'), 'tren_xe', null, null) $$, 'Phiếu dời: lên xe T1');
select lives_ok($$ select public.move_shipment((select id from public.shipments where request_id = '88888888-8888-8888-8888-888888888899'), (select v from t.ids where k = 'T3')) $$,
  'Dời sang chuyến khác (ngày khác)');
select is((select trip_id from public.shipments where request_id = '88888888-8888-8888-8888-888888888899'), (select v from t.ids where k = 'T3'), 'Phiếu nằm ở chuyến mới');
select is((select status from public.shipments where request_id = '88888888-8888-8888-8888-888888888899'), 'tren_xe', 'Giữ nguyên trạng thái đã lên xe');
select is((select service_date from public.shipments where request_id = '88888888-8888-8888-8888-888888888899'), app.local_today() + 2, 'Ngày của phiếu theo chuyến mới');
select throws_ok($$ select public.move_shipment((select id from public.shipments where request_id = '88888888-8888-8888-8888-888888888899'), (select v from t.ids where k = 'T3')) $$,
  '22023', null, 'Dời vào đúng chuyến đang ở: báo lỗi');
select throws_ok($$ select public.move_shipment((select id from public.shipments where request_id = '88888888-8888-8888-8888-888888888899'), gen_random_uuid()) $$,
  'P0002', null, 'Chuyến không có: không tìm thấy');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select throws_ok($$ select public.move_shipment((select id from public.shipments where request_id = '88888888-8888-8888-8888-888888888899'), (select v from t.ids where k = 'T1')) $$,
  'P0002', null, 'Lái xe không dời được phiếu');
reset role;
insert into t.ids select 'PD', id from public.shipments where request_id = '88888888-8888-8888-8888-888888888899';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.move_shipment((select v from t.ids where k = 'PD'), (select v from t.ids where k = 'T1')) $$,
  'P0002', null, 'Chủ B dời phiếu nhà xe A: không tìm thấy');
reset role;

select * from finish();
rollback;
