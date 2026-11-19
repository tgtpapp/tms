-- =====================================================================
-- Sửa chữa xe (như app cũ): phiếu sửa chữa PSX0001…, xe, ngày, số km (Odo), đơn vị sửa (gara), các hạng mục (nội dung, số lượng, đơn giá),
-- ảnh hóa đơn / phiếu (Storage giay-to/<nhà xe>/xe/<xe>/…). Tự hiện ở Lý lịch phương tiện (bảo dưỡng, sửa chữa).
-- Đây là sổ theo dõi kỹ thuật, chưa ghi vào sổ quỹ (sổ quỹ / chi phí làm ở Giai đoạn 7).
-- =====================================================================
create table public.repair_orders (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default app.current_tenant_id() references public.tenants (id),
  code         text not null,
  vehicle_id   uuid not null,
  repaired_on  date not null,
  odo_km       int check (odo_km is null or odo_km >= 0),
  workshop     text,                       -- gara / xưởng
  kind         text not null default 'sua_chua' check (kind in ('bao_duong', 'sua_chua', 'thay_the')),
  note         text,
  files        text[] not null default '{}',
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id) on delete cascade
);
create index repair_orders_vehicle_idx on public.repair_orders (tenant_id, vehicle_id, repaired_on);
create index repair_orders_day_idx on public.repair_orders (tenant_id, repaired_on);

create table public.repair_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant_id() references public.tenants (id),
  order_id    uuid not null,
  seq         int not null,
  content     text not null check (length(trim(content)) between 1 and 500),
  qty         numeric(10, 2) not null default 1 check (qty > 0),
  unit_price  bigint not null default 0 check (unit_price >= 0),
  unique (tenant_id, order_id, seq),
  foreign key (tenant_id, order_id) references public.repair_orders (tenant_id, id) on delete cascade
);

-- Số phiếu tự tăng theo nhà xe
create function app.repair_code()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.code is null or trim(new.code) = '' then
    perform pg_advisory_xact_lock(hashtext('repair_code:' || new.tenant_id::text));
    select 'PSX' || lpad((coalesce(max(nullif(regexp_replace(code, '\D', '', 'g'), '')::int), 0) + 1)::text, 4, '0') into new.code
    from public.repair_orders where tenant_id = new.tenant_id;
  end if;
  return new;
end;
$$;
create trigger repair_orders_code before insert on public.repair_orders for each row execute function app.repair_code();
create trigger repair_orders_touch before update on public.repair_orders for each row execute function app.touch_updated_at();
create trigger repair_orders_audit after insert or update or delete on public.repair_orders for each row execute function app.write_audit();
create trigger repair_items_audit after insert or update or delete on public.repair_items for each row execute function app.write_audit();
revoke execute on function app.repair_code() from public, anon, authenticated;

alter table public.repair_orders enable row level security;
alter table public.repair_items enable row level security;
revoke all on public.repair_orders, public.repair_items from public, anon, authenticated;
grant select, insert, update, delete on public.repair_orders, public.repair_items to authenticated, service_role;
create policy repair_orders_select on public.repair_orders for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('vehicle.manage') or app.has_permission('trip.manage')));
create policy repair_orders_write on public.repair_orders for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));
create policy repair_items_select on public.repair_items for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('vehicle.manage') or app.has_permission('trip.manage')));
create policy repair_items_write on public.repair_items for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));

-- Lưu phiếu + hạng mục một lần (thay toàn bộ hạng mục). Trả về id phiếu.
create function public.save_repair(p_id uuid, p jsonb, p_items jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  if v_tid is null or not app.has_permission('vehicle.manage') then
    raise exception 'Không có quyền quản lý xe' using errcode = '42501';
  end if;
  if not exists (select 1 from public.vehicles where tenant_id = v_tid and id = (p ->> 'vehicle_id')::uuid) then
    raise exception 'Không tìm thấy xe' using errcode = 'P0002';
  end if;
  if nullif(p ->> 'repaired_on', '') is null then raise exception 'Nhập ngày sửa' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_items, '[]')) <> 'array' then raise exception 'Hạng mục không hợp lệ' using errcode = '22023'; end if;
  if p_id is not null and not exists (select 1 from public.repair_orders where tenant_id = v_tid and id = p_id) then
    raise exception 'Không tìm thấy phiếu' using errcode = 'P0002';
  end if;
  insert into public.repair_orders (id, tenant_id, code, vehicle_id, repaired_on, odo_km, workshop, kind, note, files)
  values (v_id, v_tid, nullif(trim(p ->> 'code'), ''), (p ->> 'vehicle_id')::uuid, (p ->> 'repaired_on')::date, nullif(p ->> 'odo_km', '')::int,
          nullif(trim(p ->> 'workshop'), ''), coalesce(nullif(p ->> 'kind', ''), 'sua_chua'), nullif(trim(p ->> 'note'), ''),
          coalesce(array(select jsonb_array_elements_text(p -> 'files')), '{}'))
  on conflict (id) do update set vehicle_id = excluded.vehicle_id, repaired_on = excluded.repaired_on, odo_km = excluded.odo_km,
    workshop = excluded.workshop, kind = excluded.kind, note = excluded.note, files = excluded.files;
  delete from public.repair_items where tenant_id = v_tid and order_id = v_id;
  insert into public.repair_items (tenant_id, order_id, seq, content, qty, unit_price)
  select v_tid, v_id, ord::int, trim(e ->> 'content'), coalesce(nullif(e ->> 'qty', '')::numeric, 1), coalesce(nullif(e ->> 'unit_price', '')::bigint, 0)
  from jsonb_array_elements(coalesce(p_items, '[]')) with ordinality x(e, ord)
  where coalesce(trim(e ->> 'content'), '') <> '';
  return v_id;
end;
$$;
revoke execute on function public.save_repair(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_repair(uuid, jsonb, jsonb) to authenticated;
