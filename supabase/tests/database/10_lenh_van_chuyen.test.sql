-- Kiểm thử Giai đoạn 3.4b: cấp lệnh vận chuyển (số lệnh theo quy ước, giữ số khi in lại, chỉ chuyến hợp lệ),
-- ảnh chữ ký (Giám đốc / từng người), phân quyền, cô lập nhà xe.
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
insert into t.ids values ('D1', '33333333-3333-3333-3333-333333333331'), ('X1', '66666666-6666-6666-6666-666666666661');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Điều hành A', 'dispatcher') $$, 'Điều hành A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b4', (select v from t.ids where k = 'A'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

-- ---------------------------------------------------------------- Chủ A: dữ liệu nền + 2 tuyến cùng giờ 07:00
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.stops (code, name, kind) values ('BH', 'BX Biên Hòa', 'ben_xe'), ('VT', 'BX Vũng Tàu', 'ben_xe') $$, 'Điểm');
select lives_ok($$ insert into public.routes (code, name, distance_km, registered_code, itinerary) values
  ('BH-VT', 'Đồng Nai - Vũng Tàu', 112, '7579.1225.A', 'BX Biên Hòa - QL1A - BX Vũng Tàu và ngược lại'),
  ('BH-VT2', 'Đồng Nai - Vũng Tàu (2)', 112, null, null) $$, 'Tuyến có hành trình chạy xe');
select lives_ok($$ select public.set_route_stops(r.id, jsonb_build_array(
  jsonb_build_object('stop_id', (select id from public.stops where code = 'BH'), 'minutes_from_start', 0),
  jsonb_build_object('stop_id', (select id from public.stops where code = 'VT'), 'minutes_from_start', 120)))
  from public.routes r $$, 'Điểm dừng 2 tuyến');
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats) values ('G29', 'Ghế 29', 29) $$, 'Loại xe');
select lives_ok($$ insert into public.vehicles (id, plate, vehicle_type_id) values ((select v from t.ids where k = 'X1'), '60B-123.45', (select id from public.vehicle_types)) $$, 'Xe');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'D1'), '{"full_name": "Lái Một", "position": "lai_xe", "joined_on": "2020-01-01"}') $$, 'Lái xe');
select lives_ok($$ select public.add_extra_trip(id, 'di', app.local_today() + 1, '07:00', null) from public.routes $$, '2 chuyến 07:00 ở 2 tuyến');
reset role;
insert into t.ids select 'T1', id from public.trips where route_id = (select id from public.routes where code = 'BH-VT');
insert into t.ids select 'T2', id from public.trips where route_id = (select id from public.routes where code = 'BH-VT2');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$ select public.issue_transport_order((select v from t.ids where k = 'T1')) $$, '22023', null,
  'Chuyến chưa đủ xe + lái xe thì chưa cấp lệnh');
select lives_ok($$ select public.assign_trip((select v from t.ids where k = 'T1'), (select v from t.ids where k = 'X1'),
  (select v from t.ids where k = 'D1'), null, null, 'Đang bổ sung giấy tờ') $$, 'Xếp xe chuyến 1');
select throws_ok($$ select public.issue_transport_order((select v from t.ids where k = 'T1')) $$, '22023', null,
  'Chưa cấu hình hậu tố số lệnh');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ insert into public.tenant_settings (key, value) values ('lenh.hau_to', '"tg tp"') $$, '22023', null,
  'Hậu tố phải là chữ in hoa / số, không dấu cách');
select lives_ok($$ insert into public.tenant_settings (key, value) values ('lenh.hau_to', '"TGTP"'), ('cong_ty.giam_doc', '"Hà Văn Thịnh"') $$,
  'Cấu hình hậu tố TGTP + tên Giám đốc');
select lives_ok($$ select public.assign_trip((select v from t.ids where k = 'T2'), null, null, null, null, null) $$, 'Chuyến 2 chưa xếp');
-- cùng xe chạy tiếp 3 lượt trong ngày: về 12:00, đi 15:00, về 19:00 (lệnh 4 lượt lấy theo lịch xếp)
select lives_ok($$ select public.add_extra_trip(id, 've', app.local_today() + 1, '12:00', null), public.add_extra_trip(id, 'di', app.local_today() + 1, '15:00', null),
  public.add_extra_trip(id, 've', app.local_today() + 1, '19:00', null) from public.routes where code = 'BH-VT' $$, '3 chuyến tiếp theo');
