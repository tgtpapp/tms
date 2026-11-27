-- =====================================================================
-- Sửa phiếu gửi hàng (hàm mới update_shipment; không đổi bảng):
-- - Chỉ khi phiếu chưa giao / chưa hủy; quyền parcel.edit; sai nhà xe → "không tìm thấy".
-- - Sửa: người gửi / nhận, hàng gì, số kiện, cân nặng, giá trị khai báo, cước, người trả cước, thu hộ, ghi chú.
-- - Tiền (sổ cái chỉ thêm, không sửa giao dịch cũ):
--   cước đã thu mà tăng → ghi thu thêm phần chênh; giảm → ghi hoàn bớt phần chênh.
--   đổi "người nhận trả" → "người gửi trả" → thu cước ngay. Đã thu cước thì không đổi sang người nhận trả.
-- - Lịch sử sửa ghi tự động qua trigger nhật ký của bảng shipments.
-- =====================================================================
create function public.update_shipment(p_id uuid, p jsonb, p_method text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
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
  begin
    update public.shipments set
      sender_name = nullif(trim(p ->> 'sender_name'), ''),
      sender_phone = regexp_replace(coalesce(p ->> 'sender_phone', ''), '[^0-9]', '', 'g'),
      receiver_name = nullif(trim(p ->> 'receiver_name'), ''),
      receiver_phone = regexp_replace(coalesce(p ->> 'receiver_phone', ''), '[^0-9]', '', 'g'),
      description = trim(coalesce(p ->> 'description', '')),
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
$$;
revoke execute on function public.update_shipment(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.update_shipment(uuid, jsonb, text) to authenticated, service_role;
