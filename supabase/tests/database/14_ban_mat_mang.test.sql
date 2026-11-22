-- Kiểm thử Giai đoạn 4.4: bán khi mất mạng / vé giấy: chống gửi lặp, trùng ghế → chờ xếp, chặn trùng số vé giấy, sổ cái, cô lập nhà xe.
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
select lives_ok($$ select public.save_fare_table(null, (select id from public.routes), app.local_today(), null, null, jsonb_build_array(
  jsonb_build_object('from', '', 'to', '', 'price', 150000),
  jsonb_build_object('from', (select name from public.stops where code = 'HN'), 'to', (select name from public.stops where code = 'BR'), 'price', 120000))) $$,
  'Bảng giá: toàn tuyến 150.000, chặng Hố Nai – Bà Rịa 120.000');
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



set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select price from public.trip_fares((select v from t.ids where k = 'T')) where from_stop_id = (select v from t.ids where k = 'HN')
  and to_stop_id = (select v from t.ids where k = 'VT')), 150000, 'Bảng giá chuyến để lưu trên máy');
-- Quầy có mạng bán A01
insert into t.ids select 'B1', (public.hold_seat((select v from t.ids where k = 'T'), 'A01', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT'), null, null) ->> 'booking_id')::uuid;
select lives_ok($$ select public.confirm_booking((select v from t.ids where k = 'B1'), null, 'Khách online', 'thu_tien', false, null, null, null, null, null) $$,
  'Quầy có mạng bán A01');
-- Quầy mất mạng cũng bán A01 + A02
select is(public.sync_offline_sale('00000000-0000-0000-0000-00000000f001', null, (select v from t.ids where k = 'T'), array['A01', 'a02'],
  (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT'), 150000, '0912 345 678', 'Chú Tư', 'tien_mat', now() - interval '1 hour') -> 'conflicts',
  '["A01"]'::jsonb, 'Gửi vé bán khi mất mạng: A01 trùng → chờ xếp, A02 bán được');
select is((select count(*)::int from public.ledger_transactions), 2, 'Đã ghi tiền 2 lần (online + mất mạng)');
select is(public.sync_offline_sale('00000000-0000-0000-0000-00000000f001', null, (select v from t.ids where k = 'T'), array['A01', 'A02'],
  (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT'), 150000, null, null, 'tien_mat', now()) ->> 'repeated',
  'true', 'Gửi lặp cùng khóa: trả kết quả cũ');
select is((select count(*)::int from public.ledger_transactions), 2, 'Gửi lặp không ghi tiền thêm');
select is((select count(*)::int from public.seat_inventory where status = 'cho_xep'), 1, 'Một vé chờ xếp ghế (vẫn giữ tiền)');
select is((select paid_at from public.seat_inventory where seat_label = 'A02'),
  (select sold_offline_at from public.bookings where offline_key = '00000000-0000-0000-0000-00000000f001'), 'Giờ thu tiền = giờ bán thật');
-- Vé giấy
select is(public.sync_offline_sale('00000000-0000-0000-0000-00000000f002', 'vg-001', (select v from t.ids where k = 'T2'), array['A01'],
  (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'BR'), 140000, null, 'Khách vé giấy', 'tien_mat', now() - interval '2 hours') -> 'conflicts',
  '[]'::jsonb, 'Nhập vé giấy số VG-001');
select throws_ok($$ select public.sync_offline_sale('00000000-0000-0000-0000-00000000f003', 'VG-001', (select v from t.ids where k = 'T2'), array['A02'],
  (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT'), 150000, null, null, 'tien_mat', now()) $$, '23505', null,
  'Nhập trùng số vé giấy bị chặn');
select throws_ok($$ select public.sync_offline_sale('00000000-0000-0000-0000-00000000f004', null, (select v from t.ids where k = 'T2'), array['A02'],
  (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT'), 150000, null, null, 'tien_mat', now() - interval '60 days') $$, '22023', null,
  'Giờ bán quá 30 ngày bị chặn');
select is((select channel from public.bookings where paper_no = 'VG-001'), 'giay', 'Đơn vé giấy ghi kênh "giay"');
-- Xử lý vé chờ xếp
select is((select count(*)::int from public.cancel_quote(array(select id from public.seat_inventory where status = 'cho_xep'))), 1,
  'Vé chờ xếp ghế hủy / hoàn được');
select is(public.change_ticket((select id from public.seat_inventory where status = 'cho_xep'), (select v from t.ids where k = 'T2'), 'A02', 'tien_mat'), 0,
  'Xếp vé chờ sang ghế A02 chuyến 15:00');
select is((select status from public.seat_inventory where seat_label = 'A02' and trip_id = (select v from t.ids where k = 'T2')), 'da_tt', 'Vé đã có ghế');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select sum(debit) - sum(credit) from public.ledger_lines)::int, 0, 'Sổ cái cân');
select is((select sum(credit - debit) from public.ledger_lines where account = 'doanh_thu_ve')::int, 150000 + 300000 + 140000,
  'Doanh thu đủ: online + mất mạng 2 ghế + vé giấy');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.sync_offline_sale('00000000-0000-0000-0000-00000000f001', null, (select v from t.ids where k = 'T'), array['A01'],
  (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT'), 1, null, null, 'tien_mat', now()) $$, 'P0002', null,
  'Chủ B gửi vé vào chuyến nhà xe A: không tìm thấy');
select throws_ok($$ select * from public.trip_fares((select v from t.ids where k = 'T')) $$, 'P0002', null, 'Chủ B không xem giá chuyến nhà xe A');
reset role;

select * from finish();
rollback;
