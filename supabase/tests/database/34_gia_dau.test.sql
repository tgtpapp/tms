-- Kiểm thử Giá dầu thị trường: tự cập nhật (giữ lịch sử, giá trước), nhập tay, đơn giá niêm yết trên phiếu, quyền, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'bv@test.local'), ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select id from public.tenants where code = 'nha-xe-a'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');


set local role service_role;
select is(app.svc_set_fuel_market('{"E10 RON95-III": 19100, "E5 RON92-II": 18570, "DO 0,001S-V": 28140, "DO 0,05S-II": 26340}', 'kiểm thử'), 'same', 'Giá không đổi: chỉ ghi giờ kiểm tra');
select is(app.svc_set_fuel_market('{"E10 RON95-III": 19100, "E5 RON92-II": 18570, "DO 0,001S-V": 28140, "DO 0,05S-II": 26900}', 'kiểm thử'), 'changed', 'Giá đổi: thêm dòng mới');
select throws_ok($$ select app.svc_set_fuel_market('{"DO 0,05S-II": 12}', 'x') $$, '22023', null, 'Chặn giá vô lý');
reset role;
select is((select prev from public.fuel_market_prices order by id desc limit 1), '{"DO 0,05S-II": 26340}'::jsonb, 'Lưu giá trước của mặt hàng đã đổi');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select (prices ->> 'DO 0,05S-II')::int from public.fuel_market_prices order by effective_at desc, id desc limit 1), 26900, 'Nhà xe đọc được giá thị trường');
select throws_ok($$ select app.svc_set_fuel_market('{"DO 0,05S-II": 27000}', 'x') $$, '42501', null, 'Người dùng không ghi giá tự động');
select throws_ok($$ insert into public.fuel_market_prices (effective_at, prices) values (now(), '{}') $$, '42501', null, 'Không ghi thẳng bảng giá');
select lives_ok($$ select public.save_fuel_market_manual('{"DO 0,05S-II": 27500}', now()) $$, 'Nhập giá tay');
select is((select market_manual -> 'truoc' ->> 'DO 0,05S-II' from public.fuel_settings), '26900', 'Nhập tay lưu giá trước');
select throws_ok($$ select public.save_fuel_market_manual('{"DO 0,05S-II": 100}', now()) $$, '22023', null, 'Chặn giá nhập tay vô lý');
select lives_ok($$ insert into public.vehicle_types (id, code, name, reg_seats) values ('00000000-0000-0000-0000-0000000000e1', 'G16', 'Ghế 16', 16) $$, 'Loại xe');
select lives_ok($$ insert into public.vehicles (id, plate, vehicle_type_id) values ('00000000-0000-0000-0000-0000000000e2', '60F-000.01', '00000000-0000-0000-0000-0000000000e1') $$, 'Xe');
select ok(public.save_fuel(null, '{"kind":"bon","entry_date":"2026-11-20","vehicle_id":"00000000-0000-0000-0000-0000000000e2","liters":50,"unit_price":27500,"market_price":true}') is not null, 'Cấp dầu theo giá niêm yết');
select is((select market_price from public.fuel_entries), true, 'Phiếu ghi đơn giá lấy theo giá niêm yết');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select throws_ok($$ select public.save_fuel_market_manual('{"DO 0,05S-II": 27000}', now()) $$, '42501', null, 'Bán vé không nhập giá dầu');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.fuel_settings where market_manual is not null), 0, 'Nhà xe B không thấy giá nhập tay của A');
select lives_ok($$ select public.save_fuel_market_manual('{"DO 0,05S-II": 26000}', now()) $$, 'Nhà xe B nhập giá riêng');
reset role;
select is((select market_manual -> 'gia' ->> 'DO 0,05S-II' from public.fuel_settings where tenant_id = (select id from public.tenants where code = 'nha-xe-a')), '27500', 'Giá nhập tay của A không bị B ghi đè');
select * from finish();
rollback;
