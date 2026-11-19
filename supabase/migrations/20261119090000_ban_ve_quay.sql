-- =====================================================================
-- Giai đoạn 4.1 – Kho ghế + bán vé tại quầy
-- - MỘT kho ghế duy nhất: public.seat_inventory (mỗi dòng = 1 ghế trên 1 chặng của 1 chuyến).
--   Ràng buộc EXCLUDE chống bán trùng ghế chồng chặng, kể cả 2 quầy bấm cùng lúc.
-- - Trạng thái: giu (đang chọn ở quầy, hết hạn sau N phút) → dat (đặt chỗ trả sau) / da_tt (đã thanh toán);
--   het_han (giữ / đặt chỗ quá hạn, ghế được nhả), huy.
-- - Trình duyệt không ghi thẳng bảng ghế / tiền: chỉ qua RPC. Mọi RPC ghi có mã yêu cầu (idempotency).
-- - Tiền: sổ cái kép, chỉ thêm (không sửa / xóa); sai thì bút toán đảo.
--   Bán vé thu tiền mặt: Nợ "tien_mat" (của người thu) / Có "doanh_thu_ve".
-- =====================================================================

insert into public.permissions (code, module, name) values
  ('ticket.sell', 'ban_ve', 'Bán vé, đặt chỗ, thu tiền vé, danh sách khách');
select app.grant_permission_to_admins('ticket.sell');
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, 'ticket.sell' from public.roles r where r.code in ('seller', 'office_manager', 'dispatcher')
on conflict do nothing;

