-- =====================================================================
-- Lịch chạy theo tuyến (kiểu Vexere): mỗi tuyến – chiều một bảng giờ chạy
-- - Mỗi giờ (nốt): giờ đăng ký với Sở, số tài, loại xe (sơ đồ ghế), ngày chạy
--   (theo thứ / ngày chẵn / ngày lẻ), loại hình kinh doanh (tuyến cố định / hợp đồng).
-- - save_timetable: lưu cả bảng một lần (thêm giờ mới, sửa giờ cũ, bỏ giờ → ngừng từ ngày mai).
-- - Không gắn sẵn xe / tài xế theo giờ (điều hành xếp từng chuyến – đã chốt).
-- =====================================================================

alter table public.schedules add column registered_time time;   -- giờ đăng ký với Sở (in lệnh)
alter table public.schedules add column trip_no text check (trip_no is null or length(trip_no) <= 20);   -- số tài
alter table public.schedules add column day_rule text not null default 'thu' check (day_rule in ('thu', 'chan', 'le'));
alter table public.schedules add column business_type text not null default 'tuyen_co_dinh'
  check (business_type in ('tuyen_co_dinh', 'hop_dong'));

create or replace function app.schedule_runs_on(p_rule text, p_days int[], p_day date)
returns boolean
language sql immutable set search_path = ''
as $$
  select case p_rule
           when 'chan' then extract(day from p_day)::int % 2 = 0
           when 'le' then extract(day from p_day)::int % 2 = 1
           else extract(isodow from p_day)::int = any (p_days) end
$$;
revoke execute on function app.schedule_runs_on(text, int[], date) from public, anon, authenticated;

