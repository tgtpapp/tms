-- Kiểm thử Lái xe báo đổ dầu: lái xe gửi (chống trùng), chỉ thấy phiếu của mình, điều hành duyệt thành phiếu Đổ ngoài / bỏ, quyền, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'lx1@test.local'), ('00000000-0000-0000-0000-0000000000b4', 'lx2@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'bv@test.local'), ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select id from public.tenants where code = 'nha-xe-a'), '0900000002', 'Lái Một', 'driver') $$, 'Lái xe 1');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b4', (select id from public.tenants where code = 'nha-xe-a'), '0900000005', 'Lái Hai', 'driver') $$, 'Lái xe 2');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select id from public.tenants where code = 'nha-xe-a'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.vehicle_types (id, code, name, reg_seats) values ('00000000-0000-0000-0000-0000000000e1', 'G16', 'Ghế 16', 16) $$, 'Loại xe');
select lives_ok($$ insert into public.vehicles (id, plate, vehicle_type_id) values ('00000000-0000-0000-0000-0000000000e2', '60F-004.39', '00000000-0000-0000-0000-0000000000e1') $$, 'Xe');
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Lái Một","joined_on":"2024-01-01","position":"lai_xe"}') $$, 'Hồ sơ lái xe 1');
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa02', '{"full_name":"Lái Hai","joined_on":"2024-01-01","position":"lai_xe"}') $$, 'Hồ sơ lái xe 2');
reset role;
update public.staff_members set user_id = '00000000-0000-0000-0000-0000000000b2' where id = '00000000-0000-0000-0000-00000000aa01';
update public.staff_members set user_id = '00000000-0000-0000-0000-0000000000b4' where id = '00000000-0000-0000-0000-00000000aa02';
-- Xe 60F-004.39 có trong chuyến xếp cho cả 2 lái xe; xe 51B-999.99 không ai chạy
insert into public.vehicles (id, tenant_id, plate, vehicle_type_id) values
  ('00000000-0000-0000-0000-0000000000e3', (select id from public.tenants where code = 'nha-xe-a'), '51B-999.99', '00000000-0000-0000-0000-0000000000e1');
insert into public.routes (id, tenant_id, code, name) values
  ('00000000-0000-0000-0000-0000000000f1', (select id from public.tenants where code = 'nha-xe-a'), 'T1', 'Hố Nai – Vũng Tàu');
insert into public.trips (id, tenant_id, route_id, direction, service_date, depart_at, arrive_at, vehicle_id) values
  ('00000000-0000-0000-0000-0000000000f2', (select id from public.tenants where code = 'nha-xe-a'), '00000000-0000-0000-0000-0000000000f1', 'di',
   app.local_today(), now() + interval '1 hour', now() + interval '3 hours', '00000000-0000-0000-0000-0000000000e2');
insert into public.trip_crew (tenant_id, trip_id, role, staff_id, during)
select (select id from public.tenants where code = 'nha-xe-a'), '00000000-0000-0000-0000-0000000000f2', r, s, tstzrange(now() + interval '1 hour', now() + interval '3 hours')
from (values ('lai_xe_1', '00000000-0000-0000-0000-00000000aa01'::uuid), ('lai_xe_2', '00000000-0000-0000-0000-00000000aa02'::uuid)) x(r, s);

-- Lái xe 1 gửi
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is(public.my_staff_id(), '00000000-0000-0000-0000-00000000aa01'::uuid, 'Lái xe biết hồ sơ của mình');
select ok(public.report_fuel(jsonb_build_object('key', 'k1', 'plate', '60f00439', 'entry_date', '2026-11-20', 'liters', 44.737, 'amount', 1200000,
  'files', jsonb_build_array((select id from public.tenants where code = 'nha-xe-a')::text || '/bao_dau/00000000-0000-0000-0000-00000000aa01/a.jpg'))) is not null, 'Gửi báo đổ dầu (biển số viết liền)');
select lives_ok($$ select public.report_fuel('{"key":"k1","plate":"60F-004.39","liters":44.737,"amount":1200000}') $$, 'Gửi lại cùng mã');
select is((select count(*)::int from public.fuel_reports), 1, 'Không sinh phiếu trùng');
select is((select unit_price from public.fuel_reports), 26823::bigint, 'Đơn giá tính từ thành tiền / số lít');
select throws_ok($$ select public.report_fuel('{"key":"k2","plate":"99Z-999.99","liters":10,"unit_price":27000}') $$, 'P0002', null, 'Biển số không có');
select throws_ok($$ select public.report_fuel('{"key":"k3","plate":"60F-004.39","liters":0,"unit_price":27000}') $$, '22023', null, 'Chặn số lít 0');
select throws_ok($$ select public.report_fuel('{"key":"k7","plate":"51B-999.99","liters":10,"unit_price":27000}') $$, '42501', null,
  'Lái xe chạy xe nào báo xe đó: xe không có trong chuyến của mình bị chặn');