create or replace function app.seed_system_roles(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid; v_admin uuid; v_branch uuid; v_disp uuid; v_office uuid; v_seller uuid;
begin
  insert into public.roles (tenant_id, code, name, is_system) values
    (p_tenant_id, 'owner',          'Chủ nhà xe',         true),
    (p_tenant_id, 'admin',          'Quản trị',            true),
    (p_tenant_id, 'branch_manager', 'Quản lý chi nhánh',   true),
    (p_tenant_id, 'office_manager', 'Quản lý phòng vé',    true),
    (p_tenant_id, 'seller',         'Bán vé',              true),
    (p_tenant_id, 'dispatcher',     'Điều hành',           true),
    (p_tenant_id, 'accountant',     'Kế toán',             true),
    (p_tenant_id, 'driver',         'Lái xe',              true),
    (p_tenant_id, 'staff',          'Nhân viên',           true);

  select id into v_owner  from public.roles where tenant_id = p_tenant_id and code = 'owner';
  select id into v_admin  from public.roles where tenant_id = p_tenant_id and code = 'admin';
  select id into v_branch from public.roles where tenant_id = p_tenant_id and code = 'branch_manager';
  select id into v_disp   from public.roles where tenant_id = p_tenant_id and code = 'dispatcher';
  select id into v_office from public.roles where tenant_id = p_tenant_id and code = 'office_manager';
  select id into v_seller from public.roles where tenant_id = p_tenant_id and code = 'seller';

  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select p_tenant_id, r.id, p.code
  from (values (v_owner), (v_admin)) as r(id), public.permissions p;

  insert into public.role_permissions (tenant_id, role_id, permission_code) values
    (p_tenant_id, v_branch, 'office.manage'),
    (p_tenant_id, v_branch, 'user.read'),
    (p_tenant_id, v_disp,   'trip.manage'),
    (p_tenant_id, v_disp,   'ticket.sell'),
    (p_tenant_id, v_office, 'ticket.sell'),
    (p_tenant_id, v_seller, 'ticket.sell');
end;
$$;

-- ---------------------------------------------------------------- Cấu hình đặt chỗ
create or replace function app.validate_tenant_setting()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  v numeric;
  lim jsonb := '{
    "ban_ve.giu_ghe_quay_phut":     [1, 120, "Thời gian giữ ghế phải từ 1 đến 120 phút"],
    "ban_ve.giu_ghe_online_phut":   [1, 120, "Thời gian giữ ghế phải từ 1 đến 120 phút"],
    "ban_ve.nha_ghe_vexere_gio":    [0, 48,  "Giờ nhả ghế Vexere phải từ 0 đến 48"],
    "ban_ve.nha_dat_cho_truoc_phut":[0, 1440,"Nhả chỗ đặt trước giờ chạy phải từ 0 đến 1440 phút"],
    "giay_to.canh_bao_truoc_ngay":  [1, 180, "Số ngày cảnh báo giấy tờ phải từ 1 đến 180"],
    "chuyen.tao_truoc_ngay":        [1, 365, "Số ngày tạo chuyến trước phải từ 1 đến 365"],
    "lai_xe.gio_lien_tuc_toi_da":   [1, 12,  "Giờ lái liên tục tối đa phải từ 1 đến 12"],
    "lai_xe.gio_ngay_toi_da":       [1, 24,  "Giờ lái tối đa trong ngày phải từ 1 đến 24"],
    "lai_xe.gio_tuan_toi_da":       [1, 168, "Giờ lái tối đa trong tuần phải từ 1 đến 168"]
  }';
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if lim ? new.key then
    if jsonb_typeof(new.value) <> 'number' then
      raise exception 'Giá trị phải là số' using errcode = '22023';
    end if;
    v := (new.value #>> '{}')::numeric;
    if v <> trunc(v) then
      raise exception 'Giá trị phải là số nguyên' using errcode = '22023';
    end if;
    if v < (lim -> new.key ->> 0)::numeric or v > (lim -> new.key ->> 1)::numeric then
      raise exception '%', lim -> new.key ->> 2 using errcode = '22023';
    end if;
  elsif new.key = 'ban_ve.tu_nha_dat_cho' then
    if jsonb_typeof(new.value) <> 'boolean' then
      raise exception 'Giá trị phải là bật / tắt' using errcode = '22023';
    end if;
  elsif new.key = 'lenh.hau_to' then
    if jsonb_typeof(new.value) <> 'string' or (new.value #>> '{}') !~ '^[A-Z0-9]{1,10}$' then
      raise exception 'Hậu tố số lệnh: 1–10 chữ in hoa hoặc số, không dấu (vd TGTP)' using errcode = '22023';
    end if;
  elsif new.key in ('cong_ty.giam_doc', 'cong_ty.chuc_danh_ky', 've.ghi_chu') then
    if jsonb_typeof(new.value) <> 'string' or length(new.value #>> '{}') > 500 then
      raise exception 'Giá trị phải là chữ, tối đa 500 ký tự' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

create or replace function app.seed_default_settings(p_tenant_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.tenant_settings (tenant_id, key, value) values
    (p_tenant_id, 'ban_ve.giu_ghe_quay_phut',      '5'::jsonb),
    (p_tenant_id, 'ban_ve.giu_ghe_online_phut',    '15'::jsonb),
    (p_tenant_id, 'ban_ve.nha_ghe_vexere_gio',     '2'::jsonb),
    (p_tenant_id, 'ban_ve.tu_nha_dat_cho',         'true'::jsonb),
    (p_tenant_id, 'ban_ve.nha_dat_cho_truoc_phut', '60'::jsonb),
    (p_tenant_id, 'giay_to.canh_bao_truoc_ngay',   '30'::jsonb),
    (p_tenant_id, 'chuyen.tao_truoc_ngay',         '7'::jsonb),
    (p_tenant_id, 'lai_xe.gio_lien_tuc_toi_da',    '4'::jsonb),
    (p_tenant_id, 'lai_xe.gio_ngay_toi_da',        '10'::jsonb),
    (p_tenant_id, 'lai_xe.gio_tuan_toi_da',        '48'::jsonb)
  on conflict (tenant_id, key) do nothing
$$;
revoke execute on function app.seed_default_settings(uuid) from public, anon, authenticated;
select app.seed_default_settings(id) from public.tenants;

-- ---------------------------------------------------------------- Loại xe (sơ đồ ghế bán vé) của nốt / chuyến
alter table public.schedules add column vehicle_type_id uuid;
alter table public.schedules add foreign key (tenant_id, vehicle_type_id) references public.vehicle_types (tenant_id, id);
alter table public.trips add column vehicle_type_id uuid;
alter table public.trips add foreign key (tenant_id, vehicle_type_id) references public.vehicle_types (tenant_id, id);

create or replace function app.generate_trips_for(p_tenant uuid, p_until date, p_schedule uuid default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_tz text := app.tenant_tz(p_tenant);
  v_today date := (now() at time zone v_tz)::date;
  v_count int;
begin
  insert into public.trips (tenant_id, route_id, direction, schedule_id, service_date, depart_at, arrive_at, vehicle_type_id)
  select s.tenant_id, s.route_id, s.direction, s.id, d::date,
         (d::date + s.depart_time) at time zone v_tz,
         ((d::date + s.depart_time) at time zone v_tz) + make_interval(mins => app.route_minutes(s.tenant_id, s.route_id)),
         s.vehicle_type_id
  from public.schedules s
  cross join lateral generate_series(greatest(v_today, s.valid_from)::timestamp,
                                     least(p_until, coalesce(s.valid_to, p_until))::timestamp, interval '1 day') d
  where s.tenant_id = p_tenant and s.is_active and (p_schedule is null or s.id = p_schedule)
    and extract(isodow from d)::int = any (s.days_of_week)
    and app.route_minutes(s.tenant_id, s.route_id) > 0
  on conflict (tenant_id, schedule_id, service_date) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Đặt loại xe (sơ đồ ghế) cho nốt: áp cho các chuyến chưa có loại xe của nốt từ hôm nay
create function public.set_schedule_vehicle_type(p_schedule_id uuid, p_vehicle_type_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  if p_vehicle_type_id is not null and not exists (select 1 from public.vehicle_types where id = p_vehicle_type_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy loại xe' using errcode = 'P0002';
  end if;
  update public.schedules set vehicle_type_id = p_vehicle_type_id where id = p_schedule_id and tenant_id = v_tid;
  if not found then
    raise exception 'Không tìm thấy nốt' using errcode = 'P0002';
  end if;
  update public.trips set vehicle_type_id = p_vehicle_type_id
  where tenant_id = v_tid and schedule_id = p_schedule_id and service_date >= app.local_today() and vehicle_type_id is null;
end;
$$;

-- Đặt loại xe (sơ đồ ghế) cho 1 chuyến (vd chuyến tăng cường). Đã bán ghế không có trên sơ đồ mới → chặn.
create function public.set_trip_vehicle_type(p_trip_id uuid, p_vehicle_type_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  if not exists (select 1 from public.vehicle_types where id = p_vehicle_type_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy loại xe' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.seat_inventory s where s.tenant_id = v_tid and s.trip_id = p_trip_id and s.status in ('giu', 'dat', 'da_tt')
               and not exists (select 1 from public.vehicle_type_seats v where v.tenant_id = v_tid
                                 and v.vehicle_type_id = p_vehicle_type_id and v.label = s.seat_label)) then
    raise exception 'Có vé đã bán ở ghế không có trên sơ đồ mới' using errcode = '22023';
  end if;
  update public.trips set vehicle_type_id = p_vehicle_type_id where id = p_trip_id and tenant_id = v_tid;
  if not found then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------- Khách hàng (nhận ra khách cũ theo SĐT)
create table public.customers (
  tenant_id     uuid not null references public.tenants (id),
  phone         text not null check (phone ~ '^0[0-9]{9}$'),
  name          text,
  last_from_stop uuid,
  last_to_stop  uuid,
  last_pickup_note text,
  trips_count   int not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, phone)
);

-- ---------------------------------------------------------------- Đơn vé + kho ghế
create table public.bookings (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id),
  code         text not null,                -- mã vé in trên vé
  channel      text not null default 'quay' check (channel in ('quay', 'online', 'vexere', 'giay')),
  customer_phone text,
  customer_name  text,
  note         text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

create table public.seat_inventory (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  booking_id     uuid not null,
  trip_id        uuid not null,
  seat_label     text not null,
  from_stop_id   uuid not null,
  to_stop_id     uuid not null,
  from_idx       int not null,               -- thứ tự điểm theo CHIỀU chạy của chuyến (0 = điểm đầu)
  to_idx         int not null,
  price          int not null check (price >= 0),
  status         text not null check (status in ('giu', 'dat', 'da_tt', 'het_han', 'huy')),
  hold_until     timestamptz,               -- giu / dat: hết hạn thì tự nhả; null = giữ đến giờ chạy
  keep_reason    text,                      -- lý do "giữ đến giờ chạy" / gia hạn
  passenger_name text,
  passenger_phone text,
  pickup_note    text,
  dropoff_note   text,
  boarded        boolean not null default false,
  paid_at        timestamptz,
  paid_by        uuid,
  request_id     uuid,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (to_idx > from_idx),
  check (status not in ('giu') or hold_until is not null),
  check (status <> 'da_tt' or paid_at is not null),
  unique (tenant_id, id),
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id),
  foreign key (tenant_id, trip_id) references public.trips (tenant_id, id),
  -- Không bán trùng: cùng chuyến, cùng ghế, chặng chồng nhau, đang còn hiệu lực
  constraint seat_no_double_sale exclude using gist
    (tenant_id with =, trip_id with =, seat_label with =, int4range(from_idx, to_idx) with &&)
    where (status in ('giu', 'dat', 'da_tt'))
);
create index seat_inventory_trip_idx on public.seat_inventory (tenant_id, trip_id);
create index seat_inventory_hold_idx on public.seat_inventory (tenant_id, hold_until) where status in ('giu', 'dat');
create index seat_inventory_booking_idx on public.seat_inventory (tenant_id, booking_id);

-- ---------------------------------------------------------------- Sổ cái kép (chỉ thêm)
create table public.ledger_transactions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id),
  kind         text not null,                -- ban_ve, dao (bút toán đảo)…
  booking_id   uuid,
  reverses_id  uuid,                         -- giao dịch bị đảo
  note         text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id),
  foreign key (tenant_id, reverses_id) references public.ledger_transactions (tenant_id, id)
);
create table public.ledger_lines (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null,
  txn_id       uuid not null,
  account      text not null check (account in ('tien_mat', 'doanh_thu_ve')),
  holder_id    uuid,                         -- tien_mat: người đang giữ tiền
  debit        bigint not null default 0 check (debit >= 0),
  credit       bigint not null default 0 check (credit >= 0),
  check ((debit = 0) <> (credit = 0)),
  foreign key (tenant_id, txn_id) references public.ledger_transactions (tenant_id, id)
);
create index ledger_lines_holder_idx on public.ledger_lines (tenant_id, account, holder_id);

create function app.ledger_no_change()
returns trigger language plpgsql set search_path = ''
as $$
begin
  raise exception 'Sổ cái chỉ được thêm, không sửa / xóa (sai thì ghi bút toán đảo)' using errcode = '42501';
end;
$$;
create trigger ledger_transactions_no_change before update or delete on public.ledger_transactions
  for each row execute function app.ledger_no_change();
create trigger ledger_lines_no_change before update or delete on public.ledger_lines
  for each row execute function app.ledger_no_change();

-- Mỗi giao dịch phải cân: tổng Nợ = tổng Có (kiểm tra khi kết thúc giao dịch DB)
create function app.ledger_check_balance()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if (select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) from public.ledger_lines where txn_id = new.txn_id) <> 0 then
    raise exception 'Bút toán không cân (Nợ ≠ Có)' using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger ledger_lines_balance after insert on public.ledger_lines
  deferrable initially deferred for each row execute function app.ledger_check_balance();

create function app.post_cash_sale(p_tenant uuid, p_booking uuid, p_amount bigint, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_txn uuid;
begin
  if p_amount <= 0 then return; end if;
  insert into public.ledger_transactions (tenant_id, kind, booking_id, note, created_by)
  values (p_tenant, 'ban_ve', p_booking, p_note, auth.uid()) returning id into v_txn;
  insert into public.ledger_lines (tenant_id, txn_id, account, holder_id, debit, credit) values
    (p_tenant, v_txn, 'tien_mat', auth.uid(), p_amount, 0),
    (p_tenant, v_txn, 'doanh_thu_ve', null, 0, p_amount);
end;
$$;
revoke execute on function app.post_cash_sale(uuid, uuid, bigint, text), app.ledger_no_change(), app.ledger_check_balance()
  from public, anon, authenticated;

-- ---------------------------------------------------------------- Quyền + RLS
create trigger bookings_touch before update on public.bookings for each row execute function app.touch_updated_at();
create trigger seat_inventory_touch before update on public.seat_inventory for each row execute function app.touch_updated_at();
create trigger seat_inventory_audit after update or delete on public.seat_inventory for each row execute function app.write_audit();
create trigger bookings_audit after insert or update or delete on public.bookings for each row execute function app.write_audit();

alter table public.customers enable row level security;
alter table public.bookings enable row level security;
alter table public.seat_inventory enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_lines enable row level security;
revoke all on public.customers, public.bookings, public.seat_inventory, public.ledger_transactions, public.ledger_lines
  from anon, authenticated;
grant select on public.customers, public.bookings, public.seat_inventory, public.ledger_transactions, public.ledger_lines
  to authenticated;
grant select, insert, update, delete on public.customers, public.bookings, public.seat_inventory to service_role;
grant select, insert on public.ledger_transactions, public.ledger_lines to service_role;
grant usage on all sequences in schema public to service_role;

-- Ghế: mọi người trong nhà xe xem được (điều hành, lái xe cần danh sách khách)
create policy seat_inventory_select on public.seat_inventory for select to authenticated using (tenant_id = app.current_tenant_id());
create policy bookings_select on public.bookings for select to authenticated using (tenant_id = app.current_tenant_id());
create policy customers_select on public.customers for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('ticket.sell'));
-- Sổ cái: người bán xem tiền mình giữ; kế toán / chủ (settings.manage) xem tất cả
create policy ledger_transactions_select on public.ledger_transactions for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('settings.manage') or created_by = auth.uid()));
create policy ledger_lines_select on public.ledger_lines for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('settings.manage') or holder_id = auth.uid()));

