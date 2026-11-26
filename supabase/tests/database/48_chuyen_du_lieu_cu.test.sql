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

-- Bước 2: xóa khỏi database sau khi khớp Drive
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$ select public.archive_move((select id from public.data_archives limit 1), repeat('a', 64)) $$, '42501', null, 'Lái xe không xóa được');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
reset role;
create temp table aid as select id from public.data_archives;
grant select on aid to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.archive_move((select id from aid), repeat('a', 64)) $$, 'P0002', null, 'Chủ B không xóa được bản của nhà xe A');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select public.archive_move((select id from aid), repeat('b', 64)) $$, '22023', null, 'File trên Drive không khớp: không xóa');
reset role;
insert into public.audit_logs (tenant_id, action, entity, created_at) values ((select id from public.tenants where code = 'nha-xe-a'), 'thu', 'x', now() - interval '2 years');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select public.archive_move((select id from aid), repeat('a', 64)) $$, '22023', null, 'Dữ liệu đổi sau khi sao lưu: không xóa');
reset role;
delete from public.audit_logs where id = (select max(id) from public.audit_logs where entity = 'x');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
reset role;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
create temp table pg as select t, public.archive_page(t, (select from_on from r), (select to_on from r), null, 100) p from unnest(array['notifications', 'audit_logs']) t;
grant select on pg to authenticated;
set local role authenticated;
select lives_ok($$ select public.archive_move((select id from aid), repeat('a', 64)) $$, 'Khớp Drive + đúng số dòng: chuyển được');
select is((select status from public.data_archives), 'da_chuyen', 'Đánh dấu đã chuyển');
select throws_ok($$ select public.archive_move((select id from aid), repeat('a', 64)) $$, '22023', null, 'Không chuyển lần 2');
reset role;
select is((select count(*)::int from public.notifications where title = 'Cũ A'), 0, 'Đã xóa thông báo cũ của nhà xe A');
select is((select count(*)::int from public.notifications where title in ('Mới A', 'Cũ B')), 2, 'Giữ thông báo mới và dữ liệu nhà xe B');
select is((select count(*)::int from public.audit_logs where entity = 'x'), 0, 'Đã xóa nhật ký cũ');
select is((select count(*)::int from public.audit_logs where action = 'chuyen_du_lieu'), 1, 'Ghi 1 dòng nhật ký tổng, không ghi từng dòng bị xóa');

-- Bước 3: phục hồi
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.archive_restore_page((select id from aid), 'notifications', (select p ->> 'rows' from pg where t = 'notifications'), (select p ->> 'sig' from pg where t = 'notifications')) $$,
  'P0002', null, 'Chủ B không phục hồi được bản của nhà xe A');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select public.archive_restore_page((select id from aid), 'notifications', replace((select p ->> 'rows' from pg where t = 'notifications'), 'Cũ A', 'Sửa'), (select p ->> 'sig' from pg where t = 'notifications')) $$,
  '22023', null, 'File bị sửa: từ chối');
select is((public.archive_restore_page((select id from aid), 'notifications', (select p ->> 'rows' from pg where t = 'notifications'), (select p ->> 'sig' from pg where t = 'notifications')) ->> 'added')::int, 1, 'Phục hồi thông báo');
select is((public.archive_restore_page((select id from aid), 'notifications', (select p ->> 'rows' from pg where t = 'notifications'), (select p ->> 'sig' from pg where t = 'notifications')) ->> 'added')::int, 0, 'Nạp lại lần 2 không tạo trùng');
select is((public.archive_restore_page((select id from aid), 'audit_logs', (select p ->> 'rows' from pg where t = 'audit_logs'), (select p ->> 'sig' from pg where t = 'audit_logs')) ->> 'added')::int, 2, 'Phục hồi nhật ký (giữ mã cũ)');
select lives_ok($$ select public.archive_restored((select id from aid), 3, 0) $$, 'Đánh dấu đã phục hồi');
select is((select status from public.data_archives), 'da_phuc_hoi', 'Trạng thái đã phục hồi');
select throws_ok($$ select public.archive_restore_page((select id from aid), 'notifications', (select p ->> 'rows' from pg where t = 'notifications'), (select p ->> 'sig' from pg where t = 'notifications')) $$,
  '22023', null, 'Bản đã phục hồi không nạp lại');
reset role;
select is((select count(*)::int from public.notifications where title = 'Cũ A'), 1, 'Thông báo cũ đã trở lại');
select is((select count(*)::int from public.audit_logs where entity = 'x'), 2, 'Nhật ký cũ đã trở lại');
select * from finish();
rollback;
