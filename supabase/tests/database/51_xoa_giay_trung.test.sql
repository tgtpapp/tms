-- Kiểm thử xóa giấy / dòng lý lịch trùng: chỉ xóa được bản trùng, giấy duy nhất và bản đang dùng không xóa; cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Lái Một","joined_on":"2020-01-01","position":"lai_xe"}') $$, 'Hồ sơ lái xe');
reset role;
-- giấy tập huấn ở mục Giấy tờ + dòng lý lịch cùng số GCN (trùng) + dòng lý lịch khác (không trùng)
insert into public.documents (id, tenant_id, owner_kind, staff_id, doc_type, doc_no, issued_on, expires_on, is_current, files) values
  ('00000000-0000-0000-0000-0000000dd001', (select id from public.tenants where code = 'nha-xe-a'), 'nhan_su', '00000000-0000-0000-0000-00000000aa01', 'tap_huan', '0005902', '2025-08-27', '2028-08-27', true, '{}'),
  ('00000000-0000-0000-0000-0000000dd002', (select id from public.tenants where code = 'nha-xe-a'), 'nhan_su', '00000000-0000-0000-0000-00000000aa01', 'tap_huan', '0005902', '2025-08-27', '2028-08-27', false, '{}'),
  ('00000000-0000-0000-0000-0000000dd003', (select id from public.tenants where code = 'nha-xe-a'), 'nhan_su', '00000000-0000-0000-0000-00000000aa01', 'tap_huan', '0001111', '2022-01-01', '2025-01-01', false, '{}');
insert into public.staff_records (id, tenant_id, staff_id, kind, occurred_on, title, data) values
  ('00000000-0000-0000-0000-0000000ee001', (select id from public.tenants where code = 'nha-xe-a'), '00000000-0000-0000-0000-00000000aa01', 'dao_tao', '2025-08-26', 'Tập huấn nghiệp vụ · GCN số 0005902', '{}'),
  ('00000000-0000-0000-0000-0000000ee002', (select id from public.tenants where code = 'nha-xe-a'), '00000000-0000-0000-0000-00000000aa01', 'vi_pham', '2024-01-01', 'Vượt tốc độ', '{}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.delete_duplicate_paper('ly_lich', '00000000-0000-0000-0000-0000000ee001') $$, 'P0002', null, 'Nhà xe B không xóa được lý lịch của A');
select throws_ok($$ select public.delete_duplicate_paper('giay_to', '00000000-0000-0000-0000-0000000dd002') $$, 'P0002', null, 'Nhà xe B không xóa được giấy của A');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select public.delete_duplicate_paper('ly_lich', '00000000-0000-0000-0000-0000000ee002') $$, '22023', null, 'Dòng lý lịch không trùng: không xóa');
select throws_ok($$ select public.delete_duplicate_paper('giay_to', '00000000-0000-0000-0000-0000000dd001') $$, '22023', null, 'Bản đang dùng: không xóa');
select throws_ok($$ select public.delete_duplicate_paper('giay_to', '00000000-0000-0000-0000-0000000dd003') $$, '22023', null, 'Bản cũ không trùng: không xóa');
select lives_ok($$ select public.delete_duplicate_paper('ly_lich', '00000000-0000-0000-0000-0000000ee001') $$, 'Xóa dòng lý lịch trùng giấy tập huấn');
select lives_ok($$ select public.delete_duplicate_paper('giay_to', '00000000-0000-0000-0000-0000000dd002') $$, 'Xóa bản cũ trùng bản đang dùng');
select is((select count(*)::int from public.documents where staff_id = '00000000-0000-0000-0000-00000000aa01'), 2, 'Còn bản đang dùng + bản cũ khác');
select is((select count(*)::int from public.staff_records where staff_id = '00000000-0000-0000-0000-00000000aa01'), 1, 'Còn dòng lý lịch không trùng');
reset role;
select * from finish();
