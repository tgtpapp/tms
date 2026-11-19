-- Ghế tôi đang giữ trên 1 chuyến (kể cả sau khi tải lại trang / đổi chuyến rồi quay lại): gom về 1 đơn để bán tiếp hoặc bỏ chọn.
-- Trả về mã đơn (null nếu không còn ghế nào đang giữ).
create function public.merge_my_holds(p_trip_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_booking uuid;
begin
  if v_tid is null or not app.has_permission('ticket.sell') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  select booking_id into v_booking from public.seat_inventory
  where tenant_id = v_tid and trip_id = p_trip_id and status = 'giu' and created_by = auth.uid() and hold_until > now()
  order by created_at desc limit 1;
  if v_booking is null then return null; end if;
  update public.seat_inventory set booking_id = v_booking
  where tenant_id = v_tid and trip_id = p_trip_id and status = 'giu' and created_by = auth.uid() and booking_id <> v_booking;
  return v_booking;
end;
$$;
revoke execute on function public.merge_my_holds(uuid) from public, anon, authenticated;
grant execute on function public.merge_my_holds(uuid) to authenticated;
