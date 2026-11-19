-- Kiểm thử Giai đoạn 3.2a: loại xe, sơ đồ ghế, giới hạn theo kiểm định, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'ua2@test.local'),
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
insert into t.ids select 'B', id from public.tenants where code = 'nha-xe-b';
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select v from t.ids where k = 'B'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

select ok(exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id
                  where r.code = 'owner' and r.tenant_id = (select v from t.ids where k = 'A') and rp.permission_code = 'vehicle.manage'),
  'Chủ nhà xe có quyền quản lý xe');

-- ---------------------------------------------------------------- Chủ A tạo loại xe
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ insert into public.vehicle_types (code, name) values ('X', 'Không có số chỗ') $$, '23514', null,
  'Loại xe phải có số người cho phép chở');
select lives_ok($$ insert into public.vehicle_types (code, name, body_style, decks, reg_seats, reg_berths)
  values ('GN40', 'Giường nằm 40 chỗ', 'giuong_nam', 2, 2, 4) $$, 'Chủ A tạo loại xe giường nằm 2 tầng');
reset role;
insert into t.ids select 'T', id from public.vehicle_types where code = 'GN40';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select public.set_seat_layout((select v from t.ids where k = 'T'), 2, 3, jsonb_build_array(
  jsonb_build_object('label', 'A01', 'deck', 1, 'row', 1, 'col', 4, 'kind', 'giuong'))) $$, '22023', null,
  'Chặn chỗ nằm ngoài lưới');
select throws_ok($$ select public.set_seat_layout((select v from t.ids where k = 'T'), 2, 3, jsonb_build_array(
  jsonb_build_object('label', 'A01', 'deck', 3, 'row', 1, 'col', 1, 'kind', 'giuong'))) $$, '22023', null,
  'Chặn tầng vượt số tầng của loại xe');
select throws_ok($$ select public.set_seat_layout((select v from t.ids where k = 'T'), 2, 3, jsonb_build_array(
  jsonb_build_object('label', 'A01', 'deck', 1, 'row', 1, 'col', 1, 'kind', 'giuong'),
  jsonb_build_object('label', 'a01', 'deck', 1, 'row', 1, 'col', 2, 'kind', 'giuong'))) $$, '22023', null,
  'Chặn trùng số ghế (không phân biệt hoa thường)');
select throws_ok($$ select public.set_seat_layout((select v from t.ids where k = 'T'), 2, 3, jsonb_build_array(
  jsonb_build_object('label', 'A01', 'deck', 1, 'row', 1, 'col', 1, 'kind', 'giuong'),
  jsonb_build_object('label', 'A02', 'deck', 1, 'row', 1, 'col', 1, 'kind', 'giuong'))) $$, '22023', null,
  'Chặn hai chỗ cùng một ô');
select throws_ok($$ select public.set_seat_layout((select v from t.ids where k = 'T'), 2, 3, jsonb_build_array(
  jsonb_build_object('label', 'A01', 'deck', 1, 'row', 1, 'col', 1, 'kind', 'giuong'),
  jsonb_build_object('label', 'A02', 'deck', 1, 'row', 1, 'col', 3, 'kind', 'giuong'),
  jsonb_build_object('label', 'B01', 'deck', 2, 'row', 1, 'col', 1, 'kind', 'giuong'),
  jsonb_build_object('label', 'B02', 'deck', 2, 'row', 1, 'col', 3, 'kind', 'giuong'),
  jsonb_build_object('label', 'B03', 'deck', 2, 'row', 2, 'col', 3, 'kind', 'giuong'))) $$, '22023', null,
  'Chặn số giường vượt số chỗ nằm theo kiểm định');
select lives_ok($$ select public.set_seat_layout((select v from t.ids where k = 'T'), 2, 3, jsonb_build_array(
  jsonb_build_object('label', 'a01', 'deck', 1, 'row', 1, 'col', 1, 'kind', 'giuong', 'priority', true),
  jsonb_build_object('label', 'A02', 'deck', 1, 'row', 1, 'col', 3, 'kind', 'giuong'),
  jsonb_build_object('label', 'B01', 'deck', 2, 'row', 1, 'col', 1, 'kind', 'giuong'),
  jsonb_build_object('label', 'B02', 'deck', 2, 'row', 1, 'col', 3, 'kind', 'giuong'),
  jsonb_build_object('label', 'PX', 'deck', 1, 'row', 2, 'col', 1, 'kind', 'ghe', 'sellable', false))) $$,
  'Chủ A lưu sơ đồ 4 giường + 1 ghế phụ xe');
