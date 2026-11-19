-- =====================================================================
-- Giai đoạn 4.3 – Đổi / hủy / hoàn vé
-- - Phí hủy theo mốc giờ trước giờ chạy (cấu hình huy_ve.moc), vd hủy trước ≥ 24 giờ phí 10%,
--   ≥ 4 giờ phí 30%, dưới 4 giờ phí 100% (không hoàn). Chuyến đã chạy: không hủy.
-- - Quản trị (settings.manage) được sửa phí khi hủy, bắt buộc ghi lý do.
-- - Hoàn tiền: tiền mặt (người hủy chi ra) hoặc chuyển khoản (ghi tài khoản ngân hàng).
-- - Sổ cái (chỉ thêm): Nợ doanh_thu_ve = giá vé / Có tien_mat|ngan_hang = tiền hoàn / Có phi_huy_doi = phí.
-- - Đổi chuyến (cùng tuyến, cùng chiều): thu phí đổi (doi_ve.phi_dong, mặc định 0).
-- =====================================================================

alter table public.ledger_lines drop constraint ledger_lines_account_check;
alter table public.ledger_lines add check (account in ('tien_mat', 'ngan_hang', 'doanh_thu_ve', 'phi_huy_doi'));

alter table public.seat_inventory add column cancel_reason text;
alter table public.seat_inventory add column cancel_fee int check (cancel_fee is null or cancel_fee >= 0);
alter table public.seat_inventory add column refund_amount int check (refund_amount is null or refund_amount >= 0);
alter table public.seat_inventory add column refund_method text check (refund_method is null or refund_method in ('tien_mat', 'chuyen_khoan'));
alter table public.seat_inventory add column cancelled_at timestamptz;
alter table public.seat_inventory add column cancelled_by uuid;

-- ---------------------------------------------------------------- Cấu hình
create or replace function app.validate_tenant_setting()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  v numeric;
  e jsonb;
  prev int := null;
  lim jsonb := '{
    "ban_ve.giu_ghe_quay_phut":     [1, 120, "Thời gian giữ ghế phải từ 1 đến 120 phút"],
    "ban_ve.giu_ghe_online_phut":   [1, 120, "Thời gian giữ ghế phải từ 1 đến 120 phút"],
    "ban_ve.nha_ghe_vexere_gio":    [0, 48,  "Giờ nhả ghế Vexere phải từ 0 đến 48"],
    "ban_ve.nha_dat_cho_truoc_phut":[0, 1440,"Nhả chỗ đặt trước giờ chạy phải từ 0 đến 1440 phút"],
    "doi_ve.phi_dong":              [0, 10000000, "Phí đổi vé từ 0 đến 10.000.000 đồng"],
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
  elsif new.key = 'huy_ve.moc' then
    -- [{"truoc_gio": 24, "phi_pt": 10}, …] – giờ giảm dần, phải có mốc 0
    if jsonb_typeof(new.value) <> 'array' or jsonb_array_length(new.value) = 0 then
      raise exception 'Mốc phí hủy phải là danh sách' using errcode = '22023';
    end if;
    for e in select * from jsonb_array_elements(new.value) loop
      if jsonb_typeof(e -> 'truoc_gio') <> 'number' or jsonb_typeof(e -> 'phi_pt') <> 'number'
         or (e ->> 'truoc_gio')::numeric not between 0 and 720 or (e ->> 'phi_pt')::numeric not between 0 and 100
         or (e ->> 'truoc_gio')::numeric <> trunc((e ->> 'truoc_gio')::numeric) then
        raise exception 'Mỗi mốc: số giờ 0–720 (số nguyên), phí 0–100%%' using errcode = '22023';
      end if;
      if prev is not null and (e ->> 'truoc_gio')::int >= prev then
        raise exception 'Các mốc giờ phải giảm dần, không trùng' using errcode = '22023';
      end if;
      prev := (e ->> 'truoc_gio')::int;
    end loop;
    if prev <> 0 then
      raise exception 'Phải có mốc 0 giờ (hủy sát giờ chạy)' using errcode = '22023';
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
    (p_tenant_id, 'huy_ve.moc', '[{"truoc_gio": 24, "phi_pt": 10}, {"truoc_gio": 4, "phi_pt": 30}, {"truoc_gio": 0, "phi_pt": 100}]'::jsonb),
    (p_tenant_id, 'doi_ve.phi_dong',               '0'::jsonb),
    (p_tenant_id, 'giay_to.canh_bao_truoc_ngay',   '30'::jsonb),
    (p_tenant_id, 'chuyen.tao_truoc_ngay',         '7'::jsonb),
    (p_tenant_id, 'lai_xe.gio_lien_tuc_toi_da',    '4'::jsonb),
    (p_tenant_id, 'lai_xe.gio_ngay_toi_da',        '10'::jsonb),
    (p_tenant_id, 'lai_xe.gio_tuan_toi_da',        '48'::jsonb)
  on conflict (tenant_id, key) do nothing
