-- Kiểm thử Giai đoạn 3.4a: nốt, tạo chuyến trước N ngày, chuyến tăng cường, hủy / ngừng nốt,
-- xếp xe + lái xe (chặn trùng giờ, giấy tờ hết hạn, sai hạng GPLX; cảnh báo cần lý do), phân quyền, cô lập nhà xe.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'p@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'ua@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'ua2@test.local'),
  ('00000000-0000-0000-0000-0000000000b4', 'ua4@test.local'),
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
insert into t.ids values ('D1', '33333333-3333-3333-3333-333333333331'), ('D2', '33333333-3333-3333-3333-333333333332'),
                         ('D3', '33333333-3333-3333-3333-333333333333'), ('X1', '66666666-6666-6666-6666-666666666661'),
                         ('X2', '66666666-6666-6666-6666-666666666662');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b1', (select v from t.ids where k = 'A'), '0900000001', 'Chủ A', 'owner') $$, 'Chủ A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b2', (select v from t.ids where k = 'A'), '0900000002', 'Điều hành A', 'dispatcher') $$, 'Điều hành A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000b4', (select v from t.ids where k = 'A'), '0900000004', 'Bán vé A', 'seller') $$, 'Bán vé A');
select lives_ok($$ select public.svc_register_app_user('00000000-0000-0000-0000-0000000000c1', (select id from public.tenants where code = 'nha-xe-b'), '0900000003', 'Chủ B', 'owner') $$, 'Chủ B');
select is((select value::text from public.tenant_settings where tenant_id = (select v from t.ids where k = 'A') and key = 'chuyen.tao_truoc_ngay'),
  '7', 'Mặc định tạo chuyến trước 7 ngày');

-- ---------------------------------------------------------------- Chủ A: dữ liệu nền
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select throws_ok($$ update public.tenant_settings set value = '400' where key = 'chuyen.tao_truoc_ngay' $$, '22023', null,
  'Tạo chuyến trước tối đa 365 ngày');
select lives_ok($$ insert into public.stops (code, name, kind) values ('HN', 'BX Hố Nai', 'ben_xe'), ('VT', 'BX Vũng Tàu', 'ben_xe') $$, 'Điểm dừng');
select lives_ok($$ insert into public.routes (code, name, distance_km) values ('HN-VT', 'Hố Nai – Vũng Tàu', 110), ('KHONG', 'Tuyến chưa có giờ', 50) $$, 'Tuyến');
select lives_ok($$ select public.set_route_stops((select id from public.routes where code = 'HN-VT'), jsonb_build_array(
  jsonb_build_object('stop_id', (select id from public.stops where code = 'HN'), 'minutes_from_start', 0),
  jsonb_build_object('stop_id', (select id from public.stops where code = 'VT'), 'minutes_from_start', 300))) $$, 'Tuyến chạy 5 giờ');
select lives_ok($$ insert into public.vehicle_types (code, name, reg_seats, reg_berths) values ('GN40', 'Giường nằm 40', 2, 40), ('G29', 'Ghế 29', 29, 0) $$, 'Loại xe');
select lives_ok($$ insert into public.vehicles (id, plate, vehicle_type_id, manufacture_year) values
  ((select v from t.ids where k = 'X1'), '51B-111.11', (select id from public.vehicle_types where code = 'G29'), 2020),
  ((select v from t.ids where k = 'X2'), '51B-222.22', (select id from public.vehicle_types where code = 'GN40'), 2020) $$, 'Hai xe');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'D1'), '{"full_name": "Lái Một", "position": "lai_xe", "joined_on": "2020-01-01"}') $$, 'Lái xe 1');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'D2'), '{"full_name": "Lái Hai", "position": "lai_xe", "joined_on": "2020-01-01"}') $$, 'Lái xe 2');
select lives_ok($$ select public.save_staff((select v from t.ids where k = 'D3'), '{"full_name": "Phụ Ba", "position": "phu_xe", "joined_on": "2020-01-01"}') $$, 'Phụ xe');
-- Giấy tờ đầy đủ cho xe 1 và GPLX hạng D2 cho lái xe 1, D cho lái xe 2
select lives_ok(format($$ select public.add_vehicle_document('%1$s', '%3$s', 'S', null, null, null, app.local_today() + 365, '{}',
  array['%2$s/xe/%1$s/a.jpg'], null, null) $$, (select v from t.ids where k = 'X1'), (select v from t.ids where k = 'A'), c), 'Giấy ' || c)
  from unnest(array['kiem_dinh', 'bh_tnds', 'phu_hieu']) c;