reset role;
insert into t.ids select 'T3', id from public.trips where route_id = (select id from public.routes where code = 'BH-VT') and to_char(depart_at at time zone 'Asia/Ho_Chi_Minh', 'HH24') = '12';
insert into t.ids select 'T4', id from public.trips where route_id = (select id from public.routes where code = 'BH-VT') and to_char(depart_at at time zone 'Asia/Ho_Chi_Minh', 'HH24') = '15';
insert into t.ids select 'T5', id from public.trips where route_id = (select id from public.routes where code = 'BH-VT') and to_char(depart_at at time zone 'Asia/Ho_Chi_Minh', 'HH24') = '19';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.assign_trip(v, (select v from t.ids where k = 'X1'), (select v from t.ids where k = 'D1'), null, null, 'x') from t.ids where k in ('T3', 'T4', 'T5') $$, 'Xếp cùng xe, cùng lái xe');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from jsonb_array_elements(public.transport_order_draft((select v from t.ids where k = 'T1')) -> 'legs')), 4, 'Chưa cấp: tự lấy 4 lượt theo lịch xếp xe');
select is((public.issue_transport_order((select v from t.ids where k = 'T1'))).order_no,
  '0700-' || to_char(app.local_today() + 1, 'DDMMYYYY') || '-345/LVC-TGTP', 'Số lệnh: giờ phút - ngày tháng năm - 3 số cuối biển số / LVC-TGTP');
select is((select string_agg(l.seq || '=' || l.depart_time, ',' order by l.seq) from public.transport_order_legs l), '1=07:00,2=12:00,3=15:00,4=19:00', '2 lượt đi + 2 lượt về đúng giờ');
select is((public.issue_transport_order((select v from t.ids where k = 'T1'))).order_no,
  '0700-' || to_char(app.local_today() + 1, 'DDMMYYYY') || '-345/LVC-TGTP', 'In lại giữ nguyên số lệnh');
-- chỉnh tay: bỏ lượt về 2, sửa giờ lượt đi 2; số lệnh giữ nguyên; chuyến về cũng thấy cùng lệnh
select is((public.save_transport_order((select v from t.ids where k = 'T3'), jsonb_build_array(
  jsonb_build_object('seq', 1, 'trip_id', (select v from t.ids where k = 'T1')), jsonb_build_object('seq', 2, 'trip_id', (select v from t.ids where k = 'T3')),
  jsonb_build_object('seq', 3, 'trip_id', (select v from t.ids where k = 'T4'), 'time', '15:30')))).order_no,
  '0700-' || to_char(app.local_today() + 1, 'DDMMYYYY') || '-345/LVC-TGTP', 'Chỉnh tay lượt: giữ số lệnh');
select is((select string_agg(l.seq || '=' || l.depart_time, ',' order by l.seq) from public.transport_order_legs l), '1=07:00,2=12:00,3=15:30', 'Đã sửa giờ, bỏ lượt về 2');
select is(public.transport_order_draft((select v from t.ids where k = 'T3')) ->> 'order_no', '0700-' || to_char(app.local_today() + 1, 'DDMMYYYY') || '-345/LVC-TGTP', 'Chuyến về thấy lệnh đã cấp');
select is((select print_count from public.transport_orders), 3, 'Đếm số lần in');
select is((select valid_to - valid_from from public.transport_orders), 1, 'Lệnh có giá trị 2 ngày (ngày chạy và ngày hôm sau)');
reset role;

-- Chuyến 2 cùng 07:00 cùng ngày ở tuyến khác → số lệnh thêm ".2"
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.cancel_trip((select v from t.ids where k = 'T1'), 'Thử') $$, 'Hủy chuyến 1 để xe rảnh');
select lives_ok($$ select public.assign_trip((select v from t.ids where k = 'T2'), (select v from t.ids where k = 'X1'),
  (select v from t.ids where k = 'D1'), null, null, 'x') $$, 'Xếp xe chuyến 2');
select is((public.issue_transport_order((select v from t.ids where k = 'T2'))).order_no,
  '0700-' || to_char(app.local_today() + 1, 'DDMMYYYY') || '-345.2/LVC-TGTP', 'Trùng số: thêm .2');
select throws_ok($$ select public.save_transport_order((select v from t.ids where k = 'T2'), jsonb_build_array(
  jsonb_build_object('seq', 1, 'trip_id', (select v from t.ids where k = 'T2')), jsonb_build_object('seq', 2, 'trip_id', (select v from t.ids where k = 'T3')))) $$,
  '22023', null, 'Chuyến đã nằm trên lệnh khác thì không đưa vào lệnh thứ hai');
