-- Kiểm thử Giai đoạn 3.3a: lái xe / nhân viên, thông tin cá nhân bảo mật, giấy tờ cá nhân (CCCD 2 mặt),
-- chính người đó xem được của mình, nhật ký không chép dữ liệu nhạy cảm, cô lập nhà xe.
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

-- ---------------------------------------------------------------- Chủ A tạo hồ sơ
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ select public.save_staff((select v from t.ids where k = 'S1'), '{"full_name": "Nguyễn Văn Tài"}') $$,
  '22023', null, 'Bắt buộc ngày vào công ty');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'S1'), jsonb_build_object(
  'full_name', 'Nguyễn Văn Tài', 'position', 'lai_xe', 'phone', '0900000004', 'joined_on', '2020-03-15',
  'user_id', '00000000-0000-0000-0000-0000000000b3', 'birth_date', '1980-05-20', 'gender', 'nam',
  'address', 'Số 1 Đường A, Biên Hòa', 'contract_type', 'khong_xac_dinh')) $$, 'Chủ A thêm lái xe có liên kết tài khoản');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'S2'), jsonb_build_object(
  'full_name', 'Trần Văn Phụ', 'position', 'phu_xe', 'joined_on', '2024-01-02', 'birth_date', '1995-01-01')) $$,
  'Chủ A thêm phụ xe');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'S2'), jsonb_build_object(
  'full_name', 'Trần Văn Phụ', 'position', 'phu_xe', 'joined_on', '2024-01-02', 'left_on', '2026-10-01', 'is_active', false)) $$,
  'Lưu lại cùng mã thì cập nhật (cho nghỉ việc), không tạo trùng');
select is((select count(*)::int from public.staff_members), 2, 'Có 2 người');
select is((select is_active from public.staff_members where id = (select v from t.ids where k = 'S2')), false, 'Phụ xe đã nghỉ');
select throws_ok($$ select public.save_staff(gen_random_uuid(), jsonb_build_object('full_name', 'X', 'joined_on', '2026-01-01',
  'user_id', '00000000-0000-0000-0000-0000000000b3')) $$, '23505', null, 'Một tài khoản chỉ liên kết 1 hồ sơ');

-- Giấy tờ cá nhân: CCCD 2 mặt
select lives_ok(format($$ insert into storage.objects (bucket_id, name) values
  ('giay-to', '%1$s/nhan_su/%2$s/NGUYENVANTAI_cccd_1.jpg'), ('giay-to', '%1$s/nhan_su/%2$s/NGUYENVANTAI_cccd_2.jpg') $$,
  (select v from t.ids where k = 'A'), (select v from t.ids where k = 'S1')), 'Chủ A tải 2 mặt CCCD');
select throws_ok(format($$ select public.add_staff_document('%1$s', 'cccd', '07912345', null, null, null, '2040-05-20', '{}',
  array['%2$s/nhan_su/%1$s/NGUYENVANTAI_cccd_1.jpg'], null, null) $$, (select v from t.ids where k = 'S1'), (select v from t.ids where k = 'A')),
  '22023', null, 'Số CCCD phải đủ 12 chữ số');
select throws_ok(format($$ select public.add_staff_document('%1$s', 'kiem_dinh', 'X', null, null, null, null, '{}',
  array['%2$s/nhan_su/%1$s/a.jpg'], null, null) $$, (select v from t.ids where k = 'S1'), (select v from t.ids where k = 'A')),
  '22023', null, 'Không gắn giấy của xe cho nhân viên');
select lives_ok(format($$ select public.add_staff_document('%1$s', 'cccd', '079123456789', 'Cục CS QLHC về TTXH', '2021-06-01', null,
  '2040-05-20', '{"nv.ho_ten": "NGUYỄN VĂN TÀI", "que_quan": "Đồng Nai", "nv.noi_thuong_tru": "Số 1 Đường A, Biên Hòa"}',
  array['%2$s/nhan_su/%1$s/NGUYENVANTAI_cccd_1.jpg', '%2$s/nhan_su/%1$s/NGUYENVANTAI_cccd_2.jpg'], null, null) $$,
  (select v from t.ids where k = 'S1'), (select v from t.ids where k = 'A')), 'Lưu CCCD đủ 2 mặt');
select lives_ok(format($$ select public.add_staff_document('%1$s', 'gplx', '790123456789', 'Sở GTVT Đồng Nai', '2023-01-01', null,
  app.local_today() + 5, '{"hang": "D"}', array['%2$s/nhan_su/%1$s/NGUYENVANTAI_gplx_1.jpg'], null, null) $$,
  (select v from t.ids where k = 'S1'), (select v from t.ids where k = 'A')), 'Lưu GPLX hạng D');