-- ---------------------------------------------------------------- Hàm phụ
-- Nhả ghế hết hạn (giữ ở quầy / đặt chỗ quá giờ). p_trip null = toàn bộ (việc định kỳ).
create function app.release_expired(p_tenant uuid, p_trip uuid default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_n int;
begin
  update public.seat_inventory set status = 'het_han'
  where (p_tenant is null or tenant_id = p_tenant) and (p_trip is null or trip_id = p_trip)
    and status in ('giu', 'dat') and hold_until is not null and hold_until < now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
create function app.svc_release_expired_all()
returns int language sql security definer set search_path = ''
as $$ select app.release_expired(null, null) $$;
revoke execute on function app.release_expired(uuid, uuid), app.svc_release_expired_all() from public, anon, authenticated;
grant execute on function app.svc_release_expired_all() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('nha-ghe-het-han', '* * * * *', 'select app.svc_release_expired_all()');
  end if;
exception when others then
  raise notice 'Không đặt được việc nhả ghế định kỳ (%): ghế vẫn được nhả mỗi khi bán vé', sqlerrm;
end;
$$;

-- Thứ tự điểm dừng theo chiều chạy của chuyến (0 = điểm đầu)
create function app.stop_idx(p_tenant uuid, p_route uuid, p_dir text, p_stop uuid)
returns int
language sql stable security definer set search_path = ''
as $$
  select case when p_dir = 'di' then rn - 1 else cnt - rn end
  from (select stop_id, row_number() over (order by seq) as rn, count(*) over () as cnt
        from public.route_stops where tenant_id = p_tenant and route_id = p_route) x
  where stop_id = p_stop
$$;
revoke execute on function app.stop_idx(uuid, uuid, text, uuid) from public, anon, authenticated;

create function app.new_booking_code(p_tenant uuid)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v text;
  a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  loop
    v := '';
    for i in 1..6 loop
      v := v || substr(a, 1 + floor(random() * length(a))::int, 1);
    end loop;
    exit when not exists (select 1 from public.bookings where tenant_id = p_tenant and code = v);
  end loop;
  return v;
end;
$$;
revoke execute on function app.new_booking_code(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- Giữ ghế (bấm chọn ghế ở quầy)
-- Trả về {booking_id, ticket_id, hold_until}. Ghế đã có người (chồng chặng) → lỗi "ghế đã có người".
create function public.hold_seat(p_trip_id uuid, p_seat text, p_from_stop uuid, p_to_stop uuid, p_booking_id uuid, p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_trip public.trips;
  v_from int; v_to int;
  v_price int;
  v_booking uuid := p_booking_id;
  v_id uuid;
  v_until timestamptz;
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  if p_request_id is not null then
    select id, booking_id, hold_until into v_id, v_booking, v_until from public.seat_inventory
    where tenant_id = v_tid and request_id = p_request_id;
    if found then
      return jsonb_build_object('booking_id', v_booking, 'ticket_id', v_id, 'hold_until', v_until);
    end if;
  end if;
  select * into v_trip from public.trips where id = p_trip_id and tenant_id = v_tid;
  if not found then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  if v_trip.status <> 'mo' then
    raise exception 'Chuyến đã hủy' using errcode = '22023';
  end if;
  if v_trip.arrive_at < now() then
    raise exception 'Chuyến đã chạy xong, không bán vé' using errcode = '22023';
  end if;
  if v_trip.vehicle_type_id is null then
    raise exception 'Chuyến chưa có sơ đồ ghế: chọn loại xe cho nốt / chuyến ở mục Điều hành' using errcode = '22023';
  end if;
  if not exists (select 1 from public.vehicle_type_seats where tenant_id = v_tid and vehicle_type_id = v_trip.vehicle_type_id
                   and label = upper(trim(p_seat)) and is_sellable) then
    raise exception 'Ghế % không có trên sơ đồ hoặc không bán', p_seat using errcode = '22023';
  end if;
  v_from := app.stop_idx(v_tid, v_trip.route_id, v_trip.direction, p_from_stop);
  v_to := app.stop_idx(v_tid, v_trip.route_id, v_trip.direction, p_to_stop);
  if v_from is null or v_to is null or v_to <= v_from then
    raise exception 'Điểm đón phải trước điểm trả theo chiều chạy' using errcode = '22023';
  end if;
  v_price := public.fare_for(v_trip.route_id, p_from_stop, p_to_stop, v_trip.service_date);

  perform app.release_expired(v_tid, p_trip_id);

  if v_booking is null then
    insert into public.bookings (tenant_id, code, created_by) values (v_tid, app.new_booking_code(v_tid), auth.uid())
    returning id into v_booking;
  elsif not exists (select 1 from public.bookings where id = v_booking and tenant_id = v_tid and created_by = auth.uid()) then
    raise exception 'Không tìm thấy đơn vé' using errcode = 'P0002';
  end if;

  v_until := now() + make_interval(mins => app.setting_int(v_tid, 'ban_ve.giu_ghe_quay_phut', 5));
  begin
    insert into public.seat_inventory (tenant_id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx,
                                       price, status, hold_until, request_id, created_by)
    values (v_tid, v_booking, p_trip_id, upper(trim(p_seat)), p_from_stop, p_to_stop, v_from, v_to,
            v_price, 'giu', v_until, p_request_id, auth.uid())
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'Ghế % đã có người trên chặng này', upper(trim(p_seat)) using errcode = '23P01';
  end;
  return jsonb_build_object('booking_id', v_booking, 'ticket_id', v_id, 'hold_until', v_until);
end;
$$;

-- Bỏ chọn ghế đang giữ (chưa xác nhận)
create function public.unhold_seat(p_ticket_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  update public.seat_inventory set status = 'huy'
  where id = p_ticket_id and tenant_id = v_tid and status = 'giu' and created_by = auth.uid();
  if not found then
    raise exception 'Không tìm thấy ghế đang giữ' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------- Xác nhận: thu tiền ngay hoặc đặt chỗ trả sau
-- p_mode: 'thu_tien' | 'dat_cho'. p_keep: đặt chỗ giữ đến giờ chạy (không tự nhả), cần p_keep_reason.
-- p_passengers: [{ticket_id, name, phone}] (không bắt buộc, mặc định theo khách đặt)
create function public.confirm_booking(p_booking_id uuid, p_phone text, p_name text, p_mode text, p_keep boolean,
                                       p_keep_reason text, p_pickup_note text, p_dropoff_note text, p_note text,
                                       p_passengers jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_b public.bookings;
  v_total bigint;
  v_n int;
  v_auto boolean;
  v_before int;
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
  r record;
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  select * into v_b from public.bookings where id = p_booking_id and tenant_id = v_tid for update;
  if not found then
    raise exception 'Không tìm thấy đơn vé' using errcode = 'P0002';
  end if;
  perform app.release_expired(v_tid, null);
  -- Đã xác nhận rồi (bấm 2 lần): trả lại kết quả cũ
  if not exists (select 1 from public.seat_inventory where tenant_id = v_tid and booking_id = p_booking_id and status = 'giu') then
    if exists (select 1 from public.seat_inventory where tenant_id = v_tid and booking_id = p_booking_id and status in ('dat', 'da_tt')) then
      return jsonb_build_object('booking_id', v_b.id, 'code', v_b.code, 'repeated', true);
    end if;
    raise exception 'Hết thời gian giữ ghế, hãy chọn lại ghế' using errcode = '22023';
  end if;
  if p_mode not in ('thu_tien', 'dat_cho') then
    raise exception 'Chọn thu tiền ngay hoặc đặt chỗ' using errcode = '22023';
  end if;
  if v_phone is not null and v_phone !~ '^0[0-9]{9}$' then
    raise exception 'Số điện thoại phải gồm 10 số, bắt đầu bằng 0' using errcode = '22023';
  end if;
  if p_mode = 'dat_cho' and v_phone is null then
    raise exception 'Đặt chỗ trả sau phải có số điện thoại khách' using errcode = '22023';
  end if;
  if p_mode = 'dat_cho' and p_keep and nullif(trim(p_keep_reason), '') is null then
    raise exception 'Ghi lý do giữ chỗ đến giờ chạy' using errcode = '22023';
  end if;

  update public.bookings set customer_phone = v_phone, customer_name = nullif(trim(p_name), ''), note = nullif(trim(p_note), '')
  where id = v_b.id;

  v_auto := coalesce((select (value #>> '{}')::boolean from public.tenant_settings where tenant_id = v_tid and key = 'ban_ve.tu_nha_dat_cho'), true);
  v_before := app.setting_int(v_tid, 'ban_ve.nha_dat_cho_truoc_phut', 60);

  update public.seat_inventory s
  set status = case when p_mode = 'thu_tien' then 'da_tt' else 'dat' end,
      hold_until = case when p_mode = 'thu_tien' or p_keep or not v_auto then null
                        when t.depart_at - make_interval(mins => v_before) > now() then t.depart_at - make_interval(mins => v_before)
                        else t.depart_at end,   -- đặt sát giờ chạy: giữ đến giờ chạy
      keep_reason = case when p_mode = 'dat_cho' and p_keep then trim(p_keep_reason) end,
      paid_at = case when p_mode = 'thu_tien' then now() end,
      paid_by = case when p_mode = 'thu_tien' then auth.uid() end,
      passenger_name = coalesce(nullif(trim(p_name), ''), s.passenger_name),
      passenger_phone = coalesce(v_phone, s.passenger_phone),
      pickup_note = nullif(trim(p_pickup_note), ''),
      dropoff_note = nullif(trim(p_dropoff_note), '')
  from public.trips t
  where s.tenant_id = v_tid and s.booking_id = v_b.id and s.status = 'giu'
    and t.tenant_id = s.tenant_id and t.id = s.trip_id;
  get diagnostics v_n = row_count;

  -- Tên / SĐT riêng từng ghế (đi nhiều người)
  for r in select (e ->> 'ticket_id')::uuid as id, nullif(trim(e ->> 'name'), '') as name,
                  nullif(regexp_replace(coalesce(e ->> 'phone', ''), '[^0-9]', '', 'g'), '') as phone
           from jsonb_array_elements(coalesce(p_passengers, '[]')) e loop
    update public.seat_inventory set passenger_name = coalesce(r.name, passenger_name), passenger_phone = coalesce(r.phone, passenger_phone)
    where id = r.id and tenant_id = v_tid and booking_id = v_b.id;
  end loop;

  if p_mode = 'thu_tien' then
    select sum(price) into v_total from public.seat_inventory where tenant_id = v_tid and booking_id = v_b.id and status = 'da_tt';
    perform app.post_cash_sale(v_tid, v_b.id, v_total, 'Bán vé ' || v_b.code);
  end if;

  if v_phone is not null then
    insert into public.customers (tenant_id, phone, name, last_from_stop, last_to_stop, last_pickup_note, trips_count)
    select v_tid, v_phone, nullif(trim(p_name), ''), s.from_stop_id, s.to_stop_id, nullif(trim(p_pickup_note), ''), 1
    from public.seat_inventory s where s.tenant_id = v_tid and s.booking_id = v_b.id limit 1
    on conflict (tenant_id, phone) do update set
      name = coalesce(excluded.name, public.customers.name), last_from_stop = excluded.last_from_stop,
      last_to_stop = excluded.last_to_stop, last_pickup_note = coalesce(excluded.last_pickup_note, public.customers.last_pickup_note),
      trips_count = public.customers.trips_count + 1, updated_at = now();
  end if;
  return jsonb_build_object('booking_id', v_b.id, 'code', v_b.code, 'tickets', v_n, 'repeated', false);
end;
$$;

-- Thu tiền vé đặt chỗ (trả sau). p_ticket_ids null = cả đơn.
create function public.pay_booking(p_booking_id uuid, p_ticket_ids uuid[])
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_b public.bookings;
  v_total bigint;
  v_n int;
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  select * into v_b from public.bookings where id = p_booking_id and tenant_id = v_tid for update;
  if not found then
    raise exception 'Không tìm thấy đơn vé' using errcode = 'P0002';
  end if;
  perform app.release_expired(v_tid, null);
  with paid as (
    update public.seat_inventory set status = 'da_tt', paid_at = now(), paid_by = auth.uid(), hold_until = null
    where tenant_id = v_tid and booking_id = p_booking_id and status = 'dat' and (p_ticket_ids is null or id = any (p_ticket_ids))
    returning price
  )
  select coalesce(sum(price), 0), count(*) into v_total, v_n from paid;
  if v_n = 0 then
    -- Không còn ghế đặt chỗ nào để thu: đã thu rồi (bấm 2 lần) hoặc đã hết hạn / hủy
    if exists (select 1 from public.seat_inventory where tenant_id = v_tid and booking_id = p_booking_id and status = 'da_tt') then
      return 0;
    end if;
    raise exception 'Chỗ đặt đã hết hạn hoặc đã hủy' using errcode = '22023';
  end if;
  perform app.post_cash_sale(v_tid, p_booking_id, v_total, 'Thu tiền vé ' || v_b.code);
  return v_total;
end;
$$;

-- Gia hạn chỗ đặt: đến giờ chạy (p_keep) hoặc thêm p_minutes phút
create function public.extend_booking(p_booking_id uuid, p_keep boolean, p_minutes int, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Ghi lý do gia hạn' using errcode = '22023';
  end if;
  update public.seat_inventory s
  set hold_until = case when p_keep then null
                        else least(t.depart_at, greatest(coalesce(s.hold_until, now()), now()) + make_interval(mins => coalesce(p_minutes, 30))) end,
      keep_reason = trim(p_reason)
  from public.trips t
  where s.tenant_id = v_tid and s.booking_id = p_booking_id and s.status = 'dat'
    and t.tenant_id = s.tenant_id and t.id = s.trip_id;
  if not found then
    raise exception 'Không tìm thấy chỗ đặt còn hiệu lực' using errcode = 'P0002';
  end if;
end;
$$;

-- Sửa thông tin khách trên 1 vé
create function public.update_ticket_info(p_ticket_id uuid, p_name text, p_phone text, p_pickup_note text, p_dropoff_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  if v_phone is not null and v_phone !~ '^0[0-9]{9}$' then
    raise exception 'Số điện thoại phải gồm 10 số, bắt đầu bằng 0' using errcode = '22023';
  end if;
  update public.seat_inventory
  set passenger_name = nullif(trim(p_name), ''), passenger_phone = v_phone,
      pickup_note = nullif(trim(p_pickup_note), ''), dropoff_note = nullif(trim(p_dropoff_note), '')
  where id = p_ticket_id and tenant_id = v_tid and status in ('dat', 'da_tt');
  if not found then
    raise exception 'Không tìm thấy vé' using errcode = 'P0002';
  end if;
end;
$$;

-- Chuyển ghế / chuyển chuyến (cùng tuyến, cùng chiều, cùng chặng; giữ nguyên giá đã bán)
create function public.move_ticket(p_ticket_id uuid, p_trip_id uuid, p_seat text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_s public.seat_inventory;
  v_old public.trips;
  v_new public.trips;
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  select * into v_s from public.seat_inventory where id = p_ticket_id and tenant_id = v_tid and status in ('dat', 'da_tt') for update;
  if not found then
    raise exception 'Không tìm thấy vé' using errcode = 'P0002';
  end if;
  select * into v_old from public.trips where id = v_s.trip_id and tenant_id = v_tid;
  select * into v_new from public.trips where id = coalesce(p_trip_id, v_s.trip_id) and tenant_id = v_tid;
  if not found then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  if v_new.status <> 'mo' or v_new.route_id <> v_old.route_id or v_new.direction <> v_old.direction then
    raise exception 'Chỉ chuyển sang chuyến đang mở cùng tuyến, cùng chiều' using errcode = '22023';
  end if;
  if v_new.vehicle_type_id is null or not exists (select 1 from public.vehicle_type_seats where tenant_id = v_tid
       and vehicle_type_id = v_new.vehicle_type_id and label = upper(trim(p_seat)) and is_sellable) then
    raise exception 'Ghế % không có trên sơ đồ chuyến mới', p_seat using errcode = '22023';
  end if;
  perform app.release_expired(v_tid, v_new.id);
  begin
    update public.seat_inventory set trip_id = v_new.id, seat_label = upper(trim(p_seat)), boarded = false
    where id = p_ticket_id;
  exception when exclusion_violation then
    raise exception 'Ghế % đã có người trên chặng này', upper(trim(p_seat)) using errcode = '23P01';
  end;
end;
$$;

-- Đánh dấu khách đã lên xe (bán vé, điều hành)
create function public.set_boarded(p_ticket_id uuid, p_boarded boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not (app.has_permission('ticket.sell') or app.has_permission('trip.manage')) then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  update public.seat_inventory set boarded = coalesce(p_boarded, false)
  where id = p_ticket_id and tenant_id = v_tid and status in ('dat', 'da_tt');
  if not found then
    raise exception 'Không tìm thấy vé' using errcode = 'P0002';
  end if;
end;
$$;

-- Nhả ngay các ghế hết hạn của 1 chuyến (màn hình bán vé gọi khi mở chuyến)
create function public.refresh_trip_seats(p_trip_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  return app.release_expired(v_tid, p_trip_id);
end;
$$;

-- ---------------------------------------------------------------- Xếp xe: không đổi sang xe khác sơ đồ khi đã bán
create function app.check_trip_type_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_type uuid;
begin
  if new.vehicle_id is distinct from old.vehicle_id and new.vehicle_id is not null then
    select vehicle_type_id into v_type from public.vehicles where id = new.vehicle_id and tenant_id = new.tenant_id;
    if new.vehicle_type_id is null then
      new.vehicle_type_id := v_type;
    elsif v_type <> new.vehicle_type_id then
      if exists (select 1 from public.seat_inventory s where s.tenant_id = new.tenant_id and s.trip_id = new.id
                   and s.status in ('giu', 'dat', 'da_tt')
                   and not exists (select 1 from public.vehicle_type_seats v where v.tenant_id = s.tenant_id
                                     and v.vehicle_type_id = v_type and v.label = s.seat_label)) then
        raise exception 'Xe khác loại sơ đồ ghế: có vé đã bán ở ghế không có trên xe mới' using errcode = '22023';
      end if;
      new.vehicle_type_id := v_type;
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function app.check_trip_type_change() from public, anon, authenticated;
create trigger trips_vehicle_type before update on public.trips for each row execute function app.check_trip_type_change();

revoke execute on function
  public.set_trip_vehicle_type(uuid, uuid),
  public.set_schedule_vehicle_type(uuid, uuid),
  public.hold_seat(uuid, text, uuid, uuid, uuid, uuid),
  public.unhold_seat(uuid),
  public.confirm_booking(uuid, text, text, text, boolean, text, text, text, text, jsonb),
  public.pay_booking(uuid, uuid[]),
  public.extend_booking(uuid, boolean, int, text),
  public.update_ticket_info(uuid, text, text, text, text),
  public.move_ticket(uuid, uuid, text),
  public.set_boarded(uuid, boolean),
  public.refresh_trip_seats(uuid)
  from public, anon, authenticated;
grant execute on function
  public.set_trip_vehicle_type(uuid, uuid),
  public.set_schedule_vehicle_type(uuid, uuid),
  public.hold_seat(uuid, text, uuid, uuid, uuid, uuid),
  public.unhold_seat(uuid),
  public.confirm_booking(uuid, text, text, text, boolean, text, text, text, text, jsonb),
  public.pay_booking(uuid, uuid[]),
  public.extend_booking(uuid, boolean, int, text),
  public.update_ticket_info(uuid, text, text, text, text),
  public.move_ticket(uuid, uuid, text),
  public.set_boarded(uuid, boolean),
  public.refresh_trip_seats(uuid)
  to authenticated;
