-- =====================================================================
-- Hợp đồng thuê xe ô tô (cá nhân cho nhà xe thuê phương tiện để kinh doanh vận tải): mỗi chủ xe 1 hợp đồng,
-- 1 hoặc nhiều xe (mỗi xe giá thuê riêng). Số tự cấp 001/<năm>/HĐTX-<ký hiệu nhà xe>, không trùng, không dùng lại.
-- Thông tin chủ xe (CCCD, địa chỉ, tài khoản) là dữ liệu cá nhân: chỉ người có quyền Sửa xe xem / lập.
-- PDF hợp đồng lưu vào hồ sơ từng xe (giấy "Hợp đồng thuê xe", có hạn) và Lưu trữ hồ sơ (làm ở giao diện).
-- Căn cứ pháp lý trong mẫu theo nhà xe cung cấp: cần xác minh.
-- =====================================================================
create table public.vehicle_leases (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant_id() references public.tenants (id),
  year        int not null,
  seq         int not null check (seq > 0),
  number      text not null,
  signed_on   date not null,
  start_on    date not null,
  end_on      date not null,
  pay_day     int check (pay_day is null or pay_day between 1 and 31),
  late_days   int check (late_days is null or late_days between 1 and 365),
  tax_party   text check (tax_party is null or tax_party in ('A', 'B')),
  lessor      jsonb not null default '{}' check (jsonb_typeof(lessor) = 'object'),     -- chủ xe (+ vợ / chồng nếu tài sản chung)
  bank        jsonb not null default '{}' check (jsonb_typeof(bank) = 'object'),       -- chủ tài khoản, số tài khoản, ngân hàng
  director    jsonb not null default '{}' check (jsonb_typeof(director) = 'object'),   -- ngày cấp / nơi cấp CCCD giám đốc, SĐT Bên B
  status      text not null default 'hieu_luc' check (status in ('hieu_luc', 'cham_dut')),
  note        text,
  request_id  uuid,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, year, seq),
  unique (tenant_id, request_id),
  check (end_on >= start_on)
);
create table public.vehicle_lease_items (
  tenant_id   uuid not null default app.current_tenant_id() references public.tenants (id),
  lease_id    uuid not null,
  vehicle_id  uuid not null,
  price       bigint not null default 0 check (price between 0 and 10000000000),
  primary key (tenant_id, lease_id, vehicle_id),
  foreign key (tenant_id, lease_id) references public.vehicle_leases (tenant_id, id) on delete cascade,
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id) on delete cascade
);
create index vehicle_lease_items_vehicle_idx on public.vehicle_lease_items (tenant_id, vehicle_id);
create trigger vehicle_leases_touch before update on public.vehicle_leases for each row execute function app.touch_updated_at();
create trigger vehicle_leases_audit after insert or update or delete on public.vehicle_leases for each row execute function app.write_audit();

alter table public.vehicle_leases enable row level security;
alter table public.vehicle_lease_items enable row level security;
revoke all on public.vehicle_leases, public.vehicle_lease_items from public, anon, authenticated;
grant select on public.vehicle_leases, public.vehicle_lease_items to authenticated;
grant select, insert, update, delete on public.vehicle_leases, public.vehicle_lease_items to service_role;
create policy vehicle_leases_select on public.vehicle_leases for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.edit'));
create policy vehicle_lease_items_select on public.vehicle_lease_items for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.edit'));

