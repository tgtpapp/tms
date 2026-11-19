-- =====================================================================
-- Nhiên liệu (như app cũ): nhập dầu vào bồn (ND…), cấp dầu từ bồn cho xe (XD…), đổ ngoài cây xăng (DN…).
-- Tồn bồn, giá bình quân gia quyền, tiêu hao L/100km theo xe được tính từ các phiếu (sổ theo dõi kỹ thuật,
-- chưa ghi vào sổ quỹ / chi phí – làm ở Giai đoạn 7). Định mức tiêu hao từng xe: vehicles.fuel_norm.
-- =====================================================================
alter table public.vehicles add column fuel_norm numeric(5, 2) check (fuel_norm is null or (fuel_norm > 0 and fuel_norm < 100));

-- Thiết lập bồn dầu của nhà xe
create table public.fuel_settings (
  tenant_id      uuid primary key default app.current_tenant_id() references public.tenants (id),
  tank_name      text not null default 'Bồn dầu công ty',
  fuel_type      text not null default 'Dầu DO 0,05S',
  capacity_l     numeric(10, 2) not null default 5000 check (capacity_l >= 0),
  opening_l      numeric(10, 2) not null default 0,      -- tồn đầu kỳ
  opening_price  bigint not null default 0 check (opening_price >= 0),
  opening_on     date,
  alert_l        numeric(10, 2) not null default 500 check (alert_l >= 0),   -- cảnh báo khi tồn dưới mức này
  updated_at     timestamptz not null default now()
);
create trigger fuel_settings_touch before update on public.fuel_settings for each row execute function app.touch_updated_at();
create trigger fuel_settings_audit after insert or update or delete on public.fuel_settings for each row execute function app.write_audit();

create table public.fuel_entries (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default app.current_tenant_id() references public.tenants (id),
  code         text not null,
  kind         text not null check (kind in ('nhap', 'bon', 'ngoai')),
  entry_date   date not null,
  entry_time   time,
  vehicle_id   uuid,
  driver_id    uuid,
  odo_km       int check (odo_km is null or odo_km >= 0),
  liters       numeric(10, 2) not null check (liters > 0),
  unit_price   bigint check (unit_price is null or unit_price >= 0),   -- cấp từ bồn để trống = lấy giá bình quân
  supplier     text,          -- nhà cung cấp (nhập bồn) / cây xăng (đổ ngoài)
  invoice_no   text,
  note         text,
  files        text[] not null default '{}',
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  check (kind = 'nhap' or vehicle_id is not null),
  check (kind <> 'nhap' or unit_price is not null),
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id) on delete cascade,
  foreign key (tenant_id, driver_id) references public.staff_members (tenant_id, id) on delete set null (driver_id)
);
create index fuel_entries_day_idx on public.fuel_entries (tenant_id, entry_date, entry_time);
create index fuel_entries_vehicle_idx on public.fuel_entries (tenant_id, vehicle_id, entry_date);

create function app.fuel_code()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_pre text := case new.kind when 'nhap' then 'ND' when 'bon' then 'XD' else 'DN' end;
begin
  if new.code is null or trim(new.code) = '' then
    perform pg_advisory_xact_lock(hashtext('fuel_code:' || new.tenant_id::text || v_pre));
    select v_pre || lpad((coalesce(max(nullif(regexp_replace(substr(code, 3), '\D', '', 'g'), '')::int), 0) + 1)::text, 5, '0') into new.code
    from public.fuel_entries where tenant_id = new.tenant_id and code like v_pre || '%';
  end if;
  return new;
end;
$$;
create trigger fuel_entries_code before insert on public.fuel_entries for each row execute function app.fuel_code();
create trigger fuel_entries_touch before update on public.fuel_entries for each row execute function app.touch_updated_at();
create trigger fuel_entries_audit after insert or update or delete on public.fuel_entries for each row execute function app.write_audit();
revoke execute on function app.fuel_code() from public, anon, authenticated;

alter table public.fuel_settings enable row level security;
alter table public.fuel_entries enable row level security;
revoke all on public.fuel_settings, public.fuel_entries from public, anon, authenticated;
grant select, insert, update, delete on public.fuel_settings, public.fuel_entries to authenticated, service_role;
create policy fuel_settings_select on public.fuel_settings for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('vehicle.manage') or app.has_permission('trip.manage')));
create policy fuel_settings_write on public.fuel_settings for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));
create policy fuel_entries_select on public.fuel_entries for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('vehicle.manage') or app.has_permission('trip.manage')));
create policy fuel_entries_write on public.fuel_entries for all to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));

