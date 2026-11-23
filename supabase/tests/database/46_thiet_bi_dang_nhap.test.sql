-- Kiểm thử Quản lý thiết bị đăng nhập + duyệt thiết bị lạ + đăng nhập bằng mã QR:
-- chỉ thấy / đăng xuất thiết bị của mình; thiết bị lạ chưa duyệt không thấy dữ liệu nhà xe; lái xe không phải duyệt; QR một lần.
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
insert into auth.sessions (id, user_id, created_at, updated_at, user_agent, ip) values
  ('11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', now() - interval '2 days', now(), 'Mozilla/5.0 (Linux; Android 14) Chrome/130', '1.2.3.4'),
  ('11111111-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day', now(), 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', '5.6.7.8'),
  ('11111111-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day', now(), 'Mozilla/5.0 (Macintosh) Safari', '5.6.7.9'),
  ('22222222-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', now(), now(), 'Mozilla/5.0 (iPhone) Safari', '9.9.9.9'),
  ('33333333-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b2', now(), now(), 'Mozilla/5.0 (Linux; Android 13) Chrome/130', '7.7.7.7'),
  ('33333333-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b2', now(), now(), 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', '7.7.7.8');

-- ---------------------------------------------------------------- Thiết bị đầu tiên: quen ngay
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000001"}';
select is(public.device_hello('dien-thoai-0001', 'Chrome · Android'), 'ok', 'Thiết bị đầu tiên được dùng ngay');
select isnt(app.current_tenant_id(), null, 'Thấy nhà xe của mình');
reset role;

-- ---------------------------------------------------------------- Máy tính lạ: phải chờ duyệt
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000002"}';
select is(public.device_hello('may-tinh-0002', 'Chrome · Windows'), 'cho_duyet', 'Máy tính lạ đăng nhập bằng mật khẩu: chờ duyệt');
select is(app.current_tenant_id(), null, 'Chưa duyệt: không thuộc nhà xe nào');
select is((select count(*)::int from public.roles), 0, 'Chưa duyệt: không đọc được dữ liệu nhà xe');
select throws_ok($$ select public.approve_device('11111111-0000-0000-0000-000000000002', true) $$, '42501', null, 'Thiết bị chưa duyệt không tự duyệt mình');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","session_id":"22222222-0000-0000-0000-000000000001"}';
select is((select count(*)::int from public.pending_devices()), 0, 'Chủ nhà xe khác không thấy thiết bị chờ duyệt');
select throws_ok($$ select public.approve_device('11111111-0000-0000-0000-000000000002', true) $$, 'P0002', null, 'Chủ nhà xe khác không duyệt được');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000001"}';
select is((select name from public.pending_devices()), 'Chrome · Windows', 'Điện thoại thấy máy tính chờ duyệt');
select lives_ok($$ select public.approve_device('11111111-0000-0000-0000-000000000002', true) $$, 'Cho phép máy tính');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000002"}';
select is(public.device_hello('may-tinh-0002', 'Chrome · Windows'), 'ok', 'Đã duyệt: dùng được');
select isnt(app.current_tenant_id(), null, 'Đã duyệt: thấy nhà xe');
reset role;

-- ---------------------------------------------------------------- Quản lý thiết bị, đăng xuất
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000001"}';
select is((select count(*)::int from public.my_sessions()), 3, 'Thấy 3 thiết bị của mình, không thấy của người khác');
select is((select id from public.my_sessions() where is_current), '11111111-0000-0000-0000-000000000001'::uuid, 'Đánh dấu thiết bị đang dùng');
select ok(public.session_alive(), 'Thiết bị đang dùng còn đăng nhập');
select lives_ok($$ select public.sign_out_session('11111111-0000-0000-0000-000000000002') $$, 'Đăng xuất máy tính');
select is((select count(*)::int from public.trusted_devices where device_id = 'may-tinh-0002'), 0, 'Máy tính bị đăng xuất hết là thiết bị quen');
select throws_ok($$ select public.sign_out_session('22222222-0000-0000-0000-000000000001') $$, 'P0002', null, 'Không đăng xuất được thiết bị của người khác');
select is(public.sign_out_other_sessions(), 1, 'Đăng xuất tất cả thiết bị khác (còn 1)');
select is((select count(*)::int from public.my_sessions()), 1, 'Chỉ còn thiết bị đang dùng');
reset role;
select is((select count(*)::int from auth.sessions where user_id = '00000000-0000-0000-0000-0000000000c1'), 1, 'Phiên của người khác còn nguyên');

-- Máy tính đăng nhập lại bằng mật khẩu đã lưu: lại phải chờ duyệt
insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('11111111-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000b1', now(), now()),
  ('11111111-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000b1', now(), now());
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000004"}';
select is(public.device_hello('may-tinh-0002', 'Chrome · Windows'), 'cho_duyet', 'Máy đã bị đăng xuất, vào lại bằng mật khẩu đã lưu: phải duyệt lại');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000002"}';
select ok(not public.session_alive(), 'Thiết bị bị đăng xuất: phiên không còn');
reset role;

-- ---------------------------------------------------------------- Lái xe không phải duyệt
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated","session_id":"33333333-0000-0000-0000-000000000001"}';
select is(public.device_hello('lx-dien-thoai-1', 'Chrome · Android'), 'ok', 'Lái xe: thiết bị đầu');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated","session_id":"33333333-0000-0000-0000-000000000002"}';
select is(public.device_hello('lx-may-tinh-2', 'Chrome · Windows'), 'ok', 'Lái xe đăng nhập thiết bị khác không phải duyệt');
reset role;

-- ---------------------------------------------------------------- Đăng nhập máy tính bằng mã QR
set local role anon;
select set_config('t.qr', public.qr_start('Edge · Windows')::text, true);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000004"}';
select throws_ok($$ select public.qr_approve((current_setting('t.qr')::jsonb ->> 'id')::uuid, true) $$, '42501', null, 'Thiết bị chưa duyệt không đồng ý QR được');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000001"}';
select is(public.qr_info((current_setting('t.qr')::jsonb ->> 'id')::uuid) ->> 'name', 'Edge · Windows', 'Điện thoại thấy máy xin đăng nhập');
select lives_ok($$ select public.qr_approve((current_setting('t.qr')::jsonb ->> 'id')::uuid, true) $$, 'Điện thoại đồng ý');
reset role;
set local role service_role;
select is(public.svc_qr_take((current_setting('t.qr')::jsonb ->> 'id')::uuid, 'sai') ->> 'status', 'khong_thay', 'Sai mã bí mật: không cấp');
select is(public.svc_qr_take((current_setting('t.qr')::jsonb ->> 'id')::uuid, current_setting('t.qr')::jsonb ->> 'secret') ->> 'email', 'ua@test.local', 'Cấp đăng nhập đúng tài khoản');
select is(public.svc_qr_take((current_setting('t.qr')::jsonb ->> 'id')::uuid, current_setting('t.qr')::jsonb ->> 'secret') ->> 'status', 'het_han', 'Mã QR chỉ dùng 1 lần');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000005"}';
select is(public.device_hello('may-tinh-qr-05', 'Edge · Windows', (current_setting('t.qr')::jsonb ->> 'id')::uuid, current_setting('t.qr')::jsonb ->> 'secret'), 'ok',
  'Máy tính vào bằng QR: được dùng ngay');
reset role;

set local role anon;
select throws_ok($$ select public.my_sessions() $$, '42501', null, 'Chưa đăng nhập không gọi được');
reset role;

select * from finish();
rollback;
