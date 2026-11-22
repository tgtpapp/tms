-- Tệp trên Google Drive (bảng file_store): quyền chép đúng từ kho tệp cũ, cách ly nhà xe, ghi tệp cũ vào bảng.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 's1@test.local'),
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
insert into t.ids select 'B', id from public.tenants where code = 'nha-xe-b';
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select v from t.ids where k = 'B'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

select ok((select count(*) from pg_policies where schemaname = 'public' and tablename = 'file_store') >= 10, 'Đã chép đủ quy tắc của kho tệp cũ');

-- Chủ A: lưu logo, chữ ký Giám đốc, con dấu, chữ ký của mình
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok(format($$ insert into public.file_store (tenant_id, name, drive_id) values
  ('%1$s', '%1$s/cong_ty/logo.png', 'd1'), ('%1$s', '%1$s/chu_ky/giam_doc.png', 'd2'), ('%1$s', '%1$s/chu_ky/con_dau.png', 'd3'),
  ('%1$s', '%1$s/chu_ky/00000000-0000-0000-0000-0000000000b1.png', 'd4') $$, (select v from t.ids where k = 'A')), 'Chủ A lưu logo, chữ ký, con dấu');
select lives_ok(format($$ update public.file_store set drive_id = 'd2b' where name = '%s/chu_ky/giam_doc.png' $$, (select v from t.ids where k = 'A')), 'Chủ A thay chữ ký Giám đốc');
select is((select drive_id from public.file_store where name like '%/chu_ky/giam_doc.png'), 'd2b', 'Đã thay');
reset role;

-- Bán vé A: xem được logo, chữ ký Giám đốc, con dấu; không xem chữ ký riêng của người khác; không thay được
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.file_store where name like '%/chu_ky/giam_doc.png' or name like '%/chu_ky/con_dau.png'), 2, 'Nhân viên xem được chữ ký Giám đốc + con dấu (in giấy tờ)');
select is((select count(*)::int from public.file_store where name like '%/chu_ky/00000000-0000-0000-0000-0000000000b1.png'), 1, 'Bán vé có ô Cấp lệnh xem được chữ ký in trên lệnh (như kho cũ)');
select throws_ok(format($$ insert into public.file_store (tenant_id, name, drive_id) values ('%1$s', '%1$s/cong_ty/giay_phep.jpg', 'x') $$,
  (select v from t.ids where k = 'A')), '42501', null, 'Bán vé không lưu được tệp công ty');
update public.file_store set drive_id = 'hack' where name like '%/chu_ky/giam_doc.png';
delete from public.file_store where name like '%/cong_ty/logo.png';
reset role;
select is((select drive_id from public.file_store where name like '%/chu_ky/giam_doc.png'), 'd2b', 'Bán vé không thay được chữ ký Giám đốc');
select is((select count(*)::int from public.file_store where name like '%/cong_ty/logo.png'), 1, 'Bán vé không xóa được logo');

-- Nhà xe B: không thấy, không ghi được tệp của nhà xe A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.file_store), 0, 'Nhà xe B không thấy tệp nhà xe A');
select throws_ok(format($$ insert into public.file_store (tenant_id, name, drive_id) values ('%1$s', '%1$s/cong_ty/logo.png', 'x') $$,
  (select v from t.ids where k = 'A')), '42501', null, 'Nhà xe B không ghi được vào nhà xe A');
select throws_ok(format($$ insert into public.file_store (tenant_id, name, drive_id) values ('%1$s', '%2$s/cong_ty/logo.png', 'x') $$,
  (select v from t.ids where k = 'B'), (select v from t.ids where k = 'A')), null, null, 'Tên tệp phải nằm trong thư mục nhà xe của mình');
delete from public.file_store;
select throws_ok($$ select public.svc_file_backfill(null) $$, '42501', null, 'Người dùng không gọi được hàm nội bộ');
reset role;
select is((select count(*)::int from public.file_store where tenant_id = (select v from t.ids where k = 'A')), 4, 'Nhà xe B không xóa được tệp nhà xe A');

-- Tệp ở kho cũ (vd app bản cũ tải lên) được ghi vào bảng, chờ chuyển lên Drive
insert into storage.objects (bucket_id, name, metadata) values ('giay-to', (select v from t.ids where k = 'A') || '/xe/abc/XE_dang_ky_1.jpg', '{"size": 1234, "mimetype": "image/jpeg"}');
select is(public.svc_file_backfill((select v from t.ids where k = 'A')), 1, 'Ghi 1 tệp cũ vào bảng');
select is((select drive_id from public.file_store where name like '%/xe/abc/XE_dang_ky_1.jpg'), null, 'Tệp cũ chưa có mã Drive (chờ chuyển)');
select is((select size_bytes from public.file_store where name like '%/xe/abc/XE_dang_ky_1.jpg'), 1234::bigint, 'Ghi đúng dung lượng');
select is(public.svc_file_backfill((select v from t.ids where k = 'A')), 0, 'Chạy lại không ghi trùng');

select * from finish();
rollback;
