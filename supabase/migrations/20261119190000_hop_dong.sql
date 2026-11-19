-- =====================================================================
-- Giai đoạn 6.4 – Vận tải hợp đồng (phân hệ riêng: không bán vé lẻ, không thu tiền theo từng khách)
-- - Hợp đồng: bên thuê, điểm đón / đến, lộ trình, thời gian, xe, lái xe, số khách, giá, đặt cọc, trạng thái.
-- - Danh sách hành khách đi xe hợp đồng.
-- - Tiền: thu theo hợp đồng (đặt cọc / thanh toán) vào doanh thu hợp đồng, tách khỏi tiền vé và tiền hàng.
-- - Pháp lý (cần xác minh): Nghị định về kinh doanh vận tải bằng xe ô tô hiện hành quy định hợp đồng vận tải (giấy hoặc điện tử)
--   và danh sách hành khách phải có trên xe; app lưu và in được, việc đáp ứng đủ yêu cầu pháp lý cần xác minh với cơ quan quản lý.
-- =====================================================================

alter table public.ledger_lines drop constraint ledger_lines_account_check;
alter table public.ledger_lines add check (account in ('tien_mat', 'ngan_hang', 'doanh_thu_ve', 'phi_huy_doi', 'doanh_thu_hang', 'thu_ho', 'doanh_thu_hop_dong'));

create table public.charters (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id),
  code             text not null,
  customer_name    text not null check (length(trim(customer_name)) between 1 and 200),
  customer_phone   text not null check (customer_phone ~ '^0[0-9]{9}$'),
  customer_tax_code text,
  customer_address text,
  pickup_place     text not null check (length(trim(pickup_place)) between 1 and 300),
  destination      text not null check (length(trim(destination)) between 1 and 300),
  itinerary        text,
  start_at         timestamptz not null,
  end_at           timestamptz not null,
  passengers       int not null check (passengers between 1 and 100),
  vehicle_id       uuid,
  driver1_id       uuid,
  driver2_id       uuid,
  price            int not null check (price between 0 and 2000000000),
  deposit          int not null default 0 check (deposit >= 0),
  status           text not null default 'nhap' check (status in ('nhap', 'da_ky', 'dang_chay', 'xong', 'huy')),
  note             text,
  cancel_reason    text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (end_at > start_at),
  check (deposit <= price),
  unique (tenant_id, id),
  unique (tenant_id, code),
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id),
  foreign key (tenant_id, driver1_id) references public.staff_members (tenant_id, id),
  foreign key (tenant_id, driver2_id) references public.staff_members (tenant_id, id)
);
create index charters_time_idx on public.charters (tenant_id, start_at);
create trigger charters_touch before update on public.charters for each row execute function app.touch_updated_at();
create trigger charters_audit after insert or update on public.charters for each row execute function app.write_audit();

create table public.charter_passengers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  charter_id  uuid not null,
  seq         int not null,
  full_name   text not null check (length(trim(full_name)) between 1 and 200),
  phone       text,
  birth_year  int check (birth_year is null or birth_year between 1900 and 2100),
  unique (tenant_id, charter_id, seq),
  foreign key (tenant_id, charter_id) references public.charters (tenant_id, id) on delete cascade
);

alter table public.charters enable row level security;
alter table public.charter_passengers enable row level security;
revoke all on public.charters, public.charter_passengers from anon, authenticated;
grant select on public.charters, public.charter_passengers to authenticated;
grant select, insert, update, delete on public.charters, public.charter_passengers to service_role;

create function app.is_my_charter(p_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.charters c join public.staff_members m on m.tenant_id = c.tenant_id and m.id in (c.driver1_id, c.driver2_id)
                 where c.tenant_id = app.current_tenant_id() and c.id = p_id and m.user_id = auth.uid())
$$;
revoke execute on function app.is_my_charter(uuid) from public, anon;
grant execute on function app.is_my_charter(uuid) to authenticated;

