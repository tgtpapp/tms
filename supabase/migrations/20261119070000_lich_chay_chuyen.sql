-- =====================================================================
-- Giai đoạn 3.4a – Lịch chạy (nốt), chuyến xe, xếp xe + lái xe
-- - Nốt: giờ xuất bến cố định theo tuyến + chiều (đi / về) + ngày trong tuần.
-- - Chuyến tự tạo trước N ngày (cấu hình, tối đa 365); chuyến tăng cường tạo tay.
-- - Xếp xe / lái xe: CHẶN khi trùng giờ, giấy tờ hết hạn, quá niên hạn, sai hạng GPLX,
--   quá tuổi; CẢNH BÁO (phải ghi lý do) khi thiếu giấy tờ, vượt giờ lái.
-- - Chuyến hợp lệ để chạy khi đủ: giờ chạy + xe + lái xe.
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

insert into public.permissions (code, module, name) values
  ('trip.manage', 'van_tai', 'Điều hành: lịch chạy, chuyến, xếp xe và lái xe');
select app.grant_permission_to_admins('trip.manage');
-- Vai trò Điều hành có sẵn được quyền này
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, 'trip.manage' from public.roles r where r.code = 'dispatcher'
on conflict do nothing;

create or replace function app.seed_system_roles(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid; v_admin uuid; v_branch uuid; v_disp uuid;
begin
  insert into public.roles (tenant_id, code, name, is_system) values
    (p_tenant_id, 'owner',          'Chủ nhà xe',         true),
    (p_tenant_id, 'admin',          'Quản trị',            true),
    (p_tenant_id, 'branch_manager', 'Quản lý chi nhánh',   true),
    (p_tenant_id, 'office_manager', 'Quản lý phòng vé',    true),
    (p_tenant_id, 'seller',         'Bán vé',              true),
    (p_tenant_id, 'dispatcher',     'Điều hành',           true),
    (p_tenant_id, 'accountant',     'Kế toán',             true),
    (p_tenant_id, 'driver',         'Lái xe',              true),
    (p_tenant_id, 'staff',          'Nhân viên',           true);

  select id into v_owner  from public.roles where tenant_id = p_tenant_id and code = 'owner';
  select id into v_admin  from public.roles where tenant_id = p_tenant_id and code = 'admin';
  select id into v_branch from public.roles where tenant_id = p_tenant_id and code = 'branch_manager';
  select id into v_disp   from public.roles where tenant_id = p_tenant_id and code = 'dispatcher';

  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select p_tenant_id, r.id, p.code
  from (values (v_owner), (v_admin)) as r(id), public.permissions p;

  insert into public.role_permissions (tenant_id, role_id, permission_code) values
    (p_tenant_id, v_branch, 'office.manage'),
    (p_tenant_id, v_branch, 'user.read'),
    (p_tenant_id, v_disp,   'trip.manage');
end;
$$;

-- ---------------------------------------------------------------- Cấu hình điều hành
create or replace function app.validate_tenant_setting()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  v numeric;
  -- khóa số nguyên: [nhỏ nhất, lớn nhất, câu báo]
  lim jsonb := '{
    "ban_ve.giu_ghe_quay_phut":    [1, 120, "Thời gian giữ ghế phải từ 1 đến 120 phút"],
    "ban_ve.giu_ghe_online_phut":  [1, 120, "Thời gian giữ ghế phải từ 1 đến 120 phút"],
    "ban_ve.nha_ghe_vexere_gio":   [0, 48,  "Giờ nhả ghế Vexere phải từ 0 đến 48"],
    "giay_to.canh_bao_truoc_ngay": [1, 180, "Số ngày cảnh báo giấy tờ phải từ 1 đến 180"],
    "chuyen.tao_truoc_ngay":       [1, 365, "Số ngày tạo chuyến trước phải từ 1 đến 365"],
    "lai_xe.gio_lien_tuc_toi_da":  [1, 12,  "Giờ lái liên tục tối đa phải từ 1 đến 12"],
    "lai_xe.gio_ngay_toi_da":      [1, 24,  "Giờ lái tối đa trong ngày phải từ 1 đến 24"],
    "lai_xe.gio_tuan_toi_da":      [1, 168, "Giờ lái tối đa trong tuần phải từ 1 đến 168"]
  }';
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if lim ? new.key then
    if jsonb_typeof(new.value) <> 'number' then
      raise exception 'Giá trị phải là số' using errcode = '22023';
    end if;
    v := (new.value #>> '{}')::numeric;
    if v <> trunc(v) then
      raise exception 'Giá trị phải là số nguyên' using errcode = '22023';
    end if;
    if v < (lim -> new.key ->> 0)::numeric or v > (lim -> new.key ->> 1)::numeric then
      raise exception '%', lim -> new.key ->> 2 using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

create or replace function app.seed_default_settings(p_tenant_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.tenant_settings (tenant_id, key, value) values
    (p_tenant_id, 'ban_ve.giu_ghe_quay_phut',    '5'::jsonb),
    (p_tenant_id, 'ban_ve.giu_ghe_online_phut',  '15'::jsonb),
    (p_tenant_id, 'ban_ve.nha_ghe_vexere_gio',   '2'::jsonb),
    (p_tenant_id, 'giay_to.canh_bao_truoc_ngay', '30'::jsonb),
    (p_tenant_id, 'chuyen.tao_truoc_ngay',       '7'::jsonb),
    (p_tenant_id, 'lai_xe.gio_lien_tuc_toi_da',  '4'::jsonb),
    (p_tenant_id, 'lai_xe.gio_ngay_toi_da',      '10'::jsonb),
    (p_tenant_id, 'lai_xe.gio_tuan_toi_da',      '48'::jsonb)
  on conflict (tenant_id, key) do nothing
$$;
revoke execute on function app.seed_default_settings(uuid) from public, anon, authenticated;
select app.seed_default_settings(id) from public.tenants;

create function app.setting_int(p_tenant uuid, p_key text, p_default int)
returns int
language sql stable security definer set search_path = ''
as $$
  select coalesce((select (value #>> '{}')::int from public.tenant_settings where tenant_id = p_tenant and key = p_key), p_default)
$$;
create function app.tenant_tz(p_tenant uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce((select value #>> '{}' from public.tenant_settings where tenant_id = p_tenant and key = 'he_thong.mui_gio'),
                  'Asia/Ho_Chi_Minh')
$$;
-- Thời gian chạy toàn tuyến (phút) = số phút của điểm cuối
create function app.route_minutes(p_tenant uuid, p_route uuid)
returns int
language sql stable security definer set search_path = ''
as $$
  select coalesce(max(minutes_from_start), 0) from public.route_stops where tenant_id = p_tenant and route_id = p_route
$$;
revoke execute on function app.setting_int(uuid, text, int), app.tenant_tz(uuid), app.route_minutes(uuid, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- Nốt (lịch chạy cố định)
create table public.schedules (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id),
  route_id      uuid not null,
  direction     text not null check (direction in ('di', 've')),
  depart_time   time not null,
  days_of_week  int[] not null default '{1,2,3,4,5,6,7}'
                check (cardinality(days_of_week) > 0 and days_of_week <@ array[1, 2, 3, 4, 5, 6, 7]),
  valid_from    date not null,
  valid_to      date,
  is_active     boolean not null default true,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  unique (tenant_id, id),
  foreign key (tenant_id, route_id) references public.routes (tenant_id, id)
);
create unique index schedules_active_uq on public.schedules (tenant_id, route_id, direction, depart_time) where is_active;

-- ---------------------------------------------------------------- Chuyến
create table public.trips (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id),
  route_id       uuid not null,
  direction      text not null check (direction in ('di', 've')),
  schedule_id    uuid,                       -- null = chuyến tăng cường
  service_date   date not null,
  depart_at      timestamptz not null,
  arrive_at      timestamptz not null,
  status         text not null default 'mo' check (status in ('mo', 'huy')),
  vehicle_id     uuid,
  cancel_reason  text,
  assign_note    text,                       -- lý do vẫn xếp khi có cảnh báo
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (arrive_at > depart_at),
  check (status <> 'huy' or cancel_reason is not null),
  unique (tenant_id, id),
  unique (tenant_id, schedule_id, service_date),
  foreign key (tenant_id, route_id) references public.routes (tenant_id, id),
  foreign key (tenant_id, schedule_id) references public.schedules (tenant_id, id),
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id),
  -- Một xe không chạy 2 chuyến chồng giờ
  constraint trips_vehicle_no_overlap exclude using gist
    (tenant_id with =, vehicle_id with =, tstzrange(depart_at, arrive_at) with &&)
    where (status = 'mo' and vehicle_id is not null)
);
create index trips_day_idx on public.trips (tenant_id, service_date, depart_at);

create table public.trip_crew (
  tenant_id  uuid not null,
  trip_id    uuid not null,
  role       text not null check (role in ('lai_xe_1', 'lai_xe_2', 'phu_xe')),
  staff_id   uuid not null,
  during     tstzrange not null,           -- chép giờ chuyến để chặn trùng giờ
  active     boolean not null default true,
  primary key (tenant_id, trip_id, role),
  unique (tenant_id, trip_id, staff_id),
  foreign key (tenant_id, trip_id) references public.trips (tenant_id, id) on delete cascade,
  foreign key (tenant_id, staff_id) references public.staff_members (tenant_id, id),
  -- Một người không ở 2 chuyến chồng giờ
  constraint trip_crew_no_overlap exclude using gist (tenant_id with =, staff_id with =, during with &&) where (active)
);
create index trip_crew_staff_idx on public.trip_crew (tenant_id, staff_id);

create trigger schedules_touch before update on public.schedules for each row execute function app.touch_updated_at();
create trigger trips_touch before update on public.trips for each row execute function app.touch_updated_at();
create trigger schedules_audit after insert or update or delete on public.schedules for each row execute function app.write_audit();
create trigger trips_audit after update or delete on public.trips for each row execute function app.write_audit();
create trigger trip_crew_audit after insert or update or delete on public.trip_crew for each row execute function app.write_audit();

alter table public.schedules enable row level security;
alter table public.trips     enable row level security;
alter table public.trip_crew enable row level security;
revoke all on public.schedules, public.trips, public.trip_crew from anon, authenticated;
grant select on public.schedules, public.trips, public.trip_crew to authenticated;
grant select, insert, update, delete on public.schedules, public.trips, public.trip_crew to service_role;
create policy schedules_select on public.schedules for select to authenticated using (tenant_id = app.current_tenant_id());
create policy trips_select     on public.trips     for select to authenticated using (tenant_id = app.current_tenant_id());
create policy trip_crew_select on public.trip_crew for select to authenticated using (tenant_id = app.current_tenant_id());

-- ---------------------------------------------------------------- Tạo chuyến từ nốt
-- Tạo chuyến từ hôm nay đến p_until cho các nốt đang chạy. Đã có (kể cả đã hủy) thì bỏ qua.
create function app.generate_trips_for(p_tenant uuid, p_until date, p_schedule uuid default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_tz text := app.tenant_tz(p_tenant);
  v_today date := (now() at time zone v_tz)::date;
  v_count int;
begin
  insert into public.trips (tenant_id, route_id, direction, schedule_id, service_date, depart_at, arrive_at)
  select s.tenant_id, s.route_id, s.direction, s.id, d::date,
         (d::date + s.depart_time) at time zone v_tz,
         ((d::date + s.depart_time) at time zone v_tz) + make_interval(mins => app.route_minutes(s.tenant_id, s.route_id))
  from public.schedules s
  cross join lateral generate_series(greatest(v_today, s.valid_from)::timestamp,
                                     least(p_until, coalesce(s.valid_to, p_until))::timestamp, interval '1 day') d
  where s.tenant_id = p_tenant and s.is_active and (p_schedule is null or s.id = p_schedule)
    and extract(isodow from d)::int = any (s.days_of_week)
    and app.route_minutes(s.tenant_id, s.route_id) > 0
  on conflict (tenant_id, schedule_id, service_date) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function app.generate_trips_for(uuid, date, uuid) from public, anon, authenticated;

-- Việc định kỳ (pg_cron): mỗi đêm tạo thêm chuyến cho mọi nhà xe
create function app.svc_generate_all_trips()
returns int
language plpgsql security definer set search_path = ''
as $$
declare r record; v_total int := 0;
begin
  for r in select id from public.tenants loop
    v_total := v_total + app.generate_trips_for(r.id,
      (now() at time zone app.tenant_tz(r.id))::date + app.setting_int(r.id, 'chuyen.tao_truoc_ngay', 7));
  end loop;
  return v_total;
end;
$$;
revoke execute on function app.svc_generate_all_trips() from public, anon, authenticated;
grant execute on function app.svc_generate_all_trips() to service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('tao-chuyen-hang-dem', '5 17 * * *', 'select app.svc_generate_all_trips()');  -- 00:05 giờ VN
  else
    raise notice 'Máy chủ không có pg_cron: chuyến chỉ được tạo khi lưu nốt hoặc bấm "Tạo chuyến"';
  end if;
exception when others then
  raise notice 'Không bật được pg_cron (%): chuyến chỉ được tạo khi lưu nốt hoặc bấm "Tạo chuyến"', sqlerrm;
end;
$$;

create function public.generate_trips()
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  return app.generate_trips_for(v_tid, app.local_today() + app.setting_int(v_tid, 'chuyen.tao_truoc_ngay', 7));
end;
$$;

-- Thêm / sửa nốt. Sửa chỉ đổi ngày chạy trong tuần, ngày kết thúc, ghi chú
-- (đổi giờ / tuyến / chiều: ngừng nốt cũ, thêm nốt mới).
create function public.save_schedule(p_id uuid, p_route_id uuid, p_direction text, p_depart_time time,
                                     p_days int[], p_valid_from date, p_valid_to date, p_note text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid;
  v_n int;
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  if p_days is null or cardinality(p_days) = 0 then
    raise exception 'Chọn ít nhất 1 ngày chạy trong tuần' using errcode = '22023';
  end if;
  if p_id is null then
    if not exists (select 1 from public.routes where id = p_route_id and tenant_id = v_tid and is_active) then
      raise exception 'Không tìm thấy tuyến' using errcode = 'P0002';
    end if;
    if app.route_minutes(v_tid, p_route_id) <= 0 then
      raise exception 'Tuyến chưa có thời gian chạy: khai số phút đến điểm cuối ở mục Tuyến' using errcode = '22023';
    end if;
    if p_direction not in ('di', 've') or p_depart_time is null then
      raise exception 'Chọn chiều và giờ xuất bến' using errcode = '22023';
    end if;
    insert into public.schedules (tenant_id, route_id, direction, depart_time, days_of_week, valid_from, valid_to, note)
    values (v_tid, p_route_id, p_direction, p_depart_time, (select array_agg(distinct d order by d) from unnest(p_days) d),
            coalesce(p_valid_from, app.local_today()), p_valid_to, nullif(trim(p_note), ''))
    returning id into v_id;
  else
    update public.schedules
    set days_of_week = (select array_agg(distinct d order by d) from unnest(p_days) d), valid_to = p_valid_to,
        note = nullif(trim(p_note), '')
    where id = p_id and tenant_id = v_tid and is_active
    returning id into v_id;
    if v_id is null then
      raise exception 'Không tìm thấy nốt' using errcode = 'P0002';
    end if;
  end if;
  v_n := app.generate_trips_for(v_tid, app.local_today() + app.setting_int(v_tid, 'chuyen.tao_truoc_ngay', 7), v_id);
  return jsonb_build_object('id', v_id, 'created_trips', v_n);
end;
$$;

-- Ngừng nốt từ ngày p_from: hủy các chuyến chưa chạy của nốt từ ngày đó (giữ lại, không xóa).
create function public.stop_schedule(p_id uuid, p_from date, p_reason text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_s public.schedules;
  v_n int;
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  select * into v_s from public.schedules where id = p_id and tenant_id = v_tid and is_active for update;
  if not found then
    raise exception 'Không tìm thấy nốt' using errcode = 'P0002';
  end if;
  if p_from is null or p_from < app.local_today() then
    raise exception 'Ngày ngừng không được trước hôm nay' using errcode = '22023';
  end if;
  if p_from <= v_s.valid_from then
    update public.schedules set is_active = false, valid_to = v_s.valid_from where id = p_id;
  else
    update public.schedules set valid_to = p_from - 1 where id = p_id;
  end if;
  update public.trip_crew c set active = false
  from public.trips t
  where t.tenant_id = v_tid and t.schedule_id = p_id and t.service_date >= p_from and t.status = 'mo'
    and c.tenant_id = t.tenant_id and c.trip_id = t.id;
  update public.trips set status = 'huy', cancel_reason = coalesce(nullif(trim(p_reason), ''), 'Ngừng nốt')
  where tenant_id = v_tid and schedule_id = p_id and service_date >= p_from and status = 'mo';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Chuyến tăng cường (ngoài lịch cố định)
create function public.add_extra_trip(p_route_id uuid, p_direction text, p_date date, p_time time, p_note text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_tz text;
  v_min int;
  v_id uuid;
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  if not exists (select 1 from public.routes where id = p_route_id and tenant_id = v_tid and is_active) then
    raise exception 'Không tìm thấy tuyến' using errcode = 'P0002';
  end if;
  v_min := app.route_minutes(v_tid, p_route_id);
  if v_min <= 0 then
    raise exception 'Tuyến chưa có thời gian chạy: khai số phút đến điểm cuối ở mục Tuyến' using errcode = '22023';
  end if;
  if p_direction not in ('di', 've') or p_date is null or p_time is null then
    raise exception 'Chọn chiều, ngày và giờ xuất bến' using errcode = '22023';
  end if;
  if p_date < app.local_today() then
    raise exception 'Không tạo chuyến cho ngày đã qua' using errcode = '22023';
  end if;
  v_tz := app.tenant_tz(v_tid);
  insert into public.trips (tenant_id, route_id, direction, service_date, depart_at, arrive_at, note)
  values (v_tid, p_route_id, p_direction, p_date, (p_date + p_time) at time zone v_tz,
          ((p_date + p_time) at time zone v_tz) + make_interval(mins => v_min), coalesce(nullif(trim(p_note), ''), 'Tăng cường'))
  returning id into v_id;
  return v_id;
end;
$$;

-- Hủy / mở lại chuyến
create function public.cancel_trip(p_trip_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Nhập lý do hủy chuyến' using errcode = '22023';
  end if;
  update public.trips set status = 'huy', cancel_reason = trim(p_reason)
  where id = p_trip_id and tenant_id = v_tid and status = 'mo';
  if not found then
    raise exception 'Không tìm thấy chuyến đang mở' using errcode = 'P0002';
  end if;
  update public.trip_crew set active = false where tenant_id = v_tid and trip_id = p_trip_id;
end;
$$;

create function public.reopen_trip(p_trip_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  -- Mở lại không tự gắn lại xe / lái xe cũ (có thể đã đi chuyến khác)
  update public.trips set status = 'mo', cancel_reason = null, vehicle_id = null
  where id = p_trip_id and tenant_id = v_tid and status = 'huy' and service_date >= app.local_today();
  if not found then
    raise exception 'Không tìm thấy chuyến đã hủy (chưa qua ngày)' using errcode = 'P0002';
  end if;
  delete from public.trip_crew where tenant_id = v_tid and trip_id = p_trip_id;
end;
$$;

-- ---------------------------------------------------------------- Xếp xe + lái xe
-- Trả về {saved, warnings[]}. Lỗi chặn → exception. Có cảnh báo mà chưa ghi lý do → saved=false.
create function public.assign_trip(p_trip_id uuid, p_vehicle_id uuid, p_driver1 uuid, p_driver2 uuid,
                                   p_assistant uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_trip public.trips;
  v_route public.routes;
  v_veh public.vehicles;
  v_type public.vehicle_types;
  v_need text;
  v_range tstzrange;
  v_min numeric;
  v_drivers int;
  v_block text[] := '{}';
  v_warn text[] := '{}';
  v_tz text;
  v_cont int; v_day int; v_week int;
  d record; r record;
  v_doc public.documents;
  v_hang text;
  v_birth date; v_gender text;
  v_age int;
  v_other numeric;
  v_docname text;
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = p_trip_id and tenant_id = v_tid for update;
  if not found then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  if v_trip.status <> 'mo' then
    raise exception 'Chuyến đã hủy, mở lại trước khi xếp' using errcode = '22023';
  end if;
  select * into v_route from public.routes where id = v_trip.route_id and tenant_id = v_tid;
  v_range := tstzrange(v_trip.depart_at, v_trip.arrive_at);
  v_min := extract(epoch from (v_trip.arrive_at - v_trip.depart_at)) / 60;
  v_tz := app.tenant_tz(v_tid);

  if p_driver1 is null and p_driver2 is not null then
    raise exception 'Chọn lái xe 1 trước lái xe 2' using errcode = '22023';
  end if;
  if (p_driver1 is not null and (p_driver1 = p_driver2 or p_driver1 = p_assistant))
     or (p_driver2 is not null and p_driver2 = p_assistant) then
    raise exception 'Một người không thể giữ 2 vai trò trên cùng chuyến' using errcode = '22023';
  end if;

  -- ------------------------------------------------ Xe
  if p_vehicle_id is not null then
    select * into v_veh from public.vehicles where id = p_vehicle_id and tenant_id = v_tid;
    if not found then
      raise exception 'Không tìm thấy xe' using errcode = 'P0002';
    end if;
    select * into v_type from public.vehicle_types where id = v_veh.vehicle_type_id and tenant_id = v_tid;
    v_need := app.required_license(v_type.reg_seats, v_type.reg_berths, v_type.reg_standing);
    if not v_veh.is_active then
      v_block := v_block || format('Xe %s đang ngừng dùng', v_veh.plate);
    end if;
    if v_veh.business_type = 'hop_dong' then
      v_block := v_block || format('Xe %s chỉ đăng ký chạy hợp đồng, không chạy tuyến cố định', v_veh.plate);
    end if;
    -- Niên hạn (NĐ 158/2024): tuyến > 300 km: 15 năm; còn lại 20 năm (cách tính năm cuối: cần xác minh)
    if v_veh.manufacture_year is not null
       and extract(year from v_trip.service_date) > v_veh.manufacture_year
                                                   + case when coalesce(v_route.distance_km, 0) > 300 then 15 else 20 end then
      v_block := v_block || format('Xe %s quá niên hạn chạy tuyến này (sản xuất năm %s)', v_veh.plate, v_veh.manufacture_year);
    end if;
    for d in select code, name from public.document_types where code in ('kiem_dinh', 'bh_tnds', 'phu_hieu') order by sort loop
      select * into v_doc from public.documents
      where tenant_id = v_tid and vehicle_id = v_veh.id and doc_type = d.code and is_current;
      if not found then
        v_warn := v_warn || format('Xe %s chưa có %s trong hồ sơ', v_veh.plate, lower(d.name));
      elsif v_doc.expires_on is not null and v_doc.expires_on < v_trip.service_date then
        v_block := v_block || format('Xe %s: %s hết hạn ngày %s', v_veh.plate, lower(d.name), to_char(v_doc.expires_on, 'DD/MM/YYYY'));
      end if;
    end loop;
    for r in select t.depart_at from public.trips t
             where t.tenant_id = v_tid and t.vehicle_id = v_veh.id and t.status = 'mo' and t.id <> v_trip.id
               and tstzrange(t.depart_at, t.arrive_at) && v_range loop
      v_block := v_block || format('Xe %s đã có chuyến khác lúc %s', v_veh.plate,
                                   to_char(r.depart_at at time zone v_tz, 'HH24:MI DD/MM'));
    end loop;
  end if;

  -- ------------------------------------------------ Lái xe, phụ xe
  v_drivers := (p_driver1 is not null)::int + (p_driver2 is not null)::int;
  v_cont := app.setting_int(v_tid, 'lai_xe.gio_lien_tuc_toi_da', 4);
  v_day  := app.setting_int(v_tid, 'lai_xe.gio_ngay_toi_da', 10);
  v_week := app.setting_int(v_tid, 'lai_xe.gio_tuan_toi_da', 48);
  if v_drivers = 1 and v_min > v_cont * 60 then
    v_warn := v_warn || format('Chuyến chạy %s giờ %s phút, chỉ 1 lái xe: vượt %s giờ lái liên tục (cần dừng nghỉ hoặc thêm lái xe)',
                               floor(v_min / 60), (v_min % 60)::int, v_cont);
  end if;

  for r in select x.staff_id, x.role from (values (p_driver1, 'lai_xe_1'), (p_driver2, 'lai_xe_2'), (p_assistant, 'phu_xe')) x(staff_id, role)
           where x.staff_id is not null loop
    declare
      v_s public.staff_members;
    begin
      select * into v_s from public.staff_members where id = r.staff_id and tenant_id = v_tid;
      if not found then
        raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002';
      end if;
      if not v_s.is_active then
        v_block := v_block || format('%s đã nghỉ việc', v_s.full_name);
      end if;
      if exists (select 1 from public.trip_crew c where c.tenant_id = v_tid and c.staff_id = v_s.id and c.active
                   and c.trip_id <> v_trip.id and c.during && v_range) then
        v_block := v_block || format('%s đã có chuyến khác chồng giờ', v_s.full_name);
      end if;
      if r.role = 'phu_xe' then
        continue;
      end if;
      if v_s.position <> 'lai_xe' then
        v_block := v_block || format('%s không phải lái xe', v_s.full_name);
        continue;
      end if;
      -- GPLX
      select * into v_doc from public.documents where tenant_id = v_tid and staff_id = v_s.id and doc_type = 'gplx' and is_current;
      if not found then
        v_warn := v_warn || format('%s chưa có giấy phép lái xe trong hồ sơ', v_s.full_name);
      else
        v_hang := app.normalize_license(v_doc.data ->> 'hang', v_doc.issued_on);
        if v_doc.expires_on is not null and v_doc.expires_on < v_trip.service_date then
          v_block := v_block || format('%s: giấy phép lái xe hết hạn ngày %s', v_s.full_name, to_char(v_doc.expires_on, 'DD/MM/YYYY'));
        end if;
        if v_hang is null then
          v_warn := v_warn || format('%s chưa nhập hạng giấy phép lái xe', v_s.full_name);
        elsif v_need is not null and not app.license_covers(v_hang, v_need) then
          v_block := v_block || format('%s có GPLX hạng %s, xe %s cần hạng %s', v_s.full_name, v_hang, v_veh.plate, v_need);
        end if;
      end if;
      -- Tuổi tối đa lái xe trên 29 chỗ / giường nằm: 57 nam, 55 nữ (Luật TTATGT đường bộ 2024)
      select birth_date, gender into v_birth, v_gender from public.staff_private where staff_id = v_s.id and tenant_id = v_tid;
      if v_need = 'D' and v_birth is not null and v_gender is not null then
        v_age := extract(year from age(v_trip.service_date, v_birth));
        if v_age >= case v_gender when 'nam' then 57 else 55 end then
          v_block := v_block || format('%s đã %s tuổi, quá tuổi lái xe trên 29 chỗ / giường nằm', v_s.full_name, v_age);
        end if;
      end if;
      -- Giấy khám sức khỏe
      select * into v_doc from public.documents where tenant_id = v_tid and staff_id = v_s.id and doc_type = 'kham_suc_khoe' and is_current;
      if not found then
        v_warn := v_warn || format('%s chưa có giấy khám sức khỏe trong hồ sơ', v_s.full_name);
      elsif v_doc.expires_on is not null and v_doc.expires_on < v_trip.service_date then
        v_block := v_block || format('%s: giấy khám sức khỏe hết hạn ngày %s', v_s.full_name, to_char(v_doc.expires_on, 'DD/MM/YYYY'));
      end if;
      -- Giấy tập huấn (cần xác minh mức bắt buộc): chỉ cảnh báo
      select * into v_doc from public.documents where tenant_id = v_tid and staff_id = v_s.id and doc_type = 'tap_huan' and is_current;
      if found and v_doc.expires_on is not null and v_doc.expires_on < v_trip.service_date then
        v_warn := v_warn || format('%s: giấy tập huấn nghiệp vụ hết hạn ngày %s', v_s.full_name, to_char(v_doc.expires_on, 'DD/MM/YYYY'));
      end if;
      -- Giờ lái trong ngày / tuần (chia đều thời gian chuyến cho số lái xe của chuyến)
      select coalesce(sum(extract(epoch from (t.arrive_at - t.depart_at)) / 60
                          / (select count(*) from public.trip_crew c2 where c2.tenant_id = t.tenant_id and c2.trip_id = t.id
                               and c2.role in ('lai_xe_1', 'lai_xe_2') and c2.active)), 0)
        into v_other
      from public.trip_crew c join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id
      where c.tenant_id = v_tid and c.staff_id = v_s.id and c.active and c.role in ('lai_xe_1', 'lai_xe_2')
        and t.id <> v_trip.id and t.service_date = v_trip.service_date;
      if v_other + v_min / v_drivers > v_day * 60 then
        v_warn := v_warn || format('%s lái khoảng %s giờ trong ngày %s, vượt %s giờ', v_s.full_name,
                                   round((v_other + v_min / v_drivers) / 60, 1), to_char(v_trip.service_date, 'DD/MM'), v_day);
      end if;
      select coalesce(sum(extract(epoch from (t.arrive_at - t.depart_at)) / 60
                          / (select count(*) from public.trip_crew c2 where c2.tenant_id = t.tenant_id and c2.trip_id = t.id
                               and c2.role in ('lai_xe_1', 'lai_xe_2') and c2.active)), 0)
        into v_other
      from public.trip_crew c join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id
      where c.tenant_id = v_tid and c.staff_id = v_s.id and c.active and c.role in ('lai_xe_1', 'lai_xe_2')
        and t.id <> v_trip.id and date_trunc('week', t.service_date) = date_trunc('week', v_trip.service_date);
      if v_other + v_min / v_drivers > v_week * 60 then
        v_warn := v_warn || format('%s lái khoảng %s giờ trong tuần, vượt %s giờ', v_s.full_name,
                                   round((v_other + v_min / v_drivers) / 60, 1), v_week);
      end if;
    end;
  end loop;

  if cardinality(v_block) > 0 then
    raise exception '%', array_to_string(v_block, E'\n') using errcode = '22023';
  end if;
  if cardinality(v_warn) > 0 and nullif(trim(p_reason), '') is null then
    return jsonb_build_object('saved', false, 'warnings', to_jsonb(v_warn));
  end if;

  update public.trips
  set vehicle_id = p_vehicle_id,
      assign_note = case when cardinality(v_warn) > 0 then trim(p_reason) end
  where id = v_trip.id;
  delete from public.trip_crew where tenant_id = v_tid and trip_id = v_trip.id;
  insert into public.trip_crew (tenant_id, trip_id, role, staff_id, during)
  select v_tid, v_trip.id, x.role, x.staff_id, v_range
  from (values (p_driver1, 'lai_xe_1'), (p_driver2, 'lai_xe_2'), (p_assistant, 'phu_xe')) x(staff_id, role)
  where x.staff_id is not null;
  return jsonb_build_object('saved', true, 'warnings', to_jsonb(v_warn));
end;
$$;

revoke execute on function
  public.generate_trips(),
  public.save_schedule(uuid, uuid, text, time, int[], date, date, text),
  public.stop_schedule(uuid, date, text),
  public.add_extra_trip(uuid, text, date, time, text),
  public.cancel_trip(uuid, text),
  public.reopen_trip(uuid),
  public.assign_trip(uuid, uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.generate_trips(),
  public.save_schedule(uuid, uuid, text, time, int[], date, date, text),
  public.stop_schedule(uuid, date, text),
  public.add_extra_trip(uuid, text, date, time, text),
  public.cancel_trip(uuid, text),
  public.reopen_trip(uuid),
  public.assign_trip(uuid, uuid, uuid, uuid, uuid, text)
  to authenticated;
