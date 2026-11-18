-- Kiểm thử Giai đoạn 3.1: điểm dừng, tuyến, giá vé (giá toàn tuyến + giá chặng, 2 chiều, lịch sử).
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

-- ---------------------------------------------------------------- Chủ A khai báo tuyến
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.stops (code, name, kind) values
  ('HN', 'BX Hố Nai', 'ben_xe'), ('BR', 'Bà Rịa', 'diem_don_tra'), ('VT', 'BX Vũng Tàu', 'ben_xe') $$, 'Chủ A tạo 3 điểm dừng');
select lives_ok($$ insert into public.routes (code, name, distance_km) values ('HN-VT', 'Hố Nai – Vũng Tàu', 110) $$, 'Chủ A tạo tuyến');
reset role;
insert into t.ids select 'R', id from public.routes where code = 'HN-VT';
insert into t.ids select code, id from public.stops where tenant_id = (select v from t.ids where k = 'A');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select public.set_route_stops((select v from t.ids where k = 'R'),
  jsonb_build_array(jsonb_build_object('stop_id', (select v from t.ids where k = 'HN')))) $$, '22023', null,
  'Tuyến phải có ít nhất 2 điểm');
select throws_ok($$ select public.set_route_stops((select v from t.ids where k = 'R'), jsonb_build_array(
  jsonb_build_object('stop_id', (select v from t.ids where k = 'HN'), 'minutes_from_start', 0),
  jsonb_build_object('stop_id', (select v from t.ids where k = 'BR'), 'minutes_from_start', 60),
  jsonb_build_object('stop_id', (select v from t.ids where k = 'VT'), 'minutes_from_start', 30))) $$, '22023', null,
  'Chặn thời gian điểm sau nhỏ hơn điểm trước');
select throws_ok($$ select public.set_route_stops((select v from t.ids where k = 'R'), jsonb_build_array(
  jsonb_build_object('stop_id', (select v from t.ids where k = 'HN')),
  jsonb_build_object('stop_id', (select v from t.ids where k = 'HN'), 'minutes_from_start', 10))) $$, '22023', null,
  'Một điểm không được lặp lại trong tuyến');
select lives_ok($$ select public.set_route_stops((select v from t.ids where k = 'R'), jsonb_build_array(
  jsonb_build_object('stop_id', (select v from t.ids where k = 'HN'), 'minutes_from_start', 0),
  jsonb_build_object('stop_id', (select v from t.ids where k = 'BR'), 'minutes_from_start', 60),
  jsonb_build_object('stop_id', (select v from t.ids where k = 'VT'), 'minutes_from_start', 90))) $$,
  'Chủ A đặt 3 điểm dừng theo thứ tự');
select is((select count(*)::int from public.route_stops), 3, 'Tuyến có 3 điểm dừng');

select throws_ok($$ select public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT')) $$, 'P0002', null, 'Tuyến chưa có giá thì báo lỗi');
select lives_ok($$ select public.set_fare((select v from t.ids where k = 'R'), null, null, 150000) $$, 'Đặt giá toàn tuyến 150.000');
select lives_ok($$ select public.set_fare((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'BR'), 120000) $$, 'Đặt giá chặng Hố Nai – Bà Rịa 120.000');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'BR')),
  120000, 'Chặng có giá riêng dùng giá riêng');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'BR'), (select v from t.ids where k = 'HN')),
  120000, 'Chiều về cùng chặng dùng chung giá');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'BR'), (select v from t.ids where k = 'VT')),
  150000, 'Chặng không có giá riêng dùng giá toàn tuyến');

select lives_ok($$ select public.set_fare((select v from t.ids where k = 'R'), null, null, 170000, app.local_today() + 1) $$,
  'Đặt giá mới áp dụng từ ngày mai');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'BR'), (select v from t.ids where k = 'VT')),
  150000, 'Hôm nay vẫn giá cũ');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'BR'), (select v from t.ids where k = 'VT'), app.local_today() + 1),
  170000, 'Từ ngày mai giá mới');
select is((select count(*)::int from public.route_fares where from_stop_id is null), 2, 'Giữ lịch sử giá toàn tuyến');
select throws_ok($$ select public.set_fare((select v from t.ids where k = 'R'), null, null, 100000, app.local_today() - 1) $$,
  '22023', null, 'Không đặt giá lùi về quá khứ');
select throws_ok($$ select public.set_fare((select v from t.ids where k = 'R'), null, null, 0) $$, '22023', null,
  'Giá phải lớn hơn 0');

select lives_ok($$ select public.set_fare((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'BR'), null) $$, 'Bỏ giá riêng chặng Hố Nai – Bà Rịa');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'BR')),
  150000, 'Bỏ giá riêng thì quay về giá toàn tuyến');
reset role;

-- ---------------------------------------------------------------- Nhân viên bán vé A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.routes), 1, 'Bán vé xem được tuyến');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT')),
  150000, 'Bán vé tra được giá');
select throws_ok($$ insert into public.routes (code, name) values ('X', 'Tuyến lạ') $$, '42501', null, 'Bán vé không tạo được tuyến');
select throws_ok($$ select public.set_fare((select v from t.ids where k = 'R'), null, null, 1000) $$, '42501', null,
  'Bán vé không đổi được giá');
with u as (update public.stops set name = 'Đổi' where code = 'HN' returning 1)
select is(count(*)::int, 0, 'Bán vé không sửa được điểm dừng') from u;
reset role;

-- ---------------------------------------------------------------- Chủ B (nhà xe khác)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.routes), 0, 'Chủ B không thấy tuyến nhà xe A');
select is((select count(*)::int from public.route_fares), 0, 'Chủ B không thấy giá nhà xe A');
select throws_ok($$ select public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT')) $$, 'P0002', null, 'Chủ B không tra được giá tuyến nhà xe A');
select throws_ok($$ select public.set_fare((select v from t.ids where k = 'R'), null, null, 1000) $$, 'P0002', null,
  'Chủ B không đổi được giá tuyến nhà xe A');
select throws_ok($$ select public.set_route_stops((select v from t.ids where k = 'R'), '[]'::jsonb) $$, 'P0002', null,
  'Chủ B không sửa được điểm dừng tuyến nhà xe A');
select lives_ok($$ insert into public.stops (code, name) values ('HN', 'Điểm của B') $$, 'Nhà xe B dùng được mã điểm trùng với nhà xe A');
select throws_ok($$ insert into public.route_stops (tenant_id, route_id, seq, stop_id)
  values ((select v from t.ids where k = 'B'), (select v from t.ids where k = 'R'), 9, (select v from t.ids where k = 'HN')) $$,
  '42501', null, 'Trình duyệt không ghi thẳng bảng điểm dừng tuyến');
reset role;

select * from finish();
rollback;
