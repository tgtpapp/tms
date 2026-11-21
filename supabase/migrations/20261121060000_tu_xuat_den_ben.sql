-- =====================================================================
-- Tự ghi xuất bến / đến bến khi lái xe chưa bấm:
-- - Tới giờ chạy: chuyến đủ xe + lái xe 1, chưa hủy, chưa xuất bến → ghi xuất bến đúng giờ chạy.
-- - Sau xuất bến N giờ (cấu hình chuyen.tu_den_ben_gio, mặc định 4; 0 = tắt cả hai) → ghi đến bến = giờ xuất bến + N giờ.
-- Giờ tự ghi được đánh dấu riêng (departed_auto / arrived_auto) để phân biệt với giờ lái xe bấm thật.
-- Chỉ xử lý chuyến trong 1 ngày gần nhất: không ghi ngược cho các chuyến cũ.
-- Xuất bến (kể cả tự ghi) khóa sửa vé / xe / tổ lái như khi lái xe bấm.
-- =====================================================================
alter table public.trips add column departed_auto boolean not null default false,
                         add column arrived_auto boolean not null default false;

insert into public.tenant_settings (tenant_id, key, value)
select id, 'chuyen.tu_den_ben_gio', '4'::jsonb from public.tenants
on conflict (tenant_id, key) do nothing;

create function app.svc_auto_trip_marks()
returns int
language plpgsql security definer set search_path = ''
as $$
declare n int; m int;
begin
  update public.trips t set departed_at = t.depart_at, departed_auto = true
  where t.status = 'mo' and t.departed_at is null and t.vehicle_id is not null
    and t.depart_at <= now() and t.depart_at > now() - interval '1 day'
    and app.setting_int(t.tenant_id, 'chuyen.tu_den_ben_gio', 4) > 0
    and exists (select 1 from public.trip_crew c where c.tenant_id = t.tenant_id and c.trip_id = t.id and c.role = 'lai_xe_1' and c.active);
  get diagnostics n = row_count;
  update public.trips t set arrived_at = t.departed_at + make_interval(hours => app.setting_int(t.tenant_id, 'chuyen.tu_den_ben_gio', 4)), arrived_auto = true
  where t.status = 'mo' and t.departed_at is not null and t.arrived_at is null
    and t.departed_at > now() - interval '1 day'
    and app.setting_int(t.tenant_id, 'chuyen.tu_den_ben_gio', 4) > 0
    and t.departed_at + make_interval(hours => app.setting_int(t.tenant_id, 'chuyen.tu_den_ben_gio', 4)) <= now();
  get diagnostics m = row_count;
  return n + m;
end;
$$;
revoke execute on function app.svc_auto_trip_marks() from public, anon, authenticated;

-- Chuyến của tôi: thêm cờ tự ghi
drop function public.my_trips(date, date);
create function public.my_trips(p_from date, p_to date)
returns table (trip_id uuid, service_date date, depart_at timestamptz, arrive_at timestamptz, route_id uuid, direction text,
               status text, plate text, my_role text, departed_at timestamptz, arrived_at timestamptz, order_no text,
               departed_auto boolean, arrived_auto boolean)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.service_date, t.depart_at, t.arrive_at, t.route_id, t.direction, t.status, v.plate, c.role,
         t.departed_at, t.arrived_at, o.order_no, t.departed_auto, t.arrived_auto
  from public.trip_crew c
  join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id and m.user_id = auth.uid()
  join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id
  left join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id
  left join public.transport_orders o on o.tenant_id = t.tenant_id and o.trip_id = t.id
  where c.tenant_id = app.current_tenant_id() and c.active
    and t.service_date between coalesce(p_from, app.local_today()) and least(coalesce(p_to, p_from, app.local_today()), coalesce(p_from, app.local_today()) + 31)
  order by t.depart_at
$$;
revoke execute on function public.my_trips(date, date) from public, anon, authenticated;
grant execute on function public.my_trips(date, date) to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('tu-xuat-den-ben', '* * * * *', 'select app.svc_auto_trip_marks()');
  else
    raise notice 'Máy chủ không có pg_cron: không tự ghi xuất bến / đến bến';
  end if;
exception when others then
  raise notice 'Không bật được tự ghi xuất bến / đến bến (%)', sqlerrm;
end;
$$;
