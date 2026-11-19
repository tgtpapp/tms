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
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.vehicle_incidents), 0, 'Bán vé không xem sự cố xe');
select is((select count(*)::int from public.repair_orders), 0, 'Bán vé không xem phiếu sửa chữa');
select throws_ok($$ select public.save_repair(null, '{}', '[]') $$, '42501', null, 'Bán vé không lưu phiếu được');
select throws_ok($$ insert into public.vehicle_incidents (vehicle_id, occurred_on, summary) values (gen_random_uuid(), '2026-10-02', 'x') $$, '42501', null, 'Bán vé không ghi được');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.vehicle_incidents), 0, 'Nhà xe B không thấy sự cố của A');
select is((select count(*)::int from public.repair_orders), 0, 'Nhà xe B không thấy phiếu sửa chữa của A');
reset role;
select * from finish();
rollback;
