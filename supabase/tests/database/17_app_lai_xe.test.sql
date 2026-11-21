-- Kiểm thử Giai đoạn 6.1 – app lái xe: chuyến của tôi, xuất bến / đến bến, lên xe, thu tiền trên xe, phân quyền, cô lập nhà xe.
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
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select is((select count(*)::int from public.my_trips(app.local_today(), app.local_today() + 7)), 1, 'Lái xe thấy 1 chuyến của mình');
select is((select my_role from public.my_trips(app.local_today(), app.local_today() + 7)), 'lai_xe_1', 'Vai trò lái xe 1');
select throws_ok($$ select public.trip_mark((select v from t.ids where k = 'T1'), 'den_ben') $$, '22023', null, 'Chưa xuất bến thì chưa đến bến');
select isnt(public.trip_mark((select v from t.ids where k = 'T1'), 'xuat_ben'), null, 'Báo xuất bến');
select isnt((select departed_at from public.trips where id = (select v from t.ids where k = 'T1')), null, 'Đã ghi giờ xuất bến');
select lives_ok($$ select public.set_boarded('77777777-7777-7777-7777-777777777772', true) $$, 'Lái xe đánh dấu khách lên xe');
select is(public.crew_collect('77777777-7777-7777-7777-777777777772'), 100000, 'Lái xe thu 100.000 trên xe');
select is(public.crew_collect('77777777-7777-7777-7777-777777777772'), 0, 'Bấm thu lần 2 không thu thêm');
select is((select sum(debit - credit) from public.ledger_lines where account = 'tien_mat')::int, 100000, 'Tiền vào quỹ của lái xe');
select throws_ok($$ select public.trip_mark((select v from t.ids where k = 'T2'), 'xuat_ben') $$, 'P0002', null, 'Chuyến không được xếp: không tìm thấy');
select isnt(public.trip_mark((select v from t.ids where k = 'T1'), 'den_ben'), null, 'Báo đến bến');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select throws_ok($$ select public.crew_collect('77777777-7777-7777-7777-777777777772') $$, 'P0002', null, 'Người bán vé không phải tổ lái: không thu qua đây');
reset role;
-- Đã xuất bến: khóa sửa vé, quản trị mở khóa mới sửa được
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select throws_ok($$ select public.update_ticket_info('77777777-7777-7777-7777-777777777772', 'Tên mới', null, null, null) $$, '42501', null,
  'Chuyến đã xuất bến: không sửa vé');
select throws_ok($$ select public.set_trip_edit_lock((select v from t.ids where k = 'T1'), true) $$, '42501', null, 'Bán vé không mở khóa được');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.set_trip_edit_lock((select v from t.ids where k = 'T1'), true) $$, 'Chủ nhà xe mở khóa');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select lives_ok($$ select public.update_ticket_info('77777777-7777-7777-7777-777777777772', 'Tên mới', null, null, null) $$, 'Mở khóa rồi thì sửa được');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.set_trip_edit_lock((select v from t.ids where k = 'T1'), false) $$, 'Khóa lại');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select throws_ok($$ select public.update_ticket_info('77777777-7777-7777-7777-777777777772', 'Tên khác', null, null, null) $$, '42501', null, 'Khóa lại thì không sửa được');
reset role;
-- Đánh dấu đã in vé / in phơi (vẫn được khi đã xuất bến)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select lives_ok($$ select public.mark_tickets_printed(array['77777777-7777-7777-7777-777777777772'::uuid]) $$, 'Đánh dấu đã in vé');
select is((select print_count from public.seat_inventory where id = '77777777-7777-7777-7777-777777777772'), 1, 'Đếm số lần in vé');
select lives_ok($$ select public.mark_manifest_printed((select v from t.ids where k = 'T1')) $$, 'Đánh dấu đã in phơi');
select isnt((select manifest_printed_at from public.trips where id = (select v from t.ids where k = 'T1')), null, 'Chuyến có giờ in phơi');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.my_trips(app.local_today(), app.local_today() + 7)), 0, 'Chủ B không thấy chuyến nhà xe A');
select throws_ok($$ select public.trip_mark((select v from t.ids where k = 'T1'), 'den_ben') $$, 'P0002', null, 'Chủ B: không tìm thấy');
reset role;

