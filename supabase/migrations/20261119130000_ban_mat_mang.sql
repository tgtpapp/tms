-- =====================================================================
-- Giai đoạn 4.4 – Bán khi mất mạng + nhập vé giấy
-- - Mất mạng: app bán trên máy (vé "chờ gửi"), có mạng tự gửi lên qua sync_offline_sale.
-- - Vé giấy viết tay: nhập bù bằng cùng hàm, có số vé giấy (chặn nhập trùng số).
-- - Chống gửi lặp: mỗi đơn có khóa offline_key (UNIQUE). Gửi lại trả kết quả cũ.
-- - Trùng ghế: KHÔNG mất vé, KHÔNG mất tiền. Vé ghi trạng thái 'cho_xep' (đã thu tiền, chờ xếp ghế),
--   điều hành xếp ghế khác (change_ticket) hoặc hủy / hoàn (cancel_tickets).
-- =====================================================================

alter table public.bookings add column offline_key uuid;
alter table public.bookings add column paper_no text;
alter table public.bookings add column sold_offline_at timestamptz;
create unique index bookings_offline_key_uq on public.bookings (tenant_id, offline_key) where offline_key is not null;
create unique index bookings_paper_no_uq on public.bookings (tenant_id, paper_no) where paper_no is not null;

alter table public.seat_inventory drop constraint seat_inventory_status_check;
alter table public.seat_inventory add constraint seat_inventory_status_check
  check (status in ('giu', 'dat', 'da_tt', 'cho_xep', 'het_han', 'huy'));
alter table public.seat_inventory add check (status <> 'cho_xep' or paid_at is not null);
create index seat_inventory_waiting_idx on public.seat_inventory (tenant_id, trip_id) where status = 'cho_xep';

-- ---------------------------------------------------------------- Bảng giá chuyến (lưu trên máy để bán khi mất mạng)
create function public.trip_fares(p_trip_id uuid)
returns table (from_stop_id uuid, to_stop_id uuid, price int)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_trip public.trips;
  a record; b record;
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = p_trip_id and tenant_id = v_tid;
  if not found then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  for a in select stop_id from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id loop
    for b in select stop_id from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id and stop_id <> a.stop_id loop
      from_stop_id := a.stop_id;
      to_stop_id := b.stop_id;
      begin
        price := public.fare_for(v_trip.route_id, a.stop_id, b.stop_id, v_trip.service_date);
      exception when others then
        price := null;
      end;
      if price is not null then
        return next;
      end if;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- Gửi vé bán khi mất mạng / vé giấy