-- Lập (cấp số) hoặc sửa. p: {signed_on, start_on, end_on, pay_day, late_days, tax_party, lessor{}, bank{}, director{}, note,
--   items:[{vehicle_id, price}]}. Trả {id, number}.
create function public.save_vehicle_lease(p_id uuid, p jsonb, p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_start date := nullif(p ->> 'start_on', '')::date;
  v_end date := nullif(p ->> 'end_on', '')::date;
  v_signed date := coalesce(nullif(p ->> 'signed_on', '')::date, v_start);
  v_year int := extract(year from coalesce(v_signed, v_start))::int;
  v_seq int;
  v_suffix text;
  v_row public.vehicle_leases;
  v_items jsonb := coalesce(p -> 'items', '[]');
  e jsonb;
begin
  if v_tid is null or not app.has_permission('vehicle.edit') then
    raise exception 'Không có quyền lập hợp đồng thuê xe' using errcode = '42501';
  end if;
  if v_start is null or v_end is null or v_end < v_start then
    raise exception 'Nhập thời hạn thuê (ngày kết thúc sau ngày bắt đầu)' using errcode = '22023';
  end if;
  if nullif(trim(p -> 'lessor' ->> 'name'), '') is null then
    raise exception 'Nhập họ tên bên cho thuê' using errcode = '22023';
  end if;
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Chọn ít nhất 1 xe' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(v_items) loop
    if not exists (select 1 from public.vehicles where tenant_id = v_tid and id = nullif(e ->> 'vehicle_id', '')::uuid) then
      raise exception 'Không tìm thấy xe' using errcode = 'P0002';
    end if;
  end loop;

  if p_id is null then
    if p_request_id is not null then
      select * into v_row from public.vehicle_leases where tenant_id = v_tid and request_id = p_request_id;
      if found then return jsonb_build_object('id', v_row.id, 'number', v_row.number); end if;
    end if;
    v_seq := app.next_doc_no(v_tid, 'HDTX', v_year);
    if exists (select 1 from public.vehicle_leases where tenant_id = v_tid and year = v_year and seq >= v_seq) then
      select max(seq) + 1 into v_seq from public.vehicle_leases where tenant_id = v_tid and year = v_year;
      update public.doc_counters set last_no = v_seq where tenant_id = v_tid and code = 'HDTX' and year = v_year;
    end if;
    select upper(value #>> '{}') into v_suffix from public.tenant_settings where tenant_id = v_tid and key = 'lenh.hau_to';
    insert into public.vehicle_leases (tenant_id, year, seq, number, signed_on, start_on, end_on, pay_day, late_days, tax_party, lessor, bank, director, note, request_id)
    values (v_tid, v_year, v_seq, lpad(v_seq::text, 3, '0') || '/' || v_year || '/HĐTX' || coalesce('-' || nullif(trim(v_suffix), ''), ''),
            v_signed, v_start, v_end, nullif(p ->> 'pay_day', '')::int, nullif(p ->> 'late_days', '')::int, nullif(p ->> 'tax_party', ''),
            coalesce(p -> 'lessor', '{}'), coalesce(p -> 'bank', '{}'), coalesce(p -> 'director', '{}'), nullif(trim(p ->> 'note'), ''), p_request_id)
    returning * into v_row;
  else
    select * into v_row from public.vehicle_leases where tenant_id = v_tid and id = p_id for update;
    if not found then raise exception 'Không tìm thấy hợp đồng' using errcode = 'P0002'; end if;
    update public.vehicle_leases set signed_on = v_signed, start_on = v_start, end_on = v_end, pay_day = nullif(p ->> 'pay_day', '')::int,
      late_days = nullif(p ->> 'late_days', '')::int, tax_party = nullif(p ->> 'tax_party', ''), lessor = coalesce(p -> 'lessor', '{}'),
      bank = coalesce(p -> 'bank', '{}'), director = coalesce(p -> 'director', '{}'), note = nullif(trim(p ->> 'note'), '')
    where tenant_id = v_tid and id = p_id;
    delete from public.vehicle_lease_items where tenant_id = v_tid and lease_id = p_id;
  end if;
  insert into public.vehicle_lease_items (tenant_id, lease_id, vehicle_id, price)
  select v_tid, v_row.id, (x ->> 'vehicle_id')::uuid, greatest(0, coalesce(nullif(x ->> 'price', '')::numeric, 0))::bigint
  from jsonb_array_elements(v_items) x
  on conflict do nothing;
  return jsonb_build_object('id', v_row.id, 'number', v_row.number);
end;
$$;
revoke execute on function public.save_vehicle_lease(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_vehicle_lease(uuid, jsonb, uuid) to authenticated;

-- Chấm dứt / hiệu lực lại
create function public.set_vehicle_lease_status(p_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('vehicle.edit') then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  if p_status not in ('hieu_luc', 'cham_dut') then raise exception 'Trạng thái không hợp lệ' using errcode = '22023'; end if;
  update public.vehicle_leases set status = p_status where tenant_id = v_tid and id = p_id;
  if not found then raise exception 'Không tìm thấy hợp đồng' using errcode = 'P0002'; end if;
end;
$$;
revoke execute on function public.set_vehicle_lease_status(uuid, text) from public, anon, authenticated;
grant execute on function public.set_vehicle_lease_status(uuid, text) to authenticated;