-- ---------------------------------------------------------------- Trạng thái khách của lái xe (gọi, thuê bao, báo hủy, vắng, trả) + thu chuyển khoản
set local session_replication_role = replica;   -- chèn thẳng vé thử vào chuyến đã xuất bến
insert into public.seat_inventory (id, tenant_id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx, price, status)
values ('77777777-7777-7777-7777-777777777773', (select v from t.ids where k = 'A'), '77777777-7777-7777-7777-777777777771',
        (select v from t.ids where k = 'T1'), 'A02', (select id from public.stops where code = 'HN'), (select id from public.stops where code = 'VT'), 0, 1, 120000, 'dat');
set local session_replication_role = origin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select lives_ok($$ select public.crew_mark('77777777-7777-7777-7777-777777777773', 'goi') $$, 'Bấm gọi khách: ghi đã gọi (chuyến đã xuất bến vẫn ghi được)');
select is((select crew_call from public.seat_inventory where id = '77777777-7777-7777-7777-777777777773'), 'da_goi', 'Đã gọi');
select lives_ok($$ select public.crew_mark('77777777-7777-7777-7777-777777777773', 'thue_bao') $$, 'Thuê bao');
select lives_ok($$ select public.crew_mark('77777777-7777-7777-7777-777777777773', 'goi') $$, 'Gọi lại');
select is((select crew_call from public.seat_inventory where id = '77777777-7777-7777-7777-777777777773'), 'thue_bao', 'Gọi lại không xóa kết quả lần trước');
select lives_ok($$ select public.crew_mark('77777777-7777-7777-7777-777777777773', 'bao_huy') $$, 'Khách báo hủy');
select is((select status from public.seat_inventory where id = '77777777-7777-7777-7777-777777777773'), 'dat', 'Lái xe không tự hủy vé (quầy hủy)');
select lives_ok($$ select public.crew_mark('77777777-7777-7777-7777-777777777773', 'vang') $$, 'Vắng');
select is((select no_show::text || boarded::text from public.seat_inventory where id = '77777777-7777-7777-7777-777777777773'), 'truefalse', 'Vắng thì không lên xe');
select lives_ok($$ select public.crew_mark('77777777-7777-7777-7777-777777777773', 'len') $$, 'Lên xe');
select lives_ok($$ select public.crew_mark('77777777-7777-7777-7777-777777777773', 'tra') $$, 'Trả khách');
select is((select no_show::text || boarded::text || dropped::text from public.seat_inventory where id = '77777777-7777-7777-7777-777777777773'), 'falsetruetrue', 'Đã lên, đã trả');
select throws_ok($$ select public.crew_mark('77777777-7777-7777-7777-777777777773', 'xoa') $$, '22023', null, 'Thao tác lạ');
select is(public.crew_collect('77777777-7777-7777-7777-777777777773', 'chuyen_khoan'), 120000, 'Thu chuyển khoản trên xe');
select is((select pay_method from public.seat_inventory where id = '77777777-7777-7777-7777-777777777773'), 'chuyen_khoan', 'Ghi cách thu chuyển khoản');
select is((select sum(debit - credit) from public.ledger_lines where account = 'ngan_hang')::int, 120000, 'Tiền chuyển khoản vào tài khoản ngân hàng');
select ok(public.my_trip_layout((select v from t.ids where k = 'T1')) ? 'seats', 'Lái xe xem được sơ đồ ghế chuyến của mình');
select throws_ok($$ select public.my_trip_layout((select v from t.ids where k = 'T2')) $$, 'P0002', null, 'Chuyến không được xếp: không xem sơ đồ');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select throws_ok($$ select public.crew_mark('77777777-7777-7777-7777-777777777773', 'goi') $$, 'P0002', null, 'Bán vé không phải tổ lái: không đánh dấu');
select is((select crew_call from public.seat_inventory where id = '77777777-7777-7777-7777-777777777773'), 'bao_huy', 'Quầy bán vé thấy khách báo hủy');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.crew_mark('77777777-7777-7777-7777-777777777773', 'goi') $$, 'P0002', null, 'Nhà xe B không đánh dấu vé của A');
select throws_ok($$ select public.my_trip_layout((select v from t.ids where k = 'T1')) $$, 'P0002', null, 'Nhà xe B không xem sơ đồ chuyến của A');
select is((select count(*)::int from public.seat_inventory where crew_call is not null), 0, 'Nhà xe B không thấy trạng thái vé của A');
reset role;

