-- Kiểm thử vé cọc: nhận cọc, thu nốt phần còn lại, hủy vé cọc theo 3 cách, sổ cái cân, cách ly nhà xe.
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
-- % phí theo mốc mặc định (24 giờ 10%, 4 giờ 30%, dưới 4 giờ 100%)
create function t.pct(h numeric) returns int language sql as $$ select case when h >= 24 then 10 when h >= 4 then 30 else 100 end $$;
grant usage on schema t to authenticated;
grant select, insert on t.ids to authenticated;
grant execute on all functions in schema t to authenticated;

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
select lives_ok($$ select public.set_trip_vehicle_type(id, (select id from public.vehicle_types)) from public.trips $$, 'Gắn sơ đồ ghế');
select throws_ok($$ insert into public.tenant_settings (key, value) values ('ve.huy_coc', '"abc"') $$, '22023', null, 'Cách hủy vé cọc phải hợp lệ');
reset role;

-- 1. Cọc 50.000 rồi thu nốt 100.000
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
insert into t.ids select 'B1', (public.hold_seat((select v from t.ids where k = 'T'), 'A01', (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT'), null, null) ->> 'booking_id')::uuid;
select lives_ok($$ select public.confirm_booking((select v from t.ids where k = 'B1'), '0911111111', 'Anh Ba', 'dat_cho', false, null, null, null, null, null) $$, 'Đặt chỗ');
select throws_ok($$ select public.deposit_booking((select v from t.ids where k = 'B1'), 150000, 'tien_mat') $$, '22023', null, 'Trả đủ thì dùng Thu tiền');
select is(public.deposit_booking((select v from t.ids where k = 'B1'), 50000, 'tien_mat'), 50000::bigint, 'Nhận cọc 50.000');
select is(public.deposit_booking((select v from t.ids where k = 'B1'), 50000, 'tien_mat'), 0::bigint, 'Bấm 2 lần không ghi thêm');
select is((select deposit from public.seat_inventory where booking_id = (select v from t.ids where k = 'B1')), 50000::bigint, 'Vé ghi đã cọc 50.000');
select ok((select hold_until from public.seat_inventory where booking_id = (select v from t.ids where k = 'B1')) is null, 'Đã cọc: giữ ghế tới giờ chạy');
select is(public.pay_booking((select v from t.ids where k = 'B1'), null, 'tien_mat'), 100000::bigint, 'Thu nốt 100.000');
select is((select sum(credit - debit) from public.ledger_lines where account = 'doanh_thu_ve')::int, 150000, 'Doanh thu đúng 150.000 (không thu trùng)');

-- 2. Cọc 60.000 rồi hủy, không hoàn cọc
insert into t.ids select 'B2', (public.hold_seat((select v from t.ids where k = 'T'), 'A02', (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT'), null, null) ->> 'booking_id')::uuid;
select lives_ok($$ select public.confirm_booking((select v from t.ids where k = 'B2'), null, null, 'dat_cho', false, null, null, null, null, null) $$, 'Đặt chỗ A02');
select lives_ok($$ select public.deposit_booking((select v from t.ids where k = 'B2'), 60000, 'tien_mat') $$, 'Cọc 60.000');
select is((public.cancel_tickets(array[(select id from public.seat_inventory where booking_id = (select v from t.ids where k = 'B2'))], 'Khách bỏ', 'tien_mat', null, null, 'khong_hoan', null) ->> 'refund')::int,
  0, 'Không hoàn cọc');
select is((select cancel_fee from public.seat_inventory where booking_id = (select v from t.ids where k = 'B2')), 60000, 'Giữ lại 60.000 cọc');

-- 3. Cọc 50.000 rồi hủy, nhân viên nhập hoàn 30.000
insert into t.ids select 'B3', (public.hold_seat((select v from t.ids where k = 'T2'), 'A01', (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT'), null, null) ->> 'booking_id')::uuid;
select lives_ok($$ select public.confirm_booking((select v from t.ids where k = 'B3'), null, null, 'dat_cho', false, null, null, null, null, null) $$, 'Đặt chỗ chuyến 15:00');
select lives_ok($$ select public.deposit_booking((select v from t.ids where k = 'B3'), 50000, 'tien_mat') $$, 'Cọc 50.000');
select throws_ok($$ select public.cancel_tickets(array[(select id from public.seat_inventory where booking_id = (select v from t.ids where k = 'B3'))], 'X', 'tien_mat', null, null, 'tu_nhap', null) $$,
  '22023', null, 'Tự nhập phải có số tiền hoàn');
select is((public.cancel_tickets(array[(select id from public.seat_inventory where booking_id = (select v from t.ids where k = 'B3'))], 'Đổi ý', 'tien_mat', null, null, 'tu_nhap', 30000) ->> 'refund')::int,
  30000, 'Hoàn 30.000 theo số nhân viên nhập');

-- 4. Cọc 40.000 rồi hủy theo mặc định (trừ phí hủy, không hoàn quá số cọc)
insert into t.ids select 'B4', (public.hold_seat((select v from t.ids where k = 'T2'), 'A02', (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT'), null, null) ->> 'booking_id')::uuid;
select lives_ok($$ select public.confirm_booking((select v from t.ids where k = 'B4'), null, null, 'dat_cho', false, null, null, null, null, null) $$, 'Đặt chỗ A02 15:00');
select lives_ok($$ select public.deposit_booking((select v from t.ids where k = 'B4'), 40000, 'chuyen_khoan') $$, 'Cọc 40.000 chuyển khoản');
select is((public.cancel_tickets(array[(select id from public.seat_inventory where booking_id = (select v from t.ids where k = 'B4'))], 'Bận', 'tien_mat', null, null) ->> 'refund')::int,
  (select greatest(0, 40000 - round(150000 * t.pct(extract(epoch from ((select depart_at from public.trips where id = (select v from t.ids where k = 'T2')) - now())) / 3600) / 100.0)::int)),
  'Mặc định: hoàn cọc sau khi trừ phí hủy');
select is((select sum(debit) - sum(credit) from public.ledger_lines)::int, 0, 'Sổ cái cân');
select is((select sum(credit - debit) from public.ledger_lines where account = 'doanh_thu_ve')::int, 150000, 'Doanh thu chỉ còn vé đã đi (vé cọc hủy đã đảo)');
reset role;

-- 5. Nhà xe khác: không tìm thấy
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok(format('select public.deposit_booking(%L, 1000, %L)', (select v from t.ids where k = 'B1'), 'tien_mat'), 'P0002', null, 'Nhà xe B nhận cọc đơn nhà xe A: không tìm thấy');
select is((select count(*)::int from public.seat_inventory where deposit > 0), 0, 'Nhà xe B không thấy vé cọc nhà xe A');
reset role;
select * from finish();
rollback;