select is((select count(*)::int from public.vehicle_type_seats), 5, 'Sơ đồ có 5 chỗ');
select is((select count(*)::int from public.vehicle_type_seats where is_sellable), 4, 'Có 4 chỗ bán được');
select is((select label from public.vehicle_type_seats where is_priority), 'A01', 'Số ghế viết hoa, có chỗ ưu tiên');
-- Ô tài xế + cửa: không bán, không ưu tiên, không tính vào số chỗ theo kiểm định
select lives_ok($$ select public.set_seat_layout((select v from t.ids where k = 'T'), 3, 3, jsonb_build_array(
  jsonb_build_object('label', 'A01', 'deck', 1, 'row', 1, 'col', 1, 'kind', 'giuong', 'priority', true),
  jsonb_build_object('label', 'A02', 'deck', 1, 'row', 1, 'col', 3, 'kind', 'giuong'),
  jsonb_build_object('label', 'B01', 'deck', 2, 'row', 1, 'col', 1, 'kind', 'giuong'),
  jsonb_build_object('label', 'B02', 'deck', 2, 'row', 1, 'col', 3, 'kind', 'giuong'),
  jsonb_build_object('label', 'PX', 'deck', 1, 'row', 2, 'col', 1, 'kind', 'ghe', 'sellable', false),
  jsonb_build_object('label', 'TX', 'deck', 1, 'row', 3, 'col', 1, 'kind', 'tai_xe', 'sellable', true, 'priority', true),
  jsonb_build_object('label', 'CUA', 'deck', 1, 'row', 3, 'col', 3, 'kind', 'cua'))) $$,
  'Thêm ô tài xế + cửa lên xuống (không vượt số chỗ theo kiểm định)');
select is((select count(*)::int from public.vehicle_type_seats where kind in ('tai_xe', 'cua') and not is_sellable and not is_priority), 2,
  'Ô tài xế / cửa luôn không bán, không ưu tiên');
select is((select count(*)::int from public.vehicle_type_seats where is_sellable), 4, 'Vẫn 4 chỗ bán được');
select throws_ok($$ select public.set_seat_layout((select v from t.ids where k = 'T'), 2, 3, jsonb_build_array(
  jsonb_build_object('label', 'X1', 'deck', 1, 'row', 1, 'col', 1, 'kind', 'ban'))) $$, '22023', null, 'Loại ô lạ bị chặn');
select is((select layout_rows * 10 + layout_cols from public.vehicle_types where code = 'GN40'), 33, 'Lưu kích thước lưới');
select ok(exists (select 1 from public.audit_logs where entity = 'vehicle_type_seats'
                  and detail -> 'new' ->> 'so_do' = '1 ghế, 4 giường'), 'Nhật ký ghi lần lưu sơ đồ');

select throws_ok($$ update public.vehicle_types set decks = 1 where code = 'GN40' $$, '22023', null,
  'Không giảm số tầng khi sơ đồ còn chỗ ở tầng 2');
select throws_ok($$ update public.vehicle_types set reg_berths = 3 where code = 'GN40' $$, '22023', null,
  'Không giảm chỗ nằm theo kiểm định xuống dưới số giường trong sơ đồ');
select lives_ok($$ update public.vehicle_types set brand = 'Thaco', model_code = 'TB120SL', amenities = '{wifi,wc}' where code = 'GN40' $$,
  'Chủ A sửa thông tin loại xe');
reset role;

-- ---------------------------------------------------------------- Nhân viên bán vé A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.vehicle_type_seats), 7, 'Bán vé xem được sơ đồ ghế');
select throws_ok($$ insert into public.vehicle_types (code, name, reg_seats) values ('X', 'X', 10) $$, '42501', null,
  'Bán vé không tạo được loại xe');
select throws_ok($$ select public.set_seat_layout((select v from t.ids where k = 'T'), 1, 1, '[]'::jsonb) $$, '42501', null,
  'Bán vé không sửa được sơ đồ');
with u as (update public.vehicle_types set name = 'Đổi' where code = 'GN40' returning 1)
select is(count(*)::int, 0, 'Bán vé không sửa được loại xe') from u;
select throws_ok($$ delete from public.vehicle_type_seats $$, '42501', null, 'Trình duyệt không xóa thẳng bảng ghế');
reset role;

-- ---------------------------------------------------------------- Chủ B (nhà xe khác)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.vehicle_types), 0, 'Chủ B không thấy loại xe nhà xe A');
select is((select count(*)::int from public.vehicle_type_seats), 0, 'Chủ B không thấy sơ đồ nhà xe A');
select throws_ok($$ select public.set_seat_layout((select v from t.ids where k = 'T'), 1, 1, '[]'::jsonb) $$, 'P0002', null,
  'Chủ B sửa sơ đồ nhà xe A thì báo không tìm thấy');
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats) values ('GN40', 'Loại của B', 29) $$,
  'Nhà xe B dùng được mã loại xe trùng nhà xe A');
select throws_ok($$ insert into public.vehicle_type_seats (tenant_id, vehicle_type_id, label, deck, row_no, col_no, kind)
  values ((select v from t.ids where k = 'B'), (select v from t.ids where k = 'T'), 'Z', 1, 1, 1, 'ghe') $$,
  '42501', null, 'Trình duyệt không ghi thẳng bảng ghế');
reset role;

select ok(not has_function_privilege('anon', 'public.set_seat_layout(uuid, int, int, jsonb)', 'EXECUTE'),
  'Khách (anon) không gọi được set_seat_layout');
select ok(has_table_privilege('service_role', 'public.vehicle_types', 'SELECT'), 'service_role đọc được loại xe');

select * from finish();
rollback;
