-- Kiểm thử đồng bộ vé Vexere → TMS: tạo vé (mã TMS), chạy lại không trùng, cập nhật, hủy khi mất / hủy trên Vexere,
-- không ghi đè ghế bán ở quầy, không ghi sổ tiền, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
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
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.stops (code, name, kind) values ('BXBH', 'Bến xe Biên Hòa', 'ben_xe'), ('BR', 'Bà Rịa', 'diem_don_tra'), ('BXVT', 'BX Vũng Tàu', 'ben_xe') $$, 'Điểm');
select lives_ok($$ insert into public.routes (code, name) values ('BH-VT', 'Biên Hòa - Vũng Tàu') $$, 'Tuyến');
select lives_ok($$ select public.set_route_stops((select id from public.routes), jsonb_build_array(
  jsonb_build_object('stop_id', (select id from public.stops where code = 'BXBH'), 'minutes_from_start', 0),
  jsonb_build_object('stop_id', (select id from public.stops where code = 'BR'), 'minutes_from_start', 60),
  jsonb_build_object('stop_id', (select id from public.stops where code = 'BXVT'), 'minutes_from_start', 90))) $$, 'Điểm dừng');
select lives_ok($$ select public.save_fare_table(null, (select id from public.routes), app.local_today(), null, null, jsonb_build_array(
  jsonb_build_object('from', '', 'to', '', 'price', 150000))) $$, 'Bảng giá');
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats) values ('G3', 'Xe 3 ghế', 4) $$, 'Loại xe');
select lives_ok($$ select public.set_seat_layout((select id from public.vehicle_types), 2, 2, jsonb_build_array(
  jsonb_build_object('label', 'A01', 'deck', 1, 'row', 1, 'col', 1, 'kind', 'ghe'),
  jsonb_build_object('label', 'A02', 'deck', 1, 'row', 2, 'col', 1, 'kind', 'ghe'),
  jsonb_build_object('label', 'B01', 'deck', 1, 'row', 1, 'col', 2, 'kind', 'ghe'))) $$, 'Sơ đồ 3 ghế');
select lives_ok($$ select public.add_extra_trip((select id from public.routes), 'di', app.local_today() + 1, '07:00', null) $$, 'Chuyến ngày mai 07:00');
select lives_ok($$ select public.set_trip_vehicle_type(id, (select id from public.vehicle_types)) from public.trips $$, 'Gắn sơ đồ');
reset role;
insert into t.ids select 'T', id from public.trips;
insert into t.ids select 'BXBH', id from public.stops where code = 'BXBH';
insert into t.ids select 'BR', id from public.stops where code = 'BR';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.sync_vexere_tickets((select v from t.ids where k = 'T'), '[]') $$, 'P0002', null,
  'Nhà xe B không đồng bộ được vào chuyến của A');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is(public.sync_vexere_tickets((select v from t.ids where k = 'T'), jsonb_build_array(
  jsonb_build_object('id', '101', 'ghe', 'A1', 'tt', 'tt', 'gia', '150000', 'ten', 'Khách Một', 'sdt', '0901 111 111', 'tu_ma', 'BXBH', 'den_ma', 'BXVT', 'don', 'VP Cty', 'tra', 'Phước Lộc', 'ghi_chu', 'TX thu'),
  jsonb_build_object('id', '102', 'ghe', 'X9', 'hang', '2', 'cot', '1', 'tt', 'coc', 'coc', '50000', 'gia', '150000', 'sdt', '0902222222',
                     'tu_ten', 'Bến xe Biên Hòa', 'den_ten', 'Bà Rịa'),
  jsonb_build_object('id', '103', 'ghe', 'Z9', 'tt', 'giu'),
  jsonb_build_object('id', '104', 'ghe', 'B1', 'tt', 'huy'))) - 'loi',
  '{"moi": 2, "huy": 0, "cap_nhat": 0, "giu_nguyen": 0}'::jsonb, 'Tạo 2 vé; ghế lạ báo lỗi; vé hủy chưa có thì bỏ qua');
