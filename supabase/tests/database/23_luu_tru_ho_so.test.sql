-- Kiểm thử Lưu trữ hồ sơ: thư mục nhiều cấp theo năm, hồ sơ tệp / liên kết, trùng tên, chuyển vòng, phân quyền, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'dh@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'bv@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
create schema t;
create table t.ids (k text primary key, v uuid not null);
grant usage on schema t to authenticated;
grant select on t.ids to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
insert into t.ids select 'A', id from public.tenants where code = 'nha-xe-a';
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Điều hành A', 'dispatcher') $$, 'Điều hành A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select v from t.ids where k = 'A'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

-- Chủ A: tạo năm + thư mục + hồ sơ
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ insert into public.archive_folders (name) values ('2026') $$, 'Tạo năm 2026');
select lives_ok($$ insert into public.archive_folders (parent_id, name) select id, '01. Pháp lý công ty' from public.archive_folders where name = '2026' $$, 'Thư mục con');
select lives_ok($$ insert into public.archive_folders (parent_id, name) select id, 'Giấy phép' from public.archive_folders where name = '01. Pháp lý công ty' $$, 'Thư mục cấp 3');
select throws_ok($$ insert into public.archive_folders (parent_id, name) select id, '01. pháp lý công ty ' from public.archive_folders where name = '2026' $$,
  '23505', null, 'Trùng tên thư mục cùng cấp bị chặn');
select throws_ok($$ update public.archive_folders set parent_id = (select id from public.archive_folders where name = 'Giấy phép') where name = '2026' $$,
  '22023', null, 'Không chuyển thư mục vào thư mục con của nó');
select lives_ok($$ insert into public.archive_items (folder_id, kind, name, url, expires_on)
  select id, 'link', 'Giấy phép KDVT', 'https://drive.google.com/x', current_date + 20 from public.archive_folders where name = 'Giấy phép' $$, 'Thêm hồ sơ liên kết có hạn');
select lives_ok($$ insert into public.archive_items (folder_id, kind, name, drive_id, drive_url, file_name, mime, size_bytes)
  select id, 'file', 'Đăng ký kinh doanh', 'abc123', 'https://drive.google.com/file/d/abc123', 'dkkd.pdf', 'application/pdf', 1000
  from public.archive_folders where name = 'Giấy phép' $$, 'Thêm hồ sơ tệp (Drive)');
select throws_ok($$ insert into public.archive_items (kind, name) values ('file', 'Thiếu tệp') $$, '23514', null, 'Hồ sơ tệp phải có mã tệp Drive');
-- Kết nối Drive: lưu được, không đọc lại mã
select throws_ok($$ select public.save_drive_config('https://evil.example.com/exec', '123456') $$, '22023', null, 'Địa chỉ phải là Apps Script');
select lives_ok($$ select public.save_drive_config('https://script.google.com/macros/s/AKfy/exec', 'ma-bi-mat') $$, 'Lưu kết nối Drive');
select is(public.drive_status() ->> 'configured', 'true', 'Đã cấu hình Drive');
select throws_ok($$ select * from public.tenant_drive $$, '42501', null, 'Trình duyệt không đọc được mã kết nối');
select throws_ok($$ insert into public.archive_items (kind, name, url) values ('link', 'Sai', 'javascript:alert(1)') $$, '23514', null, 'Liên kết phải là http(s)');
select lives_ok($$ update public.archive_items set is_old = true where name = 'Đăng ký kinh doanh' $$, 'Đánh dấu bản cũ');
reset role;

-- Điều hành A: chỉ xem
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.archive_folders), 3, 'Điều hành xem được thư mục');
select is((select count(*)::int from public.archive_items), 2, 'Điều hành xem được hồ sơ');
select throws_ok($$ insert into public.archive_folders (name) values ('2027') $$, '42501', null, 'Điều hành không thêm được');
select throws_ok($$ select public.save_drive_config('https://script.google.com/macros/s/X/exec', '123456') $$, '42501', null, 'Điều hành không cấu hình Drive được');
select is((with u as (delete from public.archive_items returning 1) select count(*)::int from u), 0, 'Điều hành không xóa được');
reset role;

-- Bán vé A: không có quyền
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.archive_folders), 0, 'Bán vé không thấy lưu trữ');
reset role;

-- Nhà xe B
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.archive_folders), 0, 'Nhà xe B không thấy thư mục của A');
select is((select count(*)::int from public.archive_items), 0, 'Nhà xe B không thấy hồ sơ của A');
select is((with u as (update public.archive_folders set name = 'Hack' returning 1) select count(*)::int from u), 0, 'Nhà xe B không sửa được');
select lives_ok($$ insert into public.archive_folders (name) values ('2026') $$, 'Nhà xe B có năm 2026 riêng (không trùng với A)');
select is(public.drive_status() ->> 'configured', 'false', 'Nhà xe B chưa có kết nối Drive của A');
reset role;

-- Chủ A xóa năm: xóa luôn thư mục con và hồ sơ bên trong
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ delete from public.archive_folders where name = '2026' $$, 'Xóa năm 2026');
select is((select count(*)::int from public.archive_items), 0, 'Hồ sơ bên trong đã xóa theo');
reset role;

select * from finish();
rollback;