-- ---------------------------------------------------------------- Lái xe chỉ xem xe mình từng chạy và phiếu sửa chữa của xe đó
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.save_repair(null, jsonb_build_object('vehicle_id', (select v from t.ids where k = 'X1'), 'repaired_on', app.local_today()::text, 'kind', 'bao_duong'),
  '[{"content":"Thay nhớt","qty":1,"unit_price":500000}]'::jsonb) $$, 'Phiếu sửa xe 1');
select lives_ok($$ select public.save_repair(null, jsonb_build_object('vehicle_id', (select v from t.ids where k = 'X2'), 'repaired_on', app.local_today()::text, 'kind', 'sua_chua'),
  '[{"content":"Thay lốp","qty":1,"unit_price":900000}]'::jsonb) $$, 'Phiếu sửa xe 2');
select is((select count(*)::int from public.vehicles), 2, 'Chủ xe thấy mọi xe');
reset role;
-- Nhóm Lái xe được tích ô Xem xe (không Xem tất cả)
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, 'vehicle.view' from public.roles r where r.code = 'driver' and r.tenant_id = (select v from t.ids where k = 'A') on conflict do nothing;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select is((select array_agg(plate order by plate) from public.vehicles), array['51B-111.11'], 'Lái xe chỉ thấy xe mình từng chạy');
select is((select count(*)::int from public.documents where owner_kind = 'xe' and vehicle_id = (select v from t.ids where k = 'X1')), 3, 'Thấy giấy tờ xe mình chạy');
select is((select count(*)::int from public.repair_orders), 1, 'Lái xe chỉ thấy phiếu sửa chữa của xe mình chạy');
select is((select count(*)::int from public.repair_items), 1, 'Chỉ thấy hạng mục của phiếu đó');
select throws_ok(format('select public.save_repair(null, %L, %L)', jsonb_build_object('vehicle_id', (select v from t.ids where k = 'X1'), 'repaired_on', app.local_today()::text),
  '[{"content":"x","qty":1,"unit_price":1}]'), '42501', null, 'Lái xe không thêm phiếu sửa chữa');
reset role;
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, 'vehicle.view_all' from public.roles r where r.code = 'driver' and r.tenant_id = (select v from t.ids where k = 'A') on conflict do nothing;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select is((select count(*)::int from public.vehicles), 2, 'Tích Xem tất cả: thấy mọi xe');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.repair_orders), 2, 'Điều hành xem mọi phiếu sửa chữa');
select is((select count(*)::int from public.vehicles), 2, 'Điều hành thấy mọi xe');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.repair_orders), 0, 'Nhà xe khác không thấy phiếu sửa chữa');
reset role;

