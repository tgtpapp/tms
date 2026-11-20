-- Kiểm thử Giai đoạn 2.4: cấu hình nhà xe, vai trò tùy chỉnh, nhật ký.
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
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo Super Admin');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;

insert into t.ids select 'A', id from public.tenants where code = 'nha-xe-a';
insert into t.ids select 'B', id from public.tenants where code = 'nha-xe-b';
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Đăng ký người dùng');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Nhân viên A', 'seller') $$, 'Đăng ký người dùng');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select v from t.ids where k = 'B'), '0900000003', 'Chủ B', 'owner') $$, 'Đăng ký người dùng');

-- ---------------------------------------------------------------- Giá trị mặc định
select is((select value from public.tenant_settings where tenant_id = (select v from t.ids where k = 'A')
           and key = 'ban_ve.giu_ghe_quay_phut'), '5'::jsonb, 'Nhà xe mới có sẵn giữ ghế quầy 5 phút');
select is((select value from public.tenant_settings where tenant_id = (select v from t.ids where k = 'A')
           and key = 'ban_ve.giu_ghe_online_phut'), '15'::jsonb, 'Nhà xe mới có sẵn giữ ghế online 15 phút');
select is((select value from public.tenant_settings where tenant_id = (select v from t.ids where k = 'A')
           and key = 'ban_ve.nha_ghe_vexere_gio'), '2'::jsonb, 'Nhà xe mới có sẵn nhả ghế Vexere trước 2 giờ');

-- ---------------------------------------------------------------- Chủ A
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.update_tenant_profile('Nhà xe Thịnh Phát', 'Công ty TNHH Thịnh Phát', '0312345678',
  'GP-01', '2026-06-11', 'Sở Xây dựng Đồng Nai', 'Biên Hòa, Đồng Nai', '0251000000', '031073026942') $$, 'Chủ A sửa thông tin doanh nghiệp');
select is((select transport_license_issuer from public.tenants), 'Sở Xây dựng Đồng Nai', 'Lưu nơi cấp giấy phép kinh doanh vận tải');
select is((select director_id_no from public.tenant_private), '031073026942', 'Chủ xem được số CCCD giám đốc');
select throws_ok($$ select public.update_tenant_profile('X', null, null, null, null, null, null, null, '0310') $$, '22023', null,
  'Số CCCD giám đốc phải đủ 12 số');
select is((select name from public.tenants), 'Nhà xe Thịnh Phát', 'Tên nhà xe đã đổi');
select throws_ok($$ select public.update_tenant_profile('  ', null, null, null, null, null, null, null, null) $$, '22023', null,
  'Không cho để trống tên nhà xe');

select lives_ok($$ update public.tenant_settings set value = '7'::jsonb where key = 'ban_ve.giu_ghe_quay_phut' $$,
  'Chủ A đổi giữ ghế quầy thành 7 phút');
select is((select updated_by from public.tenant_settings where key = 'ban_ve.giu_ghe_quay_phut'),
  '00000000-0000-0000-0000-0000000000b1'::uuid, 'Ghi lại người sửa cấu hình');
select throws_ok($$ update public.tenant_settings set value = '0'::jsonb where key = 'ban_ve.giu_ghe_quay_phut' $$,
  '22023', null, 'Chặn giữ ghế 0 phút');
select throws_ok($$ update public.tenant_settings set value = '"abc"'::jsonb where key = 'ban_ve.giu_ghe_online_phut' $$,
  '22023', null, 'Chặn giá trị không phải số');
select throws_ok($$ update public.tenant_settings set value = '99'::jsonb where key = 'ban_ve.nha_ghe_vexere_gio' $$,
  '22023', null, 'Chặn giờ nhả ghế Vexere quá 48');

select lives_ok($$ select public.create_role('thu_ngan', 'Thu ngân', array['user.view']) $$, 'Chủ A tạo vai trò Thu ngân');
select is((select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id
           where r.code = 'thu_ngan'), 1, 'Vai trò Thu ngân có 1 quyền');
select throws_ok($$ select public.set_role_permissions((select id from public.roles where code = 'owner'), array['user.view']) $$,
  '42501', null, 'Không sửa được quyền của Chủ nhà xe');
select ok((select count(*) from public.audit_logs where entity = 'tenant_settings') > 0, 'Nhật ký ghi lại việc sửa cấu hình');
reset role;

-- ---------------------------------------------------------------- Nhân viên A (bán vé)
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.tenant_private), 0, 'Nhân viên không xem được CCCD giám đốc');
select throws_ok($$ select public.update_tenant_profile('Đổi tên', null, null, null, null, null, null, null, null) $$, '42501', null,
  'Nhân viên không sửa được thông tin doanh nghiệp');
with u as (update public.tenant_settings set value = '60'::jsonb where key = 'ban_ve.giu_ghe_quay_phut' returning 1)
select is(count(*)::int, 0, 'Nhân viên không sửa được cấu hình') from u;
select is((select count(*)::int from public.tenant_settings), 12, 'Nhân viên đọc được cấu hình nhà xe mình');
select is((select count(*)::int from public.audit_logs), 0, 'Nhân viên không có quyền xem nhật ký');
reset role;

-- ---------------------------------------------------------------- Chủ B
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select value from public.tenant_settings where key = 'ban_ve.giu_ghe_quay_phut'), '5'::jsonb,
  'Chủ B thấy cấu hình của nhà xe B (không bị ảnh hưởng bởi nhà xe A)');
select is((select count(*)::int from public.tenant_settings), 12, 'Chủ B chỉ thấy 12 cấu hình của nhà xe B');
select is((select count(*)::int from public.roles where code = 'thu_ngan'), 0, 'Chủ B không thấy vai trò của nhà xe A');
select ok(not exists (select 1 from public.audit_logs where tenant_id = (select v from t.ids where k = 'A')),
  'Chủ B không đọc nhật ký nhà xe A');
with u as (update public.tenant_settings set value = '9'::jsonb
           where tenant_id = (select v from t.ids where k = 'A') returning 1)
select is(count(*)::int, 0, 'Chủ B không sửa được cấu hình nhà xe A') from u;
reset role;

select * from finish();
rollback;
