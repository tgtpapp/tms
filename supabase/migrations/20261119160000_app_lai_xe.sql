-- =====================================================================
-- Giai đoạn 6.1 – App lái xe
-- - Người được xếp vào chuyến (lái xe 1, 2, phụ xe; tài khoản gắn với hồ sơ nhân viên) xem chuyến của mình,
--   danh sách khách, đánh dấu lên xe, thu tiền vé chưa trả (tiền vào quỹ của người thu), báo xuất bến / đến bến.
-- - Không cần quyền bán vé / điều hành: quyền theo chính chuyến được xếp.
-- =====================================================================

alter table public.trips add column departed_at timestamptz;
alter table public.trips add column departed_by uuid;
alter table public.trips add column arrived_at timestamptz;
alter table public.trips add column arrived_by uuid;
alter table public.trips add check (arrived_at is null or departed_at is not null);

-- Người đang đăng nhập có được xếp vào chuyến này không
create function app.is_my_trip(p_trip uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.trip_crew c join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id
                 where c.tenant_id = app.current_tenant_id() and c.trip_id = p_trip and c.active and m.user_id = auth.uid())
$$;
revoke execute on function app.is_my_trip(uuid) from public, anon;
grant execute on function app.is_my_trip(uuid) to authenticated;

-- Chuyến của tôi trong khoảng ngày
create function public.my_trips(p_from date, p_to date)
returns table (trip_id uuid, service_date date, depart_at timestamptz, arrive_at timestamptz, route_id uuid, direction text,
               status text, plate text, my_role text, departed_at timestamptz, arrived_at timestamptz, order_no text)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.service_date, t.depart_at, t.arrive_at, t.route_id, t.direction, t.status, v.plate, c.role,
         t.departed_at, t.arrived_at, o.order_no
  from public.trip_crew c
  join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id and m.user_id = auth.uid()
  join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id
  left join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id
  left join public.transport_orders o on o.tenant_id = t.tenant_id and o.trip_id = t.id
  where c.tenant_id = app.current_tenant_id() and c.active
    and t.service_date between coalesce(p_from, app.local_today()) and least(coalesce(p_to, p_from, app.local_today()), coalesce(p_from, app.local_today()) + 31)
  order by t.depart_at
$$;

-- Xuất bến / đến bến
create function public.trip_mark(p_trip_id uuid, p_event text)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_t public.trips;
begin
  if v_tid is null or not (app.is_my_trip(p_trip_id) or app.has_permission('trip.manage')) then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  select * into v_t from public.trips where id = p_trip_id and tenant_id = v_tid for update;
  if not found then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  if v_t.status <> 'mo' then
    raise exception 'Chuyến đã hủy' using errcode = '22023';
  end if;
  if p_event = 'xuat_ben' then
    if v_t.departed_at is not null then return v_t.departed_at; end if;
    if v_t.vehicle_id is null then
      raise exception 'Chuyến chưa được xếp xe' using errcode = '22023';
    end if;
    if v_t.depart_at - now() > interval '3 hours' then
      raise exception 'Chưa tới giờ xuất bến (còn hơn 3 giờ)' using errcode = '22023';
    end if;
    update public.trips set departed_at = now(), departed_by = auth.uid() where id = p_trip_id;
    return now();
  elsif p_event = 'den_ben' then
    if v_t.departed_at is null then
      raise exception 'Chưa báo xuất bến' using errcode = '22023';
    end if;
    if v_t.arrived_at is not null then return v_t.arrived_at; end if;
    update public.trips set arrived_at = now(), arrived_by = auth.uid() where id = p_trip_id;
    return now();
  end if;
  raise exception 'Sự kiện không hợp lệ' using errcode = '22023';
end;
$$;

-- Đánh dấu lên xe: thêm quyền cho người được xếp vào chuyến
create or replace function public.set_boarded(p_ticket_id uuid, p_boarded boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_trip uuid;
begin
  select trip_id into v_trip from public.seat_inventory where id = p_ticket_id and tenant_id = v_tid;
  if v_tid is null or not (app.has_permission('ticket.sell') or app.has_permission('trip.manage') or (v_trip is not null and app.is_my_trip(v_trip))) then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  update public.seat_inventory set boarded = coalesce(p_boarded, false)
  where id = p_ticket_id and tenant_id = v_tid and status in ('dat', 'da_tt');
  if not found then
    raise exception 'Không tìm thấy vé' using errcode = 'P0002';
  end if;
end;
$$;

-- Lái xe / phụ xe thu tiền vé chưa trả (khách đặt chỗ trả tiền trên xe): tiền vào quỹ tiền mặt của người thu
create function public.crew_collect(p_ticket_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_s public.seat_inventory;
  v_code text;
begin
  select * into v_s from public.seat_inventory where id = p_ticket_id and tenant_id = v_tid for update;
  if v_tid is null or not found or not app.is_my_trip(v_s.trip_id) then
    raise exception 'Không tìm thấy vé' using errcode = 'P0002';
  end if;
  if v_s.status = 'da_tt' then return 0; end if;   -- đã thu (bấm 2 lần)
  if v_s.status <> 'dat' then
    raise exception 'Vé không còn hiệu lực' using errcode = '22023';
  end if;
  update public.seat_inventory set status = 'da_tt', paid_at = now(), paid_by = auth.uid(), hold_until = null, pay_method = 'tien_mat',
         boarded = true
  where id = p_ticket_id;
  select code into v_code from public.bookings where tenant_id = v_tid and id = v_s.booking_id;
  perform app.post_sale(v_tid, v_s.booking_id, v_s.price, 'Thu trên xe vé ' || coalesce(v_code, '') || ' ghế ' || v_s.seat_label, 'tien_mat');
  return v_s.price;
end;
$$;

revoke execute on function public.my_trips(date, date), public.trip_mark(uuid, text), public.crew_collect(uuid)
  from public, anon, authenticated;
grant execute on function public.my_trips(date, date), public.trip_mark(uuid, text), public.crew_collect(uuid) to authenticated;
