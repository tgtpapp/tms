-- Kiểm thử sao lưu / khôi phục từng nhà xe: chỉ Chủ nhà xe, chữ ký chống sửa file, chỉ thêm dòng thiếu, không khôi phục sang nhà xe khác.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'bv@test.local'), ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select id from public.tenants where code = 'nha-xe-a'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

select ok(exists (select 1 from app.backup_tables() where tbl = 'staff_members' and restore), 'Nhân viên có trong bản sao lưu');
select ok(exists (select 1 from app.backup_tables() where tbl = 'user_roles' and not restore), 'Phân quyền chỉ xuất, không khôi phục');
select ok(not exists (select 1 from app.backup_tables() where tbl in ('tenant_drive', 'zalo_connections')), 'Bảng chứa mã bí mật không đưa vào file');
select ok((select ord from app.backup_tables() where tbl = 'routes') < (select ord from app.backup_tables() where tbl = 'trips'), 'Bảng cha xếp trước bảng con');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Nguyễn Văn Lưu","joined_on":"2024-01-01","position":"lai_xe"}') $$, 'Nhân viên');
create temp table pg as select public.backup_page('staff_members', null, 1000) p;
select ok((select (p ->> 'rows') like '%Nguyễn Văn Lưu%' from pg), 'Chủ A tải được trang nhân viên');
select ok((select (p ->> 'n')::int >= 1 from pg), 'Có số dòng');
select is(public.restore_page('staff_members', (select p ->> 'rows' from pg), (select p ->> 'sig' from pg)) ->> 'added', '0', 'Khôi phục khi đủ dữ liệu: không thêm, không ghi đè');
select throws_ok(format('select public.restore_page(%L, %L, %L)', 'staff_members', replace((select p ->> 'rows' from pg), 'Nguyễn Văn Lưu', 'Kẻ Giả'), (select p ->> 'sig' from pg)),
  '22023', null, 'File bị sửa: từ chối');
reset role;
delete from public.staff_members where id = '00000000-0000-0000-0000-00000000aa01';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is(public.restore_page('staff_members', (select p ->> 'rows' from pg), (select p ->> 'sig' from pg)) ->> 'added', '1', 'Dòng bị mất được thêm lại');
select is((select full_name from public.staff_members where id = '00000000-0000-0000-0000-00000000aa01'), 'Nguyễn Văn Lưu', 'Đúng dữ liệu cũ');
select is(public.restore_page('user_roles', '[]', 'x') ->> 'added', '0', 'Bảng phân quyền không khôi phục');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select throws_ok($$ select public.backup_page('staff_members', null, 10) $$, '42501', null, 'Bán vé không tải được bản sao lưu');
select throws_ok(format('select public.restore_page(%L, %L, %L)', 'staff_members', (select p ->> 'rows' from pg), (select p ->> 'sig' from pg)), '42501', null, 'Bán vé không khôi phục được');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok(format('select public.restore_page(%L, %L, %L)', 'staff_members', (select p ->> 'rows' from pg), (select p ->> 'sig' from pg)), '22023', null, 'Nhà xe B không khôi phục được file của nhà xe A');
select ok((select (public.backup_page('staff_members', null, 1000) ->> 'rows') not like '%Nguyễn Văn Lưu%'), 'Nhà xe B không tải được dữ liệu nhà xe A');
reset role;
insert into public.tenant_backups (tenant_id, kind, drive_id, file_name) select id, 'dem', 'x', 'a.json.gz' from public.tenants where code = 'nha-xe-a';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.tenant_backups), 0, 'Nhà xe khác không thấy bản sao lưu');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.tenant_backups), 0, 'Bán vé không thấy bản sao lưu');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.tenant_backups), 1, 'Chủ A thấy bản sao lưu của mình');
reset role;
select * from finish();
rollback;
