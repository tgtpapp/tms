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

select throws_ok($$ select public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT')) $$, 'P0002', null, 'Tuyến chưa có bảng giá thì báo lỗi');
select lives_ok($$ select public.save_fare_table(null, (select v from t.ids where k = 'R'), app.local_today(), null, 'Giá thường', jsonb_build_array(
  jsonb_build_object('from', '', 'to', '', 'price', 150000),
  jsonb_build_object('from', 'bx  hố nai', 'to', 'Bà Rịa', 'price', 120000))) $$, 'Bảng giá: toàn tuyến 150.000, chặng Hố Nai – Bà Rịa 120.000 (tên gõ không phân biệt hoa thường)');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'BR')), 120000, 'Chặng có trong bảng dùng giá chặng');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'BR'), (select v from t.ids where k = 'HN')), 120000, 'Chiều về cùng chặng dùng chung giá');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'BR'), (select v from t.ids where k = 'VT')), 150000, 'Chặng không có trong bảng dùng giá toàn tuyến');
select is((select count(*)::int from public.stops where tenant_id = (select v from t.ids where k = 'A')), 3, 'Tên điểm có sẵn thì dùng lại, không tạo điểm mới');
select throws_ok($$ select public.save_fare_table(null, (select v from t.ids where k = 'R'), app.local_today() + 5, null, null, '[{"from":"","to":"","price":1000}]') $$,
  '23P01', null, 'Không cho 2 bảng giá trùng khoảng ngày của cùng tuyến');
select lives_ok($$ select public.save_fare_table((select id from public.fare_tables), (select v from t.ids where k = 'R'), app.local_today(), app.local_today(), 'Giá thường',
  (select jsonb_agg(jsonb_build_object('from', coalesce(a.name, ''), 'to', coalesce(b.name, ''), 'price', i.price) order by i.seq)
   from public.fare_table_items i left join public.stops a on a.id = i.from_stop_id left join public.stops b on b.id = i.to_stop_id)) $$,
  'Sửa bảng giá: chỉ áp dụng đến hết hôm nay');
select lives_ok($$ select public.save_fare_table(null, (select v from t.ids where k = 'R'), app.local_today() + 1, null, 'Giá mới', '[{"from":"","to":"","price":170000}]') $$,
  'Bảng giá mới từ ngày mai');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'BR'), (select v from t.ids where k = 'VT')), 150000, 'Hôm nay vẫn giá cũ');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'BR'), (select v from t.ids where k = 'VT'), app.local_today() + 1), 170000, 'Từ ngày mai giá mới');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'BR'), app.local_today() + 1), 170000, 'Bảng mới không có chặng riêng thì dùng giá toàn tuyến');
select throws_ok($$ select public.save_fare_table(null, (select v from t.ids where k = 'R'), app.local_today() + 30, app.local_today() + 29, null, '[{"from":"","to":"","price":1000}]') $$,
  '22023', null, 'Ngày kết thúc phải sau ngày bắt đầu');
select throws_ok($$ select public.save_fare_table(null, (select v from t.ids where k = 'R'), app.local_today() - 30, app.local_today() - 29, null, '[{"from":"","to":"","price":0}]') $$,
  '22023', null, 'Giá phải lớn hơn 0');
select throws_ok($$ select public.save_fare_table(null, (select v from t.ids where k = 'R'), app.local_today() - 30, app.local_today() - 29, null,
  '[{"from":"BX Hố Nai","to":"Bà Rịa","price":1000},{"from":"Bà Rịa","to":"BX Hố Nai","price":2000}]') $$, '22023', null, 'Chặng nhập trùng (2 chiều) bị chặn');
select throws_ok($$ select public.save_fare_table(null, (select v from t.ids where k = 'R'), app.local_today() - 30, app.local_today() - 29, null, '[{"from":"BX Hố Nai","to":"","price":1000}]') $$,
  '22023', null, 'Chặng phải đủ điểm đi và điểm đến');
select is((select count(*)::int from public.stops where tenant_id = (select v from t.ids where k = 'A')), 3, 'Lưu lỗi thì không tạo điểm');

-- Điểm chưa có: tự tạo và thêm vào lộ trình tuyến
select lives_ok($$ select public.save_fare_table(null, (select v from t.ids where k = 'R'), app.local_today() - 60, app.local_today() - 31, 'Cũ',
  '[{"from":"BX Hố Nai","to":"Long Thành","price":60000}]') $$, 'Gõ tay điểm mới Long Thành');
select is((select array_agg(s.name order by rs.seq) from public.route_stops rs join public.stops s on s.id = rs.stop_id where rs.route_id = (select v from t.ids where k = 'R')),
  array['BX Hố Nai', 'Bà Rịa', 'Long Thành', 'BX Vũng Tàu'], 'Điểm gõ tay xếp ngay trước điểm cuối tuyến');