-- ---------------------------------------------------------------- Thông báo: lái xe được báo chuyến hôm nay; người bán được báo khi lái xe báo khách
insert into t.ids select 'T0', id from public.trips where direction = 'di' and service_date = app.local_today() and status = 'mo' limit 1;
set local session_replication_role = replica;
delete from public.trip_crew where staff_id = (select v from t.ids where k = 'D1');   -- tránh trùng giờ với chuyến thử trước
set local session_replication_role = origin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select lives_ok($$ select public.assign_trip((select v from t.ids where k = 'T0'), null, (select v from t.ids where k = 'D1'), null, null, 'Thử') $$, 'Xếp lái xe 1 chuyến hôm nay');
reset role;
set constraints all immediate;
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000000b5' and kind = 'xep_chuyen' and trip_id = (select v from t.ids where k = 'T0')),
  1, 'Lái xe được báo được xếp chuyến hôm nay');
insert into public.bookings (id, tenant_id, code, customer_phone, created_by) values ('77777777-7777-7777-7777-777777777781', (select v from t.ids where k = 'A'), 'TBAO01', '0912345678', '00000000-0000-0000-0000-0000000000b4');
insert into public.seat_inventory (id, tenant_id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx, price, status)
values ('77777777-7777-7777-7777-777777777782', (select v from t.ids where k = 'A'), '77777777-7777-7777-7777-777777777781',
        (select v from t.ids where k = 'T0'), 'B01', (select id from public.stops where code = 'HN'), (select id from public.stops where code = 'VT'), 0, 1, 100000, 'dat');
select is((select body from public.notifications where user_id = '00000000-0000-0000-0000-0000000000b5' and kind = 'khach' order by created_at desc limit 1),
  'Thêm 1 khách 0912345678', 'Lái xe được báo thêm khách');
select ok((select title from public.notifications where user_id = '00000000-0000-0000-0000-0000000000b5' and kind = 'khach' limit 1) like 'Chuyến 07:00 · %', 'Ghi giờ chuyến');
update public.seat_inventory set status = 'huy' where id = '77777777-7777-7777-7777-777777777782';
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000000b5' and body like 'Khách 0912345678 hủy vé%'), 1, 'Lái xe được báo khách hủy vé');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
update public.seat_inventory set status = 'dat' where id = '77777777-7777-7777-7777-777777777782';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
update public.seat_inventory set crew_call = 'thue_bao' where id = '77777777-7777-7777-7777-777777777782';
select is((select body from public.notifications where user_id = '00000000-0000-0000-0000-0000000000b4' and kind = 'lai_xe_bao'),
  'Khách 0912345678 thuê bao / không nghe máy', 'Người bán vé được báo lái xe báo khách thuê bao');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select ok((select count(*) from public.notifications) >= 3, 'Lái xe thấy thông báo của mình');
select is((select count(*)::int from public.notifications where user_id <> '00000000-0000-0000-0000-0000000000b5'), 0, 'Không thấy thông báo của người khác');
select lives_ok($$ select public.mark_notifications_read() $$, 'Đánh dấu đã đọc');
select is((select count(*)::int from public.notifications where read_at is null), 0, 'Đã đọc hết');
select lives_ok($$ select public.set_notify_prefs('{khach}') $$, 'Tắt loại khách đặt / hủy');
select lives_ok($$ select public.save_push_subscription('https://push.example/abc', 'k1', 'a1', 'thu') $$, 'Bật nhận trên máy');
select throws_ok($$ select public.save_push_subscription('http://x', 'k1', 'a1', null) $$, '22023', null, 'Địa chỉ nhận phải https');
select is((select count(*)::int from public.push_subscriptions), 1, 'Thấy máy của mình');
reset role;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
update public.seat_inventory set status = 'huy' where id = '77777777-7777-7777-7777-777777777782';
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000000b5' and body like 'Khách 0912345678 hủy vé%'), 1, 'Tắt loại thì không báo thêm');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.notifications), 0, 'Nhà xe khác không thấy thông báo');
select is((select count(*)::int from public.push_subscriptions), 0, 'Nhà xe khác không thấy máy nhận');
select throws_ok($$ select * from public.push_config $$, '42501', null, 'Người dùng không đọc được khóa thông báo đẩy');
reset role;

select * from finish();
rollback;
