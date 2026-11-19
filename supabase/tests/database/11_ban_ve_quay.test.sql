-- Kiểm thử Giai đoạn 4.1: kho ghế (chống bán trùng theo chặng, 2 quầy cùng lúc), giữ ghế, thu tiền / đặt chỗ,
-- tự nhả, gia hạn, sổ cái kép chỉ thêm, phân quyền, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 's1@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 's2@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');

create schema t;
create table t.ids (k text primary key, v uuid not null);
grant usage on schema t to authenticated;
grant select, insert on t.ids to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
insert into t.ids select 'A', id from public.tenants where code = 'nha-xe-a';
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Quầy 1', 'seller') $$, 'Quầy 1');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select v from t.ids where k = 'A'), '0900000005', 'Quầy 2', 'seller') $$, 'Quầy 2');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

-- ---------------------------------------------------------------- Chủ A: tuyến 3 điểm, giá, loại xe 2 ghế, chuyến ngày mai
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.stops (code, name, kind) values ('HN', 'BX Hố Nai', 'ben_xe'), ('BR', 'Bà Rịa', 'diem_don_tra'), ('VT', 'BX Vũng Tàu', 'ben_xe') $$, 'Điểm');
select lives_ok($$ insert into public.routes (code, name) values ('HN-VT', 'Hố Nai – Vũng Tàu') $$, 'Tuyến');
select lives_ok($$ select public.set_route_stops((select id from public.routes), jsonb_build_array(
  jsonb_build_object('stop_id', (select id from public.stops where code = 'HN'), 'minutes_from_start', 0),
  jsonb_build_object('stop_id', (select id from public.stops where code = 'BR'), 'minutes_from_start', 60),
  jsonb_build_object('stop_id', (select id from public.stops where code = 'VT'), 'minutes_from_start', 90))) $$, 'Điểm dừng');
select lives_ok($$ select public.set_fare((select id from public.routes), null, null, 150000) $$, 'Giá toàn tuyến');
select lives_ok($$ select public.set_fare((select id from public.routes), (select id from public.stops where code = 'HN'),
  (select id from public.stops where code = 'BR'), 120000) $$, 'Giá chặng Hố Nai – Bà Rịa');
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats) values ('G2', 'Xe 2 ghế', 3) $$, 'Loại xe');
select lives_ok($$ select public.set_seat_layout((select id from public.vehicle_types), 1, 2, jsonb_build_array(
  jsonb_build_object('label', 'A01', 'deck', 1, 'row', 1, 'col', 1, 'kind', 'ghe'),
  jsonb_build_object('label', 'A02', 'deck', 1, 'row', 1, 'col', 2, 'kind', 'ghe'))) $$, 'Sơ đồ 2 ghế');
