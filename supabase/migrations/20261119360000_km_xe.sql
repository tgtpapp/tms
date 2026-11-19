-- =====================================================================
-- Km xe đã chạy theo ngày (như app cũ "Km xe (Skysoft)"): nhập từ báo cáo GPS (file .xls / .xlsx / .csv hoặc dán bảng),
-- nhập tay. Một dòng / xe / ngày (nhập lại thì ghi đè). Dùng cho lý lịch phương tiện (km tháng, km lũy kế = Odo gốc + km đã chạy)
-- và tiêu hao nhiên liệu.
-- =====================================================================
create table public.vehicle_km (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant_id() references public.tenants (id),
  vehicle_id  uuid not null,
  run_date    date not null,
  km          numeric(9, 1) not null check (km >= 0 and km < 5000),
  source      text not null default 'tay' check (source in ('tay', 'gps', 'app_cu')),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, vehicle_id, run_date),
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id) on delete cascade
);
create index vehicle_km_day_idx on public.vehicle_km (tenant_id, run_date);
create trigger vehicle_km_touch before update on public.vehicle_km for each row execute function app.touch_updated_at();

alter table public.vehicle_km enable row level security;
revoke all on public.vehicle_km from public, anon, authenticated;
grant select, insert, update, delete on public.vehicle_km to authenticated, service_role;
create policy vehicle_km_select on public.vehicle_km for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('vehicle.manage') or app.has_permission('trip.manage')));
create policy vehicle_km_write on public.vehicle_km for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));

-- Nhập nhiều dòng: [{vehicle_id, run_date, km}] (tối đa 5000). Trả {created, updated, same}.
create function public.import_vehicle_km(p_rows jsonb, p_source text default 'gps')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  n_new int; n_upd int; n_all int;
begin
  if v_tid is null or not app.has_permission('vehicle.manage') then
    raise exception 'Không có quyền quản lý xe' using errcode = '42501';
  end if;
  if p_source not in ('tay', 'gps', 'app_cu') then raise exception 'Nguồn không hợp lệ' using errcode = '22023'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Mỗi lần tối đa 5000 dòng' using errcode = '22023';
  end if;
  create temp table if not exists pg_temp.km_in (vehicle_id uuid, run_date date, km numeric) on commit drop;
  truncate pg_temp.km_in;
  insert into pg_temp.km_in
  select distinct on ((e ->> 'vehicle_id')::uuid, (e ->> 'run_date')::date) (e ->> 'vehicle_id')::uuid, (e ->> 'run_date')::date, round((e ->> 'km')::numeric, 1)
  from jsonb_array_elements(p_rows) e
  where nullif(e ->> 'vehicle_id', '') is not null and nullif(e ->> 'run_date', '') is not null and coalesce((e ->> 'km')::numeric, -1) >= 0;
  if exists (select 1 from pg_temp.km_in k where not exists (select 1 from public.vehicles v where v.tenant_id = v_tid and v.id = k.vehicle_id)) then
    raise exception 'Không tìm thấy xe' using errcode = 'P0002';
  end if;
  if exists (select 1 from pg_temp.km_in where km >= 5000) then raise exception 'Km một ngày quá lớn (>= 5000)' using errcode = '22023'; end if;
  select count(*) into n_all from pg_temp.km_in;
  select count(*) into n_upd from pg_temp.km_in k join public.vehicle_km x on x.tenant_id = v_tid and x.vehicle_id = k.vehicle_id and x.run_date = k.run_date and x.km <> k.km;
  select count(*) into n_new from pg_temp.km_in k where not exists (select 1 from public.vehicle_km x where x.tenant_id = v_tid and x.vehicle_id = k.vehicle_id and x.run_date = k.run_date);
  insert into public.vehicle_km (tenant_id, vehicle_id, run_date, km, source)
  select v_tid, vehicle_id, run_date, km, p_source from pg_temp.km_in
  on conflict (tenant_id, vehicle_id, run_date) do update set km = excluded.km, source = excluded.source
    where public.vehicle_km.km is distinct from excluded.km;
  return jsonb_build_object('created', n_new, 'updated', n_upd, 'same', n_all - n_new - n_upd);
end;
$$;
revoke execute on function public.import_vehicle_km(jsonb, text) from public, anon, authenticated;
grant execute on function public.import_vehicle_km(jsonb, text) to authenticated;

-- Tổng hợp theo xe cho khoảng ngày [p_from, p_to): số ngày có chạy, km trong kỳ, km cộng dồn từ ngày ghi Odo gốc đến hết kỳ.
-- SECURITY INVOKER: đi qua RLS của vehicle_km / vehicles.
create function public.vehicle_km_summary(p_from date, p_to date)
returns table (vehicle_id uuid, days int, km numeric, km_since_odo numeric)
language sql stable security invoker set search_path = ''
as $$
  select v.id,
         count(*) filter (where k.run_date >= p_from and k.km > 0)::int,
         coalesce(sum(k.km) filter (where k.run_date >= p_from), 0),
         coalesce(sum(k.km) filter (where v.odo_date is null or k.run_date >= v.odo_date), 0)
  from public.vehicles v
  join public.vehicle_km k on k.tenant_id = v.tenant_id and k.vehicle_id = v.id and k.run_date < p_to
  group by v.id;
$$;
revoke execute on function public.vehicle_km_summary(date, date) from public, anon, authenticated;
grant execute on function public.vehicle_km_summary(date, date) to authenticated;