$$;
revoke execute on function app.seed_default_settings(uuid) from public, anon, authenticated;
select app.seed_default_settings(id) from public.tenants;

-- ---------------------------------------------------------------- Tính phí hủy
-- % phí theo số giờ còn lại trước giờ chạy (mốc lớn nhất mà số giờ còn lại ≥ mốc)
create function app.cancel_fee_pct(p_tenant uuid, p_hours numeric)
returns int
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select (e ->> 'phi_pt')::int
    from jsonb_array_elements(coalesce((select value from public.tenant_settings where tenant_id = p_tenant and key = 'huy_ve.moc'),
                                       '[{"truoc_gio": 0, "phi_pt": 100}]'::jsonb)) e
    where (e ->> 'truoc_gio')::numeric <= p_hours
    order by (e ->> 'truoc_gio')::numeric desc limit 1), 100)
$$;
revoke execute on function app.cancel_fee_pct(uuid, numeric) from public, anon, authenticated;

-- Xem trước: phí / tiền hoàn từng vé (chưa hủy)
create function public.cancel_quote(p_ticket_ids uuid[])
returns table (ticket_id uuid, seat_label text, status text, price int, hours_left numeric, fee_pct int, fee int, refund int)
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  return query
  select s.id, s.seat_label, s.status, s.price,
         round(extract(epoch from (t.depart_at - now())) / 3600, 1),
         case when s.status = 'da_tt' then app.cancel_fee_pct(v_tid, extract(epoch from (t.depart_at - now())) / 3600) else 0 end,
         case when s.status = 'da_tt' then round(s.price * app.cancel_fee_pct(v_tid, extract(epoch from (t.depart_at - now())) / 3600) / 100.0)::int else 0 end,
         case when s.status = 'da_tt' then s.price - round(s.price * app.cancel_fee_pct(v_tid, extract(epoch from (t.depart_at - now())) / 3600) / 100.0)::int else 0 end
  from public.seat_inventory s join public.trips t on t.tenant_id = s.tenant_id and t.id = s.trip_id
  where s.tenant_id = v_tid and s.id = any (p_ticket_ids) and s.status in ('dat', 'da_tt');
end;
$$;