select lives_ok($$ select public.add_extra_trip((select id from public.routes), 'di', app.local_today() + 1, '07:00', null) $$, 'Chuyến ngày mai 07:00');
select lives_ok($$ select public.add_extra_trip((select id from public.routes), 'di', app.local_today() + 1, '15:00', null) $$, 'Chuyến ngày mai 15:00');
reset role;
insert into t.ids select 'T', id from public.trips where to_char(depart_at at time zone 'Asia/Ho_Chi_Minh', 'HH24') = '07';
insert into t.ids select 'T2', id from public.trips where to_char(depart_at at time zone 'Asia/Ho_Chi_Minh', 'HH24') = '15';
insert into t.ids select 'HN', id from public.stops where code = 'HN';
insert into t.ids select 'BR', id from public.stops where code = 'BR';
insert into t.ids select 'VT', id from public.stops where code = 'VT';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$ select public.hold_seat((select v from t.ids where k = 'T'), 'A01', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT'), null, null) $$, '22023', null, 'Chuyến chưa có sơ đồ ghế thì chưa bán');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.set_trip_vehicle_type(id, (select id from public.vehicle_types)) from public.trips $$, 'Gắn sơ đồ ghế cho 2 chuyến');
reset role;

-- ---------------------------------------------------------------- 2 quầy cùng bán
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
insert into t.ids select 'B1', (public.hold_seat((select v from t.ids where k = 'T'), 'a01', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT'), null, '77777777-7777-7777-7777-777777777771') ->> 'booking_id')::uuid;
select is((select price from public.seat_inventory where seat_label = 'A01'), 150000, 'Quầy 1 giữ ghế A01 toàn tuyến, giá 150.000');
select is((public.hold_seat((select v from t.ids where k = 'T'), 'A01', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT'), null, '77777777-7777-7777-7777-777777777771') ->> 'booking_id')::uuid,
  (select v from t.ids where k = 'B1'), 'Bấm 2 lần cùng mã yêu cầu không giữ thêm ghế');
select throws_ok($$ select public.hold_seat((select v from t.ids where k = 'T'), 'A09', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT'), null, null) $$, '22023', null, 'Ghế không có trên sơ đồ');
select throws_ok($$ select public.hold_seat((select v from t.ids where k = 'T'), 'A02', (select v from t.ids where k = 'VT'),
  (select v from t.ids where k = 'HN'), null, null) $$, '22023', null, 'Điểm đón phải trước điểm trả');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select throws_ok($$ select public.hold_seat((select v from t.ids where k = 'T'), 'A01', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'BR'), null, null) $$, '23P01', null, 'Quầy 2 không bán được A01 chồng chặng');
insert into t.ids select 'B2', (public.hold_seat((select v from t.ids where k = 'T'), 'A02', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'BR'), null, null) ->> 'booking_id')::uuid;
insert into t.ids select 'B3', (public.hold_seat((select v from t.ids where k = 'T'), 'A02', (select v from t.ids where k = 'BR'),
  (select v from t.ids where k = 'VT'), null, null) ->> 'booking_id')::uuid;
select is((select array_agg(price order by from_idx) from public.seat_inventory where seat_label = 'A02'), array[120000, 150000],
  'Ghế A02 bán 2 chặng nối tiếp: Hố Nai–Bà Rịa 120.000, Bà Rịa–Vũng Tàu (chưa có giá chặng → giá toàn tuyến)');
select throws_ok($$ select public.confirm_booking((select v from t.ids where k = 'B2'), null, 'Khách lẻ', 'dat_cho', false, null, null, null, null, null) $$,
  '22023', null, 'Đặt chỗ trả sau phải có SĐT');
select lives_ok($$ select public.confirm_booking((select v from t.ids where k = 'B2'), '0912345678', 'Chị Lan', 'dat_cho', false, null,
  'Đón cây xăng Hố Nai', null, null, null) $$, 'Quầy 2 đặt chỗ trả sau');
select ok((select hold_until = (select depart_at from public.trips where id = (select v from t.ids where k = 'T')) - interval '60 minutes'
           from public.seat_inventory where booking_id = (select v from t.ids where k = 'B2')), 'Đặt chỗ tự nhả trước giờ chạy 60 phút');
select is((select count(*)::int from public.customers where phone = '0912345678' and name = 'Chị Lan'), 1, 'Lưu khách để lần sau nhận ra');
select throws_ok($$ select public.confirm_booking((select v from t.ids where k = 'B3'), '0912', null, 'thu_tien', false, null, null, null, null, null) $$,
  '22023', null, 'SĐT sai dạng');
select throws_ok($$ select public.confirm_booking((select v from t.ids where k = 'B3'), '0987654321', 'Anh Nam', 'dat_cho', true, null, null, null, null, null) $$,
  '22023', null, 'Giữ chỗ đến giờ chạy phải ghi lý do');
select lives_ok($$ select public.confirm_booking((select v from t.ids where k = 'B3'), '0987654321', 'Anh Nam', 'dat_cho', true, 'Khách quen',
  null, null, null, null) $$, 'Đặt chỗ giữ đến giờ chạy (khách quen)');
select is((select hold_until from public.seat_inventory where booking_id = (select v from t.ids where k = 'B3')), null, 'Không tự nhả');
reset role;

-- ---------------------------------------------------------------- Quầy 1 thu tiền ngay
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((public.confirm_booking((select v from t.ids where k = 'B1'), '0911111111', 'Anh Ba', 'thu_tien', false, null, null, null, null, null)
           ->> 'repeated'), 'false', 'Quầy 1 thu tiền ngay');
select is((public.confirm_booking((select v from t.ids where k = 'B1'), '0911111111', 'Anh Ba', 'thu_tien', false, null, null, null, null, null)
           ->> 'repeated'), 'true', 'Bấm xác nhận 2 lần không thu tiền 2 lần');
select is((select status from public.seat_inventory where booking_id = (select v from t.ids where k = 'B1')), 'da_tt', 'Vé đã thanh toán');
select is((select sum(debit - credit)::int from public.ledger_lines where account = 'tien_mat'), 150000, 'Quầy 1 đang giữ 150.000 tiền mặt');
select is((select count(*)::int from public.ledger_lines), 1, 'Quầy 1 chỉ thấy dòng tiền của mình');
select throws_ok($$ select public.move_ticket((select id from public.seat_inventory where booking_id = (select v from t.ids where k = 'B1')),
  null, 'A02') $$, '23P01', null, 'Chuyển sang ghế đã có người thì chặn');
select lives_ok($$ select public.move_ticket((select id from public.seat_inventory where booking_id = (select v from t.ids where k = 'B1')),
  (select v from t.ids where k = 'T2'), 'A02') $$, 'Chuyển vé sang chuyến 15:00 ghế A02');
select lives_ok($$ select public.set_boarded((select id from public.seat_inventory where booking_id = (select v from t.ids where k = 'B1')), true) $$,
  'Đánh dấu đã lên xe');
select throws_ok($$ insert into public.seat_inventory (tenant_id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx, price, status)
  values ((select v from t.ids where k = 'A'), (select v from t.ids where k = 'B1'), (select v from t.ids where k = 'T'), 'A01',
          (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT'), 0, 2, 0, 'da_tt') $$, '42501', null,
  'Trình duyệt không ghi thẳng kho ghế');
select throws_ok($$ insert into public.ledger_lines (tenant_id, txn_id, account, debit) values ((select v from t.ids where k = 'A'), gen_random_uuid(), 'tien_mat', 1) $$,
  '42501', null, 'Trình duyệt không ghi thẳng sổ cái');
reset role;

-- ---------------------------------------------------------------- Hết hạn, nhả ghế, thu tiền đặt chỗ
update public.seat_inventory set hold_until = now() - interval '1 minute' where booking_id = (select v from t.ids where k = 'B2');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is(public.refresh_trip_seats((select v from t.ids where k = 'T')), 1, 'Chỗ đặt quá hạn được nhả');
select is((select status from public.seat_inventory where booking_id = (select v from t.ids where k = 'B2')), 'het_han', 'Vé chuyển "hết hạn", vẫn lưu');
select throws_ok($$ select public.pay_booking((select v from t.ids where k = 'B2'), null) $$, '22023', null, 'Không thu tiền chỗ đã hết hạn');
select lives_ok($$ select public.hold_seat((select v from t.ids where k = 'T'), 'A02', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'BR'), null, null) $$, 'Ghế được nhả thì bán lại được');
select is(public.pay_booking((select v from t.ids where k = 'B3'), null), 150000::bigint, 'Thu tiền chỗ đặt của khách quen');
select is(public.pay_booking((select v from t.ids where k = 'B3'), null), 0::bigint, 'Thu lần 2 không ghi thêm tiền');
select is((select sum(debit - credit)::int from public.ledger_lines where account = 'tien_mat'), 150000, 'Quầy 2 giữ 150.000');
reset role;

-- ---------------------------------------------------------------- Sổ cái chỉ thêm, phải cân
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select sum(debit)::int from public.ledger_lines), 300000, 'Chủ xem toàn bộ sổ cái: thu 300.000');
select is((select sum(debit)::int - sum(credit)::int from public.ledger_lines), 0, 'Sổ cái cân: Nợ = Có');
reset role;
select throws_ok($$ update public.ledger_lines set debit = 1 $$, '42501', null, 'Không sửa được sổ cái (kể cả máy chủ)');
select throws_ok($$ delete from public.ledger_transactions $$, '42501', null, 'Không xóa được sổ cái');
insert into public.ledger_transactions (id, tenant_id, kind) values ('88888888-8888-8888-8888-888888888888', (select v from t.ids where k = 'A'), 'thu');
insert into public.ledger_lines (tenant_id, txn_id, account, debit) values ((select v from t.ids where k = 'A'), '88888888-8888-8888-8888-888888888888', 'tien_mat', 5);
select throws_ok($$ set constraints ledger_lines_balance immediate $$, '23514', null, 'Bút toán lệch Nợ / Có bị chặn');

-- ---------------------------------------------------------------- Nhà xe khác
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.seat_inventory), 0, 'Chủ B không thấy vé nhà xe A');
select is((select count(*)::int from public.ledger_lines), 0, 'Chủ B không thấy sổ cái nhà xe A');
select is((select count(*)::int from public.customers), 0, 'Chủ B không thấy khách nhà xe A');
select throws_ok($$ select public.hold_seat((select v from t.ids where k = 'T'), 'A01', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT'), null, null) $$, 'P0002', null, 'Chủ B bán vé chuyến nhà xe A thì báo không tìm thấy');
select throws_ok($$ select public.pay_booking((select v from t.ids where k = 'B3'), null) $$, 'P0002', null, 'Chủ B thu tiền đơn nhà xe A: không tìm thấy');
reset role;

-- ---------------------------------------------------------------- 4.2: chuyển khoản QR, nhân viên xác nhận
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
insert into t.ids select 'B4', (public.hold_seat((select v from t.ids where k = 'T'), 'A01', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT'), null, null) ->> 'booking_id')::uuid;
select throws_ok($$ select public.confirm_booking((select v from t.ids where k = 'B4'), null, null, 'chuyen_khoan', false, null, null, null, null, null) $$,
  '22023', null, 'Chưa cấu hình tài khoản nhận thì chưa bán chuyển khoản');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ insert into public.tenant_settings (key, value) values ('tt.ngan_hang_bin', '"9704"') $$, '22023', null, 'Mã BIN phải 6 số');
select lives_ok($$ insert into public.tenant_settings (key, value) values ('tt.ngan_hang_bin', '"970436"'), ('tt.so_tai_khoan', '"0123456789"'),
  ('tt.ten_tai_khoan', '"CONG TY TNHH THINH PHAT"') $$, 'Cấu hình tài khoản nhận (Vietcombank)');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((public.confirm_booking((select v from t.ids where k = 'B4'), null, null, 'chuyen_khoan', false, null, null, null, null, null)
           ->> 'total')::int, 150000, 'Tạo QR chuyển khoản 150.000');
select ok((select status = 'dat' and pay_method = 'chuyen_khoan' and hold_until between now() + interval '14 minutes' and now() + interval '16 minutes'
           from public.seat_inventory where booking_id = (select v from t.ids where k = 'B4')), 'Chờ chuyển khoản: giữ ghế 15 phút');
select is(public.pay_booking((select v from t.ids where k = 'B4'), null, 'chuyen_khoan'), 150000::bigint, 'Nhân viên bấm "Đã nhận chuyển khoản"');
select is((select sum(debit)::int from public.ledger_lines where account = 'ngan_hang'), 150000, 'Ghi vào tài khoản ngân hàng, không vào tiền mặt');
select is((select sum(debit - credit)::int from public.ledger_lines where account = 'tien_mat'), 150000, 'Tiền mặt quầy 1 không đổi');
select throws_ok($$ select public.pay_booking((select v from t.ids where k = 'B4'), null, 'the') $$, '22023', null, 'Chỉ tiền mặt hoặc chuyển khoản');
reset role;

select ok(not has_function_privilege('anon', 'public.hold_seat(uuid, text, uuid, uuid, uuid, uuid)', 'EXECUTE'), 'Khách (anon) không bán vé được');

select * from finish();
rollback;