create policy charters_select on public.charters for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('trip.manage') or app.is_my_charter(id)));
create policy charter_passengers_select on public.charter_passengers for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('trip.manage') or app.is_my_charter(charter_id)));

alter table public.ledger_transactions add column charter_id uuid;
alter table public.ledger_transactions add foreign key (tenant_id, charter_id) references public.charters (tenant_id, id);

-- Lưu hợp đồng (tạo / sửa) + danh sách hành khách. Xe / lái xe không được trùng giờ với hợp đồng khác đang hiệu lực
-- và với chuyến tuyến cố định đã xếp.
create function public.save_charter(p_id uuid, p jsonb, p_passengers jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid := p_id;
  v_code text;
  v_start timestamptz := nullif(p ->> 'start_at', '')::timestamptz;
  v_end timestamptz := nullif(p ->> 'end_at', '')::timestamptz;
  v_veh uuid := nullif(p ->> 'vehicle_id', '')::uuid;
  v_d1 uuid := nullif(p ->> 'driver1_id', '')::uuid;
  v_d2 uuid := nullif(p ->> 'driver2_id', '')::uuid;
  v_status text;
  v_warn text[] := '{}';
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  if v_start is null or v_end is null or v_end <= v_start then
    raise exception 'Nhập thời gian đi và về (về sau đi)' using errcode = '22023';
  end if;
  if v_veh is not null and not exists (select 1 from public.vehicles where id = v_veh and tenant_id = v_tid and is_active) then
    raise exception 'Không tìm thấy xe' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(array[v_d1, v_d2]) d where d is not null
             and not exists (select 1 from public.staff_members where id = d and tenant_id = v_tid and is_active)) then
    raise exception 'Không tìm thấy lái xe' using errcode = 'P0002';
  end if;
  if v_d1 is not null and v_d1 = v_d2 then
    raise exception 'Lái xe 1 và 2 phải khác nhau' using errcode = '22023';
  end if;
  -- Trùng giờ
  if v_veh is not null and (exists (select 1 from public.charters c where c.tenant_id = v_tid and c.id is distinct from v_id and c.vehicle_id = v_veh
                                      and c.status in ('da_ky', 'dang_chay') and tstzrange(c.start_at, c.end_at) && tstzrange(v_start, v_end))
                             or exists (select 1 from public.trips t where t.tenant_id = v_tid and t.vehicle_id = v_veh and t.status = 'mo'
                                      and tstzrange(t.depart_at, t.arrive_at) && tstzrange(v_start, v_end))) then
    raise exception 'Xe đã có lịch (chuyến hoặc hợp đồng khác) trong thời gian này' using errcode = '23P01';
  end if;
  if exists (select 1 from unnest(array[v_d1, v_d2]) d where d is not null and (
       exists (select 1 from public.charters c where c.tenant_id = v_tid and c.id is distinct from v_id and c.status in ('da_ky', 'dang_chay')
               and d in (c.driver1_id, c.driver2_id) and tstzrange(c.start_at, c.end_at) && tstzrange(v_start, v_end))
       or exists (select 1 from public.trip_crew tc where tc.tenant_id = v_tid and tc.staff_id = d and tc.active and tc.during && tstzrange(v_start, v_end)))) then
    raise exception 'Lái xe đã có lịch trong thời gian này' using errcode = '23P01';
  end if;
  if jsonb_typeof(coalesce(p_passengers, '[]')) <> 'array' then
    raise exception 'Danh sách hành khách không hợp lệ' using errcode = '22023';
  end if;

  begin
    if v_id is null then
      insert into public.charters (tenant_id, code, customer_name, customer_phone, customer_tax_code, customer_address, pickup_place, destination,
                                   itinerary, start_at, end_at, passengers, vehicle_id, driver1_id, driver2_id, price, deposit, note, created_by)
      values (v_tid, 'HD' || to_char(app.local_today(), 'YYMMDD') || lpad((floor(random() * 10000))::int::text, 4, '0'),
              trim(p ->> 'customer_name'), regexp_replace(coalesce(p ->> 'customer_phone', ''), '[^0-9]', '', 'g'),
              nullif(trim(p ->> 'customer_tax_code'), ''), nullif(trim(p ->> 'customer_address'), ''), trim(p ->> 'pickup_place'),
              trim(p ->> 'destination'), nullif(trim(p ->> 'itinerary'), ''), v_start, v_end, coalesce((p ->> 'passengers')::int, 0),
              v_veh, v_d1, v_d2, coalesce((p ->> 'price')::int, -1), coalesce((p ->> 'deposit')::int, 0), nullif(trim(p ->> 'note'), ''), auth.uid())
      returning id, code into v_id, v_code;
    else
      select status into v_status from public.charters where id = v_id and tenant_id = v_tid for update;
      if not found then
        raise exception 'Không tìm thấy hợp đồng' using errcode = 'P0002';
      end if;
      if v_status in ('xong', 'huy') then
        raise exception 'Hợp đồng đã xong hoặc đã hủy, không sửa được' using errcode = '22023';
      end if;
      update public.charters set customer_name = trim(p ->> 'customer_name'),
             customer_phone = regexp_replace(coalesce(p ->> 'customer_phone', ''), '[^0-9]', '', 'g'),
             customer_tax_code = nullif(trim(p ->> 'customer_tax_code'), ''), customer_address = nullif(trim(p ->> 'customer_address'), ''),
             pickup_place = trim(p ->> 'pickup_place'), destination = trim(p ->> 'destination'), itinerary = nullif(trim(p ->> 'itinerary'), ''),
             start_at = v_start, end_at = v_end, passengers = coalesce((p ->> 'passengers')::int, 0), vehicle_id = v_veh,
             driver1_id = v_d1, driver2_id = v_d2, price = coalesce((p ->> 'price')::int, -1), deposit = coalesce((p ->> 'deposit')::int, 0),
             note = nullif(trim(p ->> 'note'), '')
      where id = v_id returning code into v_code;
    end if;
  exception when check_violation then
    raise exception 'Kiểm tra lại: tên và SĐT bên thuê (10 số), điểm đón / đến, số khách 1–100, giá, đặt cọc không quá giá' using errcode = '22023';
  end;

  delete from public.charter_passengers where tenant_id = v_tid and charter_id = v_id;
  insert into public.charter_passengers (tenant_id, charter_id, seq, full_name, phone, birth_year)
  select v_tid, v_id, x.ord, trim(x.e ->> 'full_name'), nullif(regexp_replace(coalesce(x.e ->> 'phone', ''), '[^0-9]', '', 'g'), ''),
         nullif(x.e ->> 'birth_year', '')::int
  from jsonb_array_elements(coalesce(p_passengers, '[]')) with ordinality x(e, ord)
  where nullif(trim(x.e ->> 'full_name'), '') is not null;
  if (select count(*) from public.charter_passengers where tenant_id = v_tid and charter_id = v_id)
     > (select passengers from public.charters where id = v_id) then
    raise exception 'Danh sách hành khách nhiều hơn số khách của hợp đồng' using errcode = '22023';
  end if;
  return jsonb_build_object('id', v_id, 'code', v_code);
