-- =====================================================================
-- Giai đoạn 6.3 – Gửi hàng
-- - Phiếu gửi hàng: người gửi / nhận, hàng gì, số kiện, cân nặng, giá trị khai báo, cước, ai trả cước, thu hộ (COD).
-- - Gắn chuyến (đi xe nào), trạng thái: đã nhận → đã lên xe → đã đến → đã giao (hoặc đã hủy).
-- - Tiền (sổ cái chỉ thêm): cước = doanh thu hàng (tách khỏi doanh thu vé); thu hộ = tiền giữ hộ người gửi (nợ phải trả),
--   trả lại người gửi thì ghi giảm. Không sửa / xóa giao dịch.
-- =====================================================================

insert into public.permissions (code, module, name) values
  ('parcel.manage', 'gui_hang', 'Gửi hàng: nhận hàng, thu cước, giao hàng, thu hộ');
select app.grant_permission_to_admins('parcel.manage');
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, 'parcel.manage' from public.roles r where r.code in ('seller', 'office_manager', 'dispatcher')
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
    (p_tenant_id, v_seller, 'ticket.sell'),
    (p_tenant_id, v_disp,   'parcel.manage'),
    (p_tenant_id, v_office, 'parcel.manage'),
    (p_tenant_id, v_seller, 'parcel.manage');
end;
$$;

alter table public.ledger_lines drop constraint ledger_lines_account_check;
alter table public.ledger_lines add check (account in ('tien_mat', 'ngan_hang', 'doanh_thu_ve', 'phi_huy_doi', 'doanh_thu_hang', 'thu_ho'));

create table public.shipments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id),
  code            text not null,
  trip_id         uuid,
  service_date    date not null,
  from_stop_id    uuid not null,
  to_stop_id      uuid not null,
  sender_name     text,
  sender_phone    text not null check (sender_phone ~ '^0[0-9]{9}$'),
  receiver_name   text,
  receiver_phone  text not null check (receiver_phone ~ '^0[0-9]{9}$'),
  description     text not null check (length(trim(description)) between 1 and 300),
  packages        int not null default 1 check (packages between 1 and 999),
  weight_kg       numeric(8, 1) check (weight_kg is null or weight_kg > 0),
  declared_value  int check (declared_value is null or declared_value >= 0),
  fee             int not null check (fee between 0 and 100000000),
  fee_payer       text not null check (fee_payer in ('nguoi_gui', 'nguoi_nhan')),
  fee_paid_at     timestamptz,
  cod_amount      int not null default 0 check (cod_amount between 0 and 1000000000),
  cod_collected_at timestamptz,
  cod_paid_out_at timestamptz,
  status          text not null default 'nhan' check (status in ('nhan', 'tren_xe', 'den', 'giao', 'huy')),
  note            text,
  delivered_at    timestamptz,
  delivered_to    text,
  cancel_reason   text,
  request_id      uuid,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  unique (tenant_id, request_id),
  foreign key (tenant_id, trip_id) references public.trips (tenant_id, id),
  foreign key (tenant_id, from_stop_id) references public.stops (tenant_id, id),
  foreign key (tenant_id, to_stop_id) references public.stops (tenant_id, id)
);
create index shipments_day_idx on public.shipments (tenant_id, service_date);
create index shipments_trip_idx on public.shipments (tenant_id, trip_id);
create index shipments_phone_idx on public.shipments (tenant_id, receiver_phone);
create trigger shipments_touch before update on public.shipments for each row execute function app.touch_updated_at();
create trigger shipments_audit after insert or update on public.shipments for each row execute function app.write_audit();

alter table public.shipments enable row level security;
revoke all on public.shipments from anon, authenticated;
grant select on public.shipments to authenticated;
grant select, insert, update, delete on public.shipments to service_role;
-- Người có quyền gửi hàng, điều hành, hoặc tổ lái của chuyến chở hàng đó
create policy shipments_select on public.shipments for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('parcel.manage') or app.has_permission('trip.manage')
         or (trip_id is not null and app.is_my_trip(trip_id))));