select lives_ok(format($$ select public.add_staff_document('%1$s', 'gplx', '1', null, '2025-06-01', null, app.local_today() + 365,
  '{"hang": "%3$s"}', array['%2$s/nhan_su/%1$s/a.jpg'], null, null) $$, (select v from t.ids where k = k2), (select v from t.ids where k = 'A'), h),
  'GPLX ' || h) from (values ('D1', 'D2'), ('D2', 'D')) x(k2, h);
select lives_ok(format($$ select public.add_staff_document('%1$s', 'kham_suc_khoe', null, null, null, null, app.local_today() + 365,
  '{}', array['%2$s/nhan_su/%1$s/k.jpg'], null, null) $$, (select v from t.ids where k = k2), (select v from t.ids where k = 'A')),
  'Khám sức khỏe ' || k2) from (values ('D1'), ('D2')) x(k2);
reset role;

-- ---------------------------------------------------------------- Điều hành A: nốt + chuyến
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.route_stops s join public.routes r on r.id = s.route_id where r.code = 'KHONG'), 2,
  'Tuyến mới tự có điểm đầu / điểm cuối, không phải khai trước');
select is((public.save_schedule(null, (select id from public.routes where code = 'HN-VT'), 'di', '07:00', '{1,2,3,4,5,6,7}', null, null, null)
           ->> 'created_trips')::int, 8, 'Thêm nốt 07:00 chiều đi: tạo 8 chuyến (hôm nay + 7 ngày)');
select throws_ok($$ select public.save_schedule(null, (select id from public.routes where code = 'HN-VT'), 'di', '07:00', '{1}', null, null, null) $$,
  '23505', null, 'Không trùng nốt cùng tuyến, chiều, giờ');
select lives_ok($$ select public.save_schedule(null, (select id from public.routes where code = 'HN-VT'), 've', '13:00', '{1,2,3,4,5,6,7}', null, null, null) $$,
  'Thêm nốt 13:00 chiều về');
