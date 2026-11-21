-- Kiểm thử tự kiểm tra sự cố + nút xử lý: máy chủ tự đối chiếu quyền, chỉ người quản lý của đúng nhà xe xử lý được.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'bv@test.local'), ('00000000-0000-0000-0000-0000000000b4', 'bv2@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select id from public.tenants where code = 'nha-xe-a'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b4', (select id from public.tenants where code = 'nha-xe-a'), '0900000005', 'Bán vé A2', 'seller') $$, 'Bán vé A2');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

-- 1. Thiếu quyền (vai trò không có)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
create temp table t1 as select public.support_open('Không mở được nhật ký', '{"need":["audit.view","khong.co"],"screen":"Nhật ký"}') id;
select is((select jsonb_array_length(context -> 'checks' -> 'quyen') from public.support_tickets where id = (select id from t1)), 1, 'Bỏ mã quyền không có thật');
select is((select (context -> 'checks' -> 'quyen' -> 0 ->> 'ok') from public.support_tickets where id = (select id from t1)), 'false', 'Máy chủ thấy thiếu quyền');
select ok((select body from public.support_messages where ticket_id = (select id from t1) and sender = 'bot') like '%chưa có quyền "Nhật ký: Xem"%', 'Máy báo thiếu quyền');
select throws_ok(format('select public.support_fix(%L, %L, %L)', (select id from t1), 'cap_quyen', 'audit.view'), 'P0002', null, 'Người gửi không tự cấp quyền');
create temp table t1b as select public.support_open('Vào bán vé bình thường', '{"need":["sell.view"]}') id;
select ok((select body from public.support_messages where ticket_id = (select id from t1b) and sender = 'bot') like '%bình thường%', 'Đủ quyền: báo bình thường');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok(format('select public.support_fix(%L, %L, %L)', (select id from t1), 'cap_quyen', 'audit.view'), 'P0002', null, 'Nhà xe B: không tìm thấy');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok(format('select public.support_fix(%L, %L, %L)', (select id from t1), 'cap_quyen', 'audit.view'), 'Chủ A cấp quyền 1 nút');
select is((select (context -> 'checks' -> 'quyen' -> 0 ->> 'ok') from public.support_tickets where id = (select id from t1)), 'true', 'Kiểm tra lại: đã đủ quyền');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select ok(app.has_permission('audit.view'), 'Bán vé A có quyền Nhật ký: Xem');
select ok(app.has_permission('sell.view'), 'Quyền cũ vẫn giữ');

-- 2. Bị chặn riêng
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.set_user_permissions('00000000-0000-0000-0000-0000000000b4', '{}', '{sell.view}') $$, 'Chặn riêng Bán vé A2');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
create temp table t2 as select public.support_open('Không vào được màn hình đặt vé', '{"need":["sell.view"]}') id;
select is((select (context -> 'checks' -> 'quyen' -> 0 ->> 'chan') from public.support_tickets where id = (select id from t2)), 'true', 'Thấy bị chặn riêng');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok(format('select public.support_fix(%L, %L, %L)', (select id from t2), 'cap_quyen', 'sell.view'), 'Bỏ chặn 1 nút');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select ok(app.has_permission('sell.view'), 'Bán vé A2 vào lại được bán vé');
reset role;
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000000b4' and kind = 'su_co'), 1, 'Người gửi được báo đã xử lý');

-- 3. Màn hình đăng nhập: tài khoản bị khóa
update public.app_users set status = 'locked' where id = '00000000-0000-0000-0000-0000000000b4';
select is(public.svc_support_login('nha-xe-a', '0900000005', 'Không đăng nhập được', '{}', 'h9'), true, 'Nhận sự cố');
select is((select context -> 'checks' ->> 'tai_khoan' from public.support_tickets where channel = 'login'), 'locked', 'Thấy tài khoản bị khóa');
select is(public.svc_support_login('nha-xe-a', '0911111111', 'Không đăng nhập được 2', '{}', 'h9'), true, 'Nhận sự cố số lạ');
select is((select context -> 'checks' ->> 'tai_khoan' from public.support_tickets where channel = 'login' and reporter_phone = '0911111111'), 'khong_co', 'Số chưa có tài khoản');
select is(public.svc_support_login('nha-xe-a', null, 'Không đăng nhập được 3', '{}', 'h9'), true, 'Nhận sự cố không ghi số');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok(format('select public.support_fix(%L, %L)', (select id from public.support_tickets where channel = 'login' and reporter_phone = '0900000005'), 'mo_khoa'),
  'P0002', null, 'Nhà xe B không mở khóa được');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok(format('select public.support_fix(%L, %L)', (select id from public.support_tickets where channel = 'login' and reporter_phone = '0900000005'), 'mo_khoa'), 'Chủ A mở khóa');
select is((select status from public.app_users where id = '00000000-0000-0000-0000-0000000000b4'), 'active', 'Tài khoản đã mở');
select is((select context -> 'checks' ->> 'tai_khoan' from public.support_tickets where channel = 'login' and reporter_phone = '0900000005'), 'active', 'Kiểm tra lại: đang hoạt động');
select throws_ok(format('select public.support_fix(%L, %L, %L)', (select id from public.support_tickets where channel = 'login' and reporter_phone = '0900000005'), 'cap_quyen', 'sell.view'),
  '22023', null, 'Không cấp quyền qua sự cố chưa xác minh');
select throws_ok(format('select public.support_fix(%L, %L)', (select id from public.support_tickets where channel = 'login' and reporter_phone = '0911111111'), 'mo_khoa'),
  '22023', null, 'Số lạ: không có tài khoản để mở');
reset role;
select * from finish();
rollback;
