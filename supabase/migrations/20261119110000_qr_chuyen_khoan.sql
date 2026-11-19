-- =====================================================================
-- Giai đoạn 4.2 – Thanh toán chuyển khoản bằng QR (VietQR), NHÂN VIÊN XÁC NHẬN THỦ CÔNG
-- - Cấu hình tài khoản nhận: mã BIN ngân hàng, số tài khoản, tên chủ tài khoản.
-- - Bán vé "Chuyển khoản (QR)": ghế được giữ ở trạng thái chờ chuyển khoản (mặc định 15 phút,
--   cấu hình ban_ve.giu_ghe_online_phut); nhân viên thấy tiền về thì bấm "Đã nhận chuyển khoản".
-- - Sổ cái: Nợ "ngan_hang" (ghi người xác nhận) / Có "doanh_thu_ve". Không gộp với tiền mặt.
-- =====================================================================

alter table public.ledger_lines drop constraint ledger_lines_account_check;
alter table public.ledger_lines add check (account in ('tien_mat', 'ngan_hang', 'doanh_thu_ve'));

alter table public.seat_inventory add column pay_method text check (pay_method is null or pay_method in ('tien_mat', 'chuyen_khoan'));
update public.seat_inventory set pay_method = 'tien_mat' where status = 'da_tt';