select is((select count(*)::int from public.trips), 16, 'Có 16 chuyến');
select is((select extract(epoch from (arrive_at - depart_at))::int / 60 from public.trips limit 1), 300, 'Chuyến dài đúng 5 giờ');
select is((select to_char(depart_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI') from public.trips where direction = 'di' limit 1), '07:00',
  'Giờ xuất bến theo giờ Việt Nam');
select is(public.generate_trips(), 0, 'Bấm "Tạo chuyến" lần nữa không tạo trùng');
reset role;
insert into t.ids select 'T1', id from public.trips where direction = 'di' and service_date = app.local_today() + 1;
insert into t.ids select 'T2', id from public.trips where direction = 've' and service_date = app.local_today() + 1;
insert into t.ids select 'T3', id from public.trips where direction = 'di' and service_date = app.local_today() + 2;

-- ---------------------------------------------------------------- Xếp xe + lái xe
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
-- Chuyến 5 giờ, 1 lái xe: vượt 4 giờ lái liên tục → cảnh báo, chưa lưu
select is((public.assign_trip((select v from t.ids where k = 'T1'), (select v from t.ids where k = 'X1'),
                              (select v from t.ids where k = 'D1'), null, null, null) ->> 'saved'), 'false',
  'Có cảnh báo mà chưa ghi lý do thì chưa lưu');
select ok((public.assign_trip((select v from t.ids where k = 'T1'), (select v from t.ids where k = 'X1'),
                              (select v from t.ids where k = 'D1'), null, null, null) -> 'warnings') ->> 0 like '%giờ lái liên tục%',
  'Cảnh báo vượt giờ lái liên tục');
select is((select vehicle_id from public.trips where id = (select v from t.ids where k = 'T1')), null, 'Chưa lưu xe');
select is((public.assign_trip((select v from t.ids where k = 'T1'), (select v from t.ids where k = 'X1'),
                              (select v from t.ids where k = 'D1'), null, (select v from t.ids where k = 'D3'), 'Dừng nghỉ 20 phút ở Long Thành') ->> 'saved'),
  'true', 'Ghi lý do thì lưu được');
select is((select assign_note from public.trips where id = (select v from t.ids where k = 'T1')), 'Dừng nghỉ 20 phút ở Long Thành', 'Lưu lý do');
select is((select count(*)::int from public.trip_crew where trip_id = (select v from t.ids where k = 'T1')), 2, 'Chuyến có lái xe + phụ xe');
select is((public.assign_trip((select v from t.ids where k = 'T3'), (select v from t.ids where k = 'X1'),
                              (select v from t.ids where k = 'D1'), (select v from t.ids where k = 'D2'), null, null) ->> 'saved'),
  'true', '2 lái xe, giấy tờ đủ: lưu ngay không cần lý do');

-- Chặn
select throws_ok($$ select public.assign_trip((select v from t.ids where k = 'T1'), (select v from t.ids where k = 'X2'),
  (select v from t.ids where k = 'D1'), null, null, 'x') $$, '22023', null, 'Chặn: GPLX hạng D2 lái xe giường nằm');
select throws_ok($$ select public.assign_trip((select v from t.ids where k = 'T1'), null,
  (select v from t.ids where k = 'D3'), null, null, 'x') $$, '22023', null, 'Chặn: phụ xe không làm lái xe');
select throws_ok($$ select public.assign_trip((select v from t.ids where k = 'T1'), null,
  (select v from t.ids where k = 'D1'), (select v from t.ids where k = 'D1'), null, 'x') $$, '22023', null, 'Chặn: 1 người giữ 2 vai trò');
select lives_ok($$ select public.add_extra_trip((select id from public.routes where code = 'HN-VT'), 'di', app.local_today() + 1, '09:00', null) $$,
  'Thêm chuyến tăng cường 09:00 (chồng giờ chuyến 07:00)');
select throws_ok($$ select public.assign_trip((select id from public.trips where schedule_id is null), (select v from t.ids where k = 'X1'),
  (select v from t.ids where k = 'D2'), null, null, 'x') $$, '22023', null, 'Chặn: xe đã có chuyến khác chồng giờ');
select throws_ok($$ select public.assign_trip((select id from public.trips where schedule_id is null), null,
  (select v from t.ids where k = 'D1'), null, null, 'x') $$, '22023', null, 'Chặn: lái xe đã có chuyến khác chồng giờ');
select ok((select (r ->> 'saved') = 'false' and (r -> 'warnings')::text like '%chưa có giấy chứng nhận kiểm định%'
            from public.assign_trip((select id from public.trips where schedule_id is null), (select v from t.ids where k = 'X2'),
                                    (select v from t.ids where k = 'D2'), null, null, null) r),
  'Xe thiếu giấy tờ trong hồ sơ: chỉ cảnh báo');
reset role;

-- Chủ A: giấy kiểm định xe 2 hết hạn → chặn; giảm giờ lái/ngày → cảnh báo
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';
select lives_ok(format($$ select public.add_vehicle_document('%1$s', 'kiem_dinh', 'KD', null, null, null, app.local_today(), '{}',
  array['%2$s/xe/%1$s/k.jpg'], null, null) $$, (select v from t.ids where k = 'X2'), (select v from t.ids where k = 'A')), 'Kiểm định xe 2 hết hạn hôm nay');
select throws_ok($$ select public.assign_trip((select id from public.trips where schedule_id is null), (select v from t.ids where k = 'X2'),
  (select v from t.ids where k = 'D2'), null, null, 'x') $$, '22023', null, 'Chặn: giấy kiểm định hết hạn trước ngày chạy');
select lives_ok($$ update public.tenant_settings set value = '8' where key = 'lai_xe.gio_ngay_toi_da' $$, 'Giờ lái tối đa/ngày = 8');
select ok((public.assign_trip((select v from t.ids where k = 'T2'), (select v from t.ids where k = 'X1'),
           (select v from t.ids where k = 'D1'), null, null, null) -> 'warnings')::text like '%trong ngày%',
  'Lái xe 1 chạy 2 chuyến 5 giờ trong ngày: cảnh báo vượt giờ/ngày');
reset role;

-- ---------------------------------------------------------------- Hủy, mở lại, ngừng nốt
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$ select public.cancel_trip((select v from t.ids where k = 'T1'), '') $$, '22023', null, 'Hủy chuyến phải có lý do');
select lives_ok($$ select public.cancel_trip((select v from t.ids where k = 'T1'), 'Xe hỏng') $$, 'Hủy chuyến');
select is((select count(*)::int from public.trip_crew where trip_id = (select v from t.ids where k = 'T1') and active), 0,
  'Hủy chuyến thì lái xe được nhả');
select lives_ok($$ select public.assign_trip((select id from public.trips where schedule_id is null), null,
  (select v from t.ids where k = 'D1'), (select v from t.ids where k = 'D2'), null, null) $$, 'Lái xe 1 xếp được chuyến 09:00 sau khi chuyến 07:00 hủy');
select lives_ok($$ select public.reopen_trip((select v from t.ids where k = 'T1')) $$, 'Mở lại chuyến');
select is((select vehicle_id from public.trips where id = (select v from t.ids where k = 'T1')), null, 'Mở lại không tự gắn xe cũ');
select is(public.stop_schedule((select id from public.schedules where direction = 've'), app.local_today() + 3, 'Đổi giờ'), 5,
  'Ngừng nốt chiều về từ ngày +3: hủy 5 chuyến còn lại');
select is((select count(*)::int from public.trips where direction = 've' and status = 'huy'), 5, 'Chuyến cũ vẫn giữ (đã hủy, không xóa)');
reset role;

-- ---------------------------------------------------------------- Bán vé A, Chủ B
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}';
select ok((select count(*) from public.trips) > 0, 'Bán vé xem được chuyến');
select throws_ok($$ select public.assign_trip((select v from t.ids where k = 'T3'), null, null, null, null, null) $$, '42501', null,
  'Bán vé không xếp được xe');
