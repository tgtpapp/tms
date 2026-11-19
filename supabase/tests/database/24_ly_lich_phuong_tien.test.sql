-- Kiểm thử lý lịch phương tiện: sự cố / tai nạn của xe, phân quyền, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'bv@test.local'), ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
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
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select v from t.ids where k = 'A'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats, reg_berths) values ('G16', 'Ghế 16', 16, 0) $$, 'Loại xe');
select lives_ok($$ insert into public.vehicles (plate, vehicle_type_id, gsht_account, odo_start, odo_date) values ('60F-004.39', (select id from public.vehicle_types), 'tk-gps', 120000, '2026-01-01') $$, 'Xe có GPS + Odo gốc');
select lives_ok($$ insert into public.vehicle_incidents (vehicle_id, occurred_on, place, summary, damage, resolution)
  values ((select id from public.vehicles), '2026-10-01', 'QL51', 'Nổ lốp', 'Nhẹ', 'Thay lốp') $$, 'Ghi sự cố xe');
select throws_ok($$ insert into public.vehicle_incidents (vehicle_id, occurred_on, summary) values ((select id from public.vehicles), '2026-10-02', ' ') $$,
  '23514', null, 'Phải có tóm tắt sự cố');
-- Sửa chữa: số phiếu tự tăng, hạng mục, sửa lại thay hạng mục
select lives_ok($$ select public.save_repair(null, jsonb_build_object('vehicle_id', (select id from public.vehicles), 'repaired_on', '2026-10-05', 'odo_km', 150000, 'workshop', 'Gara A'),
  '[{"content":"Thay nhớt","qty":1,"unit_price":800000},{"content":"Lọc gió","qty":2,"unit_price":150000}]') $$, 'Lưu phiếu sửa chữa');
select is((select code from public.repair_orders), 'PSX0001', 'Số phiếu tự tăng');
select is((select sum(qty * unit_price)::int from public.repair_items), 1100000, 'Tổng tiền 1.100.000');
select lives_ok($$ select public.save_repair((select id from public.repair_orders), jsonb_build_object('vehicle_id', (select id from public.vehicles), 'repaired_on', '2026-10-05'),
  '[{"content":"Thay nhớt","qty":1,"unit_price":900000}]') $$, 'Sửa phiếu');
select is((select count(*)::int from public.repair_items), 1, 'Hạng mục được thay');
select lives_ok($$ select public.save_repair(null, jsonb_build_object('vehicle_id', (select id from public.vehicles), 'repaired_on', '2026-10-06'), '[]') $$, 'Phiếu 2');
select is((select max(code) from public.repair_orders), 'PSX0002', 'Phiếu 2 số PSX0002');
-- Nhiên liệu: nhập bồn, cấp từ bồn, đổ ngoài; số phiếu theo loại
select lives_ok($$ insert into public.fuel_settings (tank_name, opening_l, opening_price) values ('Bồn A', 1000, 20000) $$, 'Thiết lập bồn');
select lives_ok($$ select public.save_fuel(null, jsonb_build_object('kind', 'nhap', 'entry_date', '2026-10-01', 'liters', 2000, 'unit_price', 21000, 'supplier', 'Petrolimex')) $$, 'Nhập bồn');
select lives_ok($$ select public.save_fuel(null, jsonb_build_object('kind', 'bon', 'entry_date', '2026-10-02', 'vehicle_id', (select id from public.vehicles), 'liters', 60, 'odo_km', 150500)) $$, 'Cấp dầu từ bồn');
select lives_ok($$ select public.save_fuel(null, jsonb_build_object('kind', 'bon', 'entry_date', '2026-10-03', 'vehicle_id', (select id from public.vehicles), 'liters', 55.5)) $$, 'Cấp dầu lần 2');
select lives_ok($$ select public.save_fuel(null, jsonb_build_object('kind', 'ngoai', 'entry_date', '2026-10-04', 'vehicle_id', (select id from public.vehicles), 'liters', 40, 'unit_price', 22000)) $$, 'Đổ ngoài');
select is((select array_agg(code order by code) from public.fuel_entries), array['DN00001', 'ND00001', 'XD00001', 'XD00002'], 'Số phiếu ND / XD / DN tự tăng');
select throws_ok($$ select public.save_fuel(null, jsonb_build_object('kind', 'bon', 'entry_date', '2026-10-02', 'liters', 10)) $$, '22023', 'Chọn xe', 'Cấp dầu phải có xe');
select throws_ok($$ select public.save_fuel(null, jsonb_build_object('kind', 'nhap', 'entry_date', '2026-10-02', 'liters', 10)) $$, '22023', null, 'Nhập bồn phải có giá');
select throws_ok($$ select public.save_fuel((select id from public.fuel_entries where code = 'XD00001'), jsonb_build_object('kind', 'ngoai', 'entry_date', '2026-10-02', 'vehicle_id', (select id from public.vehicles), 'liters', 10)) $$,
  '22023', null, 'Không đổi loại phiếu');
