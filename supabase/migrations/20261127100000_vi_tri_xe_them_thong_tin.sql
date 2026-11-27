-- Vị trí xe (mô phỏng màn Skysoft): thêm số điện thoại lái xe và lúc xe chạy gần nhất (để tính xe đã dừng bao lâu).
drop function if exists public.live_vehicles();
create function public.live_vehicles()
returns table (trip_id uuid, depart_at timestamptz, route_id uuid, direction text, plate text, driver text, driver_phone text, at timestamptz,
               lat numeric, lng numeric, speed numeric, heading int, moved_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not (app.has_permission('trip.view') or app.is_tenant_admin()) then
    raise exception 'Không có quyền xem vị trí xe' using errcode = '42501';
  end if;
  return query
  select t.id, t.depart_at, t.route_id, t.direction, v.plate, d.full_name, d.phone,
         p.at, p.lat, p.lng, p.speed, p.heading,
         (select max(x.at) from public.vehicle_positions x where x.tenant_id = t.tenant_id and x.trip_id = t.id and x.speed >= 3)
  from public.trips t
  left join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id
  left join lateral (select m.full_name, m.phone from public.trip_crew c join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id
                     where c.tenant_id = t.tenant_id and c.trip_id = t.id and c.active order by c.role limit 1) d on true
  left join lateral (select x.at, x.lat, x.lng, x.speed, x.heading from public.vehicle_positions x
                     where x.tenant_id = t.tenant_id and x.trip_id = t.id order by x.at desc limit 1) p on true
  where t.tenant_id = v_tid and t.status = 'mo' and t.departed_at is not null and t.arrived_at is null
    and t.service_date between app.local_today() - 1 and app.local_today()
  order by t.depart_at;
end;
$$;
revoke execute on function public.live_vehicles() from public, anon, authenticated;
grant execute on function public.live_vehicles() to authenticated, service_role;
