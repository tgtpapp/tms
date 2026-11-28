-- Việc của tôi (Admin): ẩn chuyến đã hủy (admin_trips trả mọi chuyến của nhà xe nên lẫn rất nhiều chuyến hủy).
create or replace function public.admin_trips(p_from date, p_to date)
returns table (trip_id uuid, service_date date, depart_at timestamptz, arrive_at timestamptz, route_id uuid, direction text,
               status text, plate text, my_role text, departed_at timestamptz, arrived_at timestamptz, order_no text,
               departed_auto boolean, arrived_auto boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.is_tenant_admin() then
    raise exception 'Chỉ Admin của nhà xe' using errcode = '42501';
  end if;
  return query
  select t.id, t.service_date, t.depart_at, t.arrive_at, t.route_id, t.direction, t.status, v.plate,
         (select c.role from public.trip_crew c join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id and m.user_id = auth.uid()
           where c.tenant_id = t.tenant_id and c.trip_id = t.id and c.active limit 1),
         t.departed_at, t.arrived_at, o.order_no, t.departed_auto, t.arrived_auto
  from public.trips t
  left join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id
  left join public.transport_order_legs l on l.tenant_id = t.tenant_id and l.trip_id = t.id
  left join public.transport_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
  where t.tenant_id = v_tid and t.status <> 'huy'   -- chuyến đã hủy: không hiện
    and t.service_date between coalesce(p_from, app.local_today()) and least(coalesce(p_to, p_from, app.local_today()), coalesce(p_from, app.local_today()) + 31)
  order by t.depart_at;
end;
$$;
