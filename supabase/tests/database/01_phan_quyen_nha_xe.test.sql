-- Kiểm thử bắt buộc Giai đoạn 2.1: cách ly nhà xe, phạm vi, chống tự nâng quyền.
-- Chạy: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- Người dùng đăng nhập giả lập
-- a1 = Super Admin, a2 = người lạ, b1 = Chủ nhà xe A, b2 = nhân viên A, c1 = Chủ nhà xe B
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'x@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'ua2@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'ua3@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');

create schema t;
create table t.ids (k text primary key, v uuid not null);
grant usage on schema t to authenticated;
grant select on t.ids to authenticated;

-- ---------------------------------------------------------------- Super Admin
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Super Admin khởi tạo lần đầu');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Super Admin tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Super Admin tạo nhà xe B');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select throws_ok($$ select public.bootstrap_platform_admin() $$, '42501', null, 'Không khởi tạo lại Super Admin được');
select throws_ok($$ select public.create_tenant('nha-xe-c', 'Nhà xe C') $$, '42501', null, 'Người thường không tạo được nhà xe');
select is((select count(*)::int from public.tenants), 0, 'Người lạ không thấy nhà xe nào');
reset role;

insert into t.ids select 'A', id from public.tenants where code = 'nha-xe-a';
insert into t.ids select 'B', id from public.tenants where code = 'nha-xe-b';

-- Đăng ký người dùng (giả lập Edge Function chạy bằng service_role)
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1',
  (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Đăng ký Chủ nhà xe A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2',
  (select v from t.ids where k = 'A'), '0900000002', 'Nhân viên A2', null) $$, 'Đăng ký nhân viên A2');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3',
  (select v from t.ids where k = 'A'), '0900000004', 'Nhân viên bán vé A3', null) $$, 'Đăng ký nhân viên A3');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1',
  (select v from t.ids where k = 'B'), '0900000003', 'Chủ B', 'owner') $$, 'Đăng ký Chủ nhà xe B');
select throws_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000a2',
  (select v from t.ids where k = 'A'), '0900000001', 'Trùng SĐT', null) $$, '23505', null,
  'Không cho trùng số điện thoại trong cùng nhà xe');

-- ---------------------------------------------------------------- Chủ nhà xe A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.branches (code, name) values ('A1', 'Chi nhánh A1') $$, 'Chủ A tạo chi nhánh A1');
select lives_ok($$ insert into public.branches (code, name) values ('A2', 'Chi nhánh A2') $$, 'Chủ A tạo chi nhánh A2');
select throws_ok($$ insert into public.branches (tenant_id, code, name)
  values ((select v from t.ids where k = 'B'), 'X1', 'Giả mạo') $$, '42501', null,
  'Chủ A không tạo được chi nhánh cho nhà xe B');
select is((select count(*)::int from public.branches), 2, 'Chủ A thấy đúng 2 chi nhánh của mình');
select is((select count(*)::int from public.app_users), 3, 'Chủ A thấy 3 người dùng nhà xe A');
reset role;

insert into t.ids select 'A1', id from public.branches where code = 'A1' and tenant_id = (select v from t.ids where k = 'A');
insert into t.ids select 'A2', id from public.branches where code = 'A2' and tenant_id = (select v from t.ids where k = 'A');

-- ---------------------------------------------------------------- Chủ nhà xe B
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.branches), 0, 'Chủ B không thấy chi nhánh nhà xe A');
select is((select count(*)::int from public.app_users), 1, 'Chủ B chỉ thấy người dùng nhà xe B');
select is((select count(*)::int from public.tenants), 1, 'Chủ B chỉ thấy nhà xe B');
with u as (update public.branches set name = 'Bị sửa' where id = (select v from t.ids where k = 'A1') returning 1)
select is(count(*)::int, 0, 'Chủ B không sửa được chi nhánh nhà xe A') from u;
select throws_ok($$ select public.assign_role('00000000-0000-0000-0000-0000000000b2',
  (select id from public.roles where code = 'admin')) $$, 'P0002', null,
  'Chủ B không gán vai trò cho người của nhà xe A');