-- ---------------------------------------------------------------- Cấu hình tài khoản nhận
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
  elsif new.key in ('ban_ve.tu_nha_dat_cho', 'in.chu_ky_giam_doc', 'in.con_dau') then
    if jsonb_typeof(new.value) <> 'boolean' then
      raise exception 'Giá trị phải là bật / tắt' using errcode = '22023';
    end if;
  elsif new.key = 'lenh.hau_to' then
    if jsonb_typeof(new.value) <> 'string' or (new.value #>> '{}') !~ '^[A-Z0-9]{1,10}$' then
      raise exception 'Hậu tố số lệnh: 1–10 chữ in hoa hoặc số, không dấu (vd TGTP)' using errcode = '22023';
    end if;
  elsif new.key = 'tt.ngan_hang_bin' then
    if jsonb_typeof(new.value) <> 'string' or (new.value #>> '{}') !~ '^[0-9]{6}$' then
      raise exception 'Mã ngân hàng (BIN) gồm 6 chữ số' using errcode = '22023';
    end if;
  elsif new.key = 'tt.so_tai_khoan' then
    if jsonb_typeof(new.value) <> 'string' or (new.value #>> '{}') !~ '^[0-9A-Za-z]{6,19}$' then
      raise exception 'Số tài khoản: 6–19 chữ số' using errcode = '22023';
    end if;
  elsif new.key = 'tt.ten_tai_khoan' then
    if jsonb_typeof(new.value) <> 'string' or length(new.value #>> '{}') not between 2 and 50 then
      raise exception 'Tên chủ tài khoản: 2–50 ký tự' using errcode = '22023';
    end if;
  elsif new.key in ('cong_ty.giam_doc', 'cong_ty.chuc_danh_ky', 've.ghi_chu') then
    if jsonb_typeof(new.value) <> 'string' or length(new.value #>> '{}') > 500 then
      raise exception 'Giá trị phải là chữ, tối đa 500 ký tự' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------- Ghi sổ
create or replace function app.post_cash_sale(p_tenant uuid, p_booking uuid, p_amount bigint, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.post_sale(p_tenant, p_booking, p_amount, p_note, 'tien_mat');
end;
$$;

create function app.post_sale(p_tenant uuid, p_booking uuid, p_amount bigint, p_note text, p_method text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_txn uuid;
begin
  if p_amount <= 0 then return; end if;
  insert into public.ledger_transactions (tenant_id, kind, booking_id, note, created_by)
  values (p_tenant, 'ban_ve', p_booking, p_note, auth.uid()) returning id into v_txn;
  insert into public.ledger_lines (tenant_id, txn_id, account, holder_id, debit, credit) values
    (p_tenant, v_txn, case p_method when 'chuyen_khoan' then 'ngan_hang' else 'tien_mat' end, auth.uid(), p_amount, 0),
    (p_tenant, v_txn, 'doanh_thu_ve', null, 0, p_amount);
end;
$$;
revoke execute on function app.post_sale(uuid, uuid, bigint, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- Xác nhận đơn: thêm cách "chuyen_khoan"
create or replace function public.confirm_booking(p_booking_id uuid, p_phone text, p_name text, p_mode text, p_keep boolean,
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
  v_qr_min int;
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
  if not exists (select 1 from public.seat_inventory where tenant_id = v_tid and booking_id = p_booking_id and status = 'giu') then
    if exists (select 1 from public.seat_inventory where tenant_id = v_tid and booking_id = p_booking_id and status in ('dat', 'da_tt')) then
      return jsonb_build_object('booking_id', v_b.id, 'code', v_b.code, 'repeated', true);
    end if;
    raise exception 'Hết thời gian giữ ghế, hãy chọn lại ghế' using errcode = '22023';
  end if;
  if p_mode not in ('thu_tien', 'dat_cho', 'chuyen_khoan') then
    raise exception 'Chọn thu tiền mặt, chuyển khoản hoặc đặt chỗ' using errcode = '22023';
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
  if p_mode = 'chuyen_khoan' and not exists (select 1 from public.tenant_settings where tenant_id = v_tid and key = 'tt.so_tai_khoan') then
    raise exception 'Chưa cấu hình tài khoản nhận chuyển khoản (Cấu hình → Chuyển khoản)' using errcode = '22023';
  end if;

  update public.bookings set customer_phone = v_phone, customer_name = nullif(trim(p_name), ''), note = nullif(trim(p_note), '')
  where id = v_b.id;

  v_auto := coalesce((select (value #>> '{}')::boolean from public.tenant_settings where tenant_id = v_tid and key = 'ban_ve.tu_nha_dat_cho'), true);
  v_before := app.setting_int(v_tid, 'ban_ve.nha_dat_cho_truoc_phut', 60);
  v_qr_min := app.setting_int(v_tid, 'ban_ve.giu_ghe_online_phut', 15);

  update public.seat_inventory s
  set status = case when p_mode = 'thu_tien' then 'da_tt' else 'dat' end,
      pay_method = case when p_mode = 'thu_tien' then 'tien_mat' when p_mode = 'chuyen_khoan' then 'chuyen_khoan' end,
      hold_until = case when p_mode = 'thu_tien' then null
                        -- chờ chuyển khoản: giữ N phút (không quá giờ chạy)
                        when p_mode = 'chuyen_khoan' then least(t.depart_at, now() + make_interval(mins => v_qr_min))
                        when p_keep or not v_auto then null
                        when t.depart_at - make_interval(mins => v_before) > now() then t.depart_at - make_interval(mins => v_before)
                        else t.depart_at end,
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

  for r in select (e ->> 'ticket_id')::uuid as id, nullif(trim(e ->> 'name'), '') as name,
                  nullif(regexp_replace(coalesce(e ->> 'phone', ''), '[^0-9]', '', 'g'), '') as phone
           from jsonb_array_elements(coalesce(p_passengers, '[]')) e loop
    update public.seat_inventory set passenger_name = coalesce(r.name, passenger_name), passenger_phone = coalesce(r.phone, passenger_phone)
    where id = r.id and tenant_id = v_tid and booking_id = v_b.id;
  end loop;

  if p_mode = 'thu_tien' then
    select sum(price) into v_total from public.seat_inventory where tenant_id = v_tid and booking_id = v_b.id and status = 'da_tt';
    perform app.post_sale(v_tid, v_b.id, v_total, 'Bán vé ' || v_b.code, 'tien_mat');
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
  select coalesce(sum(price), 0) into v_total from public.seat_inventory where tenant_id = v_tid and booking_id = v_b.id and status in ('dat', 'da_tt');
  return jsonb_build_object('booking_id', v_b.id, 'code', v_b.code, 'tickets', v_n, 'total', v_total, 'repeated', false);
end;
$$;

-- ---------------------------------------------------------------- Thu tiền: tiền mặt hoặc "đã nhận chuyển khoản"
drop function public.pay_booking(uuid, uuid[]);
create function public.pay_booking(p_booking_id uuid, p_ticket_ids uuid[], p_method text default 'tien_mat')
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
  if coalesce(p_method, '') not in ('tien_mat', 'chuyen_khoan') then
    raise exception 'Chọn tiền mặt hoặc chuyển khoản' using errcode = '22023';
  end if;
  select * into v_b from public.bookings where id = p_booking_id and tenant_id = v_tid for update;
  if not found then
    raise exception 'Không tìm thấy đơn vé' using errcode = 'P0002';
  end if;
  perform app.release_expired(v_tid, null);
  with paid as (
    update public.seat_inventory set status = 'da_tt', paid_at = now(), paid_by = auth.uid(), hold_until = null, pay_method = p_method
    where tenant_id = v_tid and booking_id = p_booking_id and status = 'dat' and (p_ticket_ids is null or id = any (p_ticket_ids))
    returning price
  )
  select coalesce(sum(price), 0), count(*) into v_total, v_n from paid;
  if v_n = 0 then
    if exists (select 1 from public.seat_inventory where tenant_id = v_tid and booking_id = p_booking_id and status = 'da_tt') then
      return 0;   -- đã thu rồi (bấm 2 lần)
    end if;
    raise exception 'Chỗ đặt đã hết hạn hoặc đã hủy' using errcode = '22023';
  end if;
  perform app.post_sale(v_tid, p_booking_id, v_total,
                        case p_method when 'chuyen_khoan' then 'Nhận chuyển khoản vé ' else 'Thu tiền vé ' end || v_b.code, p_method);
  return v_total;
end;
$$;
revoke execute on function public.pay_booking(uuid, uuid[], text) from public, anon, authenticated;
grant execute on function public.pay_booking(uuid, uuid[], text) to authenticated;
