-- =====================================================================
-- Vé cọc: khách trả trước một phần, phần còn lại thu sau.
-- - Tiền cọc ghi sổ cái như tiền vé đã thu (Nợ tiền mặt / ngân hàng, Có doanh thu vé); thu nốt chỉ ghi phần còn lại.
-- - Vé đã cọc giữ ghế tới giờ chạy (không tự nhả).
-- - Hủy vé cọc: 3 cách, không làm cứng — mặc định theo Cấu hình (ve.huy_coc), nhân viên chọn lại khi hủy:
--   hoan_theo_phi (trừ phí hủy như vé đã trả, không hoàn quá số đã cọc) | khong_hoan | tu_nhap (nhập số tiền hoàn).
-- =====================================================================
alter table public.seat_inventory add column deposit bigint not null default 0 check (deposit >= 0);

/** Nhận cọc cho các vé đang đặt chỗ của đơn. p_amount < số còn phải thu (đủ tiền thì dùng Thu tiền). */
create function public.deposit_booking(p_booking_id uuid, p_amount bigint, p_method text default 'tien_mat')
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); v_b public.bookings; v_due bigint; v_left bigint := p_amount; r record; v_add bigint;
begin
  if v_tid is null or not app.has_permission('sell.add') then raise exception 'Không có quyền bán vé' using errcode = '42501'; end if;
  if coalesce(p_method, '') not in ('tien_mat', 'chuyen_khoan') then raise exception 'Chọn tiền mặt hoặc chuyển khoản' using errcode = '22023'; end if;
  select * into v_b from public.bookings where id = p_booking_id and tenant_id = v_tid for update;
  if not found then raise exception 'Không tìm thấy đơn vé' using errcode = 'P0002'; end if;
  perform app.release_expired(v_tid, null);
  select coalesce(sum(price - deposit), 0) into v_due from public.seat_inventory where tenant_id = v_tid and booking_id = p_booking_id and status = 'dat';
  if v_due <= 0 then raise exception 'Đơn không còn vé chờ thanh toán' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Nhập số tiền cọc' using errcode = '22023'; end if;
  if p_amount >= v_due then raise exception 'Khách trả đủ thì chọn Thu tiền (còn phải thu %)', v_due using errcode = '22023'; end if;
  -- bấm 2 lần: cùng người, cùng số tiền trong 30 giây thì không ghi lại
  if exists (select 1 from public.ledger_transactions x join public.ledger_lines l on l.tenant_id = x.tenant_id and l.txn_id = x.id
             where x.tenant_id = v_tid and x.booking_id = p_booking_id and x.kind = 'ban_ve' and x.note like 'Nhận cọc vé %'
               and x.created_by = auth.uid() and x.created_at > now() - interval '30 seconds' and l.account = 'doanh_thu_ve' and l.credit = p_amount) then
    return 0;
  end if;
  for r in select id, price, deposit from public.seat_inventory where tenant_id = v_tid and booking_id = p_booking_id and status = 'dat'
           order by seat_label for update loop
    exit when v_left <= 0;
    v_add := least(v_left, r.price - r.deposit);
    continue when v_add <= 0;
    update public.seat_inventory set deposit = deposit + v_add, hold_until = null, keep_reason = coalesce(keep_reason, 'Đã cọc') where id = r.id;
    v_left := v_left - v_add;
  end loop;
  -- vé chưa được chia cọc trong đơn cũng giữ tới giờ chạy
  update public.seat_inventory set hold_until = null, keep_reason = coalesce(keep_reason, 'Đơn đã cọc')
  where tenant_id = v_tid and booking_id = p_booking_id and status = 'dat';
  perform app.post_sale(v_tid, p_booking_id, p_amount,
    case p_method when 'chuyen_khoan' then 'Nhận cọc vé (chuyển khoản) ' else 'Nhận cọc vé ' end || v_b.code, p_method);
  return p_amount;
