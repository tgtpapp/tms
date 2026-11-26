-- =====================================================================
-- Đồng bộ vé Vexere → TMS (chạy mỗi giờ qua mục Điều hành → Nhập lịch Vexere).
-- - Chỉ THÊM: bookings.ext_ref (mã vé phía Vexere, để chạy lại không tạo trùng). Mã vé TMS vẫn sinh như bán ở quầy.
-- - Hàm public.sync_vexere_tickets(chuyến, danh sách vé): vé mới → giữ ghế + tạo vé kênh 'vexere'; vé đổi → cập nhật;
--   vé hủy / không còn trên Vexere → hủy, nhả ghế. Ghế đã bán ở quầy TMS: không ghi đè, báo trùng.
-- - Trạng thái: tt = đã thanh toán, coc = đặt chỗ có cọc, giu = giữ chỗ (đều giữ tới giờ chạy). KHÔNG ghi sổ tiền
--   (tiền vé Vexere thu ngoài TMS).
-- =====================================================================
alter table public.bookings add column ext_ref text;
create unique index bookings_ext_ref_uq on public.bookings (tenant_id, ext_ref) where ext_ref is not null;

-- Ký hiệu ghế so khớp: A2 = A02 = a 2
create function app.seat_key(p text)
returns text language sql immutable set search_path = ''
as $$ select regexp_replace(upper(regexp_replace(coalesce(p, ''), '\s+', '', 'g')), '^([A-Z]*)0*([0-9]+)$', '\1\2') $$;

-- Tên điểm so khớp: bỏ "bến xe" / "BX" / "VP", chữ thường, gộp khoảng trắng
create function app.stop_key(p text)
returns text language sql immutable set search_path = ''
as $$ select trim(regexp_replace(regexp_replace(lower(normalize(coalesce(p, ''), NFC)), '^\s*(bến xe|bx|vp|văn phòng)\s+', ''), '\s+', ' ', 'g')) $$;
revoke execute on function app.seat_key(text), app.stop_key(text) from public, anon, authenticated;