select is((select count(*)::int from public.audit_logs where tenant_id = (select v from t.ids where k = 'A')), 0,
  'Chủ B không đọc được nhật ký nhà xe A');
reset role;

-- ---------------------------------------------------------------- Nhân viên A2 chưa có vai trò
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$ insert into public.branches (code, name) values ('A9', 'Không được') $$, '42501', null,
  'Nhân viên không có quyền không tạo được chi nhánh');
select is((select count(*)::int from public.app_users), 1, 'Nhân viên chỉ thấy chính mình');
select is((select id from public.app_users), '00000000-0000-0000-0000-0000000000b2'::uuid,
  'Nhân viên xem được hồ sơ của chính mình');
select throws_ok($$ select public.assign_role('00000000-0000-0000-0000-0000000000b2',
  (select id from public.roles where code = 'owner')) $$, '42501', null, 'Nhân viên không tự nâng quyền được');
select throws_ok($$ select public.create_role('sieu_quyen', 'Siêu quyền', array['user.edit']) $$, '42501', null,
  'Nhân viên không tạo được vai trò');
reset role;

-- ---------------------------------------------------------------- Chủ A giao quyền theo phạm vi
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.assign_role('00000000-0000-0000-0000-0000000000b2',
  (select id from public.roles where code = 'branch_manager'), 'branch', (select v from t.ids where k = 'A1')) $$,
  'Chủ A giao quản lý chi nhánh A1 cho nhân viên A2');
select lives_ok($$ select public.assign_role('00000000-0000-0000-0000-0000000000b3',
  (select id from public.roles where code = 'seller'), 'branch', (select v from t.ids where k = 'A1')) $$,
  'Chủ A giao bán vé tại chi nhánh A1 cho nhân viên A3');
select throws_ok($$ select public.assign_role('00000000-0000-0000-0000-0000000000b1',
  (select id from public.roles where code = 'admin')) $$, '42501', null, 'Không tự gán vai trò cho chính mình');
select throws_ok($$ select public.set_user_status('00000000-0000-0000-0000-0000000000b1', 'locked') $$, '42501', null,
  'Không tự khóa tài khoản của mình');
select throws_ok($$ select public.revoke_role((select id from public.user_roles
  where user_id = '00000000-0000-0000-0000-0000000000b1')) $$, '42501', null,
  'Không tự thu hồi vai trò Chủ nhà xe của mình');
select ok((select count(*) from public.audit_logs) > 0, 'Chủ A đọc được nhật ký nhà xe A');
reset role;

-- ---------------------------------------------------------------- Quản lý chi nhánh A1
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select lives_ok($$ insert into public.ticket_offices (branch_id, code, name)
  values ((select v from t.ids where k = 'A1'), 'PV1', 'Phòng vé 1') $$, 'Quản lý A1 tạo phòng vé trong chi nhánh A1');
select throws_ok($$ insert into public.ticket_offices (branch_id, code, name)
  values ((select v from t.ids where k = 'A2'), 'PV2', 'Phòng vé 2') $$, '42501', null,
  'Quản lý A1 không tạo được phòng vé ở chi nhánh A2');
with u as (update public.branches set name = 'Đổi tên' where id = (select v from t.ids where k = 'A1') returning 1)
select is(count(*)::int, 0, 'Quản lý chi nhánh không có quyền sửa thông tin chi nhánh') from u;
select is((select count(*)::int from public.app_users), 2, 'Quản lý A1 thấy mình và nhân viên chi nhánh A1');
select is((select count(*)::int from public.app_users where id = '00000000-0000-0000-0000-0000000000b1'), 0,
  'Quản lý A1 không thấy người ngoài chi nhánh (Chủ A)');
reset role;

-- ---------------------------------------------------------------- Khóa tài khoản
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.set_user_status('00000000-0000-0000-0000-0000000000b2', 'locked') $$,
  'Chủ A khóa tài khoản nhân viên A2');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.branches), 0, 'Tài khoản bị khóa không thấy dữ liệu nhà xe');
reset role;

select * from finish();
rollback;
