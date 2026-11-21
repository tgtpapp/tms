-- =====================================================================
-- Lệnh vận chuyển 4 lượt (2 lượt đi + 2 lượt về) trên 1 tờ lệnh, cấp ở Bán vé và Điều hành.
-- - Số lệnh mới: <giờ xuất bến lượt đầu HHMM>-<ngày DDMMYYYY>-<3 số cuối biển số xe>/LVC-<hậu tố> (vd 0700-21112026-786/LVC-TGTP).
--   Lệnh đã cấp trước đây giữ nguyên số. Trùng số → thêm ".2", ".3"…
-- - Lượt đi / về lấy tự động theo lịch xếp xe (các chuyến kế tiếp của cùng xe, đổi chiều lần lượt), sau đó chỉnh tay được
--   (chọn chuyến khác, sửa giờ / ngày). Mỗi chuyến chỉ nằm trên 1 lệnh.
-- =====================================================================
create table public.transport_order_legs (
  tenant_id    uuid not null references public.tenants (id),
  order_id     uuid not null,
  seq          int not null check (seq between 1 and 4),   -- 1: lượt đi, 2: lượt về, 3: lượt đi, 4: lượt về
  trip_id      uuid,
  depart_time  text check (depart_time is null or depart_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  depart_date  date,
  primary key (tenant_id, order_id, seq),
  unique (tenant_id, trip_id),
  foreign key (tenant_id, order_id) references public.transport_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, trip_id) references public.trips (tenant_id, id)
);
alter table public.transport_order_legs enable row level security;
revoke all on public.transport_order_legs from public, anon, authenticated;
grant select on public.transport_order_legs to authenticated;
grant select, insert, update, delete on public.transport_order_legs to service_role;
create policy transport_order_legs_select on public.transport_order_legs for select to authenticated
  using (tenant_id = app.current_tenant_id());

-- lệnh đã cấp: lượt đi 1 = chuyến của lệnh
insert into public.transport_order_legs (tenant_id, order_id, seq, trip_id, depart_time, depart_date)
select o.tenant_id, o.id, 1, o.trip_id, to_char(t.depart_at at time zone app.tenant_tz(o.tenant_id), 'HH24:MI'), t.service_date
from public.transport_orders o join public.trips t on t.tenant_id = o.tenant_id and t.id = o.trip_id;