-- Chuyển từ app cũ: giữ số phiếu, nhập lại không trùng
select is(public.import_legacy_ops(
  jsonb_build_array(jsonb_build_object('code', 'SC001', 'vehicle_id', (select id from public.vehicles), 'repaired_on', '2026-09-01', 'items', '[{"content":"Vá lốp","qty":1,"unit_price":50000}]'::jsonb)),
  jsonb_build_array(jsonb_build_object('code', 'XD00099', 'kind', 'bon', 'entry_date', '2026-09-01', 'vehicle_id', (select id from public.vehicles), 'liters', 30))) - 'errors',
  '{"repairs":1,"fuel":1,"same":0}'::jsonb, 'Chuyển phiếu app cũ');
select is(public.import_legacy_ops(
  jsonb_build_array(jsonb_build_object('code', 'SC001', 'vehicle_id', (select id from public.vehicles), 'repaired_on', '2026-09-01')),
  jsonb_build_array(jsonb_build_object('code', 'XD00099', 'kind', 'bon', 'entry_date', '2026-09-01', 'vehicle_id', (select id from public.vehicles), 'liters', 30))) ->> 'same',
  '2', 'Nhập lại không trùng');
select is((select code from public.fuel_entries where kind = 'bon' order by created_at desc, code desc limit 1), 'XD00099', 'Giữ số phiếu app cũ');
-- Km xe theo ngày (GPS): nhập, nhập lại ghi đè, km sai bị chặn
select is(public.import_vehicle_km(jsonb_build_array(
  jsonb_build_object('vehicle_id', (select id from public.vehicles), 'run_date', '2026-10-01', 'km', 320.5),
  jsonb_build_object('vehicle_id', (select id from public.vehicles), 'run_date', '2026-10-02', 'km', 280))), '{"created":2,"updated":0,"same":0}'::jsonb, 'Nhập km GPS');
select is(public.import_vehicle_km(jsonb_build_array(
  jsonb_build_object('vehicle_id', (select id from public.vehicles), 'run_date', '2026-10-01', 'km', 320.5),
  jsonb_build_object('vehicle_id', (select id from public.vehicles), 'run_date', '2026-10-02', 'km', 300))), '{"created":0,"updated":1,"same":1}'::jsonb, 'Nhập lại ghi đè');
select is((select sum(km)::numeric from public.vehicle_km), 620.5::numeric, 'Tổng km');
select is((select km from public.vehicle_km_summary('2026-10-02', '2026-11-01')), 300::numeric, 'Tổng hợp km trong kỳ');
select is((select km_since_odo from public.vehicle_km_summary('2026-10-02', '2026-11-01')), 620.5::numeric, 'Km cộng dồn từ ngày Odo gốc');
select is((select count(*)::int from public.vehicle_km_stats('2026-10-01', '2026-11-01', 'day')), 2, 'Thống kê theo ngày');
select is((select km from public.vehicle_km_stats('2026-10-01', '2026-11-01', 'month')), 620.5::numeric, 'Thống kê theo tháng');
select is((select period from public.vehicle_km_stats('2026-01-01', '2027-01-01', 'year')), '2026-01-01'::date, 'Thống kê theo năm');
select throws_ok($$ select * from public.vehicle_km_stats('2026-10-01', '2026-11-01', 'gio') $$, '22023', null, 'Kỳ sai bị chặn');
select throws_ok($$ select public.import_vehicle_km(jsonb_build_array(jsonb_build_object('vehicle_id', gen_random_uuid(), 'run_date', '2026-10-01', 'km', 1))) $$, 'P0002', null, 'Xe lạ bị chặn');
select throws_ok($$ select public.import_vehicle_km(jsonb_build_array(jsonb_build_object('vehicle_id', (select id from public.vehicles), 'run_date', '2026-10-03', 'km', 9000))) $$, '22023', null, 'Km quá lớn bị chặn');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.vehicle_incidents), 0, 'Bán vé không xem sự cố xe');
select is((select count(*)::int from public.repair_orders), 0, 'Bán vé không xem phiếu sửa chữa');
select throws_ok($$ select public.save_repair(null, '{}', '[]') $$, '42501', null, 'Bán vé không lưu phiếu được');
select is((select count(*)::int from public.fuel_entries), 0, 'Bán vé không xem phiếu nhiên liệu');
select throws_ok($$ select public.save_fuel(null, '{}') $$, '42501', null, 'Bán vé không lưu phiếu nhiên liệu');
select is((select count(*)::int from public.vehicle_km), 0, 'Bán vé không xem km xe');
select throws_ok($$ select public.import_vehicle_km('[]') $$, '42501', null, 'Bán vé không nhập km');
select throws_ok($$ insert into public.vehicle_incidents (vehicle_id, occurred_on, summary) values (gen_random_uuid(), '2026-10-02', 'x') $$, '42501', null, 'Bán vé không ghi được');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.vehicle_incidents), 0, 'Nhà xe B không thấy sự cố của A');
select is((select count(*)::int from public.repair_orders), 0, 'Nhà xe B không thấy phiếu sửa chữa của A');
select is((select count(*)::int from public.fuel_entries), 0, 'Nhà xe B không thấy phiếu nhiên liệu của A');
select is((select count(*)::int from public.fuel_settings), 0, 'Nhà xe B không thấy bồn dầu của A');
select is((select count(*)::int from public.vehicle_km), 0, 'Nhà xe B không thấy km xe của A');
select is((select count(*)::int from public.vehicle_km_stats('2026-01-01', '2027-01-01', 'month')), 0, 'Nhà xe B không thấy thống kê km của A');
reset role;
select * from finish();
rollback;