select throws_ok($$ select public.generate_trips() $$, '42501', null, 'Bán vé không tạo được chuyến');
select throws_ok($$ update public.trips set note = 'x' $$, '42501', null, 'Trình duyệt không sửa thẳng bảng chuyến');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.trips), 0, 'Chủ B không thấy chuyến nhà xe A');
select is((select count(*)::int from public.schedules), 0, 'Chủ B không thấy nốt nhà xe A');
select throws_ok($$ select public.assign_trip((select v from t.ids where k = 'T3'), null, null, null, null, null) $$, 'P0002', null,
  'Chủ B xếp xe chuyến nhà xe A thì báo không tìm thấy');
select throws_ok($$ select public.cancel_trip((select v from t.ids where k = 'T3'), 'x') $$, 'P0002', null,
  'Chủ B hủy chuyến nhà xe A thì báo không tìm thấy');
select is(public.generate_trips(), 0, 'Chủ B không có nốt thì không tạo chuyến nào');
reset role;

select ok(not has_function_privilege('anon', 'public.assign_trip(uuid, uuid, uuid, uuid, uuid, text)', 'EXECUTE'), 'Khách (anon) không xếp xe được');
select ok(app.svc_generate_all_trips() >= 0, 'Việc định kỳ tạo chuyến chạy được');

-- Bỏ chuyến trống: không tự tạo chuyến trống theo nốt, xóa chuyến chưa có xe và tài xế (giữ chuyến đã xếp)
insert into public.tenant_settings (tenant_id, key, value) select id, 'chuyen.tao_chuyen_trong', '0' from public.tenants where code = 'nha-xe-a';
select ok((select count(*) from public.trips x where x.vehicle_id is null and not exists (select 1 from public.trip_crew c where c.trip_id = x.id and c.active)) > 0, 'Đang có chuyến trống');
select ok(app.purge_empty_trips((select id from public.tenants where code = 'nha-xe-a')) > 0, 'Xóa chuyến trống');
select is((select count(*)::int from public.trips x where x.vehicle_id is null and not exists (select 1 from public.trip_crew c where c.trip_id = x.id and c.active and c.role in ('lai_xe_1', 'lai_xe_2'))), 0, 'Không còn chuyến trống');
select ok((select count(*) from public.trips) > 0, 'Chuyến đã xếp xe / tài xế giữ nguyên');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is(public.generate_trips(), 0, 'Tắt chuyến trống: bấm Tạo chuyến không tạo lại');
reset role;
select is(app.svc_generate_all_trips(), 0, 'Việc hằng đêm không tạo lại chuyến trống');

select * from finish();
rollback;