/** Lượt tự động theo lịch xếp: chuyến này rồi các chuyến kế tiếp của cùng xe (trong ngày và hôm sau), đổi chiều lần lượt, tối đa 4 */
create function app.order_auto_legs(p_tid uuid, p_trip uuid, p_order uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  t0 public.trips; x record; v_dir text; out jsonb; n int := 1;
  tz text := app.tenant_tz(p_tid);
begin
  select * into t0 from public.trips where tenant_id = p_tid and id = p_trip;
  out := jsonb_build_array(jsonb_build_object('trip_id', t0.id, 'time', to_char(t0.depart_at at time zone tz, 'HH24:MI'), 'date', t0.service_date));
  v_dir := t0.direction;
  if t0.vehicle_id is null then return out; end if;
  for x in
    select t.id, t.direction, t.depart_at, t.service_date from public.trips t
    where t.tenant_id = p_tid and t.vehicle_id = t0.vehicle_id and t.status = 'mo' and t.id <> t0.id
      and t.depart_at > t0.depart_at and t.service_date <= t0.service_date + 1
      and not exists (select 1 from public.transport_order_legs l where l.tenant_id = p_tid and l.trip_id = t.id and l.order_id is distinct from p_order)
    order by t.depart_at
  loop
    exit when n >= 4;
    continue when x.direction = v_dir;
    out := out || jsonb_build_array(jsonb_build_object('trip_id', x.id, 'time', to_char(x.depart_at at time zone tz, 'HH24:MI'), 'date', x.service_date));
    v_dir := x.direction; n := n + 1;
  end loop;
  return out;
end;
$$;
revoke execute on function app.order_auto_legs(uuid, uuid, uuid) from public, anon, authenticated;

/** Lệnh của chuyến (đã cấp: số lệnh + các lượt; chưa cấp: các lượt tự động theo lịch xếp) để xem / chỉnh trước khi cấp */
create function public.transport_order_draft(p_trip_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); o public.transport_orders;
begin
  if v_tid is null or not app.has_permission('trip.edit') then raise exception 'Không có quyền cấp lệnh' using errcode = '42501'; end if;
  if not exists (select 1 from public.trips where tenant_id = v_tid and id = p_trip_id) then raise exception 'Không tìm thấy chuyến' using errcode = 'P0002'; end if;
  select o2.* into o from public.transport_order_legs l join public.transport_orders o2 on o2.tenant_id = l.tenant_id and o2.id = l.order_id
  where l.tenant_id = v_tid and l.trip_id = p_trip_id;
  if found then
    return jsonb_build_object('order_id', o.id, 'order_no', o.order_no, 'legs',
      (select jsonb_agg(jsonb_build_object('seq', l.seq, 'trip_id', l.trip_id, 'time', l.depart_time, 'date', l.depart_date) order by l.seq)
       from public.transport_order_legs l where l.tenant_id = v_tid and l.order_id = o.id));
  end if;
  return jsonb_build_object('order_id', null, 'order_no', null, 'legs',
    (select jsonb_agg(e || jsonb_build_object('seq', i)) from jsonb_array_elements(app.order_auto_legs(v_tid, p_trip_id, null)) with ordinality a(e, i)));
end;
$$;

/** Cấp lệnh / lưu lại các lượt (giữ số lệnh), mỗi lần gọi = 1 lần in.
    p_legs: [{seq 1-4, trip_id?, time 'HH:MM'?, date?}]; null = lệnh đã cấp thì in lại, chưa cấp thì lấy lượt tự động. */
create function public.save_transport_order(p_trip_id uuid, p_legs jsonb)
returns public.transport_orders
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  o public.transport_orders; e jsonb; t1 public.trips; tr public.trips;
  v_suffix text; v_base text; v_no text; v_n int := 1; v_seq int; v_time text; v_date date; v_other text;
  v_plate text; v_from date; v_to date;
begin
  if v_tid is null or not app.has_permission('trip.edit') then raise exception 'Không có quyền cấp lệnh' using errcode = '42501'; end if;
  perform 1 from public.trips where tenant_id = v_tid and id = p_trip_id for update;
  if not found then raise exception 'Không tìm thấy chuyến' using errcode = 'P0002'; end if;
  select o2.* into o from public.transport_order_legs l join public.transport_orders o2 on o2.tenant_id = l.tenant_id and o2.id = l.order_id
  where l.tenant_id = v_tid and l.trip_id = p_trip_id;
  if p_legs is null then
    if o.id is not null then
      update public.transport_orders set print_count = print_count + 1 where tenant_id = v_tid and id = o.id returning * into o;
      return o;
    end if;
    p_legs := (select jsonb_agg(e2 || jsonb_build_object('seq', i)) from jsonb_array_elements(app.order_auto_legs(v_tid, p_trip_id, null)) with ordinality a(e2, i));
  end if;
  if jsonb_typeof(p_legs) <> 'array' or jsonb_array_length(p_legs) = 0 or jsonb_array_length(p_legs) > 4 then
    raise exception 'Lệnh có từ 1 đến 4 lượt' using errcode = '22023';
  end if;
  -- lượt đi đầu tiên phải là chuyến có trong lịch, đủ xe + lái xe 1
  select t.* into t1 from public.trips t
  where t.tenant_id = v_tid and t.id = (select (x ->> 'trip_id')::uuid from jsonb_array_elements(p_legs) x where (x ->> 'seq')::int = 1);
  if t1.id is null then raise exception 'Lượt đi đầu tiên phải chọn chuyến' using errcode = '22023'; end if;
  if t1.status <> 'mo' then raise exception 'Chuyến đã hủy, không cấp lệnh' using errcode = '22023'; end if;
  if t1.vehicle_id is null or not exists (select 1 from public.trip_crew where tenant_id = v_tid and trip_id = t1.id and role = 'lai_xe_1' and active) then
    raise exception 'Chuyến chưa đủ xe và lái xe, chưa cấp lệnh được' using errcode = '22023';
  end if;
  v_suffix := (select value #>> '{}' from public.tenant_settings where tenant_id = v_tid and key = 'lenh.hau_to');
  if v_suffix is null then raise exception 'Chưa cấu hình hậu tố số lệnh (Cấu hình → Lệnh vận chuyển)' using errcode = '22023'; end if;

  if o.id is null then
    v_plate := right(regexp_replace((select plate from public.vehicles where tenant_id = v_tid and id = t1.vehicle_id), '\D', '', 'g'), 3);
    v_base := to_char(t1.depart_at at time zone app.tenant_tz(v_tid), 'HH24MI') || '-' || to_char(t1.service_date, 'DDMMYYYY') || '-' || v_plate;
    v_no := v_base || '/LVC-' || v_suffix;
    while exists (select 1 from public.transport_orders where tenant_id = v_tid and order_no = v_no) loop
      v_n := v_n + 1; v_no := v_base || '.' || v_n || '/LVC-' || v_suffix;
    end loop;
    insert into public.transport_orders (tenant_id, trip_id, order_no, valid_from, valid_to, issued_by, print_count)
    values (v_tid, t1.id, v_no, t1.service_date, t1.service_date + 1, auth.uid(), 0) returning * into o;
  end if;
  delete from public.transport_order_legs where tenant_id = v_tid and order_id = o.id;
  v_from := t1.service_date; v_to := t1.service_date + 1;
  for e in select * from jsonb_array_elements(p_legs) loop
    v_seq := (e ->> 'seq')::int;
    if v_seq is null or v_seq < 1 or v_seq > 4 then raise exception 'Thứ tự lượt không hợp lệ' using errcode = '22023'; end if;
    tr := null;
    if nullif(e ->> 'trip_id', '') is not null then
      select * into tr from public.trips where tenant_id = v_tid and id = (e ->> 'trip_id')::uuid;
      if tr.id is null then raise exception 'Không tìm thấy chuyến' using errcode = 'P0002'; end if;
      if tr.status <> 'mo' then raise exception 'Chuyến % đã hủy', to_char(tr.depart_at at time zone app.tenant_tz(v_tid), 'HH24:MI DD/MM') using errcode = '22023'; end if;
      select o3.order_no into v_other from public.transport_order_legs l join public.transport_orders o3 on o3.tenant_id = l.tenant_id and o3.id = l.order_id
      where l.tenant_id = v_tid and l.trip_id = tr.id and l.order_id <> o.id;
      if v_other is not null then
        raise exception 'Chuyến % đã có trong lệnh %', to_char(tr.depart_at at time zone app.tenant_tz(v_tid), 'HH24:MI DD/MM'), v_other using errcode = '22023';
      end if;
    end if;
    v_time := coalesce(nullif(e ->> 'time', ''), case when tr.id is not null then to_char(tr.depart_at at time zone app.tenant_tz(v_tid), 'HH24:MI') end);
    v_date := coalesce(nullif(e ->> 'date', '')::date, tr.service_date);
    continue when tr.id is null and v_time is null and v_date is null;   -- lượt bỏ trống
    insert into public.transport_order_legs (tenant_id, order_id, seq, trip_id, depart_time, depart_date)
    values (v_tid, o.id, v_seq, tr.id, v_time, v_date);
    if v_date > v_to then v_to := v_date; end if;
  end loop;
  update public.transport_orders set trip_id = t1.id, valid_from = v_from, valid_to = v_to, print_count = print_count + 1
  where tenant_id = v_tid and id = o.id returning * into o;
  return o;
end;
$$;
revoke execute on function public.transport_order_draft(uuid), public.save_transport_order(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.transport_order_draft(uuid), public.save_transport_order(uuid, jsonb) to authenticated, service_role;

-- Cấp lệnh kiểu cũ (Điều hành, app lái xe…): cùng quy tắc mới
create or replace function public.issue_transport_order(p_trip_id uuid)
returns public.transport_orders
language sql security definer set search_path = ''
as $$ select public.save_transport_order(p_trip_id, null) $$;

-- Chuyến của tôi: số lệnh theo lượt (chuyến về cũng thấy số lệnh)
create or replace function public.my_trips(p_from date, p_to date)
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
  left join public.transport_order_legs l on l.tenant_id = t.tenant_id and l.trip_id = t.id
  left join public.transport_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
  where c.tenant_id = app.current_tenant_id() and c.active
    and t.service_date between coalesce(p_from, app.local_today()) and least(coalesce(p_to, p_from, app.local_today()), coalesce(p_from, app.local_today()) + 31)
  order by t.depart_at
$$;
