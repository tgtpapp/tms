-- Định vị xe qua app lái xe (đã duyệt 27/11/2026):
-- - Chỉ ghi khi lái xe đang chạy chuyến (đã xuất bến, chưa đến bến) và lái xe đã đồng ý cho gửi vị trí (Luật BVDLCN 91/2025 – cần xác minh thêm).
-- - Máy lái xe gửi khoảng 1 phút / lần (chỉ khi app đang mở: giới hạn của app web).
-- - Văn phòng (quyền xem điều hành) và Admin xem vị trí mới nhất các xe đang chạy.
-- - Lịch sử vị trí giữ 30 ngày rồi tự xóa (mức 30 ngày cần xác minh).

create table public.tracking_consents (
  tenant_id  uuid not null references public.tenants (id),
  user_id    uuid not null,
  agreed_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
alter table public.tracking_consents enable row level security;
revoke all on public.tracking_consents from public, anon, authenticated;
grant select on public.tracking_consents to authenticated;
grant select, insert, update, delete on public.tracking_consents to service_role;
create policy tracking_consents_select on public.tracking_consents for select to authenticated
  using (tenant_id = app.current_tenant_id() and (user_id = auth.uid() or app.is_tenant_admin()));

create table public.vehicle_positions (
  tenant_id  uuid not null references public.tenants (id),
  id         uuid not null default gen_random_uuid(),
  trip_id    uuid not null,
  vehicle_id uuid,
  user_id    uuid not null,
  at         timestamptz not null default now(),
  lat        numeric(9, 6) not null check (lat between 8 and 24),
  lng        numeric(9, 6) not null check (lng between 102 and 110),
  acc        int check (acc is null or acc between 0 and 100000),
  speed      numeric(6, 1) check (speed is null or speed between 0 and 400),   -- km/h
  heading    int check (heading is null or heading between 0 and 360),
  primary key (tenant_id, id),
  foreign key (tenant_id, trip_id) references public.trips (tenant_id, id) on delete cascade
);
create index vehicle_positions_trip_idx on public.vehicle_positions (tenant_id, trip_id, at desc);
create index vehicle_positions_at_idx on public.vehicle_positions (tenant_id, at);
alter table public.vehicle_positions enable row level security;
revoke all on public.vehicle_positions from public, anon, authenticated;
grant select on public.vehicle_positions to authenticated;
grant select, insert, update, delete on public.vehicle_positions to service_role;
-- Đọc: văn phòng (xem điều hành), Admin; lái xe xem được vị trí của chính mình
create policy vehicle_positions_select on public.vehicle_positions for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('trip.view') or app.is_tenant_admin() or user_id = auth.uid()));

/** Lái xe đồng ý cho gửi vị trí trong chuyến */
create function public.tracking_agree()
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or auth.uid() is null then raise exception 'Không có quyền' using errcode = '42501'; end if;
  insert into public.tracking_consents (tenant_id, user_id) values (v_tid, auth.uid()) on conflict (tenant_id, user_id) do nothing;
end;
$$;
revoke execute on function public.tracking_agree() from public, anon, authenticated;
grant execute on function public.tracking_agree() to authenticated, service_role;

/** Lái xe thôi đồng ý: ngừng gửi vị trí */
create function public.tracking_withdraw()
returns void
language sql security definer set search_path = ''
as $$ delete from public.tracking_consents where tenant_id = app.current_tenant_id() and user_id = auth.uid() $$;
revoke execute on function public.tracking_withdraw() from public, anon, authenticated;
grant execute on function public.tracking_withdraw() to authenticated, service_role;

/** Máy lái xe gửi 1 vị trí. Trả: 'luu' | 'bo_qua' (chưa đồng ý / chuyến chưa chạy hoặc đã đến / gửi quá dày) */
create function public.track_point(p_trip_id uuid, p_lat numeric, p_lng numeric, p_acc numeric, p_speed numeric, p_heading numeric)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  t public.trips;
begin
  if v_tid is null or auth.uid() is null then raise exception 'Không có quyền' using errcode = '42501'; end if;
  select * into t from public.trips where tenant_id = v_tid and id = p_trip_id;
  if not found or not app.is_my_trip(p_trip_id) then raise exception 'Không tìm thấy chuyến' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.tracking_consents where tenant_id = v_tid and user_id = auth.uid()) then return 'bo_qua'; end if;
  if t.status <> 'mo' or t.departed_at is null or t.arrived_at is not null then return 'bo_qua'; end if;
  if p_lat is null or p_lng is null or p_lat not between 8 and 24 or p_lng not between 102 and 110 then return 'bo_qua'; end if;
  if coalesce(p_acc, 0) > 2000 then return 'bo_qua'; end if;   -- vị trí quá sai
  if exists (select 1 from public.vehicle_positions where tenant_id = v_tid and trip_id = p_trip_id and user_id = auth.uid() and at > now() - interval '20 seconds') then
    return 'bo_qua';
  end if;
  insert into public.vehicle_positions (tenant_id, trip_id, vehicle_id, user_id, lat, lng, acc, speed, heading)
  values (v_tid, p_trip_id, t.vehicle_id, auth.uid(), round(p_lat, 6), round(p_lng, 6), round(p_acc)::int,
          case when p_speed between 0 and 400 then round(p_speed, 1) end, case when p_heading between 0 and 360 then round(p_heading)::int end);
  return 'luu';
end;
$$;
revoke execute on function public.track_point(uuid, numeric, numeric, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.track_point(uuid, numeric, numeric, numeric, numeric, numeric) to authenticated, service_role;

/** Văn phòng / Admin: vị trí mới nhất của các chuyến đang chạy (đã xuất bến, chưa đến bến) */
create function public.live_vehicles()
returns table (trip_id uuid, depart_at timestamptz, route_id uuid, direction text, plate text, driver text, at timestamptz,
               lat numeric, lng numeric, speed numeric, heading int)
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not (app.has_permission('trip.view') or app.is_tenant_admin()) then
    raise exception 'Không có quyền xem vị trí xe' using errcode = '42501';
  end if;
  return query
  select t.id, t.depart_at, t.route_id, t.direction, v.plate,
         (select m.full_name from public.trip_crew c join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id
           where c.tenant_id = t.tenant_id and c.trip_id = t.id and c.active order by c.role limit 1),
         p.at, p.lat, p.lng, p.speed, p.heading
  from public.trips t
  left join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id
  left join lateral (select x.at, x.lat, x.lng, x.speed, x.heading from public.vehicle_positions x
                     where x.tenant_id = t.tenant_id and x.trip_id = t.id order by x.at desc limit 1) p on true
  where t.tenant_id = v_tid and t.status = 'mo' and t.departed_at is not null and t.arrived_at is null
    and t.service_date between app.local_today() - 1 and app.local_today()
  order by t.depart_at;
end;
$$;
revoke execute on function public.live_vehicles() from public, anon, authenticated;
grant execute on function public.live_vehicles() to authenticated, service_role;

/** Xóa vị trí cũ hơn 30 ngày (chạy mỗi đêm, 3 giờ 20 sáng giờ Việt Nam) */
create function public.svc_purge_positions()
returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  delete from public.vehicle_positions where at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.svc_purge_positions() from public, anon, authenticated;
grant execute on function public.svc_purge_positions() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('xoa-vi-tri-cu', '20 20 * * *', 'select public.svc_purge_positions()');
  else
    raise notice 'Máy chủ không có pg_cron: không tự xóa vị trí cũ';
  end if;
exception when others then
  raise notice 'Không bật được tự xóa vị trí cũ (%)', sqlerrm;
end;
$$;
