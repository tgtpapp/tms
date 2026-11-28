-- Gửi hàng: dời phiếu sang xe (chuyến) khác, kể cả chuyến của tuyến khác; giữ nguyên trạng thái phiếu (đã nhận / đã lên xe).
create function public.move_shipment(p_id uuid, p_trip_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_s public.shipments;
  v_t public.trips;
begin
  select * into v_s from public.shipments where id = p_id and tenant_id = v_tid for update;
  if v_tid is null or not found or not (app.has_permission('parcel.edit') or app.has_permission('trip.edit')) then
    raise exception 'Không tìm thấy phiếu gửi hàng' using errcode = 'P0002';
  end if;
  if v_s.status not in ('nhan', 'tren_xe') then
    raise exception 'Chỉ dời được phiếu chưa đến / chưa giao' using errcode = '22023';
  end if;
  select * into v_t from public.trips where id = p_trip_id and tenant_id = v_tid and status = 'mo';
  if not found then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  if v_s.trip_id is not distinct from p_trip_id then
    raise exception 'Phiếu đang ở chuyến này rồi' using errcode = '22023';
  end if;
  update public.shipments set trip_id = p_trip_id, service_date = v_t.service_date where id = p_id and tenant_id = v_tid;
end;
$$;
revoke execute on function public.move_shipment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.move_shipment(uuid, uuid) to authenticated, service_role;