end;
$$;
revoke execute on function public.deposit_booking(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.deposit_booking(uuid, bigint, text) to authenticated, service_role;

-- Thu nốt: chỉ ghi phần còn lại (giá - đã cọc)
do $$
declare v text;
begin
  v := pg_get_functiondef('public.pay_booking(uuid, uuid[], text)'::regprocedure);
  v := replace(v, E'    returning price\n', E'    returning price - deposit\n');
  if v not like '%returning price - deposit%' then raise exception 'Không sửa được pay_booking'; end if;
  execute v;
end;
$$;

-- Hủy vé: thêm cách xử lý tiền cọc
do $$
declare v text;
begin
  v := pg_get_functiondef('public.cancel_tickets(uuid[], text, text, integer, text)'::regprocedure);
  v := replace(v, 'p_fee_override integer, p_override_reason text)', 'p_fee_override integer, p_override_reason text, p_deposit_mode text DEFAULT NULL::text, p_deposit_refund bigint DEFAULT NULL::bigint)');
  v := replace(v, E'  v_booking uuid;\n', E'  v_booking uuid;\n  v_mode text;\n  v_left bigint;\n');
  v := replace(v, E'  for r in select s.*, t.depart_at', E'  v_mode := coalesce(nullif(p_deposit_mode, ''''), (select value #>> ''{}'' from public.tenant_settings where tenant_id = v_tid and key = ''ve.huy_coc''), ''hoan_theo_phi'');\n'
    || E'  if v_mode not in (''hoan_theo_phi'', ''khong_hoan'', ''tu_nhap'') then raise exception ''Cách xử lý tiền cọc không hợp lệ'' using errcode = ''22023''; end if;\n'
    || E'  if v_mode = ''tu_nhap'' and (p_deposit_refund is null or p_deposit_refund < 0) then raise exception ''Nhập số tiền hoàn cọc'' using errcode = ''22023''; end if;\n'
    || E'  v_left := coalesce(p_deposit_refund, 0);\n'
    || E'  for r in select s.*, t.depart_at');
  v := replace(v, E'    if r.status = ''dat'' then\n      v_fee := 0; v_refund := 0;',
       E'    if r.status = ''dat'' and r.deposit > 0 then\n'
    || E'      v_refund := case v_mode when ''khong_hoan'' then 0\n'
    || E'                    when ''tu_nhap'' then least(v_left, r.deposit)\n'
    || E'                    else greatest(0, r.deposit - case when p_fee_override is not null then p_fee_override\n'
    || E'                      else round(r.price * app.cancel_fee_pct(v_tid, extract(epoch from (r.depart_at - now())) / 3600) / 100.0)::bigint end) end;\n'
    || E'      if v_mode = ''tu_nhap'' then v_left := v_left - v_refund; end if;\n'
    || E'      v_fee := r.deposit - v_refund;\n'
    || E'      v_total_price := v_total_price + r.deposit;\n'
    || E'      v_total_fee := v_total_fee + v_fee;\n'
    || E'      v_total_refund := v_total_refund + v_refund;\n'
    || E'      v_booking := r.booking_id;\n'
    || E'    elsif r.status = ''dat'' then\n      v_fee := 0; v_refund := 0;');
  v := replace(v, 'refund_method = case when r.status <> ''dat'' then p_refund_method end', 'refund_method = case when r.status <> ''dat'' or r.deposit > 0 then p_refund_method end');
  if v not like '%p_deposit_mode text DEFAULT%' or v not like '%v_mode text;%' or v not like '%ve.huy_coc%' or v not like '%r.deposit > 0 then%'
     or v not like '%or r.deposit > 0 then p_refund_method%' then
    raise exception 'Không sửa được cancel_tickets';
  end if;
  drop function public.cancel_tickets(uuid[], text, text, integer, text);
  execute v;
end;
$$;
revoke execute on function public.cancel_tickets(uuid[], text, text, integer, text, text, bigint) from public, anon, authenticated;
grant execute on function public.cancel_tickets(uuid[], text, text, integer, text, text, bigint) to authenticated, service_role;

-- Cấu hình: cách hủy vé cọc mặc định
do $$
declare v text;
begin
  v := pg_get_functiondef('app.validate_tenant_setting()'::regprocedure);
  v := replace(v, E'  elsif new.key = ''lenh.hau_to'' then',
       E'  elsif new.key = ''ve.huy_coc'' then\n'
    || E'    if jsonb_typeof(new.value) <> ''string'' or (new.value #>> ''{}'') not in (''hoan_theo_phi'', ''khong_hoan'', ''tu_nhap'') then\n'
    || E'      raise exception ''Cách hủy vé cọc không hợp lệ'' using errcode = ''22023'';\n    end if;\n'
    || E'  elsif new.key = ''lenh.hau_to'' then');
  if v not like '%ve.huy_coc%' then raise exception 'Không sửa được validate_tenant_setting'; end if;
  execute v;
end;
$$;