alter table public.ledger_transactions add column shipment_id uuid;
alter table public.ledger_transactions add foreign key (tenant_id, shipment_id) references public.shipments (tenant_id, id);

create function app.new_shipment_code(p_tenant uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v text;
begin
  loop
    v := 'GH' || to_char(app.local_today(), 'YYMMDD') || lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (select 1 from public.shipments where tenant_id = p_tenant and code = v);
  end loop;
  return v;
end;
$$;
revoke execute on function app.new_shipment_code(uuid) from public, anon, authenticated;

-- Ghi sổ: p_kind cuoc (Nợ tiền / Có doanh_thu_hang) · thu_ho (Nợ tiền / Có thu_ho) · tra_thu_ho (Nợ thu_ho / Có tiền)
create function app.post_parcel(p_tenant uuid, p_ship uuid, p_kind text, p_amount bigint, p_method text, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_txn uuid;
  v_cash text := case p_method when 'chuyen_khoan' then 'ngan_hang' else 'tien_mat' end;
begin
  if p_amount <= 0 then return; end if;
  insert into public.ledger_transactions (tenant_id, kind, shipment_id, note, created_by)
  values (p_tenant, 'gui_hang_' || p_kind, p_ship, p_note, auth.uid()) returning id into v_txn;
  insert into public.ledger_lines (tenant_id, txn_id, account, holder_id, debit, credit)
  select p_tenant, v_txn, x.account, x.holder, x.debit, x.credit
  from (values
    (case when p_kind = 'tra_thu_ho' then 'thu_ho' else v_cash end, case when p_kind = 'tra_thu_ho' then null else auth.uid() end, p_amount, 0::bigint),
    (case p_kind when 'cuoc' then 'doanh_thu_hang' when 'thu_ho' then 'thu_ho' else v_cash end,
     case when p_kind = 'tra_thu_ho' then auth.uid() end, 0::bigint, p_amount)
  ) x(account, holder, debit, credit);
end;
$$;
revoke execute on function app.post_parcel(uuid, uuid, text, bigint, text, text) from public, anon, authenticated;

-- Nhận hàng (tạo phiếu). Người gửi trả cước: thu luôn bằng p_method.
create function public.create_shipment(p jsonb, p_method text, p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid;
  v_code text;
  v_trip public.trips;
  v_fee int;
  v_payer text := coalesce(p ->> 'fee_payer', 'nguoi_gui');
begin
  if v_tid is null or not app.has_permission('parcel.manage') then
    raise exception 'Không có quyền gửi hàng' using errcode = '42501';
  end if;
  if p_request_id is not null then
    select id, code into v_id, v_code from public.shipments where tenant_id = v_tid and request_id = p_request_id;
    if found then return jsonb_build_object('id', v_id, 'code', v_code, 'repeated', true); end if;
  end if;
  if nullif(p ->> 'trip_id', '') is not null then
    select * into v_trip from public.trips where id = (p ->> 'trip_id')::uuid and tenant_id = v_tid and status = 'mo';
    if not found then
      raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
    end if;
  end if;
  if not exists (select 1 from public.stops where tenant_id = v_tid and id = nullif(p ->> 'from_stop_id', '')::uuid)
     or not exists (select 1 from public.stops where tenant_id = v_tid and id = nullif(p ->> 'to_stop_id', '')::uuid) then
    raise exception 'Chọn nơi gửi và nơi nhận' using errcode = '22023';
  end if;
  if v_payer not in ('nguoi_gui', 'nguoi_nhan') then
    raise exception 'Chọn người trả cước' using errcode = '22023';
  end if;
  if v_payer = 'nguoi_gui' and coalesce(p_method, '') not in ('tien_mat', 'chuyen_khoan') then
    raise exception 'Chọn cách thu cước' using errcode = '22023';
  end if;
  v_fee := coalesce((p ->> 'fee')::int, -1);
  begin
    insert into public.shipments (tenant_id, code, trip_id, service_date, from_stop_id, to_stop_id, sender_name, sender_phone,
                                  receiver_name, receiver_phone, description, packages, weight_kg, declared_value, fee, fee_payer,
                                  fee_paid_at, cod_amount, note, request_id, created_by)
    values (v_tid, app.new_shipment_code(v_tid), v_trip.id, coalesce(v_trip.service_date, nullif(p ->> 'service_date', '')::date, app.local_today()),
            (p ->> 'from_stop_id')::uuid, (p ->> 'to_stop_id')::uuid, nullif(trim(p ->> 'sender_name'), ''),
            regexp_replace(coalesce(p ->> 'sender_phone', ''), '[^0-9]', '', 'g'), nullif(trim(p ->> 'receiver_name'), ''),
            regexp_replace(coalesce(p ->> 'receiver_phone', ''), '[^0-9]', '', 'g'), trim(coalesce(p ->> 'description', '')),
            coalesce((p ->> 'packages')::int, 1), nullif(p ->> 'weight_kg', '')::numeric, nullif(p ->> 'declared_value', '')::int,
            v_fee, v_payer, case when v_payer = 'nguoi_gui' then now() end, coalesce((p ->> 'cod_amount')::int, 0),
            nullif(trim(p ->> 'note'), ''), p_request_id, auth.uid())
    returning id, code into v_id, v_code;
  exception when check_violation then
    raise exception 'Kiểm tra lại: SĐT người gửi / nhận 10 số, mô tả hàng, số kiện, cước, thu hộ' using errcode = '22023';
  end;
  if v_payer = 'nguoi_gui' then
    perform app.post_parcel(v_tid, v_id, 'cuoc', v_fee, p_method, 'Cước gửi hàng ' || v_code);
  end if;
  return jsonb_build_object('id', v_id, 'code', v_code, 'repeated', false);
end;
$$;

-- Đổi trạng thái: tren_xe (gắn chuyến) / den / huy. Giao hàng dùng deliver_shipment.
create function public.set_shipment_status(p_id uuid, p_status text, p_trip_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_s public.shipments;
begin
  select * into v_s from public.shipments where id = p_id and tenant_id = v_tid for update;
  if v_tid is null or not found or not (app.has_permission('parcel.manage') or app.has_permission('trip.manage')
       or (v_s.trip_id is not null and app.is_my_trip(v_s.trip_id))) then
    raise exception 'Không tìm thấy phiếu gửi hàng' using errcode = 'P0002';
  end if;
  if v_s.status in ('giao', 'huy') then
    raise exception 'Phiếu đã giao hoặc đã hủy' using errcode = '22023';
  end if;
  if p_status = 'tren_xe' then
    if p_trip_id is not null and not exists (select 1 from public.trips where id = p_trip_id and tenant_id = v_tid and status = 'mo') then
      raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
    end if;
    if coalesce(p_trip_id, v_s.trip_id) is null then
      raise exception 'Chọn chuyến chở hàng' using errcode = '22023';
    end if;
    update public.shipments set status = 'tren_xe', trip_id = coalesce(p_trip_id, trip_id) where id = p_id;
  elsif p_status = 'den' then
    update public.shipments set status = 'den' where id = p_id;
  elsif p_status = 'huy' then
    if not app.has_permission('parcel.manage') then
      raise exception 'Không có quyền hủy phiếu' using errcode = '42501';
    end if;
    if nullif(trim(p_reason), '') is null then
      raise exception 'Nhập lý do hủy' using errcode = '22023';
    end if;
    update public.shipments set status = 'huy', cancel_reason = trim(p_reason) where id = p_id;
    -- Cước đã thu: hoàn lại người gửi (bút toán đảo)
    if v_s.fee_paid_at is not null and v_s.fee > 0 then
      insert into public.ledger_transactions (tenant_id, kind, shipment_id, note, created_by)
      values (v_tid, 'gui_hang_hoan_cuoc', p_id, 'Hủy phiếu ' || v_s.code || ': hoàn cước', auth.uid());
      insert into public.ledger_lines (tenant_id, txn_id, account, holder_id, debit, credit)
      select v_tid, (select id from public.ledger_transactions where tenant_id = v_tid and shipment_id = p_id and kind = 'gui_hang_hoan_cuoc' order by created_at desc limit 1),
             x.a, x.h, x.d, x.c
      from (values ('doanh_thu_hang', null::uuid, v_s.fee::bigint, 0::bigint), ('tien_mat', auth.uid(), 0::bigint, v_s.fee::bigint)) x(a, h, d, c);
    end if;
  else
    raise exception 'Trạng thái không hợp lệ' using errcode = '22023';
  end if;
end;
$$;

-- Giao hàng cho người nhận: thu cước (nếu người nhận trả) + thu hộ. Trả về số tiền đã thu.
create function public.deliver_shipment(p_id uuid, p_receiver text, p_method text)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_s public.shipments;
  v_total bigint := 0;
begin
  select * into v_s from public.shipments where id = p_id and tenant_id = v_tid for update;
  if v_tid is null or not found or not (app.has_permission('parcel.manage') or (v_s.trip_id is not null and app.is_my_trip(v_s.trip_id))) then
    raise exception 'Không tìm thấy phiếu gửi hàng' using errcode = 'P0002';
  end if;
  if v_s.status = 'giao' then return 0; end if;
  if v_s.status = 'huy' then
    raise exception 'Phiếu đã hủy' using errcode = '22023';
  end if;
  if coalesce(p_method, '') not in ('tien_mat', 'chuyen_khoan') then
    raise exception 'Chọn cách thu tiền' using errcode = '22023';
  end if;
  if v_s.fee_paid_at is null and v_s.fee > 0 then
    perform app.post_parcel(v_tid, p_id, 'cuoc', v_s.fee, p_method, 'Thu cước khi giao ' || v_s.code);
    v_total := v_total + v_s.fee;
  end if;
  if v_s.cod_amount > 0 and v_s.cod_collected_at is null then
    perform app.post_parcel(v_tid, p_id, 'thu_ho', v_s.cod_amount, p_method, 'Thu hộ ' || v_s.code);
    v_total := v_total + v_s.cod_amount;
  end if;
  update public.shipments set status = 'giao', delivered_at = now(), delivered_to = coalesce(nullif(trim(p_receiver), ''), receiver_name),
         fee_paid_at = coalesce(fee_paid_at, now()), cod_collected_at = case when cod_amount > 0 then coalesce(cod_collected_at, now()) end
  where id = p_id;
  return v_total;
end;
$$;

-- Trả tiền thu hộ cho người gửi
create function public.pay_out_cod(p_id uuid, p_method text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_s public.shipments;
begin
  if v_tid is null or not app.has_permission('parcel.manage') then
    raise exception 'Không có quyền gửi hàng' using errcode = '42501';
  end if;
  select * into v_s from public.shipments where id = p_id and tenant_id = v_tid for update;
  if not found then
    raise exception 'Không tìm thấy phiếu gửi hàng' using errcode = 'P0002';
  end if;
  if v_s.cod_paid_out_at is not null then return 0; end if;
  if v_s.cod_collected_at is null or v_s.cod_amount = 0 then
    raise exception 'Chưa thu hộ được tiền của phiếu này' using errcode = '22023';
  end if;
  if coalesce(p_method, '') not in ('tien_mat', 'chuyen_khoan') then
    raise exception 'Chọn cách trả tiền' using errcode = '22023';
  end if;
  perform app.post_parcel(v_tid, p_id, 'tra_thu_ho', v_s.cod_amount, p_method, 'Trả tiền thu hộ ' || v_s.code);
  update public.shipments set cod_paid_out_at = now() where id = p_id;
  return v_s.cod_amount;
end;
$$;

revoke execute on function public.create_shipment(jsonb, text, uuid), public.set_shipment_status(uuid, text, uuid, text),
  public.deliver_shipment(uuid, text, text), public.pay_out_cod(uuid, text) from public, anon, authenticated;
grant execute on function public.create_shipment(jsonb, text, uuid), public.set_shipment_status(uuid, text, uuid, text),
  public.deliver_shipment(uuid, text, text), public.pay_out_cod(uuid, text) to authenticated;
