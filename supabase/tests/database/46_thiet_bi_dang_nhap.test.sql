-- Kiểm thử Quản lý thiết bị đăng nhập: chỉ thấy / đăng xuất thiết bị của chính mình; đăng xuất thiết bị khác giữ thiết bị đang dùng.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'), ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
insert into auth.sessions (id, user_id, created_at, updated_at, user_agent, ip) values
  ('11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', now() - interval '2 days', now(), 'Mozilla/5.0 (Linux; Android 14) Chrome/130', '1.2.3.4'),
  ('11111111-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day', now(), 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', '5.6.7.8'),
  ('11111111-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day', now(), 'Mozilla/5.0 (Macintosh) Safari', '5.6.7.9'),
  ('22222222-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', now(), now(), 'Mozilla/5.0 (iPhone) Safari', '9.9.9.9');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000001"}';
select is((select count(*)::int from public.my_sessions()), 3, 'Thấy 3 thiết bị của mình, không thấy của người khác');
select is((select id from public.my_sessions() where is_current), '11111111-0000-0000-0000-000000000001'::uuid, 'Đánh dấu thiết bị đang dùng');
select ok(public.session_alive(), 'Thiết bị đang dùng còn đăng nhập');
select lives_ok($$ select public.sign_out_session('11111111-0000-0000-0000-000000000002') $$, 'Đăng xuất máy Windows');
select throws_ok($$ select public.sign_out_session('22222222-0000-0000-0000-000000000001') $$, 'P0002', null, 'Không đăng xuất được thiết bị của người khác');
select is(public.sign_out_other_sessions(), 1, 'Đăng xuất tất cả thiết bị khác (còn 1)');
select is((select count(*)::int from public.my_sessions()), 1, 'Chỉ còn thiết bị đang dùng');
reset role;
select is((select count(*)::int from auth.sessions where user_id = '00000000-0000-0000-0000-0000000000c1'), 1, 'Phiên của người khác còn nguyên');

-- Thiết bị đã bị đăng xuất từ máy khác: tự biết để thoát
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","session_id":"11111111-0000-0000-0000-000000000002"}';
select ok(not public.session_alive(), 'Thiết bị bị đăng xuất: phiên không còn');
reset role;
set local role anon;
select throws_ok($$ select public.my_sessions() $$, '42501', null, 'Chưa đăng nhập không gọi được');
reset role;

select * from finish();
rollback;
