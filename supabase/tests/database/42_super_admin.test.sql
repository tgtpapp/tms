-- Super Admin chỉ thấy danh sách nhà xe + đã có Chủ hay chưa; nhân viên nhà xe không gọi được.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is((select has_owner from public.platform_tenants() where code = 'nha-xe-a'), true, 'Nhà xe A đã có Chủ');
select is((select has_owner from public.platform_tenants() where code = 'nha-xe-b'), false, 'Nhà xe B chưa có Chủ');
select is((select count(*)::int from public.app_users), 0, 'Super Admin không đọc tài khoản nhà xe');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select * from public.platform_tenants() $$, '42501', null, 'Chủ nhà xe không gọi được');
reset role;
select * from finish();
rollback;