select is((select string_agg(seat_label || ':' || status || ':' || deposit, ',' order by seat_label) from public.seat_inventory),
  'A01:da_tt:0,A02:dat:50000', 'A1 → A01 đã thanh toán; ghế theo hàng/cột → A02 đặt chỗ có cọc');
select is((select count(*)::int from public.bookings where channel = 'vexere' and code ~ '^[A-Z0-9]{6}$' and ext_ref like 'vexere:%'), 2,
  'Mã vé là mã TMS, kênh vexere');
select is((select passenger_phone from public.seat_inventory where seat_label = 'A01'), '0901111111', 'SĐT chỉ giữ chữ số');
select is((select pickup_note || '/' || dropoff_note from public.seat_inventory where seat_label = 'A01'), 'VP Cty/Phước Lộc', 'Điểm đón / trả Vexere');
select is((select b.note from public.bookings b join public.seat_inventory s on s.booking_id = b.id where s.seat_label = 'A01'), 'TX thu', 'Ghi chú vé vào đơn');
select is((select to_stop_id from public.seat_inventory where seat_label = 'A02'), (select v from t.ids where k = 'BR'), 'Nhận điểm trả theo tên');
select is((select count(*)::int from public.seat_inventory where hold_until is not null), 0, 'Giữ tới giờ chạy, không tự nhả');
select is((select count(*)::int from public.ledger_transactions), 0, 'Không ghi sổ tiền');

select is(public.sync_vexere_tickets((select v from t.ids where k = 'T'), jsonb_build_array(
  jsonb_build_object('id', '101', 'ghe', 'A1', 'tt', 'tt', 'gia', '150000', 'ten', 'Khách Một', 'sdt', '0901 111 111', 'tu_ma', 'BXBH', 'den_ma', 'BXVT', 'don', 'VP Cty', 'tra', 'Phước Lộc', 'ghi_chu', 'TX thu'),
  jsonb_build_object('id', '102', 'ghe', 'X9', 'hang', '2', 'cot', '1', 'tt', 'tt', 'gia', '150000', 'sdt', '0902222222',
                     'tu_ten', 'Bến xe Biên Hòa', 'den_ten', 'Bà Rịa'))) - 'loi',
  '{"moi": 0, "huy": 0, "cap_nhat": 1, "giu_nguyen": 1}'::jsonb, 'Chạy lại: không trùng, vé đã trả đủ thì cập nhật');
select is((select count(*)::int from public.bookings), 2, 'Vẫn 2 đơn');

-- quầy TMS bán ghế B01 → Vexere báo vé cùng ghế: không ghi đè
select lives_ok($$ select public.hold_seat((select v from t.ids where k = 'T'), 'B01', (select v from t.ids where k = 'BXBH'),
  (select id from public.stops where code = 'BXVT'), null, null) $$, 'Quầy giữ B01');
select is(jsonb_array_length(public.sync_vexere_tickets((select v from t.ids where k = 'T'), jsonb_build_array(
  jsonb_build_object('id', '101', 'ghe', 'A1', 'tt', 'tt', 'gia', '150000', 'ten', 'Khách Một', 'sdt', '0901111111', 'tu_ma', 'BXBH', 'den_ma', 'BXVT'),
  jsonb_build_object('id', '105', 'ghe', 'B1', 'tt', 'giu'))) -> 'loi'), 1, 'Ghế quầy đang giữ: báo trùng');
select is((select status from public.seat_inventory where seat_label = 'A02' order by updated_at desc limit 1), 'huy',
  'Vé 102 không còn trên Vexere: hủy, nhả ghế');
select is((select status from public.seat_inventory where seat_label = 'B01' order by created_at limit 1), 'giu', 'Ghế quầy giữ nguyên');

select is(public.sync_vexere_tickets((select v from t.ids where k = 'T'), jsonb_build_array(
  jsonb_build_object('id', '101', 'ghe', 'A1', 'tt', 'huy'))) -> 'huy', '1'::jsonb, 'Vé hủy trên Vexere: hủy trong TMS');
select is((select count(*)::int from public.seat_inventory where status in ('giu', 'dat', 'da_tt') and seat_label <> 'B01'), 0, 'Hết vé Vexere');
reset role;

select * from finish();
rollback;
