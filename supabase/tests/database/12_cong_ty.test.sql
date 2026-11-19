-- Kiểm thử thông tin công ty: logo ai cũng xem, hồ sơ pháp lý chỉ quản trị, chữ ký / con dấu, bỏ ảnh.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'ua2@test.local'),
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
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok(format($$ insert into storage.objects (bucket_id, name) values
  ('giay-to', '%1$s/cong_ty/logo.png'), ('giay-to', '%1$s/cong_ty/ho_so/giay_phep.jpg'), ('giay-to', '%1$s/cong_ty/ho_so/cccd_truoc.jpg'),
  ('giay-to', '%1$s/chu_ky/giam_doc.png'), ('giay-to', '%1$s/chu_ky/con_dau.png') $$, (select v from t.ids where k = 'A')),
  'Quản trị tải logo, giấy phép, CCCD giám đốc, chữ ký, con dấu');
select lives_ok($$ insert into public.tenant_settings (key, value) values ('in.chu_ky_giam_doc', 'true'), ('in.con_dau', 'false') $$,
  'Bật in chữ ký, tắt in con dấu');
select throws_ok($$ insert into public.tenant_settings (key, value) values ('in.chu_ky_giam_doc', '"có"') $$, '22023', null,
  'Bật / tắt phải là true / false');
select is((select count(*)::int from storage.objects where name like '%/cong_ty/%'), 3, 'Quản trị xem được cả hồ sơ');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select array_agg(substr(name, 38)) from storage.objects where name like '%/cong_ty/%'), array['cong_ty/logo.png'],
  'Nhân viên chỉ xem được logo, không xem hồ sơ pháp lý');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('giay-to', '%s/cong_ty/logo2.png') $$,
  (select v from t.ids where k = 'A')), '42501', null, 'Nhân viên không đổi được logo');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('giay-to', '%s/chu_ky/con_dau.png') $$,
  (select v from t.ids where k = 'A')), '42501', null, 'Nhân viên không tải được con dấu');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from storage.objects where bucket_id = 'giay-to'), 0, 'Nhà xe B không thấy logo / hồ sơ nhà xe A');
reset role;

select ok((select count(*) from pg_policies where schemaname = 'storage' and policyname in ('cong_ty_delete', 'chu_ky_delete')) = 2,
  'Có quyền "Bỏ ảnh" (xóa) cho quản trị');

select * from finish();
rollback;