create or replace function app.generate_trips_for(p_tenant uuid, p_until date, p_schedule uuid default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_tz text := app.tenant_tz(p_tenant);
  v_today date := (now() at time zone v_tz)::date;
  v_count int;
begin
  insert into public.trips (tenant_id, route_id, direction, schedule_id, service_date, depart_at, arrive_at, vehicle_type_id)
  select s.tenant_id, s.route_id, s.direction, s.id, d::date,
         (d::date + s.depart_time) at time zone v_tz,
         ((d::date + s.depart_time) at time zone v_tz) + make_interval(mins => app.route_minutes(s.tenant_id, s.route_id)),
         s.vehicle_type_id
  from public.schedules s
  cross join lateral generate_series(greatest(v_today, s.valid_from)::timestamp,
                                     least(p_until, coalesce(s.valid_to, p_until))::timestamp, interval '1 day') d
  where s.tenant_id = p_tenant and s.is_active and (p_schedule is null or s.id = p_schedule)
    and app.schedule_runs_on(s.day_rule, s.days_of_week, d::date)
    and app.route_minutes(s.tenant_id, s.route_id) > 0
  on conflict (tenant_id, schedule_id, service_date) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- p_items: [{ id?, depart_time "HH:MM", registered_time?, trip_no?, vehicle_type_id?, day_rule, days[], business_type }]
-- p_stop_ids: giờ bị bỏ khỏi bảng → ngừng từ ngày mai (chuyến đã tạo từ ngày mai chuyển "đã hủy", giữ lại)
create function public.save_timetable(p_route_id uuid, p_direction text, p_valid_from date, p_valid_to date, p_note text,
                                      p_items jsonb, p_stop_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  e jsonb;
  v_id uuid;
  v_time time;
  v_rule text;
  v_days int[];
  v_type uuid;
  v_biz text;
  v_saved int := 0;
  v_stopped int := 0;
  v_cancel int := 0;
  v_sid uuid;
  v_n int;
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  if not exists (select 1 from public.routes where id = p_route_id and tenant_id = v_tid and is_active) then
    raise exception 'Không tìm thấy tuyến' using errcode = 'P0002';
  end if;
  if p_direction not in ('di', 've') then
    raise exception 'Chọn chiều chạy' using errcode = '22023';
  end if;
  if app.route_minutes(v_tid, p_route_id) <= 0 then
    raise exception 'Tuyến chưa có thời gian chạy: khai số phút đến điểm cuối ở mục Tuyến' using errcode = '22023';
  end if;
  if p_valid_to is not null and p_valid_to < coalesce(p_valid_from, app.local_today()) then
    raise exception 'Ngày kết thúc phải sau ngày bắt đầu' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]')) <> 'array' then
    raise exception 'Bảng giờ không hợp lệ' using errcode = '22023';
  end if;

  -- Bỏ giờ
  foreach v_sid in array coalesce(p_stop_ids, '{}') loop
    if exists (select 1 from public.schedules where id = v_sid and tenant_id = v_tid and route_id = p_route_id
                 and direction = p_direction and is_active) then
      perform public.stop_schedule(v_sid, app.local_today() + 1, 'Bỏ giờ khỏi lịch chạy');
      v_stopped := v_stopped + 1;
    end if;
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    begin
      v_time := (e ->> 'depart_time')::time;
    exception when others then
      raise exception 'Giờ chạy không hợp lệ: %', e ->> 'depart_time' using errcode = '22023';
    end;
    if v_time is null then
      raise exception 'Thiếu giờ chạy' using errcode = '22023';
    end if;
    v_rule := coalesce(e ->> 'day_rule', 'thu');
    if v_rule not in ('thu', 'chan', 'le') then
      raise exception 'Ngày chạy không hợp lệ' using errcode = '22023';
    end if;
    v_days := coalesce((select array_agg(distinct x::int order by x::int) from jsonb_array_elements_text(e -> 'days') x
                        where x ~ '^[1-7]$'), '{1,2,3,4,5,6,7}');
    if v_rule = 'thu' and cardinality(v_days) = 0 then
      raise exception 'Giờ % chưa chọn thứ chạy', to_char(v_time, 'HH24:MI') using errcode = '22023';
    end if;
    v_type := nullif(e ->> 'vehicle_type_id', '')::uuid;
    if v_type is not null and not exists (select 1 from public.vehicle_types where id = v_type and tenant_id = v_tid) then
      raise exception 'Không tìm thấy loại xe' using errcode = 'P0002';
    end if;
    v_biz := coalesce(e ->> 'business_type', 'tuyen_co_dinh');
    if v_biz not in ('tuyen_co_dinh', 'hop_dong') then
      raise exception 'Loại hình kinh doanh không hợp lệ' using errcode = '22023';
    end if;
    if length(coalesce(e ->> 'trip_no', '')) > 20 then
      raise exception 'Số tài tối đa 20 ký tự' using errcode = '22023';
    end if;

    v_id := nullif(e ->> 'id', '')::uuid;
    if v_id is null then
      begin
        insert into public.schedules (tenant_id, route_id, direction, depart_time, days_of_week, day_rule, valid_from, valid_to, note,
                                      registered_time, trip_no, vehicle_type_id, business_type)
        values (v_tid, p_route_id, p_direction, v_time, v_days, v_rule, coalesce(p_valid_from, app.local_today()), p_valid_to,
                nullif(trim(p_note), ''), nullif(e ->> 'registered_time', '')::time, nullif(trim(e ->> 'trip_no'), ''), v_type, v_biz);
      exception when unique_violation then
        raise exception 'Giờ % đã có trong lịch chạy của tuyến này', to_char(v_time, 'HH24:MI') using errcode = '23505';
      end;
    else
      update public.schedules
      set registered_time = nullif(e ->> 'registered_time', '')::time, trip_no = nullif(trim(e ->> 'trip_no'), ''),
          days_of_week = v_days, day_rule = v_rule, business_type = v_biz, vehicle_type_id = v_type,
          valid_to = p_valid_to, note = coalesce(nullif(trim(p_note), ''), note)
      where id = v_id and tenant_id = v_tid and route_id = p_route_id and direction = p_direction and is_active;
      if not found then
        raise exception 'Không tìm thấy giờ chạy %', to_char(v_time, 'HH24:MI') using errcode = 'P0002';
      end if;
      -- Chuyến đã tạo từ ngày mai không còn đúng ngày chạy mới: hủy nếu chưa bán vé, chưa xếp xe
      update public.trips t set status = 'huy', cancel_reason = 'Đổi ngày chạy trong lịch chạy'
      where t.tenant_id = v_tid and t.schedule_id = v_id and t.status = 'mo' and t.service_date > app.local_today()
        and t.vehicle_id is null and not app.schedule_runs_on(v_rule, v_days, t.service_date)
        and not exists (select 1 from public.seat_inventory si where si.tenant_id = v_tid and si.trip_id = t.id
                          and si.status in ('giu', 'dat', 'da_tt', 'cho_xep'));
      get diagnostics v_n = row_count;
      v_cancel := v_cancel + v_n;
      -- Loại xe mới áp cho chuyến tương lai chưa có sơ đồ ghế
      update public.trips set vehicle_type_id = v_type
      where tenant_id = v_tid and schedule_id = v_id and service_date >= app.local_today() and vehicle_type_id is null and v_type is not null;
    end if;
    v_saved := v_saved + 1;
  end loop;

  v_n := app.generate_trips_for(v_tid, app.local_today() + app.setting_int(v_tid, 'chuyen.tao_truoc_ngay', 7), null);
  return jsonb_build_object('saved', v_saved, 'stopped', v_stopped, 'created_trips', v_n, 'cancelled_trips', v_cancel);
end;
$$;
revoke execute on function public.save_timetable(uuid, text, date, date, text, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function public.save_timetable(uuid, text, date, date, text, jsonb, uuid[]) to authenticated;
