-- Kiểm thử Sổ giám sát an toàn: ghi, sửa, đóng (tự ghi lý lịch lái xe / phương tiện), xóa, quyền, cô lập nhà xe.
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


set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok($$ select public.save_staff('00000000-0000-0000-0000-00000000aa01', '{"full_name":"Lái Một","joined_on":"2024-01-01","position":"lai_xe"}') $$, 'Lái xe');
select lives_ok($$ insert into public.vehicle_types (id, code, name, reg_seats) values ('00000000-0000-0000-0000-0000000000e1', 'G16', 'Ghế 16', 16) $$, 'Loại xe');
select lives_ok($$ insert into public.vehicles (id, plate, vehicle_type_id) values ('00000000-0000-0000-0000-0000000000e2', '60F-000.01', '00000000-0000-0000-0000-0000000000e1') $$, 'Xe');
select ok(public.save_safety_event(null, '{"occurred_at":"2026-11-20T08:00:00+07:00","kind":"toc_do","level":2,"content":"Vượt tốc độ 92/80 km/h","source":"GSHT","staff_id":"00000000-0000-0000-0000-00000000aa01","vehicle_id":"00000000-0000-0000-0000-0000000000e2"}', '00000000-0000-0000-0000-0000000000f1') is not null, 'Ghi sự việc');
select is(public.save_safety_event(null, '{"occurred_at":"2026-11-20T08:00:00+07:00","content":"x"}', '00000000-0000-0000-0000-0000000000f1'),
  (select id from public.safety_events where request_id = '00000000-0000-0000-0000-0000000000f1'), 'Bấm 2 lần không ghi trùng');
select throws_ok($$ select public.save_safety_event(null, '{"occurred_at":"2026-11-20T08:00:00+07:00","content":" "}', null) $$, '22023', null, 'Bắt buộc nội dung');
select lives_ok($$ select public.close_safety_event((select id from public.safety_events where request_id = '00000000-0000-0000-0000-0000000000f1'), 'vi_pham', 'Đã nhắc nhở, lập biên bản') $$, 'Đóng: vi phạm');
select is((select kind || '|' || title from public.staff_records where staff_id = '00000000-0000-0000-0000-00000000aa01'), 'vi_pham|Vượt tốc độ 92/80 km/h', 'Tự ghi Lý lịch hành nghề lái xe');
select throws_ok($$ select public.save_safety_event((select id from public.safety_events where request_id = '00000000-0000-0000-0000-0000000000f1'), '{"occurred_at":"2026-11-20T08:00:00+07:00","content":"sửa"}', null) $$, '22023', null, 'Đã đóng không sửa được');
select throws_ok($$ select public.delete_safety_event((select id from public.safety_events where request_id = '00000000-0000-0000-0000-0000000000f1')) $$, 'P0002', null, 'Đã đóng không xóa được');
select ok(public.save_safety_event(null, '{"occurred_at":"2026-11-20T10:00:00+07:00","kind":"su_co","level":3,"content":"Nổ lốp sau trên cao tốc","place":"Km 30 cao tốc","vehicle_id":"00000000-0000-0000-0000-0000000000e2"}', '00000000-0000-0000-0000-0000000000f2') is not null, 'Ghi sự cố');
select lives_ok($$ select public.close_safety_event((select id from public.safety_events where request_id = '00000000-0000-0000-0000-0000000000f2'), 'khac_phuc', 'Đã thay lốp') $$, 'Đóng sự cố');
select is((select summary || '|' || resolution from public.vehicle_incidents), 'Nổ lốp sau trên cao tốc|Đã thay lốp', 'Tự ghi lý lịch phương tiện');
select ok(public.save_safety_event(null, '{"occurred_at":"2026-11-20T11:00:00+07:00","content":"Ghi nhầm"}', '00000000-0000-0000-0000-0000000000f3') is not null, 'Ghi nhầm');
select lives_ok($$ select public.delete_safety_event((select id from public.safety_events where request_id = '00000000-0000-0000-0000-0000000000f3')) $$, 'Xóa sự việc chưa đóng');
select is((public.safety_period_stats('2026-11-01', '2026-11-30') ->> 'trips')::int, 0, 'Thống kê kỳ chạy được');
select throws_ok($$ insert into public.safety_events (occurred_at, kind, content) values (now(), 'khac', 'x') $$, '42501', null, 'Trình duyệt không ghi thẳng bảng');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}';
select is((select count(*)::int from public.safety_events), 0, 'Bán vé không xem sổ giám sát');
select throws_ok($$ select public.save_safety_event(null, '{"occurred_at":"2026-11-20T08:00:00+07:00","content":"x"}', null) $$, '42501', null, 'Bán vé không ghi sổ');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.safety_events), 0, 'Nhà xe B không thấy sổ của A');
select throws_ok($$ select public.save_safety_event(null, '{"occurred_at":"2026-11-20T08:00:00+07:00","content":"x","staff_id":"00000000-0000-0000-0000-00000000aa01"}', null) $$, 'P0002', null, 'Nhà xe B không ghi cho lái xe của A');
select throws_ok($$ select public.close_safety_event((select id from public.safety_events limit 1), 'khac_phuc', null) $$, 'P0002', null, 'Nhà xe B không đóng được sự việc của A');
reset role;
select * from finish();
rollback;
