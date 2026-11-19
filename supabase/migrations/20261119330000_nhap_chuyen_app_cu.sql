-- =====================================================================
-- Chuyển lịch chạy (chuyến đã điều: xe + lái xe) từ app cũ sang TMS, kể cả ngày đã qua.
-- p_rows: [{ "route_id", "direction": "di"|"ve", "date": "YYYY-MM-DD", "time": "HH:MM", "vehicle_id"?, "driver_id"? }, ...]
-- - Có chuyến cùng tuyến / chiều / ngày / giờ thì điền xe + lái xe 1; chưa có thì tạo chuyến (ghi chú "Nhập từ app cũ").
-- - Không đè chuyến đã xuất bến; dòng lỗi (trùng giờ xe / lái xe…) bỏ qua, các dòng khác vẫn nhập.
-- - Nhập lại nhiều lần không tạo trùng.
-- =====================================================================
create function public.import_legacy_trips(p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_tz text;
  r jsonb;
  v_route uuid; v_dir text; v_date date; v_time time; v_veh uuid; v_drv uuid;
  v_trip public.trips;
  v_min int;
  v_kind text;
  n_new int := 0; n_up int := 0; n_same int := 0; n_skip int := 0;
  errs jsonb := '[]';
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'Mỗi lần gửi tối đa 500 chuyến' using errcode = '22023';
  end if;
  v_tz := app.tenant_tz(v_tid);
  for r in select * from jsonb_array_elements(p_rows) loop
    begin
      v_route := (r ->> 'route_id')::uuid;
      v_dir := r ->> 'direction';
      v_date := (r ->> 'date')::date;
      v_time := (r ->> 'time')::time;
      v_veh := nullif(r ->> 'vehicle_id', '')::uuid;
      v_drv := nullif(r ->> 'driver_id', '')::uuid;
      if v_dir not in ('di', 've') or v_date is null or v_time is null
         or not exists (select 1 from public.routes where tenant_id = v_tid and id = v_route) then
        raise exception 'Dòng không hợp lệ (tuyến / chiều / ngày / giờ)';
      end if;
      if v_veh is not null and not exists (select 1 from public.vehicles where tenant_id = v_tid and id = v_veh) then v_veh := null; end if;
      if v_drv is not null and not exists (select 1 from public.staff_members where tenant_id = v_tid and id = v_drv) then v_drv := null; end if;

      select * into v_trip from public.trips
      where tenant_id = v_tid and route_id = v_route and direction = v_dir and service_date = v_date and status = 'mo'
        and (depart_at at time zone v_tz)::time = v_time
      limit 1;
      if not found then
        v_min := app.route_minutes(v_tid, v_route);
        insert into public.trips (tenant_id, route_id, direction, service_date, depart_at, arrive_at, note)
        values (v_tid, v_route, v_dir, v_date, (v_date + v_time) at time zone v_tz,
                ((v_date + v_time) at time zone v_tz) + make_interval(mins => v_min), 'Nhập từ app cũ')
        returning * into v_trip;
        v_kind := 'new';
      elsif v_trip.departed_at is not null and v_trip.edit_unlocked_at is null then
        n_skip := n_skip + 1;
        continue;
      elsif v_trip.vehicle_id is not distinct from coalesce(v_veh, v_trip.vehicle_id)
            and (v_drv is null or exists (select 1 from public.trip_crew c where c.tenant_id = v_tid and c.trip_id = v_trip.id
                                          and c.role = 'lai_xe_1' and c.staff_id = v_drv and c.active)) then
        n_same := n_same + 1;
        continue;
      else
        v_kind := 'up';
      end if;

      if v_veh is not null and v_trip.vehicle_id is distinct from v_veh then
        update public.trips set vehicle_id = v_veh where tenant_id = v_tid and id = v_trip.id;
      end if;
      if v_drv is not null then
        delete from public.trip_crew where tenant_id = v_tid and trip_id = v_trip.id and (role = 'lai_xe_1' or staff_id = v_drv);
        insert into public.trip_crew (tenant_id, trip_id, role, staff_id, during)
        values (v_tid, v_trip.id, 'lai_xe_1', v_drv, tstzrange(v_trip.depart_at, v_trip.arrive_at));
      end if;
      if v_kind = 'new' then n_new := n_new + 1; else n_up := n_up + 1; end if;
    exception when others then
      errs := errs || jsonb_build_object('date', r ->> 'date', 'time', r ->> 'time',
        'error', case when sqlerrm ~ 'no_overlap' then 'xe hoặc lái xe trùng giờ với chuyến khác' else sqlerrm end);
    end;
  end loop;
  return jsonb_build_object('created', n_new, 'updated', n_up, 'same', n_same, 'skipped', n_skip, 'errors', errs);
end;
$$;
revoke execute on function public.import_legacy_trips(jsonb) from public, anon, authenticated;
grant execute on function public.import_legacy_trips(jsonb) to authenticated;