-- ---------------------------------------------------------------- Hủy vé + hoàn tiền
-- p_fee_override: quản trị sửa tổng phí (đồng / vé), cần p_override_reason.
create function public.cancel_tickets(p_ticket_ids uuid[], p_reason text, p_refund_method text,
                                      p_fee_override int, p_override_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  r record;
  v_fee int;
  v_refund int;
  v_total_price bigint := 0;
  v_total_fee bigint := 0;
  v_total_refund bigint := 0;
  v_n int := 0;
  v_txn uuid;
  v_booking uuid;
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Nhập lý do hủy vé' using errcode = '22023';
  end if;
  if coalesce(p_refund_method, '') not in ('tien_mat', 'chuyen_khoan') then
    raise exception 'Chọn hoàn tiền mặt hoặc chuyển khoản' using errcode = '22023';
  end if;
  if p_fee_override is not null then
    if not app.has_permission('settings.manage') then
      raise exception 'Chỉ quản trị được sửa phí hủy' using errcode = '42501';
    end if;
    if p_fee_override < 0 or nullif(trim(p_override_reason), '') is null then
      raise exception 'Sửa phí hủy phải ghi lý do, phí không âm' using errcode = '22023';
    end if;
  end if;

  for r in select s.*, t.depart_at from public.seat_inventory s join public.trips t on t.tenant_id = s.tenant_id and t.id = s.trip_id
           where s.tenant_id = v_tid and s.id = any (p_ticket_ids) and s.status in ('dat', 'da_tt')
           order by s.id for update of s loop
    if r.depart_at <= now() then
      raise exception 'Ghế % thuộc chuyến đã chạy, không hủy được', r.seat_label using errcode = '22023';
    end if;
    if r.status = 'dat' then
      v_fee := 0; v_refund := 0;   -- chưa thu tiền: chỉ nhả ghế
    else
      v_fee := case when p_fee_override is not null then least(p_fee_override, r.price)
                    else round(r.price * app.cancel_fee_pct(v_tid, extract(epoch from (r.depart_at - now())) / 3600) / 100.0)::int end;
      v_refund := r.price - v_fee;
      v_total_price := v_total_price + r.price;
      v_total_fee := v_total_fee + v_fee;
      v_total_refund := v_total_refund + v_refund;
      v_booking := r.booking_id;
    end if;
    update public.seat_inventory
    set status = 'huy', cancel_reason = trim(p_reason) || case when p_fee_override is not null then ' | Sửa phí: ' || trim(p_override_reason) else '' end,
        cancel_fee = v_fee, refund_amount = v_refund, refund_method = case when r.status = 'da_tt' then p_refund_method end,
        cancelled_at = now(), cancelled_by = auth.uid(), hold_until = null
    where id = r.id;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then
    raise exception 'Không có vé nào còn hiệu lực để hủy' using errcode = 'P0002';
  end if;

  if v_total_price > 0 then
    insert into public.ledger_transactions (tenant_id, kind, booking_id, note, created_by)
    values (v_tid, 'huy_ve', v_booking, 'Hủy vé: ' || trim(p_reason), auth.uid()) returning id into v_txn;
    insert into public.ledger_lines (tenant_id, txn_id, account, holder_id, debit, credit)
    select v_tid, v_txn, x.account, x.holder, x.debit, x.credit
    from (values ('doanh_thu_ve', null::uuid, v_total_price, 0::bigint),
                 (case p_refund_method when 'chuyen_khoan' then 'ngan_hang' else 'tien_mat' end, auth.uid(), 0::bigint, v_total_refund),
                 ('phi_huy_doi', null::uuid, 0::bigint, v_total_fee)) x(account, holder, debit, credit)
    where x.debit > 0 or x.credit > 0;
  end if;
  return jsonb_build_object('tickets', v_n, 'fee', v_total_fee, 'refund', v_total_refund);
end;
$$;

-- ---------------------------------------------------------------- Đổi chuyến có phí
-- Đổi chuyến (khác chuyến) với vé đã thanh toán: thu phí đổi (doi_ve.phi_dong) bằng p_fee_method.
create or replace function public.move_ticket(p_ticket_id uuid, p_trip_id uuid, p_seat text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.change_ticket(p_ticket_id, p_trip_id, p_seat, 'tien_mat');
end;
$$;

create function public.change_ticket(p_ticket_id uuid, p_trip_id uuid, p_seat text, p_fee_method text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_s public.seat_inventory;
  v_old public.trips;
  v_new public.trips;
  v_fee int := 0;
  v_txn uuid;
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
  if v_new.arrive_at <= now() then
    raise exception 'Chuyến mới đã chạy' using errcode = '22023';
  end if;
  if v_new.vehicle_type_id is null or not exists (select 1 from public.vehicle_type_seats where tenant_id = v_tid
       and vehicle_type_id = v_new.vehicle_type_id and label = upper(trim(p_seat)) and is_sellable) then
    raise exception 'Ghế % không có trên sơ đồ chuyến mới', p_seat using errcode = '22023';
  end if;
  if v_new.id <> v_old.id and v_s.status = 'da_tt' then
    v_fee := app.setting_int(v_tid, 'doi_ve.phi_dong', 0);
    if v_fee > 0 and coalesce(p_fee_method, '') not in ('tien_mat', 'chuyen_khoan') then
      raise exception 'Chọn cách thu phí đổi vé' using errcode = '22023';
    end if;
  end if;
  perform app.release_expired(v_tid, v_new.id);
  begin
    update public.seat_inventory set trip_id = v_new.id, seat_label = upper(trim(p_seat)), boarded = false
    where id = p_ticket_id;
  exception when exclusion_violation then
    raise exception 'Ghế % đã có người trên chặng này', upper(trim(p_seat)) using errcode = '23P01';
  end;
  if v_fee > 0 then
    insert into public.ledger_transactions (tenant_id, kind, booking_id, note, created_by)
    values (v_tid, 'doi_ve', v_s.booking_id, 'Phí đổi vé ghế ' || upper(trim(p_seat)), auth.uid()) returning id into v_txn;
    insert into public.ledger_lines (tenant_id, txn_id, account, holder_id, debit, credit) values
      (v_tid, v_txn, case p_fee_method when 'chuyen_khoan' then 'ngan_hang' else 'tien_mat' end, auth.uid(), v_fee, 0),
      (v_tid, v_txn, 'phi_huy_doi', null, 0, v_fee);
  end if;
  return v_fee;
end;
$$;

revoke execute on function public.cancel_quote(uuid[]), public.cancel_tickets(uuid[], text, text, int, text),
  public.change_ticket(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.cancel_quote(uuid[]), public.cancel_tickets(uuid[], text, text, int, text),
  public.change_ticket(uuid, uuid, text, text) to authenticated;