-- Lưu một phiếu (thêm / sửa). p_id null = thêm. Trả về id.
create function public.save_fuel(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_kind text := coalesce(nullif(p ->> 'kind', ''), 'bon');
  v_veh uuid := nullif(p ->> 'vehicle_id', '')::uuid;
  v_drv uuid := nullif(p ->> 'driver_id', '')::uuid;
begin
  if v_tid is null or not app.has_permission('vehicle.manage') then
    raise exception 'Không có quyền quản lý xe' using errcode = '42501';
  end if;
  if v_kind not in ('nhap', 'bon', 'ngoai') then raise exception 'Loại phiếu không hợp lệ' using errcode = '22023'; end if;
  if nullif(p ->> 'entry_date', '') is null then raise exception 'Nhập ngày' using errcode = '22023'; end if;
  if coalesce(nullif(p ->> 'liters', '')::numeric, 0) <= 0 then raise exception 'Nhập số lít' using errcode = '22023'; end if;
  if v_kind = 'nhap' then v_veh := null; v_drv := null;
    if nullif(p ->> 'unit_price', '') is null then raise exception 'Nhập đơn giá dầu nhập bồn' using errcode = '22023'; end if;
  elsif v_veh is null then raise exception 'Chọn xe' using errcode = '22023';
  end if;
  if v_veh is not null and not exists (select 1 from public.vehicles where tenant_id = v_tid and id = v_veh) then
    raise exception 'Không tìm thấy xe' using errcode = 'P0002';
  end if;
  if v_drv is not null and not exists (select 1 from public.staff_members where tenant_id = v_tid and id = v_drv) then
    raise exception 'Không tìm thấy lái xe' using errcode = 'P0002';
  end if;
  if p_id is not null and not exists (select 1 from public.fuel_entries where tenant_id = v_tid and id = p_id) then
    raise exception 'Không tìm thấy phiếu' using errcode = 'P0002';
  end if;
  if p_id is not null and (select kind from public.fuel_entries where tenant_id = v_tid and id = p_id) <> v_kind then
    raise exception 'Không đổi loại phiếu được, hãy xóa và tạo phiếu mới' using errcode = '22023';
  end if;
  insert into public.fuel_entries (id, tenant_id, code, kind, entry_date, entry_time, vehicle_id, driver_id, odo_km, liters, unit_price, supplier, invoice_no, note, files)
  values (v_id, v_tid, nullif(trim(p ->> 'code'), ''), v_kind, (p ->> 'entry_date')::date, nullif(p ->> 'entry_time', '')::time, v_veh, v_drv,
          nullif(p ->> 'odo_km', '')::int, (p ->> 'liters')::numeric, nullif(p ->> 'unit_price', '')::bigint,
          nullif(trim(p ->> 'supplier'), ''), nullif(trim(p ->> 'invoice_no'), ''), nullif(trim(p ->> 'note'), ''),
          coalesce(array(select jsonb_array_elements_text(p -> 'files')), '{}'))
  on conflict (id) do update set entry_date = excluded.entry_date, entry_time = excluded.entry_time, vehicle_id = excluded.vehicle_id,
    driver_id = excluded.driver_id, odo_km = excluded.odo_km, liters = excluded.liters, unit_price = excluded.unit_price,
    supplier = excluded.supplier, invoice_no = excluded.invoice_no, note = excluded.note, files = excluded.files;
  return v_id;
end;
$$;
revoke execute on function public.save_fuel(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_fuel(uuid, jsonb) to authenticated;

-- Chuyển phiếu sửa chữa + nhiên liệu từ app cũ (giữ nguyên số phiếu; nhập lại không trùng theo số phiếu).
-- p_repairs: [{code, vehicle_id, repaired_on, odo_km, workshop, note, items:[{content, qty, unit_price}]}]
-- p_fuel:    [{code, kind, entry_date, entry_time, vehicle_id, driver_id, odo_km, liters, unit_price, supplier, invoice_no, note}]
create function public.import_legacy_ops(p_repairs jsonb, p_fuel jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  r jsonb;
  v_id uuid;
  n_rep int := 0; n_fuel int := 0; n_same int := 0;
  v_err jsonb := '[]';
begin
  if v_tid is null or not app.has_permission('vehicle.manage') then
    raise exception 'Không có quyền quản lý xe' using errcode = '42501';
  end if;
  if jsonb_array_length(coalesce(p_repairs, '[]')) + jsonb_array_length(coalesce(p_fuel, '[]')) > 1000 then
    raise exception 'Mỗi lần tối đa 1000 phiếu' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_repairs, '[]')) loop
    begin
      if exists (select 1 from public.repair_orders where tenant_id = v_tid and code = r ->> 'code') then n_same := n_same + 1; continue; end if;
      v_id := public.save_repair(null, r, coalesce(r -> 'items', '[]'));
      n_rep := n_rep + 1;
    exception when others then
      v_err := v_err || jsonb_build_object('code', r ->> 'code', 'error', sqlerrm);
    end;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_fuel, '[]')) loop
    begin
      if exists (select 1 from public.fuel_entries where tenant_id = v_tid and code = r ->> 'code') then n_same := n_same + 1; continue; end if;
      v_id := public.save_fuel(null, r);
      n_fuel := n_fuel + 1;
    exception when others then
      v_err := v_err || jsonb_build_object('code', r ->> 'code', 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('repairs', n_rep, 'fuel', n_fuel, 'same', n_same, 'errors', v_err);
end;
$$;
revoke execute on function public.import_legacy_ops(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.import_legacy_ops(jsonb, jsonb) to authenticated;