select lives_ok($$ select public.save_fare_table(null, (select v from t.ids where k = 'R'), app.local_today() - 90, app.local_today() - 61, null,
  '[{"from":"Phú Mỹ","to":"BX Vũng Tàu","price":40000}]', '["BX Vũng Tàu","Phú Mỹ","Bà Rịa"]') $$, 'Danh sách điểm ghi ngược chiều tuyến');
select is((select array_agg(s.name order by rs.seq) from public.route_stops rs join public.stops s on s.id = rs.stop_id where rs.route_id = (select v from t.ids where k = 'R')),
  array['BX Hố Nai', 'Bà Rịa', 'Phú Mỹ', 'Long Thành', 'BX Vũng Tàu'], 'Điểm mới xếp theo danh sách điểm (đảo đúng chiều tuyến)');
select is((select minutes_from_start from public.route_stops rs join public.stops s on s.id = rs.stop_id where rs.route_id = (select v from t.ids where k = 'R') and s.name = 'Phú Mỹ'),
  60, 'Điểm mới lấy số phút của điểm trước, sửa lại được ở Tuyến');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT'), app.local_today() - 90), 40000, 'Bảng không có giá toàn tuyến: chặng khác lấy giá chặng có trong bảng');
reset role;

-- ---------------------------------------------------------------- Bán vé không được sửa / xóa bảng giá
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$ select public.delete_fare_table((select id from public.fare_tables order by valid_from desc limit 1)) $$, '42501', null,
  'Bán vé không xóa được bảng giá');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.delete_fare_table((select id from public.fare_tables where note = 'Cũ')) $$, 'Chủ A xóa bảng giá cũ');
select is((select count(*)::int from public.fare_tables), 3, 'Còn 3 bảng giá');
reset role;

-- ---------------------------------------------------------------- Nhân viên bán vé A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.routes), 1, 'Bán vé xem được tuyến');
select is(public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'), (select v from t.ids where k = 'VT')),
  150000, 'Bán vé tra được giá');
select throws_ok($$ insert into public.routes (code, name) values ('X', 'Tuyến lạ') $$, '42501', null, 'Bán vé không tạo được tuyến');
select throws_ok($$ select public.save_fare_table(null, (select v from t.ids where k = 'R'), app.local_today() + 400, null, null, '[{"from":"","to":"","price":1000}]') $$, '42501', null,
  'Bán vé không thêm được bảng giá');
with u as (update public.stops set name = 'Đổi' where code = 'HN' returning 1)
select is(count(*)::int, 0, 'Bán vé không sửa được điểm dừng') from u;
reset role;

-- ---------------------------------------------------------------- Chủ B (nhà xe khác)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.routes), 0, 'Chủ B không thấy tuyến nhà xe A');
select is((select count(*)::int from public.fare_tables), 0, 'Chủ B không thấy bảng giá nhà xe A');
select is((select count(*)::int from public.fare_table_items), 0, 'Chủ B không thấy giá chặng nhà xe A');
select throws_ok($$ select public.fare_for((select v from t.ids where k = 'R'), (select v from t.ids where k = 'HN'),
  (select v from t.ids where k = 'VT')) $$, 'P0002', null, 'Chủ B không tra được giá tuyến nhà xe A');
select throws_ok($$ select public.save_fare_table(null, (select v from t.ids where k = 'R'), app.local_today() + 400, null, null, '[{"from":"","to":"","price":1000}]') $$, 'P0002', null,
  'Chủ B không thêm được bảng giá tuyến nhà xe A');
reset role;
insert into t.ids select 'FT', id from public.fare_tables order by valid_from limit 1;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.delete_fare_table((select v from t.ids where k = 'FT')) $$, 'P0002', null, 'Chủ B không xóa được bảng giá nhà xe A');
select throws_ok($$ select public.set_route_stops((select v from t.ids where k = 'R'), '[]'::jsonb) $$, 'P0002', null,
  'Chủ B không sửa được điểm dừng tuyến nhà xe A');
select lives_ok($$ insert into public.stops (code, name) values ('HN', 'Điểm của B') $$, 'Nhà xe B dùng được mã điểm trùng với nhà xe A');
select throws_ok($$ insert into public.route_stops (tenant_id, route_id, seq, stop_id)
  values ((select v from t.ids where k = 'B'), (select v from t.ids where k = 'R'), 9, (select v from t.ids where k = 'HN')) $$,
  '42501', null, 'Trình duyệt không ghi thẳng bảng điểm dừng tuyến');
reset role;

select * from finish();
rollback;
