-- =====================================================================
-- Giai đoạn 3.1 – Tuyến: điểm dừng, tuyến, thứ tự điểm dừng, giá vé
-- Giá: 1 giá toàn tuyến + giá riêng cho chặng (cặp điểm, 2 chiều như nhau).
-- Giá có lịch sử theo ngày áp dụng; chặng không có giá riêng → giá toàn tuyến.
-- =====================================================================

-- ---------------------------------------------------------------- Quyền mới
insert into public.permissions (code, module, name) values
  ('route.manage', 'van_tai', 'Quản lý tuyến và điểm dừng'),
  ('fare.manage',  'van_tai', 'Quản lý giá vé');

-- Quyền mới được cấp cho Chủ nhà xe + Quản trị của mọi nhà xe đã có
create function app.grant_permission_to_admins(p_code text)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select r.tenant_id, r.id, p_code from public.roles r where r.code in ('owner', 'admin')
  on conflict do nothing
$$;
revoke execute on function app.grant_permission_to_admins(text) from public, anon, authenticated;

select app.grant_permission_to_admins('route.manage');
select app.grant_permission_to_admins('fare.manage');

-- ---------------------------------------------------------------- Ngày theo giờ địa phương
-- Database chạy giờ UTC; ngày nghiệp vụ tính theo múi giờ của nhà xe (mặc định Việt Nam).
create function app.local_today()
returns date
language sql stable security definer set search_path = ''
as $$
  select (now() at time zone coalesce(
    (select value #>> '{}' from public.tenant_settings
     where tenant_id = app.current_tenant_id() and key = 'he_thong.mui_gio'),
    'Asia/Ho_Chi_Minh'))::date
$$;
grant execute on function app.local_today() to authenticated, service_role;

