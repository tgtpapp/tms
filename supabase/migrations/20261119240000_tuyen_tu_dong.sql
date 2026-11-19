-- =====================================================================
-- Tuyến dùng được ngay, không bắt khai báo trước:
-- - Tạo tuyến mà chưa có điểm dừng → tự tạo điểm đầu / điểm cuối theo tên tuyến
--   ("Biên Hòa - Vũng Tàu" → "Biên Hòa", "Vũng Tàu"; trùng tên điểm có sẵn thì dùng lại).
-- - Thời gian chạy chưa khai → tự ước tính: cự ly ÷ 40 km/h (làm tròn 5 phút), không có cự ly thì 120 phút.
--   Sau này sửa điểm dừng / số phút ở mục Tuyến thì dùng số đã sửa.
-- =====================================================================

create function app.route_estimate_minutes(p_tenant uuid, p_route uuid)
returns int
language sql stable security definer set search_path = ''
as $$
  select coalesce((select greatest(30, (round(r.distance_km / 40.0 * 60 / 5) * 5)::int)
                   from public.routes r where r.tenant_id = p_tenant and r.id = p_route and r.distance_km > 0), 120)
$$;

-- Thời gian chạy toàn tuyến: số phút của điểm cuối; chưa khai thì ước tính
create or replace function app.route_minutes(p_tenant uuid, p_route uuid)
returns int
language sql stable security definer set search_path = ''
as $$
  select coalesce(nullif((select max(minutes_from_start) from public.route_stops where tenant_id = p_tenant and route_id = p_route), 0),
                  app.route_estimate_minutes(p_tenant, p_route))
$$;

create function app.ensure_route_stops(p_tenant uuid, p_route uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_parts text[];
  v_ids uuid[] := '{}';
  v_name text;
  v_id uuid;
  v_code text;
  i int;
  k int;
begin
  if exists (select 1 from public.route_stops where tenant_id = p_tenant and route_id = p_route) then return; end if;
  select code, name into r from public.routes where tenant_id = p_tenant and id = p_route;
  if not found then return; end if;
  v_parts := array(select trim(x) from regexp_split_to_table(r.name, '\s+[-–—]\s+') x where trim(x) <> '');
  if coalesce(array_length(v_parts, 1), 0) < 2 or lower(v_parts[1]) = lower(v_parts[array_length(v_parts, 1)]) then
    v_parts := array[r.name || ' (điểm đầu)', r.name || ' (điểm cuối)'];
  else
    v_parts := array[v_parts[1], v_parts[array_length(v_parts, 1)]];
  end if;
  for i in 1..2 loop
    v_name := v_parts[i];
    select id into v_id from public.stops where tenant_id = p_tenant and lower(name) = lower(v_name) order by is_active desc limit 1;
    if v_id is null then
      k := i;
      loop
        v_code := left(r.code, 20) || '-' || k;
        exit when not exists (select 1 from public.stops where tenant_id = p_tenant and code = v_code);
        k := k + 2;
      end loop;
      insert into public.stops (tenant_id, code, name, kind) values (p_tenant, v_code, v_name, 'diem_don_tra') returning id into v_id;
    end if;
    v_ids := v_ids || v_id;
    v_id := null;
  end loop;
  insert into public.route_stops (tenant_id, route_id, seq, stop_id, minutes_from_start)
  values (p_tenant, p_route, 1, v_ids[1], 0),
         (p_tenant, p_route, 2, v_ids[2], app.route_estimate_minutes(p_tenant, p_route));
end;
$$;

create function app.routes_auto_stops()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.ensure_route_stops(new.tenant_id, new.id);
  return null;
end;
$$;
create trigger routes_auto_stops after insert on public.routes for each row execute function app.routes_auto_stops();

revoke execute on function app.route_estimate_minutes(uuid, uuid), app.ensure_route_stops(uuid, uuid), app.routes_auto_stops()
  from public, anon, authenticated;

-- Tuyến đang có mà chưa có điểm dừng: bổ sung luôn
select app.ensure_route_stops(r.tenant_id, r.id) from public.routes r
where not exists (select 1 from public.route_stops s where s.tenant_id = r.tenant_id and s.route_id = r.id);
