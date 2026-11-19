-- Kiểm thử nhập dữ liệu app cũ: import_document (cho phép chưa có tệp, không đè giấy hiện hành, chống trùng, phân quyền, cô lập nhà xe).
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'ua2@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'ua3@test.local'),
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
insert into t.ids values ('S1', '33333333-3333-3333-3333-333333333331'), ('S2', '33333333-3333-3333-3333-333333333332');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select v from t.ids where k = 'A'), '0900000004', 'Lái xe Tài', 'driver') $$, 'Lái xe A có tài khoản');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select v from t.ids where k = 'B'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');


set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'S1'), jsonb_build_object(
  'full_name', 'Nguyễn Văn Tài', 'position', 'lai_xe', 'joined_on', '2020-03-15')) $$, 'Nhân viên từ app cũ');
select isnt(public.import_document('nhan_su', (select v from t.ids where k = 'S1'), 'gplx', 'AB123456', 'Sở GTVT Đồng Nai', '2020-01-01',
  null, '2030-01-01', '{"hang": "D"}', '{}', 'Nhập từ app cũ', '44444444-4444-4444-4444-444444444441'), null,
  'Nhập giấy phép lái xe chưa có ảnh');
select is(public.import_document('nhan_su', (select v from t.ids where k = 'S1'), 'gplx', 'AB123456', null, null,
  null, null, null, '{}', null, '44444444-4444-4444-4444-444444444441'),
  (select id from public.documents where request_id = '44444444-4444-4444-4444-444444444441'), 'Nhập lại cùng khóa: trả bản cũ');
select is(public.import_document('nhan_su', (select v from t.ids where k = 'S1'), 'gplx', 'XYZ', null, null,
  null, null, null, '{}', null, '44444444-4444-4444-4444-444444444442'), null, 'Đã có giấy hiện hành: không nhập đè');
select is((select count(*)::int from public.documents where doc_type = 'gplx'), 1, 'Chỉ có 1 giấy phép lái xe');
select throws_ok($$ select public.import_document('nhan_su', (select v from t.ids where k = 'S1'), 'kiem_dinh', null, null, null,
  null, null, null, '{}', null, '44444444-4444-4444-4444-444444444443') $$, '22023', null, 'Sai loại giấy theo chủ');
select throws_ok($$ select public.import_document('nhan_su', (select v from t.ids where k = 'S1'), 'cccd', null, null, null,
  null, null, null, array['khac/nhan_su/x/a.jpg'], null, '44444444-4444-4444-4444-444444444444') $$, '22023', null, 'Tệp không thuộc nhân viên này');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$ select public.import_document('nhan_su', (select v from t.ids where k = 'S1'), 'cccd', null, null, null,
  null, null, null, '{}', null, '44444444-4444-4444-4444-444444444445') $$, '42501', null, 'Nhân viên bán vé không nhập được');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.import_document('nhan_su', (select v from t.ids where k = 'S1'), 'cccd', null, null, null,
  null, null, null, '{}', null, '44444444-4444-4444-4444-444444444446') $$, 'P0002', null, 'Chủ B nhập vào nhân viên nhà xe A: không tìm thấy');
reset role;

select * from finish();
rollback;
