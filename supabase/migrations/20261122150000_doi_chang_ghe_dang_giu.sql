-- =====================================================================
-- Đổi chặng ngay trong cửa sổ bán vé: các ghế mình đang giữ (chưa xác nhận) của đơn chuyển sang chặng mới,
-- giá vé tính lại theo Bảng giá vé. Ghế đã có người trên chặng mới thì báo, không đổi ghế nào.
-- =====================================================================
create function public.set_hold_segment(p_booking_id uuid, p_from_stop uuid, p_to_stop uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  r record;
  v_from int; v_to int; v_price int;
  n int := 0;
begin
  if v_tid is null or not app.has_permission('sell.add') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  for r in select s.id, s.seat_label, t.route_id, t.direction, t.service_date, t.id as trip_id
           from public.seat_inventory s join public.trips t on t.tenant_id = s.tenant_id and t.id = s.trip_id
           where s.tenant_id = v_tid and s.booking_id = p_booking_id and s.status = 'giu' and s.created_by = auth.uid()
           for update of s loop
    v_from := app.stop_idx(v_tid, r.route_id, r.direction, p_from_stop);
    v_to := app.stop_idx(v_tid, r.route_id, r.direction, p_to_stop);
    if v_from is null or v_to is null or v_to <= v_from then
      raise exception 'Điểm đón phải trước điểm trả theo chiều chạy' using errcode = '22023';
    end if;
    v_price := public.fare_for(r.route_id, p_from_stop, p_to_stop, r.service_date);
    begin
      update public.seat_inventory set from_stop_id = p_from_stop, to_stop_id = p_to_stop, from_idx = v_from, to_idx = v_to, price = v_price
      where tenant_id = v_tid and id = r.id;
    exception when exclusion_violation then
      raise exception 'Ghế % đã có người trên chặng này', r.seat_label using errcode = '23P01';
    end;
    n := n + 1;
  end loop;
  if n = 0 then
    raise exception 'Không tìm thấy ghế đang giữ' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.set_hold_segment(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_hold_segment(uuid, uuid, uuid) to authenticated;
