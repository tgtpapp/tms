-- Kiểm thử "Máy tính chỉ đăng nhập bằng quét mã QR": bật thì phiên mật khẩu trên máy tính (nhóm được chọn) không dùng được dữ liệu,
-- điện thoại vẫn dùng mật khẩu, máy tính vào bằng QR dùng được, lái xe không áp dụng, tạm cho phép 1 ngày, nhà xe khác không ảnh hưởng.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'lx@test.local'), ('00000000-0000-0000-0000-0000000000b3', 'bv@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select id from public.tenants where code = 'nha-xe-a'), '0900000002', 'Lái A', 'driver') $$, 'Lái xe A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select id from public.tenants where code = 'nha-xe-a'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');
insert into auth.sessions (id, user_id, created_at, updated_at, user_agent) values
  ('11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b3', now(), now(), 'Mozilla/5.0 (Linux; Android 14) Chrome/130'),
  ('11111111-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b3', now(), now(), 'Mozilla/5.0 (Windows NT 10.0) Chrome/130'),
  ('11111111-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000b2', now(), now(), 'Mozilla/5.0 (Windows NT 10.0) Chrome/130'),
  ('11111111-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000b1', now(), now(), 'Mozilla/5.0 (Windows NT 10.0) Chrome/130'),
  ('22222222-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', now(), now(), 'Mozilla/5.0 (Windows NT 10.0) Chrome/130');

set local role anon;
select is(public.login_policy('nha-xe-a') ->> 'may_tinh_qr', 'false', 'Mặc định tắt');
reset role;
-- Nhà xe A bật: mọi nhóm trừ Lái xe
insert into public.tenant_settings (tenant_id, key, value) values ((select id from public.tenants where code = 'nha-xe-a'), 'bao_mat.may_tinh_qr',
  '{"on": true, "roles": ["owner", "seller", "office_manager", "dispatcher", "accountant"]}');
set local role anon;
select is(public.login_policy('nha-xe-a') ->> 'may_tinh_qr', 'true', 'Màn đăng nhập biết nhà xe A bật');
select is(public.login_policy('nha-xe-b') ->> 'may_tinh_qr', 'false', 'Nhà xe B không bật');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000001"}';
select is(public.device_hello('dt-ban-ve-0001', 'Chrome · Android'), 'ok', 'Bán vé trên điện thoại: dùng mật khẩu được');
select ok(app.current_tenant_id() is not null, 'Điện thoại thấy dữ liệu nhà xe');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000002"}';
select is(public.device_hello('mt-ban-ve-0002', 'Chrome · Windows', null, null, false), 'chi_qr', 'Bán vé trên máy tính bằng mật khẩu: phải dùng QR (dù app báo là điện thoại)');
select ok(app.current_tenant_id() is null, 'Phiên mật khẩu trên máy tính không thấy dữ liệu');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000003"}';
select is(public.device_hello('mt-lai-xe-0003', 'Chrome · Windows'), 'ok', 'Lái xe không áp dụng');
select ok(app.current_tenant_id() is not null, 'Lái xe trên máy tính vẫn thấy dữ liệu');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","session_id":"22222222-0000-0000-0000-000000000001"}';
select is(public.device_hello('mt-chu-b-0001', 'Chrome · Windows'), 'ok', 'Nhà xe B không ảnh hưởng');

-- Chủ A cho bán vé tạm đăng nhập mật khẩu trên máy tính 1 ngày (Chủ A dùng điện thoại)
reset role;
insert into auth.sessions (id, user_id, created_at, updated_at, user_agent) values
  ('11111111-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000b1', now(), now(), 'Mozilla/5.0 (iPhone) Safari');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000005"}';
select is(public.device_hello('dt-chu-a-0005', 'Safari · iPhone'), 'ok', 'Chủ A trên điện thoại');
select ok(public.allow_desktop_password('00000000-0000-0000-0000-0000000000b3', true) > now(), 'Tạm cho phép 1 ngày');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000002"}';
select ok(app.current_tenant_id() is not null, 'Được tạm cho phép: máy tính dùng được');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000005"}';
select is(public.allow_desktop_password('00000000-0000-0000-0000-0000000000b3', false), null, 'Thôi cho phép');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000002"}';
select ok(app.current_tenant_id() is null, 'Thôi cho phép: máy tính lại bị chặn');
select throws_ok($$ select public.allow_desktop_password('00000000-0000-0000-0000-0000000000b3', true) $$, '42501', null, 'Phiên bị chặn không tự cho phép được');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","session_id":"22222222-0000-0000-0000-000000000001"}';
select throws_ok($$ select public.allow_desktop_password('00000000-0000-0000-0000-0000000000b3', true) $$, 'P0002', null, 'Chủ B không cho phép người nhà xe A');

-- Máy tính vào bằng QR: dùng được
reset role;
insert into auth.sessions (id, user_id, created_at, updated_at, user_agent) values
  ('11111111-0000-0000-0000-000000000006', '00000000-0000-0000-0000-0000000000b3', now(), now(), 'Mozilla/5.0 (Windows NT 10.0) Chrome/130');
insert into public.qr_logins (id, secret_hash, user_id, ok, taken_at) values
  ('44444444-0000-0000-0000-000000000001', encode(extensions.digest('bi-mat-qr', 'sha256'), 'hex'), '00000000-0000-0000-0000-0000000000b3', true, now());
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000006"}';
select is(public.device_hello('mt-ban-ve-0006', 'Chrome · Windows', '44444444-0000-0000-0000-000000000001', 'bi-mat-qr'), 'ok', 'Máy tính vào bằng QR: dùng được');
select ok(app.current_tenant_id() is not null, 'Phiên QR thấy dữ liệu');
reset role;
select is((select via from public.session_devices where session_id = '11111111-0000-0000-0000-000000000006'), 'qr', 'Ghi phiên vào bằng QR');
select * from finish();
rollback;
