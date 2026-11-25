-- Kiểm thử Nghỉ phép + số sổ BHXH / tài khoản ngân hàng:
-- lái xe tự xin nghỉ, chỉ thấy đơn của mình, không tự duyệt; quản lý duyệt / từ chối / hủy; đơn đã xử lý không sửa; cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'lx1@test.local'), ('00000000-0000-0000-0000-0000000000b4', 'lx2@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select id from public.tenants where code = 'nha-xe-a'), '0900000002', 'Lái Một', 'driver') $$, 'Lái xe 1');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b4', (select id from public.tenants where code = 'nha-xe-a'), '0900000005', 'Lái Hai', 'driver') $$, 'Lái xe 2');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Lái Một","joined_on":"2020-01-01","position":"lai_xe","bhxh_no":"7912345678","bank_account":"VCB 0123456789"}') $$, 'Hồ sơ lái xe 1 có số BHXH, tài khoản');
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa02', '{"full_name":"Lái Hai","joined_on":"2024-01-01","position":"lai_xe"}') $$, 'Hồ sơ lái xe 2');
select is((select bhxh_no || ' / ' || bank_account from public.staff_private where staff_id = '00000000-0000-0000-0000-00000000aa01'), '7912345678 / VCB 0123456789', 'Lưu số sổ BHXH, tài khoản ngân hàng');
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Lái Một","joined_on":"2020-01-01","position":"lai_xe"}') $$, 'Sửa hồ sơ không gửi 2 ô mới');
select is((select bhxh_no from public.staff_private where staff_id = '00000000-0000-0000-0000-00000000aa01'), '7912345678', 'Không gửi ô thì giữ nguyên số BHXH cũ');
reset role;
update public.staff_members set user_id = '00000000-0000-0000-0000-0000000000b2' where id = '00000000-0000-0000-0000-00000000aa01';
update public.staff_members set user_id = '00000000-0000-0000-0000-0000000000b4' where id = '00000000-0000-0000-0000-00000000aa02';

-- Lái xe 1 tự xin nghỉ
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select lives_ok($$ select public.save_leave('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-00000000aa01', 'phep_nam', '2026-12-01', '2026-12-02', 2, 'Về quê') $$, 'Lái xe tự xin nghỉ phép');
select lives_ok($$ select public.save_leave('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-00000000aa01', 'phep_nam', '2026-12-01', '2026-12-02', 2, 'Về quê') $$, 'Bấm gửi 2 lần không lỗi');
select is((select count(*)::int from public.staff_leaves), 1, 'Không tạo trùng đơn');
select throws_ok($$ select public.save_leave('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-00000000aa02', 'phep_nam', '2026-12-01', '2026-12-01', 1, null) $$, '42501', null, 'Lái xe không ghi đơn cho người khác');
select throws_ok($$ select public.save_leave('00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-00000000aa01', 'phep_nam', '2026-12-05', '2026-12-01', 1, null) $$, '22023', null, 'Ngày kết thúc trước ngày bắt đầu');
select throws_ok($$ select public.decide_leave('00000000-0000-0000-0000-0000000d0001', 'da_duyet', null) $$, '42501', null, 'Lái xe không tự duyệt');
select throws_ok($$ insert into public.staff_leaves (tenant_id, staff_id, kind, from_on, to_on, days) values ((select tenant_id from public.staff_members limit 1), '00000000-0000-0000-0000-00000000aa01', 'om', '2026-12-01', '2026-12-01', 1) $$, '42501', null, 'Trình duyệt không ghi thẳng vào bảng');
select is((select count(*)::int from public.staff_private where staff_id = '00000000-0000-0000-0000-00000000aa02'), 0, 'Lái xe không đọc được hồ sơ riêng (BHXH, tài khoản) của người khác');
select is((select bank_account from public.staff_private where staff_id = '00000000-0000-0000-0000-00000000aa01'), 'VCB 0123456789', 'Lái xe đọc được tài khoản của chính mình');
reset role;

-- Lái xe 2 không thấy đơn của lái xe 1
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select is((select count(*)::int from public.staff_leaves), 0, 'Lái xe khác không thấy đơn');
select throws_ok($$ select public.cancel_leave('00000000-0000-0000-0000-0000000d0001') $$, 'P0002', null, 'Lái xe khác không hủy được');
reset role;

-- Chủ nhà xe B: không thấy, không duyệt được
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.staff_leaves), 0, 'Nhà xe B không thấy đơn nghỉ của A');
select throws_ok($$ select public.decide_leave('00000000-0000-0000-0000-0000000d0001', 'da_duyet', null) $$, 'P0002', null, 'Nhà xe B không duyệt được');
select throws_ok($$ select public.save_leave('00000000-0000-0000-0000-0000000d0009', '00000000-0000-0000-0000-00000000aa01', 'om', '2026-12-01', '2026-12-01', 1, null) $$, 'P0002', null, 'Nhà xe B không ghi đơn cho người của A');
reset role;

-- Chủ A duyệt; đơn đã duyệt không sửa được; hủy giữ lịch sử
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.staff_leaves where status = 'cho_duyet'), 1, 'Chủ thấy 1 đơn chờ duyệt');
select lives_ok($$ select public.decide_leave('00000000-0000-0000-0000-0000000d0001', 'da_duyet', 'Đồng ý') $$, 'Duyệt');
select throws_ok($$ select public.decide_leave('00000000-0000-0000-0000-0000000d0001', 'tu_choi', null) $$, '22023', null, 'Đơn đã xử lý không duyệt lại');
select lives_ok($$ select public.save_leave('00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-00000000aa02', 'om', '2026-12-03', '2026-12-03', 1, 'Ốm') $$, 'Chủ ghi đơn cho lái xe 2');
select lives_ok($$ select public.cancel_leave('00000000-0000-0000-0000-0000000d0004') $$, 'Hủy đơn');
select is((select status from public.staff_leaves where id = '00000000-0000-0000-0000-0000000d0004'), 'da_huy', 'Hủy = đổi trạng thái, không xóa');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$ select public.save_leave('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-00000000aa01', 'phep_nam', '2026-12-01', '2026-12-03', 3, null) $$, '22023', null, 'Đơn đã duyệt không sửa được');
select throws_ok($$ select public.cancel_leave('00000000-0000-0000-0000-0000000d0001') $$, '42501', null, 'Lái xe không tự hủy đơn đã duyệt');
reset role;

select * from finish();
rollback;