select is((select array_length(files, 1) from public.documents where doc_type = 'cccd'), 2, 'CCCD có 2 tệp (2 mặt)');

-- Nhật ký không chép dữ liệu nhạy cảm
select ok(exists (select 1 from public.audit_logs where entity = 'documents' and detail -> 'new' ->> 'doc_type' = 'cccd'),
  'Nhật ký có ghi việc thêm CCCD');
select ok(not exists (select 1 from public.audit_logs where detail::text like '%079123456789%'), 'Nhật ký không chứa số CCCD');
select ok(not exists (select 1 from public.audit_logs where detail::text like '%1980-05-20%'), 'Nhật ký không chứa ngày sinh');
select ok(not exists (select 1 from public.audit_logs where detail::text like '%Đường A%'), 'Nhật ký không chứa địa chỉ');
reset role;

-- ---------------------------------------------------------------- Bán vé A: chỉ thấy tên, không thấy thông tin cá nhân
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.staff_members), 2, 'Bán vé thấy danh sách tên');
select is((select count(*)::int from public.staff_private), 0, 'Bán vé không thấy thông tin cá nhân');
select is((select count(*)::int from public.documents where owner_kind = 'nhan_su'), 0, 'Bán vé không thấy giấy tờ cá nhân');
select is((select count(*)::int from storage.objects where name like '%/nhan_su/%'), 0, 'Bán vé không xem được ảnh CCCD');
select throws_ok($$ select public.save_staff(gen_random_uuid(), '{"full_name": "X", "joined_on": "2026-01-01"}') $$,
  '42501', null, 'Bán vé không thêm được nhân viên');
select throws_ok(format($$ insert into storage.objects (bucket_id, name) values ('giay-to', '%s/nhan_su/%s/x.jpg') $$,
  (select v from t.ids where k = 'A'), (select v from t.ids where k = 'S1')), '42501', null, 'Bán vé không tải được ảnh giấy tờ nhân viên');
reset role;

-- ---------------------------------------------------------------- Lái xe Tài: xem được của chính mình
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.staff_private), 1, 'Lái xe xem được thông tin cá nhân của mình');
select is((select birth_date::text from public.staff_private), '1980-05-20', 'Đúng là hồ sơ của mình');
select is((select count(*)::int from public.documents), 2, 'Lái xe xem được giấy tờ của mình (CCCD, GPLX)');
select is((select count(*)::int from storage.objects where name like '%/nhan_su/%'), 2, 'Lái xe xem được ảnh CCCD của mình');
select throws_ok($$ select public.update_document((select id from public.documents where doc_type = 'gplx'), 'X', null, null, null, null, '{}', null) $$,
  '42501', null, 'Lái xe không tự sửa được giấy tờ');
reset role;

-- ---------------------------------------------------------------- Chủ B
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.staff_members), 0, 'Chủ B không thấy nhân viên nhà xe A');
select is((select count(*)::int from public.staff_private), 0, 'Chủ B không thấy thông tin cá nhân nhà xe A');
select is((select count(*)::int from public.documents), 0, 'Chủ B không thấy giấy tờ nhà xe A');
select is((select count(*)::int from storage.objects where bucket_id = 'giay-to'), 0, 'Chủ B không thấy ảnh nhà xe A');
select throws_ok($$ select public.save_staff((select v from t.ids where k = 'S1'), '{"full_name": "Chiếm", "joined_on": "2026-01-01"}') $$,
  'P0002', null, 'Chủ B sửa hồ sơ nhà xe A thì báo không tìm thấy');
select throws_ok(format($$ select public.add_staff_document('%1$s', 'cccd', null, null, null, null, null, '{}', array['%2$s/nhan_su/%1$s/a.jpg'], null, null) $$,
  (select v from t.ids where k = 'S1'), (select v from t.ids where k = 'B')), 'P0002', null, 'Chủ B thêm giấy cho nhân viên nhà xe A thì báo không tìm thấy');
select throws_ok($$ select public.save_staff(gen_random_uuid(), jsonb_build_object('full_name', 'X', 'joined_on', '2026-01-01',
  'user_id', '00000000-0000-0000-0000-0000000000b3')) $$, 'P0002', null, 'Chủ B không liên kết được tài khoản nhà xe A');
reset role;

select ok(not has_function_privilege('anon', 'public.save_staff(uuid, jsonb)', 'EXECUTE'), 'Khách (anon) không gọi được save_staff');
select ok(not has_table_privilege('authenticated', 'public.staff_private', 'INSERT'), 'Trình duyệt không ghi thẳng thông tin cá nhân');

select * from finish();
rollback;