select throws_ok(format($$ select public.report_fuel('{"key":"k4","plate":"60F-004.39","liters":10,"unit_price":27000,"files":["%s/bao_dau/00000000-0000-0000-0000-00000000aa02/x.jpg"]}') $$,
  (select id from public.tenants where code = 'nha-xe-a')), '22023', null, 'Không gắn ảnh của người khác');
select throws_ok($$ insert into public.fuel_reports (staff_id, vehicle_id, plate, entry_date, liters, unit_price, client_key) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000e2', 'x', '2026-11-20', 1, 1, 'x') $$, '42501', null, 'Không ghi thẳng bảng');
select throws_ok($$ select public.approve_fuel_report((select id from public.fuel_reports limit 1), '{}') $$, '42501', null, 'Lái xe không tự duyệt');
select is((select count(*)::int from public.fuel_entries), 0, 'Lái xe không thấy / chưa có phiếu nhiên liệu');
reset role;

-- Lái xe 2 không thấy phiếu của lái xe 1
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select is((select count(*)::int from public.fuel_reports), 0, 'Lái xe khác không thấy phiếu');
select lives_ok($$ select public.report_fuel('{"key":"k5","plate":"60F-004.39","liters":20,"unit_price":27000}') $$, 'Lái xe 2 gửi');
reset role;

-- Bán vé (không có hồ sơ nhân viên, không quyền nhiên liệu)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select throws_ok($$ select public.report_fuel('{"key":"k6","plate":"60F-004.39","liters":20,"unit_price":27000}') $$, '42501', null, 'Không có hồ sơ thì không báo đổ dầu');
select is((select count(*)::int from public.fuel_reports), 0, 'Bán vé không thấy phiếu lái xe gửi');
select is((select count(*)::int from public.notifications where kind = 'dau'), 0, 'Người không có quyền nhiên liệu không nhận thông báo đổ dầu');
reset role;

-- Chủ duyệt / bỏ
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.fuel_reports where status = 'cho'), 2, 'Điều hành thấy 2 phiếu chờ duyệt');
select is((select count(*)::int from public.notifications where kind = 'dau' and user_id = auth.uid()), 2, 'Người duyệt nhận thông báo 2 phiếu đổ dầu chờ duyệt');
select ok(exists (select 1 from public.notifications where kind = 'dau' and user_id = auth.uid() and body like '%44,737 lít · 1.200.000 đ'), 'Nội dung: số lít, số tiền');
select ok(public.approve_fuel_report((select id from public.fuel_reports where client_key = 'k1'),
  '{"entry_date":"2026-11-20","vehicle_id":"00000000-0000-0000-0000-0000000000e2","driver_id":"00000000-0000-0000-0000-00000000aa01","liters":44.74,"unit_price":26824,"supplier":"CX Long Thành"}') is not null, 'Duyệt');
select is((select kind || '|' || liters || '|' || array_length(files, 1) || '|' || (note like '%Lái Một gửi qua app%') from public.fuel_entries), 'ngoai|44.74|1|true', 'Thành phiếu Đổ ngoài kèm ảnh, ghi người gửi');
select is((select status from public.fuel_reports where client_key = 'k1'), 'duyet', 'Phiếu chuyển Đã duyệt');
select throws_ok($$ select public.approve_fuel_report((select id from public.fuel_reports where client_key = 'k1'), '{"entry_date":"2026-11-20","vehicle_id":"00000000-0000-0000-0000-0000000000e2","liters":1,"unit_price":1}') $$, '22023', null, 'Không duyệt 2 lần');
select lives_ok($$ select public.reject_fuel_report((select id from public.fuel_reports where client_key = 'k5'), 'Ảnh mờ') $$, 'Bỏ phiếu');
select is((select status || '|' || reject_reason from public.fuel_reports where client_key = 'k5'), 'bo|Ảnh mờ', 'Ghi lý do bỏ');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select is((select reject_reason from public.fuel_reports), 'Ảnh mờ', 'Lái xe thấy lý do phiếu của mình bị bỏ');
select is((select count(*)::int from public.fuel_entries where vehicle_id = '00000000-0000-0000-0000-0000000000e2'), 1, 'Lái xe xem được phiếu nhiên liệu của xe mình chạy');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.fuel_entries), 0, 'Bán vé (không có quyền nhiên liệu) không thấy phiếu');
reset role;

-- Nhà xe B
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.fuel_reports), 0, 'Nhà xe B không thấy phiếu của A');
select throws_ok($$ select public.reject_fuel_report((select id from public.fuel_reports limit 1), 'x') $$, 'P0002', null, 'Nhà xe B không bỏ được phiếu của A');
select throws_ok($$ select public.approve_fuel_report('00000000-0000-0000-0000-000000000000', '{}') $$, 'P0002', null, 'Không tìm thấy');
select is(public.my_staff_id(), null, 'Chủ B không có hồ sơ lái xe');
reset role;
select * from finish();
rollback;
