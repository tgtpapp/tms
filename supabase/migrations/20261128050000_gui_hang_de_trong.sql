-- =====================================================================
-- Gửi hàng: cho phép để trống, điền sau (khi sửa phiếu):
--   Gửi tại, SĐT người gửi, SĐT người nhận, Hàng gì. Nhận tại vẫn bắt buộc.
-- - Cột bỏ NOT NULL; ràng buộc kiểm tra cũ giữ nguyên (giá trị trống = NULL thì không bị kiểm tra,
--   có nhập thì SĐT vẫn phải 10 số).
-- - Sửa phiếu được điền Gửi tại (from_stop_id) nếu gửi lên.
-- =====================================================================
alter table public.shipments
  alter column from_stop_id drop not null,
  alter column sender_phone drop not null,
  alter column receiver_phone drop not null,
  alter column description drop not null;

create or replace function public.create_shipment(p jsonb, p_method text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid;
  v_code text;
  v_trip public.trips;
  v_fee int;
  v_payer text := coalesce(p ->> 'fee_payer', 'nguoi_gui');
begin
  if v_tid is null or not app.has_permission('parcel.add') then
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
  if (nullif(p ->> 'from_stop_id', '') is not null
      and not exists (select 1 from public.stops where tenant_id = v_tid and id = (p ->> 'from_stop_id')::uuid))
     or not exists (select 1 from public.stops where tenant_id = v_tid and id = nullif(p ->> 'to_stop_id', '')::uuid) then
    raise exception 'Chọn nơi nhận' using errcode = '22023';
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
            nullif(p ->> 'from_stop_id', '')::uuid, (p ->> 'to_stop_id')::uuid, nullif(trim(p ->> 'sender_name'), ''),
            nullif(regexp_replace(coalesce(p ->> 'sender_phone', ''), '[^0-9]', '', 'g'), ''), nullif(trim(p ->> 'receiver_name'), ''),
            nullif(regexp_replace(coalesce(p ->> 'receiver_phone', ''), '[^0-9]', '', 'g'), ''), nullif(trim(coalesce(p ->> 'description', '')), ''),
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
$function$;

create or replace function public.update_shipment(p_id uuid, p jsonb, p_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tid uuid := app.current_tenant_id();
  v_s public.shipments;
  v_fee int := coalesce((p ->> 'fee')::int, -1);
  v_payer text := coalesce(p ->> 'fee_payer', '');
  v_diff int;
  v_txn uuid;
  v_cash text := case p_method when 'chuyen_khoan' then 'ngan_hang' else 'tien_mat' end;
begin
  select * into v_s from public.shipments where id = p_id and tenant_id = v_tid for update;
  if v_tid is null or not found or not app.has_permission('parcel.edit') then
    raise exception 'Không tìm thấy phiếu gửi hàng' using errcode = 'P0002';
  end if;
  if v_s.status in ('giao', 'huy') then
    raise exception 'Phiếu đã giao hoặc đã hủy, không sửa được' using errcode = '22023';
  end if;
  if v_payer not in ('nguoi_gui', 'nguoi_nhan') then
    raise exception 'Chọn người trả cước' using errcode = '22023';
  end if;
  if v_s.fee_paid_at is not null and v_payer = 'nguoi_nhan' then
    raise exception 'Đã thu cước của người gửi, không đổi sang người nhận trả' using errcode = '22023';
  end if;
  v_diff := case when v_s.fee_paid_at is not null then v_fee - v_s.fee
                 when v_payer = 'nguoi_gui' then v_fee else 0 end;
  if v_diff <> 0 and coalesce(p_method, '') not in ('tien_mat', 'chuyen_khoan') then
    raise exception 'Chọn cách thu / hoàn tiền chênh lệch' using errcode = '22023';
  end if;
  if nullif(p ->> 'from_stop_id', '') is not null
     and not exists (select 1 from public.stops where tenant_id = v_tid and id = (p ->> 'from_stop_id')::uuid) then
    raise exception 'Không tìm thấy nơi gửi' using errcode = 'P0002';
  end if;
  begin
    update public.shipments set
      from_stop_id = case when p ? 'from_stop_id' then nullif(p ->> 'from_stop_id', '')::uuid else from_stop_id end,
      sender_name = nullif(trim(p ->> 'sender_name'), ''),
      sender_phone = nullif(regexp_replace(coalesce(p ->> 'sender_phone', ''), '[^0-9]', '', 'g'), ''),
      receiver_name = nullif(trim(p ->> 'receiver_name'), ''),
      receiver_phone = nullif(regexp_replace(coalesce(p ->> 'receiver_phone', ''), '[^0-9]', '', 'g'), ''),
      description = nullif(trim(coalesce(p ->> 'description', '')), ''),
      packages = coalesce((p ->> 'packages')::int, 1),
      weight_kg = nullif(p ->> 'weight_kg', '')::numeric,
      declared_value = case when p ? 'declared_value' then nullif(p ->> 'declared_value', '')::int else declared_value end,
      fee = v_fee,
      fee_payer = v_payer,
      fee_paid_at = case when v_payer = 'nguoi_gui' then coalesce(fee_paid_at, now()) end,
      cod_amount = coalesce((p ->> 'cod_amount')::int, 0),
      note = nullif(trim(p ->> 'note'), '')
    where id = p_id;
  exception when check_violation then
    raise exception 'Kiểm tra lại: SĐT người gửi / nhận 10 số, mô tả hàng, số kiện, cước, thu hộ' using errcode = '22023';
  end;
  if v_diff > 0 then
    perform app.post_parcel(v_tid, p_id, 'cuoc', v_diff, p_method,
      case when v_s.fee_paid_at is null then 'Cước gửi hàng ' else 'Sửa phiếu: thu thêm cước ' end || v_s.code);
  elsif v_diff < 0 then
    insert into public.ledger_transactions (tenant_id, kind, shipment_id, note, created_by)
    values (v_tid, 'gui_hang_hoan_cuoc', p_id, 'Sửa phiếu ' || v_s.code || ': hoàn bớt cước', auth.uid()) returning id into v_txn;
    insert into public.ledger_lines (tenant_id, txn_id, account, holder_id, debit, credit) values
      (v_tid, v_txn, 'doanh_thu_hang', null, -v_diff, 0),
      (v_tid, v_txn, v_cash, auth.uid(), 0, -v_diff);
  end if;
  return jsonb_build_object('chenh_lech', v_diff);
end;
$function$;
revoke execute on function public.create_shipment(jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.create_shipment(jsonb, text, uuid) to authenticated, service_role;
revoke execute on function public.update_shipment(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.update_shipment(uuid, jsonb, text) to authenticated, service_role;
