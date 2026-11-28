-- Kiểm thử: Admin của nhà xe (Chủ nhà xe / Quản trị) xem được mọi chuyến ở "Việc của tôi" (admin_trips); lái xe, điều hành không gọi được; không thấy chuyến nhà xe khác.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'ua2@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'ua3@test.local'),
  ('00000000-0000-0000-0000-0000000000b5', 'lx@test.local'),
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
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select v from t.ids where k = 'A'), '0900000003', 'Quản trị A', 'admin') $$, 'Quản trị A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b5', (select v from t.ids where k = 'A'), '0900000005', 'Lái Một', 'driver') $$, 'Lái xe A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000009', 'Chủ B', 'owner') $$, 'Chủ B');

-- Chủ A: tuyến + lái xe gắn tài khoản
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.stops (code, name, kind) values ('HN', 'BX Hố Nai', 'ben_xe'), ('VT', 'BX Vũng Tàu', 'ben_xe') $$, 'Điểm dừng');
select lives_ok($$ insert into public.routes (code, name, distance_km) values ('HN-VT', 'Hố Nai – Vũng Tàu', 110) $$, 'Tuyến');
select lives_ok($$ select public.set_route_stops((select id from public.routes where code = 'HN-VT'), jsonb_build_array(
  jsonb_build_object('stop_id', (select id from public.stops where code = 'HN'), 'minutes_from_start', 0),
  jsonb_build_object('stop_id', (select id from public.stops where code = 'VT'), 'minutes_from_start', 120))) $$, 'Điểm của tuyến');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'D1'), jsonb_build_object('full_name', 'Lái Một', 'position', 'lai_xe',
  'joined_on', '2020-01-01', 'user_id', '00000000-0000-0000-0000-0000000000b5')) $$, 'Lái xe gắn tài khoản');
reset role;

-- Điều hành A: 1 nốt mỗi ngày → 8 chuyến; xếp lái xe vào 1 chuyến
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select lives_ok($$ select public.save_schedule(null, (select id from public.routes where code = 'HN-VT'), 'di', '07:00', '{1,2,3,4,5,6,7}', null, null, null) $$, 'Nốt 07:00');
reset role;
insert into t.ids select 'T1', id from public.trips where service_date = app.local_today() + 1;
insert into public.trip_crew (tenant_id, trip_id, staff_id, role, during)
select t.tenant_id, t.id, (select v from t.ids where k = 'D1'), 'lai_xe_1', tstzrange(t.depart_at, t.arrive_at)
from public.trips t where t.id = (select v from t.ids where k = 'T1');

-- Chủ nhà xe: thấy mọi chuyến của nhà xe, không phải vai trò trên chuyến
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is(public.my_is_admin(), true, 'Chủ nhà xe là Admin');
select is((select count(*)::int from public.admin_trips(app.local_today(), app.local_today() + 7)), (select count(*)::int from public.trips),
  'Chủ nhà xe thấy mọi chuyến của nhà xe');
select is((select count(*)::int from public.admin_trips(app.local_today(), app.local_today() + 7) where my_role is not null), 0, 'Chủ nhà xe không chạy chuyến nào: vai trò trống');
reset role;
update public.trips set status = 'huy', cancel_reason = 'thử' where id = (select v from t.ids where k = 'T1');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.admin_trips(app.local_today(), app.local_today() + 7) where trip_id = (select v from t.ids where k = 'T1')), 0, 'Chuyến đã hủy không hiện');
select is((select count(*)::int from public.admin_trips(app.local_today(), app.local_today() + 7)), (select count(*)::int from public.trips where status <> 'huy'), 'Chỉ còn chuyến chưa hủy');
reset role;
update public.trips set status = 'mo', cancel_reason = null where id = (select v from t.ids where k = 'T1');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.my_trips(app.local_today(), app.local_today() + 7)), 0, 'my_trips giữ nguyên: chỉ chuyến của mình');
reset role;

-- Quản trị: cũng là Admin
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is(public.my_is_admin(), true, 'Quản trị là Admin');
select ok((select count(*)::int from public.admin_trips(app.local_today(), app.local_today() + 7)) > 0, 'Quản trị thấy chuyến của nhà xe');
reset role;

-- Lái xe, điều hành: không phải Admin, không gọi được admin_trips
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select is(public.my_is_admin(), false, 'Lái xe không phải Admin');
select throws_ok($$ select * from public.admin_trips(app.local_today(), app.local_today() + 7) $$, '42501', null, 'Lái xe không xem được mọi chuyến');
select is((select count(*)::int from public.my_trips(app.local_today(), app.local_today() + 7)), 1, 'Lái xe vẫn thấy chuyến của mình');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is(public.my_is_admin(), false, 'Điều hành không phải Admin');
select throws_ok($$ select * from public.admin_trips(app.local_today(), app.local_today() + 7) $$, '42501', null, 'Điều hành không gọi được');
reset role;

-- Nhà xe khác: Chủ B không thấy chuyến nhà xe A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.admin_trips(app.local_today(), app.local_today() + 7)), 0, 'Chủ B không thấy chuyến nhà xe A');
reset role;

-- Chưa đăng nhập: không gọi được
set local role anon;
select throws_ok($$ select * from public.admin_trips('2026-01-01'::date, '2026-01-02'::date) $$, '42501', null, 'Chưa đăng nhập: không có quyền');
reset role;

select * from finish();
rollback;
