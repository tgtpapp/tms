-- Kiểm thử người lập lý lịch hành nghề khi lái xe tự xem: người quản lý cập nhật hồ sơ gần nhất (không phải lái xe), chưa có thì Chủ nhà xe;
-- lái xe chỉ hỏi được của chính mình, đọc được chữ ký đúng người lập; nhà xe khác không thấy.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'lx@test.local'), ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select id from public.tenants where code = 'nha-xe-a'), '0900000002', 'Lái A', 'driver') $$, 'Lái xe A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');
insert into public.staff_members (id, tenant_id, full_name, joined_on, position, user_id) values
  ('00000000-0000-0000-0000-00000000aa01', (select id from public.tenants where code = 'nha-xe-a'), 'Lái A', '2024-01-01', 'lai_xe', '00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-00000000aa02', (select id from public.tenants where code = 'nha-xe-a'), 'Lái Khác', '2024-01-01', 'lai_xe', null);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is(public.paper_maker('00000000-0000-0000-0000-00000000aa01') ->> 'user_id', '00000000-0000-0000-0000-0000000000b1', 'Chưa ai cập nhật: người lập là Chủ nhà xe');
select throws_ok($$ select public.paper_maker('00000000-0000-0000-0000-00000000aa02') $$, 'P0002', null, 'Lái xe không hỏi người lập của người khác');
select ok('00000000-0000-0000-0000-0000000000b1.png' = any (app.my_paper_maker_files()), 'Lái xe được đọc chữ ký người lập');
select ok(not ('00000000-0000-0000-0000-0000000000c1.png' = any (app.my_paper_maker_files())), 'Không đọc chữ ký người khác');
reset role;
-- Lái xe tự sửa hồ sơ của mình: không tính là người lập
insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id) values
  ((select id from public.tenants where code = 'nha-xe-a'), '00000000-0000-0000-0000-0000000000b2', 'update', 'staff_members', '00000000-0000-0000-0000-00000000aa01');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is(public.paper_maker('00000000-0000-0000-0000-00000000aa01') ->> 'user_id', '00000000-0000-0000-0000-0000000000b1', 'Lái xe tự sửa: người lập vẫn không phải lái xe');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.paper_maker('00000000-0000-0000-0000-00000000aa01') $$, 'P0002', null, 'Chủ B không thấy người lập của nhà xe A');
reset role;
select * from finish();
rollback;
