-- Kiểm thử định vị xe: chỉ ghi khi lái xe đã đồng ý + chuyến đang chạy; văn phòng / Admin xem; lái xe khác, nhà xe khác không xem được; xóa vị trí cũ.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'ua2@test.local'),
  ('00000000-0000-0000-0000-0000000000b5', 'lx@test.local'),
  ('00000000-0000-0000-0000-0000000000b6', 'lx2@test.local'),
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
insert into t.ids values ('D1', '33333333-3333-3333-3333-333333333331');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Điều hành A', 'dispatcher') $$, 'Điều hành A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b5', (select v from t.ids where k = 'A'), '0900000005', 'Lái Một', 'driver') $$, 'Lái xe 1');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b6', (select v from t.ids where k = 'A'), '0900000006', 'Lái Hai', 'driver') $$, 'Lái xe 2');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000009', 'Chủ B', 'owner') $$, 'Chủ B');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.stops (code, name, kind) values ('HN', 'BX Hố Nai', 'ben_xe'), ('VT', 'BX Vũng Tàu', 'ben_xe') $$, 'Điểm dừng');
select lives_ok($$ insert into public.routes (code, name, distance_km) values ('HN-VT', 'Hố Nai – Vũng Tàu', 110) $$, 'Tuyến');
select lives_ok($$ select public.set_route_stops((select id from public.routes where code = 'HN-VT'), jsonb_build_array(
  jsonb_build_object('stop_id', (select id from public.stops where code = 'HN'), 'minutes_from_start', 0),
  jsonb_build_object('stop_id', (select id from public.stops where code = 'VT'), 'minutes_from_start', 120))) $$, 'Điểm của tuyến');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'D1'), jsonb_build_object('full_name', 'Lái Một', 'position', 'lai_xe',
  'joined_on', '2020-01-01', 'user_id', '00000000-0000-0000-0000-0000000000b5')) $$, 'Lái xe 1 gắn tài khoản');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select lives_ok($$ select public.save_schedule(null, (select id from public.routes where code = 'HN-VT'), 'di', '07:00', '{1,2,3,4,5,6,7}', null, null, null) $$, 'Nốt 07:00');
reset role;
insert into t.ids select 'T1', id from public.trips where service_date = app.local_today();
-- Chuyến hôm nay đang chạy: lái xe 1 trong tổ lái, đã xuất bến, chưa đến bến
insert into public.trip_crew (tenant_id, trip_id, staff_id, role, during)
select t.tenant_id, t.id, (select v from t.ids where k = 'D1'), 'lai_xe_1', tstzrange(t.depart_at, t.arrive_at) from public.trips t where t.id = (select v from t.ids where k = 'T1');
set local session_replication_role = replica;
update public.trips set depart_at = now() - interval '30 minutes', arrive_at = now() + interval '90 minutes', departed_at = now() - interval '30 minutes'
where id = (select v from t.ids where k = 'T1');
set local session_replication_role = origin;

-- Lái xe 1: chưa đồng ý thì không ghi
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select is(public.track_point((select v from t.ids where k = 'T1'), 10.95, 106.85, 15, 50, 90), 'bo_qua', 'Chưa đồng ý: không ghi vị trí');
select lives_ok($$ select public.tracking_agree() $$, 'Lái xe đồng ý gửi vị trí');
select is(public.track_point((select v from t.ids where k = 'T1'), 10.95, 106.85, 15, 50, 90), 'luu', 'Đã đồng ý + chuyến đang chạy: ghi vị trí');
select is(public.track_point((select v from t.ids where k = 'T1'), 10.96, 106.86, 15, 50, 90), 'bo_qua', 'Gửi dày quá (dưới 20 giây): bỏ qua');
select is(public.track_point((select v from t.ids where k = 'T1'), 48.85, 2.35, 15, 50, 90), 'bo_qua', 'Vị trí ngoài Việt Nam: bỏ qua');
select throws_ok($$ insert into public.vehicle_positions (tenant_id, trip_id, user_id, lat, lng) values (app.current_tenant_id(), (select v from t.ids where k = 'T1'), auth.uid(), 10, 106) $$,
  '42501', null, 'Không ghi thẳng vào bảng vị trí');
select is((select count(*)::int from public.vehicle_positions), 1, 'Lái xe xem được vị trí của chính mình');
select throws_ok($$ select * from public.live_vehicles() $$, '42501', null, 'Lái xe không xem bản đồ văn phòng');
reset role;

-- Lái xe 2 (không ở chuyến): không gửi được, không thấy vị trí người khác
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b6","role":"authenticated"}';
select lives_ok($$ select public.tracking_agree() $$, 'Lái xe 2 đồng ý');
select throws_ok($$ select public.track_point((select v from t.ids where k = 'T1'), 10.95, 106.85, 15, 50, 90) $$, 'P0002', null, 'Không ở chuyến: không gửi được');
select is((select count(*)::int from public.vehicle_positions), 0, 'Lái xe 2 không thấy vị trí của lái xe 1');
reset role;

-- Điều hành, Chủ nhà xe: xem vị trí mới nhất
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.live_vehicles() where lat is not null), 1, 'Điều hành thấy 1 xe đang chạy có vị trí');
select is((select driver from public.live_vehicles()), 'Lái Một', 'Có tên lái xe');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select lat from public.live_vehicles()), 10.950000::numeric, 'Chủ nhà xe thấy vị trí');
reset role;

-- Nhà xe khác
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.live_vehicles()), 0, 'Chủ B không thấy xe nhà xe A');
select is((select count(*)::int from public.vehicle_positions), 0, 'Chủ B không đọc được vị trí nhà xe A');
reset role;

-- Đến bến: ngừng ghi; thôi đồng ý: ngừng ghi
update public.vehicle_positions set at = now() - interval '1 minute';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select lives_ok($$ select public.tracking_withdraw() $$, 'Lái xe thôi đồng ý');
select is(public.track_point((select v from t.ids where k = 'T1'), 10.97, 106.87, 15, 50, 90), 'bo_qua', 'Thôi đồng ý: không ghi nữa');
reset role;

-- Tự xóa vị trí cũ hơn 30 ngày
update public.vehicle_positions set at = now() - interval '31 days';
select is(public.svc_purge_positions(), 1, 'Xóa vị trí cũ hơn 30 ngày');

-- Chưa đăng nhập
set local role anon;
select throws_ok($$ select * from public.live_vehicles() $$, '42501', null, 'Chưa đăng nhập: không xem được');
reset role;

select * from finish();
rollback;