create function public.sync_vexere_tickets(p_trip_id uuid, p_tickets jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_trip public.trips;
  v_first uuid; v_last uuid;
  e jsonb;
  v_ref text; v_tt text; v_label text; v_from uuid; v_to uuid; v_fi int; v_ti int;
  v_price int; v_dep bigint; v_phone text; v_name text; v_note text; v_status text;
  v_b uuid; v_row public.seat_inventory;
  v_seen text[] := '{}';
  v_new int := 0; v_upd int := 0; v_huy int := 0; v_same int := 0; v_n int;
  v_err jsonb := '[]'::jsonb;
begin
  if v_tid is null or not app.has_permission('sell.add') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = p_trip_id and tenant_id = v_tid;
  if not found then raise exception 'Không tìm thấy chuyến' using errcode = 'P0002'; end if;
  if v_trip.status <> 'mo' then raise exception 'Chuyến đã hủy' using errcode = '22023'; end if;
  if v_trip.vehicle_type_id is null then
    raise exception 'Chuyến chưa có sơ đồ ghế' using errcode = '22023';
  end if;
  if jsonb_typeof(p_tickets) is distinct from 'array' then
    raise exception 'Danh sách vé không hợp lệ' using errcode = '22023';
  end if;

  -- điểm đầu / cuối theo chiều chạy (dùng khi không nhận ra điểm đón / trả)
  select stop_id into v_first from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id
  order by case when v_trip.direction = 'di' then seq else -seq end limit 1;
  select stop_id into v_last from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id
  order by case when v_trip.direction = 'di' then -seq else seq end limit 1;
  if v_first is null or v_first = v_last then
    raise exception 'Tuyến chưa có điểm dừng' using errcode = '22023';
  end if;

  for e in select x from jsonb_array_elements(p_tickets) x loop
    v_ref := nullif(trim(e ->> 'id'), '');
    if v_ref is null then
      v_err := v_err || jsonb_build_object('ghe', e ->> 'ghe', 'loi', 'Thiếu mã vé Vexere');
      continue;
    end if;
    v_ref := 'vexere:' || v_ref;
    v_seen := v_seen || v_ref;
    v_tt := coalesce(e ->> 'tt', '');
    v_b := null; v_row := null;
    select id into v_b from public.bookings where tenant_id = v_tid and ext_ref = v_ref;
    if v_b is not null then
      select * into v_row from public.seat_inventory
      where tenant_id = v_tid and booking_id = v_b and status in ('giu', 'dat', 'da_tt') order by created_at desc limit 1;
    end if;

    if v_tt not in ('tt', 'coc', 'giu') then          -- vé hủy trên Vexere
      if v_row.id is not null then
        update public.seat_inventory set status = 'huy' where id = v_row.id;
        v_huy := v_huy + 1;
      end if;
      continue;
    end if;

    -- ghế: theo ký hiệu (A2 = A02), không có thì theo vị trí tầng / hàng / cột
    select label into v_label from public.vehicle_type_seats
    where tenant_id = v_tid and vehicle_type_id = v_trip.vehicle_type_id and is_sellable
      and app.seat_key(label) = app.seat_key(e ->> 'ghe') limit 1;
    if v_label is null and (e ->> 'hang') ~ '^\d+$' and (e ->> 'cot') ~ '^\d+$' then
      select label into v_label from public.vehicle_type_seats
      where tenant_id = v_tid and vehicle_type_id = v_trip.vehicle_type_id and is_sellable
        and deck = coalesce(nullif(e ->> 'tang', '')::int, 1) and row_no = (e ->> 'hang')::int and col_no = (e ->> 'cot')::int;
    end if;
    if v_label is null then
      v_err := v_err || jsonb_build_object('ghe', e ->> 'ghe', 'loi', 'Ghế không có trên sơ đồ xe của chuyến');
      continue;
    end if;

    -- điểm đón / trả: theo mã hoặc tên điểm trên tuyến, không nhận ra thì lấy đầu / cuối tuyến
    select rs.stop_id into v_from from public.route_stops rs join public.stops s on s.tenant_id = rs.tenant_id and s.id = rs.stop_id
    where rs.tenant_id = v_tid and rs.route_id = v_trip.route_id
      and (upper(s.code) = upper(coalesce(e ->> 'tu_ma', '')) or app.stop_key(s.name) = app.stop_key(e ->> 'tu_ten')) limit 1;
    select rs.stop_id into v_to from public.route_stops rs join public.stops s on s.tenant_id = rs.tenant_id and s.id = rs.stop_id
    where rs.tenant_id = v_tid and rs.route_id = v_trip.route_id
      and (upper(s.code) = upper(coalesce(e ->> 'den_ma', '')) or app.stop_key(s.name) = app.stop_key(e ->> 'den_ten')) limit 1;
    v_from := coalesce(v_from, v_first); v_to := coalesce(v_to, v_last);
    v_fi := app.stop_idx(v_tid, v_trip.route_id, v_trip.direction, v_from);
    v_ti := app.stop_idx(v_tid, v_trip.route_id, v_trip.direction, v_to);
    if v_fi is null or v_ti is null or v_ti <= v_fi then
      v_from := v_first; v_to := v_last;
      v_fi := app.stop_idx(v_tid, v_trip.route_id, v_trip.direction, v_from);
      v_ti := app.stop_idx(v_tid, v_trip.route_id, v_trip.direction, v_to);
    end if;

    v_price := case when (e ->> 'gia') ~ '^\d+$' and (e ->> 'gia')::bigint between 1 and 100000000 then (e ->> 'gia')::int end;
    if v_price is null then
      begin
        v_price := public.fare_for(v_trip.route_id, v_from, v_to, v_trip.service_date);
      exception when others then v_price := 0;
      end;
    end if;
    v_dep := case when v_tt = 'coc' and (e ->> 'coc') ~ '^\d+$' then least((e ->> 'coc')::bigint, v_price) else 0 end;
    v_phone := nullif(regexp_replace(coalesce(e ->> 'sdt', ''), '[^0-9]', '', 'g'), '');
    v_name := nullif(left(trim(coalesce(e ->> 'ten', '')), 120), '');
    v_note := nullif(left(trim(coalesce(e ->> 'ghi_chu', '')), 300), '');
    v_status := case when v_tt = 'tt' then 'da_tt' else 'dat' end;

    if v_row.id is not null and v_row.trip_id = p_trip_id then
      if v_row.seat_label = v_label and v_row.from_stop_id = v_from and v_row.to_stop_id = v_to and v_row.status = v_status
         and v_row.price = v_price and v_row.deposit = v_dep and v_row.passenger_phone is not distinct from v_phone
         and v_row.passenger_name is not distinct from v_name and v_row.pickup_note is not distinct from v_note then
        v_same := v_same + 1;
        continue;
      end if;
      begin
        update public.seat_inventory set seat_label = v_label, from_stop_id = v_from, to_stop_id = v_to, from_idx = v_fi, to_idx = v_ti,
          price = v_price, deposit = v_dep, status = v_status, hold_until = null,
          keep_reason = case v_tt when 'tt' then null when 'coc' then 'Vexere: cọc' else 'Vexere: giữ chỗ' end,
          paid_at = case when v_status = 'da_tt' then coalesce(paid_at, now()) end,
          paid_by = case when v_status = 'da_tt' then coalesce(paid_by, auth.uid()) end,
          passenger_name = v_name, passenger_phone = v_phone, pickup_note = v_note
        where id = v_row.id;
        update public.bookings set customer_phone = v_phone, customer_name = v_name, note = v_note where id = v_b;
        v_upd := v_upd + 1;
      exception when exclusion_violation then
        v_err := v_err || jsonb_build_object('ghe', v_label, 'loi', 'Ghế đã có người trên TMS, không đổi được');
      end;
      continue;
    end if;

    begin
      if v_row.id is not null then          -- vé chuyển sang chuyến khác trên Vexere
        update public.seat_inventory set status = 'huy' where id = v_row.id;
      end if;
      if v_b is null then
        insert into public.bookings (tenant_id, code, channel, ext_ref, customer_phone, customer_name, note, created_by)
        values (v_tid, app.new_booking_code(v_tid), 'vexere', v_ref, v_phone, v_name, v_note, auth.uid())
        returning id into v_b;
      end if;
      insert into public.seat_inventory (tenant_id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx,
                                         price, deposit, status, hold_until, keep_reason, paid_at, paid_by,
                                         passenger_name, passenger_phone, pickup_note, created_by)
      values (v_tid, v_b, p_trip_id, v_label, v_from, v_to, v_fi, v_ti, v_price, v_dep, v_status, null,
              case v_tt when 'tt' then null when 'coc' then 'Vexere: cọc' else 'Vexere: giữ chỗ' end,
              case when v_status = 'da_tt' then now() end, case when v_status = 'da_tt' then auth.uid() end,
              v_name, v_phone, v_note, auth.uid());
      v_new := v_new + 1;
    exception when exclusion_violation then
      v_err := v_err || jsonb_build_object('ghe', v_label, 'loi', 'Ghế đã bán ở TMS, không ghi đè');
    end;
  end loop;

  -- vé Vexere của chuyến này không còn trong danh sách → hủy, nhả ghế
  update public.seat_inventory s set status = 'huy'
  from public.bookings b
  where s.tenant_id = v_tid and s.trip_id = p_trip_id and s.status in ('giu', 'dat', 'da_tt')
    and b.tenant_id = s.tenant_id and b.id = s.booking_id and b.channel = 'vexere' and b.ext_ref is not null
    and not (b.ext_ref = any (v_seen));
  get diagnostics v_n = row_count;
  v_huy := v_huy + v_n;

  return jsonb_build_object('moi', v_new, 'cap_nhat', v_upd, 'huy', v_huy, 'giu_nguyen', v_same, 'loi', v_err);
end;
$$;
revoke execute on function public.sync_vexere_tickets(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sync_vexere_tickets(uuid, jsonb) to authenticated, service_role;