-- ---------------------------------------------------------------- Điểm dừng của nhà xe
create table public.stops (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant_id() references public.tenants (id),
  code        text not null check (length(trim(code)) > 0),
  name        text not null check (length(trim(name)) > 0),
  kind        text not null default 'diem_don_tra'
              check (kind in ('ben_xe', 'van_phong', 'diem_don_tra', 'tram_dung')),
  province    text,
  address     text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

-- ---------------------------------------------------------------- Tuyến
create table public.routes (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant_id() references public.tenants (id),
  code             text not null check (length(trim(code)) > 0),
  name             text not null check (length(trim(name)) > 0),
  registered_code  text,                       -- mã số tuyến đăng ký với Sở
  distance_km      numeric(7, 1) check (distance_km is null or distance_km > 0),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

-- Điểm dừng theo thứ tự chiều đi (chiều về = ngược lại)
create table public.route_stops (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  route_id            uuid not null,
  seq                 int not null check (seq >= 1),
  stop_id             uuid not null,
  minutes_from_start  int not null default 0 check (minutes_from_start >= 0),
  allow_pickup        boolean not null default true,
  allow_dropoff       boolean not null default true,
  unique (tenant_id, id),
  unique (tenant_id, route_id, seq),
  unique (tenant_id, route_id, stop_id),
  foreign key (tenant_id, route_id) references public.routes (tenant_id, id) on delete cascade,
  foreign key (tenant_id, stop_id) references public.stops (tenant_id, id)
);

-- Giá vé: from_stop_id/to_stop_id cùng null = giá toàn tuyến; ngược lại = giá chặng.
-- Cặp điểm lưu theo thứ tự chuẩn (from < to) để 2 chiều dùng chung 1 giá.
-- price null ở dòng chặng = bỏ giá riêng từ ngày đó (quay về giá toàn tuyến).
create table public.route_fares (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  route_id        uuid not null,
  from_stop_id    uuid,
  to_stop_id      uuid,
  price           int check (price is null or price > 0),
  effective_from  date not null,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  check ((from_stop_id is null) = (to_stop_id is null)),
  check (from_stop_id is null or from_stop_id < to_stop_id),
  check (from_stop_id is not null or price is not null),
  unique nulls not distinct (tenant_id, route_id, from_stop_id, to_stop_id, effective_from),
  foreign key (tenant_id, route_id) references public.routes (tenant_id, id) on delete cascade,
  foreign key (tenant_id, from_stop_id) references public.stops (tenant_id, id),
  foreign key (tenant_id, to_stop_id) references public.stops (tenant_id, id)
);
create index route_fares_lookup_idx on public.route_fares (tenant_id, route_id, from_stop_id, to_stop_id, effective_from desc);

-- ---------------------------------------------------------------- Trigger
do $$
declare t text;
begin
  foreach t in array array['stops', 'routes'] loop
    execute format('create trigger %I before update on public.%I for each row execute function app.touch_updated_at()', t || '_touch', t);
  end loop;
  foreach t in array array['stops', 'routes', 'route_stops', 'route_fares'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app.write_audit()', t || '_audit', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- RLS + quyền
alter table public.stops       enable row level security;
alter table public.routes      enable row level security;
alter table public.route_stops enable row level security;
alter table public.route_fares enable row level security;

revoke all on public.stops, public.routes, public.route_stops, public.route_fares from anon, authenticated;
grant select on public.stops, public.routes, public.route_stops, public.route_fares to authenticated;
grant insert, update on public.stops, public.routes to authenticated;
grant select, insert, update, delete on public.stops, public.routes, public.route_stops, public.route_fares to service_role;

-- Mọi người trong nhà xe xem được (bán vé, điều hành cần); ghi khi có route.manage
create policy stops_select on public.stops for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy stops_insert on public.stops for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('route.manage'));
create policy stops_update on public.stops for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('route.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('route.manage'));

create policy routes_select on public.routes for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy routes_insert on public.routes for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('route.manage'));
create policy routes_update on public.routes for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('route.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('route.manage'));

create policy route_stops_select on public.route_stops for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy route_fares_select on public.route_fares for select to authenticated
  using (tenant_id = app.current_tenant_id());

-- ---------------------------------------------------------------- Hàm nghiệp vụ

-- Đặt lại toàn bộ danh sách điểm dừng của tuyến (chiều đi).
-- p_stops: [{ "stop_id": uuid, "minutes_from_start": int, "allow_pickup": bool, "allow_dropoff": bool }, ...]
create function public.set_route_stops(p_route_id uuid, p_stops jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_n int;
  v_prev int := -1;
  r record;
begin
  if v_tid is null or not app.has_permission('route.manage') then
    raise exception 'Không có quyền quản lý tuyến' using errcode = '42501';
  end if;
  if not exists (select 1 from public.routes where id = p_route_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy tuyến' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_stops) <> 'array' then
    raise exception 'Danh sách điểm dừng không hợp lệ' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_stops);
  if v_n < 2 then
    raise exception 'Tuyến phải có ít nhất 2 điểm dừng' using errcode = '22023';
  end if;

  for r in select (e ->> 'stop_id')::uuid as stop_id,
                  coalesce((e ->> 'minutes_from_start')::int, 0) as minutes,
                  coalesce((e ->> 'allow_pickup')::boolean, true) as pickup,
                  coalesce((e ->> 'allow_dropoff')::boolean, true) as dropoff,
                  ord
           from jsonb_array_elements(p_stops) with ordinality as x(e, ord) loop
    if not exists (select 1 from public.stops where id = r.stop_id and tenant_id = v_tid and is_active) then
      raise exception 'Điểm dừng thứ % không tồn tại hoặc đã ngừng hoạt động', r.ord using errcode = 'P0002';
    end if;
    if r.minutes < v_prev then
      raise exception 'Thời gian điểm dừng thứ % không được nhỏ hơn điểm trước', r.ord using errcode = '22023';
    end if;
    if r.ord = 1 and not r.pickup then
      raise exception 'Điểm đầu tuyến phải cho đón khách' using errcode = '22023';
    end if;
    if r.ord = v_n and not r.dropoff then
      raise exception 'Điểm cuối tuyến phải cho trả khách' using errcode = '22023';
    end if;
    v_prev := r.minutes;
  end loop;

  if (select count(distinct (e ->> 'stop_id')) from jsonb_array_elements(p_stops) e) <> v_n then
    raise exception 'Một điểm dừng chỉ xuất hiện một lần trong tuyến' using errcode = '22023';
  end if;
  if (select ((p_stops -> 0) ->> 'minutes_from_start')::int) is distinct from 0
     and (p_stops -> 0) ? 'minutes_from_start' then
    raise exception 'Điểm đầu tuyến phải có thời gian 0 phút' using errcode = '22023';
  end if;

  delete from public.route_stops where tenant_id = v_tid and route_id = p_route_id;
  insert into public.route_stops (tenant_id, route_id, seq, stop_id, minutes_from_start, allow_pickup, allow_dropoff)
  select v_tid, p_route_id, ord::int, (e ->> 'stop_id')::uuid,
         coalesce((e ->> 'minutes_from_start')::int, 0),
         coalesce((e ->> 'allow_pickup')::boolean, true),
         coalesce((e ->> 'allow_dropoff')::boolean, true)
  from jsonb_array_elements(p_stops) with ordinality as x(e, ord);
end;
$$;

-- Đặt giá. p_from/p_to null = giá toàn tuyến. p_price null (chỉ cho chặng) = bỏ giá riêng.
-- Cùng ngày áp dụng thì ghi đè (sửa nhầm trong ngày); khác ngày thì thêm dòng lịch sử.
create function public.set_fare(p_route_id uuid, p_from_stop uuid, p_to_stop uuid, p_price int,
                                p_effective_from date default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_a uuid := least(p_from_stop, p_to_stop);
  v_b uuid := greatest(p_from_stop, p_to_stop);
  v_eff date := coalesce(p_effective_from, app.local_today());
begin
  if v_tid is null or not app.has_permission('fare.manage') then
    raise exception 'Không có quyền quản lý giá vé' using errcode = '42501';
  end if;
  if not exists (select 1 from public.routes where id = p_route_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy tuyến' using errcode = 'P0002';
  end if;
  if (p_from_stop is null) <> (p_to_stop is null) then
    raise exception 'Chặng phải có cả điểm đi và điểm đến' using errcode = '22023';
  end if;
  if p_from_stop is not null then
    if p_from_stop = p_to_stop then
      raise exception 'Điểm đi và điểm đến phải khác nhau' using errcode = '22023';
    end if;
    if (select count(*) from public.route_stops
        where tenant_id = v_tid and route_id = p_route_id and stop_id in (p_from_stop, p_to_stop)) <> 2 then
      raise exception 'Hai điểm của chặng phải thuộc tuyến' using errcode = 'P0002';
    end if;
  elsif p_price is null then
    raise exception 'Giá toàn tuyến không được để trống' using errcode = '22023';
  end if;
  if p_price is not null and p_price <= 0 then
    raise exception 'Giá vé phải lớn hơn 0' using errcode = '22023';
  end if;
  if v_eff < app.local_today() then
    raise exception 'Ngày áp dụng không được ở quá khứ' using errcode = '22023';
  end if;

  insert into public.route_fares (tenant_id, route_id, from_stop_id, to_stop_id, price, effective_from, created_by)
  values (v_tid, p_route_id, v_a, v_b, p_price, v_eff, auth.uid())
  on conflict (tenant_id, route_id, from_stop_id, to_stop_id, effective_from)
  do update set price = excluded.price, created_at = now(), created_by = excluded.created_by;
end;
$$;

-- Giá vé áp dụng cho một chặng tại một ngày (2 chiều như nhau).
create function public.fare_for(p_route_id uuid, p_from_stop uuid, p_to_stop uuid, p_at date default null)
returns int
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_a uuid := least(p_from_stop, p_to_stop);
  v_b uuid := greatest(p_from_stop, p_to_stop);
  v_at date := coalesce(p_at, app.local_today());
  v_pair record;
  v_full int;
begin
  if v_tid is null or not exists (select 1 from public.routes where id = p_route_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy tuyến' using errcode = 'P0002';
  end if;
  if p_from_stop is null or p_from_stop = p_to_stop
     or (select count(*) from public.route_stops
         where tenant_id = v_tid and route_id = p_route_id and stop_id in (p_from_stop, p_to_stop)) <> 2 then
    raise exception 'Chặng không thuộc tuyến' using errcode = 'P0002';
  end if;

  select price into v_pair from public.route_fares
  where tenant_id = v_tid and route_id = p_route_id and from_stop_id = v_a and to_stop_id = v_b
    and effective_from <= v_at
  order by effective_from desc limit 1;
  if found and v_pair.price is not null then
    return v_pair.price;
  end if;

  select price into v_full from public.route_fares
  where tenant_id = v_tid and route_id = p_route_id and from_stop_id is null and effective_from <= v_at
  order by effective_from desc limit 1;
  if v_full is null then
    raise exception 'Tuyến chưa có giá vé' using errcode = 'P0002';
  end if;
  return v_full;
end;
$$;

revoke execute on function public.set_route_stops(uuid, jsonb), public.set_fare(uuid, uuid, uuid, int, date),
  public.fare_for(uuid, uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.set_route_stops(uuid, jsonb), public.set_fare(uuid, uuid, uuid, int, date),
  public.fare_for(uuid, uuid, uuid, date) to authenticated;
