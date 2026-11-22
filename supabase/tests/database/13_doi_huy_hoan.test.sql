-- Kiểm thử Giai đoạn 4.3: hủy vé theo mốc phí, hoàn tiền, quản trị sửa phí, đổi chuyến có phí, sổ cái cân, phân quyền.
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


-- ---------------------------------------------------------------- Cấu hình mốc phí
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ update public.tenant_settings set value = '[{"truoc_gio": 4, "phi_pt": 30}, {"truoc_gio": 24, "phi_pt": 10}, {"truoc_gio": 0, "phi_pt": 100}]'
  where key = 'huy_ve.moc' $$, '22023', null, 'Mốc giờ phải giảm dần');
select throws_ok($$ update public.tenant_settings set value = '[{"truoc_gio": 24, "phi_pt": 10}]' where key = 'huy_ve.moc' $$, '22023', null,
  'Phải có mốc 0 giờ');
select lives_ok($$ update public.tenant_settings set value = '20000' where key = 'doi_ve.phi_dong' $$, 'Phí đổi vé 20.000');
reset role;

-- ---------------------------------------------------------------- Quầy 1 bán 2 vé, hủy 1 vé (chuyến ngày mai: còn > 24 giờ? → tùy giờ chạy thử)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
insert into t.ids select 'B1', (public.hold_seat((select v from t.ids where k = 'T'), 'A01', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT'), null, null) ->> 'booking_id')::uuid;
select lives_ok($$ select public.hold_seat((select v from t.ids where k = 'T'), 'A02', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT'), (select v from t.ids where k = 'B1'), null) $$, 'Giữ thêm ghế A02 cùng đơn');
select lives_ok($$ select public.confirm_booking((select v from t.ids where k = 'B1'), '0911111111', 'Anh Ba', 'thu_tien', false, null, null, null, null, null) $$,
  'Thu tiền 2 vé 300.000');
select is((select fee_pct from public.cancel_quote(array[(select id from public.seat_inventory where seat_label = 'A01')])),
  t.pct(
    extract(epoch from ((select depart_at from public.trips where id = (select v from t.ids where k = 'T')) - now())) / 3600),
  'Xem trước phí hủy theo mốc giờ');
select throws_ok($$ select public.cancel_tickets(array[(select id from public.seat_inventory where seat_label = 'A01')], 'Khách bận', 'tien_mat', 0, 'Quen') $$,
  '42501', null, 'Nhân viên bán vé không được sửa phí');
select is((public.cancel_tickets(array[(select id from public.seat_inventory where seat_label = 'A01')], '', 'tien_mat', null, null) ->> 'refund')::int,
  (select 150000 - round(150000 * fee_pct / 100.0)::int from (select t.pct(
    extract(epoch from ((select depart_at from public.trips where id = (select v from t.ids where k = 'T')) - now())) / 3600) as fee_pct) x),
  'Hủy vé A01: hoàn tiền = giá vé − phí theo mốc');
select is((select status from public.seat_inventory where seat_label = 'A01' and booking_id = (select v from t.ids where k = 'B1')), 'huy', 'Vé A01 đã hủy (vẫn lưu)');
select is((select cancel_reason from public.seat_inventory where seat_label = 'A01' and booking_id = (select v from t.ids where k = 'B1')), 'Không ghi lý do',
  'Lý do hủy để trống được');
select throws_ok($$ select public.delete_cancelled_ticket((select id from public.seat_inventory where seat_label = 'A01' and status = 'huy')) $$, '42501', null,
  'Nhân viên bán vé không xóa được vé đã hủy');
select lives_ok($$ select public.hold_seat((select v from t.ids where k = 'T'), 'A01', (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT'), null, null) $$, 'Ghế A01 bán lại được');
select throws_ok($$ select public.cancel_tickets(array[(select id from public.seat_inventory where seat_label = 'A01' and status = 'huy')], 'Lần 2', 'tien_mat', null, null) $$,
  'P0002', null, 'Hủy lại vé đã hủy: không có vé còn hiệu lực');
-- Đổi chuyến vé A02 sang 15:00: thu phí đổi 20.000
select throws_ok($$ select public.change_ticket((select id from public.seat_inventory where seat_label = 'A02'), (select v from t.ids where k = 'T2'), 'A02', null) $$,
  '22023', null, 'Có phí đổi thì phải chọn cách thu');
select is(public.change_ticket((select id from public.seat_inventory where seat_label = 'A02'), (select v from t.ids where k = 'T2'), 'A02', 'tien_mat'), 20000,
  'Đổi sang chuyến 15:00, thu phí đổi 20.000');
select is(public.change_ticket((select id from public.seat_inventory where seat_label = 'A02'), (select v from t.ids where k = 'T2'), 'A01', 'tien_mat'), 0,
  'Đổi ghế trong cùng chuyến: không thu phí');
reset role;

-- ---------------------------------------------------------------- Quản trị: sửa phí khi hủy, hoàn chuyển khoản
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select public.cancel_tickets(array[(select id from public.seat_inventory where seat_label = 'A01' and status = 'da_tt')], 'Xe hỏng',
  'chuyen_khoan', 0, null) $$, '22023', null, 'Sửa phí phải ghi lý do');
select is((public.cancel_tickets(array[(select id from public.seat_inventory where seat_label = 'A01' and status = 'da_tt')], 'Xe hỏng',
  'chuyen_khoan', 0, 'Lỗi nhà xe') ->> 'refund')::int, 150000, 'Quản trị miễn phí: hoàn đủ 150.000 qua chuyển khoản');
select is((select sum(debit) - sum(credit) from public.ledger_lines)::int, 0, 'Sổ cái vẫn cân sau hủy / đổi');
select is((select sum(credit - debit) from public.ledger_lines where account = 'doanh_thu_ve')::int, 0, 'Doanh thu vé = 0 (cả 2 vé đã hủy)');
select is((select sum(credit - debit) from public.ledger_lines where account = 'phi_huy_doi')::int,
  (select sum(cancel_fee) from public.seat_inventory where status = 'huy')::int + 20000, 'Phí hủy + phí đổi ghi riêng');
select is((select sum(debit - credit) from public.ledger_lines where account = 'ngan_hang')::int, -150000, 'Hoàn chuyển khoản ghi vào tài khoản ngân hàng');
reset role;

-- ---------------------------------------------------------------- Lịch sử vé
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select ok(jsonb_array_length(public.ticket_history((select v from t.ids where k = 'B1'))) >= 3, 'Quầy xem được lịch sử đơn vé');
select ok(exists (select 1 from jsonb_array_elements(public.ticket_history((select v from t.ids where k = 'B1'))) e
                  where e ->> 'entity' = 'tien' and (e ->> 'amount')::int > 0), 'Lịch sử có lần thu tiền');
select ok(exists (select 1 from jsonb_array_elements(public.ticket_history((select v from t.ids where k = 'B1'))) e
                  where e ->> 'actor' = 'Quầy 1'), 'Lịch sử ghi tên người thao tác');
reset role;
select set_config('t.b1', (select v::text from t.ids where k = 'B1'), true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.ticket_history(current_setting('t.b1')::uuid) $$, 'P0002', null, 'Chủ B xem lịch sử vé nhà xe A: không tìm thấy');
reset role;

-- ---------------------------------------------------------------- Quản trị: sửa / xóa vé đã hủy
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.update_ticket_info((select id from public.seat_inventory where status = 'huy' order by created_at limit 1), 'Anh Hùng', '0911222333', null, null) $$,
  'Quản trị sửa thông tin khách trên vé đã hủy');
select is((select passenger_name from public.seat_inventory where status = 'huy' order by created_at limit 1), 'Anh Hùng', 'Đã sửa tên khách');
select throws_ok($$ select public.delete_cancelled_ticket((select id from public.seat_inventory where status not in ('huy', 'het_han') limit 1)) $$, '22023', null,
  'Vé còn hiệu lực không xóa được');
select set_config('t.del', (select id::text from public.seat_inventory where status = 'huy' order by created_at limit 1), true);
select lives_ok($$ select public.delete_cancelled_ticket(current_setting('t.del')::uuid) $$, 'Quản trị xóa vé đã hủy');
select is((select count(*)::int from public.seat_inventory where id = current_setting('t.del')::uuid), 0, 'Vé đã hủy đã xóa');
select is((select sum(debit) - sum(credit) from public.ledger_lines)::int, 0, 'Sổ cái giữ nguyên, vẫn cân');
reset role;

-- ---------------------------------------------------------------- Nhà xe khác
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.cancel_quote(array(select v from t.ids))), 0, 'Chủ B không xem được phí vé nhà xe A');
select throws_ok($$ select public.cancel_tickets(array(select v from t.ids), 'x', 'tien_mat', null, null) $$, 'P0002', null,
  'Chủ B hủy vé nhà xe A: không tìm thấy');
reset role;
select set_config('t.del2', (select id::text from public.seat_inventory where status = 'huy' limit 1), true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.delete_cancelled_ticket(current_setting('t.del2')::uuid) $$, 'P0002', null, 'Chủ B xóa vé đã hủy nhà xe A: không tìm thấy');
reset role;

select * from finish();
rollback;
