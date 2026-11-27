-- Kiểm thử: trợ lý giọng nói tự học câu nói — lưu câu, không lưu từ tục, dùng chung trong nhà xe, nhà xe khác không thấy, chỉ Admin xóa.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b5', 'lx@test.local'),
  ('00000000-0000-0000-0000-0000000000c1', 'ub@test.local');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok($$ select public.bootstrap_platform_admin() $$, 'Khởi tạo');
select lives_ok($$ select public.create_tenant('nha-xe-a', 'Nhà xe A') $$, 'Tạo nhà xe A');
select lives_ok($$ select public.create_tenant('nha-xe-b', 'Nhà xe B') $$, 'Tạo nhà xe B');
reset role;
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select id from public.tenants where code = 'nha-xe-a'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b5', (select id from public.tenants where code = 'nha-xe-a'), '0900000005', 'Lái A', 'driver') $$, 'Lái xe A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000009', 'Chủ B', 'owner') $$, 'Chủ B');

-- Lái xe dạy trợ lý
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}';
select is(public.voice_learn('Cho xe lăn bánh', 'cho xe lan banh', 'chuyen'), 'luu', 'Lưu câu mới');
select is(public.voice_learn('cho xe lăn bánh!', 'cho xe lan banh', 'chuyen'), 'co_roi', 'Câu đã có: không lưu trùng');
select is(public.voice_learn('Sắp qua đèo rồi', 'sap qua deo roi', 'diem_toi'), 'luu', '"đèo" không bị nhầm là từ tục');
select is(public.voice_learn('đụng xe rồi', 'dung xe roi', 'su_co'), 'luu', '"đụng" không bị nhầm là từ tục');
select is(public.voice_learn('đổi đĩa nhạc', 'doi dia nhac', 'nhac:tiep'), 'luu', '"đĩa" không bị nhầm là từ tục');
select is(public.voice_learn('đéo hiểu gì', 'deo hieu gi', 'diem_toi'), 'bo_qua', 'Câu có từ tục: không lưu');
select is(public.voice_learn('ĐM khách đâu', 'dm khach dau', 'diem_toi'), 'bo_qua', 'Viết tắt tục: không lưu');
select is(public.voice_learn('khách đâu vl', 'khach dau vl', 'diem_toi'), 'bo_qua', 'Từ tục cuối câu: không lưu');
select is((select count(*)::int from public.voice_phrases where phrase_key in ('deo hieu gi', 'dm khach dau', 'khach dau vl')), 0, 'Không có câu tục nào được lưu');
select throws_ok($$ select public.voice_learn('abc', 'abc', 'xoa_het') $$, '22023', null, 'Lệnh lạ: từ chối');
select throws_ok($$ select public.voice_learn('abc', 'ABC; drop', 'chuyen') $$, '22023', null, 'Mã câu sai dạng: từ chối');
select throws_ok($$ insert into public.voice_phrases (tenant_id, phrase_key, phrase, intent) values (app.current_tenant_id(), 'x', 'x', 'chuyen') $$,
  '42501', null, 'Không ghi thẳng vào bảng');
select is((select count(*)::int from public.voice_phrases), 4, 'Lái xe thấy các câu đã học của nhà xe');
select lives_ok($$ select public.voice_used((select id from public.voice_phrases where phrase_key = 'cho xe lan banh')) $$, 'Đếm lượt dùng');
select is((select uses from public.voice_phrases where phrase_key = 'cho xe lan banh'), 2, 'Lượt dùng tăng');
select throws_ok($$ select public.voice_forget((select id from public.voice_phrases where phrase_key = 'cho xe lan banh')) $$, '42501', null, 'Lái xe không xóa được');
reset role;

-- Nhà xe khác không thấy, không xóa được
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.voice_phrases), 0, 'Chủ B không thấy câu của nhà xe A');
reset role;
create temp table ids as select id from public.voice_phrases where phrase_key = 'sap qua deo roi';
grant select on ids to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select throws_ok($$ select public.voice_forget((select id from ids)) $$, 'P0002', null, 'Chủ B xóa câu nhà xe A: không tìm thấy');
reset role;

-- Admin nhà xe A xóa câu học sai
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.voice_forget((select id from public.voice_phrases where phrase_key = 'doi dia nhac')) $$, 'Admin xóa câu học sai');
select is((select count(*)::int from public.voice_phrases), 3, 'Còn 3 câu');
reset role;

-- Chưa đăng nhập
set local role anon;
select throws_ok($$ select public.voice_learn('a', 'a', 'chuyen') $$, '42501', null, 'Chưa đăng nhập: không dạy được');
reset role;

select * from finish();
rollback;