select is((public.issue_transport_order((select v from t.ids where k = 'T1'))).print_count, 4,
  'Chuyến đã hủy vẫn in lại được lệnh đã cấp (không cấp mới)');

-- Chữ ký: Giám đốc do chủ tải; mỗi người tự tải của mình
select lives_ok(format($$ insert into storage.objects (bucket_id, name) values ('giay-to', '%s/chu_ky/giam_doc.png') $$,
  (select v from t.ids where k = 'A')), 'Chủ tải chữ ký + dấu Giám đốc');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('giay-to', '%s/chu_ky/00000000-0000-0000-0000-0000000000b2.png') $$,
  (select v from t.ids where k = 'A')), '42501', null, 'Điều hành không tự tải chữ ký của mình (quản lý nhân sự tải trong hồ sơ)');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('giay-to', '%s/chu_ky/giam_doc.png') $$,
  (select v from t.ids where k = 'A')), '42501', null, 'Điều hành không thay được chữ ký Giám đốc');
select is((select count(*)::int from storage.objects where name like '%/chu_ky/%'), 1, 'Điều hành (người in lệnh) xem được chữ ký');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select is((select count(*)::int from storage.objects where name like '%/chu_ky/%'), 1, 'Bán vé (có ô Cấp lệnh) xem được chữ ký in trên lệnh');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('giay-to', '%s/chu_ky/00000000-0000-0000-0000-0000000000b2.png') $$,
  (select v from t.ids where k = 'A')), '42501', null, 'Không tải chữ ký thay người khác');
select is(public.transport_order_draft((select v from t.ids where k = 'T2')) ->> 'order_no', '0700-' || to_char(app.local_today() + 1, 'DDMMYYYY') || '-345.2/LVC-TGTP', 'Phòng vé xem lệnh của chuyến');
select is((public.issue_transport_order((select v from t.ids where k = 'T2'))).print_count, 2, 'Phòng vé in lại lệnh');
select lives_ok($$ select public.set_order_print((select id from public.transport_orders where trip_id = (select v from t.ids where k = 'T2')), false, true) $$, 'Phòng vé chọn không in chữ ký Giám đốc');
select is((public.transport_order_print((select id from public.transport_orders where trip_id = (select v from t.ids where k = 'T2'))) ->> 'sign'), 'false', 'Lệnh nhớ lựa chọn in chữ ký');
select is(jsonb_array_length(public.transport_order_print((select id from public.transport_orders where trip_id = (select v from t.ids where k = 'T2'))) -> 'crew'), 1, 'Dữ liệu in có lái xe (không cần quyền xem nhân sự)');
reset role;
delete from public.role_permissions where permission_code = 'order.add' and role_id in (select id from public.roles where code = 'seller');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select throws_ok($$ select public.issue_transport_order((select v from t.ids where k = 'T2')) $$, '42501', null, 'Bỏ ô Cấp lệnh thì bán vé không cấp được');
select throws_ok($$ select public.transport_order_print((select id from public.transport_orders limit 1)) $$, '42501', null, 'Bỏ ô Cấp lệnh thì không lấy dữ liệu in');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.transport_orders), 0, 'Chủ B không thấy lệnh nhà xe A');
select is((select count(*)::int from public.transport_order_legs), 0, 'Chủ B không thấy lượt lệnh nhà xe A');
select throws_ok($$ select public.save_transport_order((select v from t.ids where k = 'T2'), null) $$, 'P0002', null, 'Chủ B lưu lệnh chuyến nhà xe A: không tìm thấy');
select throws_ok(format('select public.transport_order_print(%L)', (select id from public.transport_orders limit 1)), 'P0002', null, 'Chủ B lấy dữ liệu in lệnh nhà xe A: không tìm thấy');
select is((select count(*)::int from storage.objects where name like '%/chu_ky/%'), 0, 'Chủ B không thấy chữ ký nhà xe A');
select throws_ok($$ select public.issue_transport_order((select v from t.ids where k = 'T2')) $$, 'P0002', null,
  'Chủ B cấp lệnh chuyến nhà xe A thì báo không tìm thấy');
reset role;

select ok(not has_function_privilege('anon', 'public.issue_transport_order(uuid)', 'EXECUTE'), 'Khách (anon) không cấp lệnh');

select * from finish();
rollback;