-- p_price: giá MỖI ghế đã thu thật (vé giấy theo giá viết trên vé). p_sold_at: giờ bán thật.
create function public.sync_offline_sale(p_key uuid, p_paper_no text, p_trip_id uuid, p_seats text[], p_from_stop uuid, p_to_stop uuid,
                                         p_price int, p_phone text, p_name text, p_method text, p_sold_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_trip public.trips;
  v_b public.bookings;
  v_from int; v_to int;
  v_paper text := nullif(upper(trim(p_paper_no)), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
  v_seat text;
  v_ok boolean;
  v_conf text[] := '{}';
  v_n int := 0;
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  if p_key is null then
    raise exception 'Thiếu khóa chống gửi lặp' using errcode = '22023';
  end if;
  select * into v_b from public.bookings where tenant_id = v_tid and offline_key = p_key;
  if found then
    return jsonb_build_object('booking_id', v_b.id, 'code', v_b.code, 'repeated', true,
      'conflicts', coalesce((select jsonb_agg(seat_label order by seat_label) from public.seat_inventory
                             where tenant_id = v_tid and booking_id = v_b.id and status = 'cho_xep'), '[]'));
  end if;
  if v_paper is not null then
    if v_paper !~ '^[A-Z0-9/.-]{1,20}$' then
      raise exception 'Số vé giấy: 1–20 ký tự chữ, số' using errcode = '22023';
    end if;
    select * into v_b from public.bookings where tenant_id = v_tid and paper_no = v_paper;
    if found then
      raise exception 'Vé giấy số % đã nhập rồi (mã %)', v_paper, v_b.code using errcode = '23505';
    end if;
  end if;
  select * into v_trip from public.trips where id = p_trip_id and tenant_id = v_tid;
  if not found then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  if p_seats is null or cardinality(p_seats) = 0 or cardinality(p_seats) > 60 then
    raise exception 'Chọn ghế' using errcode = '22023';
  end if;
  if p_price is null or p_price < 0 or p_price > 10000000 then
    raise exception 'Giá vé từ 0 đến 10.000.000 đồng' using errcode = '22023';
  end if;
  if coalesce(p_method, '') not in ('tien_mat', 'chuyen_khoan') then
    raise exception 'Chọn thu tiền mặt hoặc chuyển khoản' using errcode = '22023';
  end if;
  if v_phone is not null and v_phone !~ '^0[0-9]{9}$' then
    raise exception 'Số điện thoại phải gồm 10 số, bắt đầu bằng 0' using errcode = '22023';
  end if;
  if p_sold_at is null or p_sold_at > now() + interval '10 minutes' or p_sold_at < now() - interval '30 days' then
    raise exception 'Giờ bán không hợp lệ (trong vòng 30 ngày)' using errcode = '22023';
  end if;
  v_from := app.stop_idx(v_tid, v_trip.route_id, v_trip.direction, p_from_stop);
  v_to := app.stop_idx(v_tid, v_trip.route_id, v_trip.direction, p_to_stop);
  if v_from is null or v_to is null or v_to <= v_from then
    raise exception 'Điểm đón phải trước điểm trả theo chiều chạy' using errcode = '22023';
  end if;

  insert into public.bookings (tenant_id, code, channel, customer_phone, customer_name, created_by, offline_key, paper_no, sold_offline_at, note)
  values (v_tid, app.new_booking_code(v_tid), case when v_paper is null then 'quay' else 'giay' end, v_phone, nullif(trim(p_name), ''),
          auth.uid(), p_key, v_paper, p_sold_at, case when v_paper is null then 'Bán khi mất mạng' else 'Vé giấy số ' || v_paper end)
  returning * into v_b;

  perform app.release_expired(v_tid, p_trip_id);
  foreach v_seat in array p_seats loop
    v_seat := upper(trim(v_seat));
    v_ok := v_trip.status = 'mo' and v_trip.vehicle_type_id is not null
      and exists (select 1 from public.vehicle_type_seats where tenant_id = v_tid and vehicle_type_id = v_trip.vehicle_type_id
                    and label = v_seat and is_sellable);
    if v_ok then
      begin
        insert into public.seat_inventory (tenant_id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx,
                                           price, status, paid_at, paid_by, pay_method, passenger_name, passenger_phone, created_by)
        values (v_tid, v_b.id, p_trip_id, v_seat, p_from_stop, p_to_stop, v_from, v_to, p_price, 'da_tt', p_sold_at, auth.uid(),
                p_method, nullif(trim(p_name), ''), v_phone, auth.uid());
      exception when exclusion_violation then
        v_ok := false;
      end;
    end if;
    if not v_ok then
      -- Trùng ghế / ghế không còn trên sơ đồ: vẫn lưu vé và tiền, chờ điều hành xếp ghế khác
      insert into public.seat_inventory (tenant_id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx,
                                         price, status, paid_at, paid_by, pay_method, passenger_name, passenger_phone, created_by)
      values (v_tid, v_b.id, p_trip_id, v_seat, p_from_stop, p_to_stop, v_from, v_to, p_price, 'cho_xep', p_sold_at, auth.uid(),
              p_method, nullif(trim(p_name), ''), v_phone, auth.uid());
      v_conf := v_conf || v_seat;
    end if;
    v_n := v_n + 1;
  end loop;

  perform app.post_sale(v_tid, v_b.id, p_price::bigint * v_n,
    case when v_paper is null then 'Bán khi mất mạng ' || v_b.code else 'Vé giấy số ' || v_paper end, p_method);
  return jsonb_build_object('booking_id', v_b.id, 'code', v_b.code, 'repeated', false, 'conflicts', to_jsonb(v_conf));
end;
$$;

-- ---------------------------------------------------------------- Hủy / đổi: tính cả vé chờ xếp ghế (đã thu tiền)
create or replace function public.cancel_quote(p_ticket_ids uuid[])
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
         case when s.status <> 'dat' then app.cancel_fee_pct(v_tid, extract(epoch from (t.depart_at - now())) / 3600) else 0 end,
         case when s.status <> 'dat' then round(s.price * app.cancel_fee_pct(v_tid, extract(epoch from (t.depart_at - now())) / 3600) / 100.0)::int else 0 end,
         case when s.status <> 'dat' then s.price - round(s.price * app.cancel_fee_pct(v_tid, extract(epoch from (t.depart_at - now())) / 3600) / 100.0)::int else 0 end
  from public.seat_inventory s join public.trips t on t.tenant_id = s.tenant_id and t.id = s.trip_id
  where s.tenant_id = v_tid and s.id = any (p_ticket_ids) and s.status in ('dat', 'da_tt', 'cho_xep');
end;
$$;

create or replace function public.cancel_tickets(p_ticket_ids uuid[], p_reason text, p_refund_method text,
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
           where s.tenant_id = v_tid and s.id = any (p_ticket_ids) and s.status in ('dat', 'da_tt', 'cho_xep')
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
        cancel_fee = v_fee, refund_amount = v_refund, refund_method = case when r.status <> 'dat' then p_refund_method end,
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

create or replace function public.change_ticket(p_ticket_id uuid, p_trip_id uuid, p_seat text, p_fee_method text)
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
  select * into v_s from public.seat_inventory where id = p_ticket_id and tenant_id = v_tid and status in ('dat', 'da_tt', 'cho_xep') for update;
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
  if v_new.arrive_at <= now() and v_s.status <> 'cho_xep' then
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
    update public.seat_inventory set trip_id = v_new.id, seat_label = upper(trim(p_seat)), boarded = false,
           status = case when status = 'cho_xep' then 'da_tt' else status end
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

revoke execute on function public.trip_fares(uuid),
  public.sync_offline_sale(uuid, text, uuid, text[], uuid, uuid, int, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.trip_fares(uuid),
  public.sync_offline_sale(uuid, text, uuid, text[], uuid, uuid, int, text, text, text, timestamptz) to authenticated;