end;
$$;

-- Đổi trạng thái: da_ky (cần xe + lái xe) → dang_chay → xong; huy (cần lý do)
create function public.set_charter_status(p_id uuid, p_status text, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_c public.charters;
begin
  select * into v_c from public.charters where id = p_id and tenant_id = v_tid for update;
  if v_tid is null or not found or not (app.has_permission('trip.manage') or (p_status in ('dang_chay', 'xong') and app.is_my_charter(p_id))) then
    raise exception 'Không tìm thấy hợp đồng' using errcode = 'P0002';
  end if;
  if v_c.status in ('xong', 'huy') then
    raise exception 'Hợp đồng đã xong hoặc đã hủy' using errcode = '22023';
  end if;
  if p_status = 'da_ky' then
    if v_c.vehicle_id is null or v_c.driver1_id is null then
      raise exception 'Chọn xe và lái xe trước khi ký' using errcode = '22023';
    end if;
  elsif p_status = 'dang_chay' then
    if v_c.status <> 'da_ky' then raise exception 'Hợp đồng chưa ký' using errcode = '22023'; end if;
  elsif p_status = 'xong' then
    if v_c.status <> 'dang_chay' then raise exception 'Hợp đồng chưa chạy' using errcode = '22023'; end if;
  elsif p_status = 'huy' then
    if nullif(trim(p_reason), '') is null then raise exception 'Nhập lý do hủy' using errcode = '22023'; end if;
  else
    raise exception 'Trạng thái không hợp lệ' using errcode = '22023';
  end if;
  update public.charters set status = p_status, cancel_reason = case when p_status = 'huy' then trim(p_reason) end where id = p_id;
end;
$$;

-- Thu tiền hợp đồng (đặt cọc / thanh toán): Nợ tiền / Có doanh_thu_hop_dong. Không vượt giá hợp đồng.
create function public.charter_payment(p_id uuid, p_amount int, p_method text, p_note text)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_c public.charters;
  v_paid bigint;
  v_txn uuid;
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  select * into v_c from public.charters where id = p_id and tenant_id = v_tid for update;
  if not found then
    raise exception 'Không tìm thấy hợp đồng' using errcode = 'P0002';
  end if;
  if v_c.status = 'huy' then raise exception 'Hợp đồng đã hủy' using errcode = '22023'; end if;
  if coalesce(p_method, '') not in ('tien_mat', 'chuyen_khoan') then
    raise exception 'Chọn tiền mặt hoặc chuyển khoản' using errcode = '22023';
  end if;
  select coalesce(sum(l.credit - l.debit), 0) into v_paid from public.ledger_lines l join public.ledger_transactions t on t.tenant_id = l.tenant_id and t.id = l.txn_id
  where t.tenant_id = v_tid and t.charter_id = p_id and l.account = 'doanh_thu_hop_dong';
  if p_amount is null or p_amount <= 0 or v_paid + p_amount > v_c.price then
    raise exception 'Số tiền phải > 0 và tổng đã thu không quá giá hợp đồng (còn %)', v_c.price - v_paid using errcode = '22023';
  end if;
  insert into public.ledger_transactions (tenant_id, kind, charter_id, note, created_by)
  values (v_tid, 'hop_dong', p_id, coalesce(nullif(trim(p_note), ''), 'Thu tiền hợp đồng ' || v_c.code), auth.uid()) returning id into v_txn;
  insert into public.ledger_lines (tenant_id, txn_id, account, holder_id, debit, credit) values
    (v_tid, v_txn, case p_method when 'chuyen_khoan' then 'ngan_hang' else 'tien_mat' end, auth.uid(), p_amount, 0),
    (v_tid, v_txn, 'doanh_thu_hop_dong', null, 0, p_amount);
  return v_paid + p_amount;
end;
$$;

-- Đã thu bao nhiêu (cho màn hình)
create function public.charter_paid(p_ids uuid[])
returns table (charter_id uuid, paid bigint)
language sql stable security definer set search_path = ''
as $$
  select t.charter_id, coalesce(sum(l.credit - l.debit), 0)::bigint
  from public.ledger_transactions t join public.ledger_lines l on l.tenant_id = t.tenant_id and l.txn_id = t.id and l.account = 'doanh_thu_hop_dong'
  where t.tenant_id = app.current_tenant_id() and t.charter_id = any (p_ids) and app.has_permission('trip.manage')
  group by t.charter_id
$$;

revoke execute on function public.save_charter(uuid, jsonb, jsonb), public.set_charter_status(uuid, text, text),
  public.charter_payment(uuid, int, text, text), public.charter_paid(uuid[]) from public, anon, authenticated;
grant execute on function public.save_charter(uuid, jsonb, jsonb), public.set_charter_status(uuid, text, text),
  public.charter_payment(uuid, int, text, text), public.charter_paid(uuid[]) to authenticated;
