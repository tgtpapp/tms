-- =====================================================================
-- Lý lịch phương tiện kinh doanh vận tải (như app cũ, in 4 trang).
-- Lấy sẵn: thông tin xe, các lần kiểm định (giấy tờ kiểm định cũ + mới), tai nạn ghi ở lý lịch hành nghề lái xe (có xe),
-- số chuyến theo tháng. Nhập thêm: tài khoản GPS, Odo gốc, ngày ngừng / thanh lý, sự cố kỹ thuật / tai nạn của xe.
-- Mẫu sổ lý lịch theo quy định hiện hành: cần xác minh.
-- =====================================================================
alter table public.vehicles add column gsht_account text;      -- tài khoản truy cập GPS
alter table public.vehicles add column odo_start int check (odo_start is null or odo_start >= 0);
alter table public.vehicles add column odo_date date;
alter table public.vehicles add column retired_on date;         -- ngừng hoạt động / thanh lý

create table public.vehicle_incidents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default app.current_tenant_id() references public.tenants (id),
  vehicle_id   uuid not null,
  occurred_on  date not null,
  place        text,
  summary      text not null check (length(trim(summary)) between 1 and 1000),
  damage       text,
  resolution   text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id) on delete cascade
);
create index vehicle_incidents_vehicle_idx on public.vehicle_incidents (tenant_id, vehicle_id, occurred_on);
create trigger vehicle_incidents_touch before update on public.vehicle_incidents for each row execute function app.touch_updated_at();
create trigger vehicle_incidents_audit after insert or update or delete on public.vehicle_incidents for each row execute function app.write_audit();

alter table public.vehicle_incidents enable row level security;
revoke all on public.vehicle_incidents from public, anon, authenticated;
grant select, insert, update, delete on public.vehicle_incidents to authenticated, service_role;
create policy vehicle_incidents_select on public.vehicle_incidents for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('vehicle.manage') or app.has_permission('trip.manage')));
create policy vehicle_incidents_insert on public.vehicle_incidents for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));
create policy vehicle_incidents_update on public.vehicle_incidents for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));
create policy vehicle_incidents_delete on public.vehicle_incidents for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));
