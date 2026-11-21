-- Kiểm thử báo sự cố: nhà xe lấy từ phiên đăng nhập, người gửi chỉ thấy của mình, người xử lý chỉ thấy nhà xe mình,
-- nhà xe khác "không tìm thấy", màn hình đăng nhập chỉ qua service_role và có giới hạn.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'), ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'bv@test.local'), ('00000000-0000-0000-0000-0000000000b4', 'bv2@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b3', (select id from public.tenants where code = 'nha-xe-a'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b4', (select id from public.tenants where code = 'nha-xe-a'), '0900000005', 'Bán vé A2', 'seller') $$, 'Bán vé A2');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');

-- Bán vé A báo sự cố trong app
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
create temp table tk as select public.support_open('Không vào được màn hình đặt vé', '{"screen":"Bán vé","errors":["lỗi 1"],"la":"bỏ"}') id;
select is((select tenant_id from public.support_tickets where id = (select id from tk)), (select id from public.tenants where code = 'nha-xe-a'), 'Nhà xe lấy từ phiên đăng nhập');
select is((select no from public.support_tickets where id = (select id from tk)), 1, 'Số sự cố 1');
select is((select context ->> 'la' from public.support_tickets where id = (select id from tk)), null, 'Bỏ thông tin máy không cần');
select is((select count(*)::int from public.support_messages where ticket_id = (select id from tk)), 2, 'Tin người gửi + máy báo đã nhận');
select is(public.support_open('Không vào được màn hình đặt vé', '{}'), (select id from tk), 'Bấm gửi 2 lần không tạo phiếu mới');
select throws_ok($$ select public.support_open('a', '{}') $$, '22023', null, 'Mô tả quá ngắn');
select throws_ok($$ insert into public.support_tickets (tenant_id, no, channel, summary) values ((select id from public.tenants where code = 'nha-xe-a'), 99, 'app', 'x') $$,
  '42501', null, 'Không ghi thẳng vào bảng');
select throws_ok($$ select ip_hash from public.support_tickets $$, '42501', null, 'Không đọc mã băm địa chỉ máy');
reset role;
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000000b1' and kind = 'su_co'), 1, 'Chủ A nhận thông báo sự cố');

-- Bán vé khác của cùng nhà xe: không thấy, không trả lời được
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select is((select count(*)::int from public.support_tickets), 0, 'Người khác cùng nhà xe không thấy sự cố');
select is((select count(*)::int from public.support_messages), 0, 'Không thấy tin nhắn');
select throws_ok(format('select public.support_reply(%L, %L)', (select id from tk), 'chen vao'), 'P0002', null, 'Không trả lời được sự cố của người khác');

-- Nhà xe B: không thấy, không tìm thấy
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.support_tickets), 0, 'Nhà xe B không thấy sự cố nhà xe A');
select throws_ok(format('select public.support_reply(%L, %L)', (select id from tk), 'x'), 'P0002', null, 'Nhà xe B trả lời: không tìm thấy');
select throws_ok(format('select public.support_set_status(%L, %L)', (select id from tk), 'dong'), 'P0002', null, 'Nhà xe B đóng: không tìm thấy');
create temp table tkb as select public.support_open('Máy in lỗi', '{}') id;
select is((select no from public.support_tickets where id = (select id from tkb)), 1, 'Số sự cố đếm riêng từng nhà xe');

-- Chủ A xử lý
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.support_tickets), 1, 'Chủ A thấy sự cố nhà xe mình');
select lives_ok(format('select public.support_reply(%L, %L)', (select id from tk), 'Anh xem giúp'), 'Chủ A trả lời');
select is((select sender from public.support_messages where ticket_id = (select id from tk) order by created_at desc limit 1), 'xu_ly', 'Ghi là người xử lý');
select lives_ok(format('select public.support_set_status(%L, %L)', (select id from tk), 'dong'), 'Chủ A đóng');
reset role;
select is((select count(*)::int from public.notifications where user_id = '00000000-0000-0000-0000-0000000000b3' and kind = 'su_co'), 2, 'Người gửi nhận trả lời + đã xử lý');

-- Người gửi nhắn lại: mở lại sự cố
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select lives_ok(format('select public.support_reply(%L, %L)', (select id from tk), 'Vẫn chưa được'), 'Người gửi nhắn lại');
select is((select status from public.support_tickets where id = (select id from tk)), 'mo', 'Tự mở lại');

-- Màn hình đăng nhập
select throws_ok($$ select public.svc_support_login('nha-xe-a', '0900000004', 'Không đăng nhập được', '{}', 'h1') $$, '42501', null, 'Trình duyệt không gọi được hàm nội bộ');
reset role;
select is(public.svc_support_login('khong-co', '0900000004', 'Không đăng nhập được', '{}', 'h1'), false, 'Sai mã nhà xe: không lưu');
select is(public.svc_support_login('nha-xe-a', '0900000004', 'Không đăng nhập được', '{}', 'h1'), true, 'Lưu sự cố từ màn hình đăng nhập');
select is((select created_by from public.support_tickets where channel = 'login'), null, 'Không gắn vào tài khoản (chưa xác minh)');
select is((select reporter_name from public.support_tickets where channel = 'login'), 'Bán vé A', 'Ghi tên theo số điện thoại cho người xử lý');
select is((select count(*)::int from public.support_tickets where channel = 'login'), 1, 'Một phiếu');
select is(public.svc_support_login('nha-xe-a', '0900000004', 'Không đăng nhập được', '{}', 'h1'), true, 'Gửi lại cùng nội dung');
select is((select count(*)::int from public.support_tickets where channel = 'login'), 1, 'Không tạo trùng');
select lives_ok($$ select public.svc_support_login('nha-xe-a', null, 'Lần ' || g, '{}', 'h1') from generate_series(2, 6) g $$, 'Gửi dồn');
select is((select count(*)::int from public.support_tickets where channel = 'login' and ip_hash = 'h1'), 5, 'Mỗi máy tối đa 5 lần / giờ');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.support_tickets where channel = 'login'), 0, 'Người có số điện thoại trùng không thấy phiếu chưa xác minh');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.support_tickets where channel = 'login'), 0, 'Nhà xe B không thấy');
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.support_tickets where channel = 'login'), 5, 'Chủ A thấy');
-- Super Admin không mặc nhiên đọc
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is((select count(*)::int from public.support_tickets), 0, 'Super Admin không mặc nhiên đọc sự cố nhà xe');
reset role;
select * from finish();
rollback;
