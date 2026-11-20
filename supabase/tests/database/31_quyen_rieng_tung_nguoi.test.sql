-- Kiểm thử quyền riêng từng người: tích thêm ngoài nhóm, bỏ tích ô của nhóm chỉ riêng người đó, không ảnh hưởng người khác.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'nv1@test.local'), ('00000000-0000-0000-0000-0000000000b4', 'nv2@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select id from public.tenants where code = 'nha-xe-a'), '0900000004', 'Bán vé 1', 'seller') $$, 'Bán vé 1');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b4', (select id from public.tenants where code = 'nha-xe-a'), '0900000005', 'Bán vé 2', 'seller') $$, 'Bán vé 2');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.set_user_permissions('00000000-0000-0000-0000-0000000000b3', array['report.view'], array['sell.delete', 'parcel.view']) $$,
  'Chủ: thêm Báo cáo, bỏ Hủy vé + Xem gửi hàng cho Bán vé 1');
select lives_ok($$ select public.set_user_permissions('00000000-0000-0000-0000-0000000000b3', array['report.view'], array['sell.delete']) $$, 'Lưu lại (thay thế) không lỗi');
select throws_ok($$ select public.set_user_permissions('00000000-0000-0000-0000-0000000000b1', array[]::text[], array['sell.view']) $$, '42501', null, 'Không tự sửa quyền mình');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select ok(app.has_permission('report.view'), 'Bán vé 1 có quyền riêng Báo cáo');
select ok(not app.has_permission('sell.delete'), 'Bán vé 1 bị bỏ ô Hủy vé');
select ok(app.has_permission('sell.add') and app.has_permission('parcel.view'), 'Các ô khác của nhóm vẫn còn (Xem gửi hàng đã bỏ chặn ở lần lưu sau)');
select ok(not exists (select 1 from public.my_permissions() where permission_code = 'sell.delete'), 'Danh sách quyền của tôi không còn ô bị bỏ');
select throws_ok($$ select public.set_user_permissions('00000000-0000-0000-0000-0000000000b4', array['report.view'], array[]::text[]) $$, '42501', null, 'Bán vé không phân quyền người khác');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select ok(app.has_permission('sell.delete') and not app.has_permission('report.view'), 'Bán vé 2 cùng nhóm không bị ảnh hưởng');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.set_user_permissions('00000000-0000-0000-0000-0000000000b4', array[]::text[], array['sell.view']) $$, 'P0002', null, 'Nhà xe B không sửa quyền người của A');
select is((select count(*)::int from public.user_permission_denies), 0, 'Nhà xe B không thấy quyền bị chặn của A');
reset role;
select * from finish();
rollback;
