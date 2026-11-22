-- Lái xe in phiếu lương của mình: đọc được chữ ký Giám đốc + con dấu; không đọc được chữ ký người khác; không thấy của nhà xe khác.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'd1@test.local'),
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
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Lái xe A', 'driver') $$, 'Lái xe A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select v from t.ids where k = 'B'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

insert into storage.objects (bucket_id, name) values
  ('giay-to', (select v from t.ids where k = 'A') || '/chu_ky/giam_doc.png'),
  ('giay-to', (select v from t.ids where k = 'A') || '/chu_ky/con_dau.png'),
  ('giay-to', (select v from t.ids where k = 'A') || '/chu_ky/00000000-0000-0000-0000-0000000000b1.png');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from storage.objects where name like '%/chu_ky/giam_doc.png'), 1, 'Lái xe đọc được chữ ký Giám đốc để in phiếu lương');
select is((select count(*)::int from storage.objects where name like '%/chu_ky/con_dau.png'), 1, 'Lái xe đọc được con dấu công ty');
select is((select count(*)::int from storage.objects where name like '%/chu_ky/00000000-0000-0000-0000-0000000000b1.png'), 0, 'Lái xe không đọc được chữ ký riêng của người khác');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('giay-to', '%s/chu_ky/giam_doc.png') $$,
  (select v from t.ids where k = 'A')), '42501', null, 'Lái xe không thay được chữ ký Giám đốc');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from storage.objects where name like '%/chu_ky/%'), 0, 'Nhà xe B không thấy chữ ký, con dấu nhà xe A');
reset role;

select * from finish();
rollback;
