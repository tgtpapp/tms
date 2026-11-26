-- Kiểm thử Chuyển dữ liệu cũ sang Google Drive (bước 1): chỉ Chủ nhà xe, chỉ dữ liệu cũ hơn 12 tháng,
-- đếm / xuất đúng dữ liệu của nhà xe mình, file có chữ ký gắn khoảng ngày, nhà xe khác không thấy.
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
-- Thông báo, nhật ký cũ (2 năm trước) của 2 nhà xe + 1 thông báo mới của nhà xe A
insert into public.notifications (tenant_id, user_id, kind, title, body, created_at) values
  ((select id from public.tenants where code = 'nha-xe-a'), '00000000-0000-0000-0000-0000000000b2', 'xep_chuyen', 'Cũ A', 'x', now() - interval '2 years'),
  ((select id from public.tenants where code = 'nha-xe-a'), '00000000-0000-0000-0000-0000000000b2', 'xep_chuyen', 'Mới A', 'x', now()),
  ((select id from public.tenants where code = 'nha-xe-b'), '00000000-0000-0000-0000-0000000000c1', 'xep_chuyen', 'Cũ B', 'x', now() - interval '2 years');
insert into public.audit_logs (tenant_id, action, entity, created_at) values
  ((select id from public.tenants where code = 'nha-xe-a'), 'thu', 'x', now() - interval '2 years'),
  ((select id from public.tenants where code = 'nha-xe-a'), 'thu', 'x', now() - interval '2 years');
create temp table r (from_on date, to_on date);
insert into r select (now() - interval '3 years')::date, (now() - interval '13 months')::date;
grant select on r to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$ select public.archive_preview((select from_on from r), (select to_on from r)) $$, '42501', null, 'Lái xe không chuyển dữ liệu được');
select is((select count(*)::int from public.data_archives), 0, 'Lái xe không thấy danh sách đã chuyển');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select public.archive_preview((select from_on from r), current_date) $$, '22023', null, 'Không chuyển dữ liệu chưa đủ 12 tháng');
select throws_ok($$ select public.archive_preview((select to_on from r), (select from_on from r)) $$, '22023', null, 'Khoảng ngày ngược');
select is((public.archive_preview((select from_on from r), (select to_on from r)) ->> 'notifications')::int, 1, 'Chỉ đếm thông báo cũ của nhà xe mình');
select is((public.archive_preview((select from_on from r), (select to_on from r)) ->> 'audit_logs')::int, 2, 'Đếm nhật ký cũ của nhà xe mình');
select is((public.archive_page('notifications', (select from_on from r), (select to_on from r), null, 100) ->> 'n')::int, 1, 'Xuất đúng 1 thông báo');
select ok(public.archive_page('notifications', (select from_on from r), (select to_on from r), null, 100) ->> 'rows' like '%Cũ A%', 'Đúng thông báo cũ của nhà xe A');
select is(length(public.archive_page('notifications', (select from_on from r), (select to_on from r), null, 100) ->> 'sig'), 64, 'Trang dữ liệu có chữ ký');
select throws_ok($$ select public.archive_page('ledger_lines', (select from_on from r), (select to_on from r), null, 100) $$, '22023', null, 'Không xuất sổ cái tiền');
select throws_ok($$ select public.svc_archive_saved(app.current_tenant_id(), auth.uid(), (select from_on from r), (select to_on from r), 'x', 'x', 1, 'x', '{}') $$, '42501', null, 'Trình duyệt không tự ghi danh sách đã chuyển');
reset role;
select lives_ok($$ select public.svc_archive_saved((select id from public.tenants where code = 'nha-xe-a'), '00000000-0000-0000-0000-0000000000b1', (select from_on from r), (select to_on from r),
  'drive-1', 'du-lieu-cu.json.gz', 100, repeat('a', 64), '{"notifications": 1, "audit_logs": 2}') $$, 'Máy chủ ghi lại bản đã đẩy lên Drive');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select row_count from public.data_archives), 3, 'Chủ A thấy bản đã sao lưu (3 dòng)');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.data_archives), 0, 'Chủ B không thấy bản của nhà xe A');
select is((public.archive_preview((select from_on from r), (select to_on from r)) ->> 'audit_logs')::int, 0, 'Chủ B không đếm được nhật ký nhà xe A');
select ok(public.archive_page('notifications', (select from_on from r), (select to_on from r), null, 100) ->> 'rows' not like '%Cũ A%', 'Chủ B không xuất được dữ liệu nhà xe A');
reset role;
select is((select count(*)::int from public.notifications), 3, 'Bước 1 chưa xóa gì khỏi database');
select * from finish();
rollback;
