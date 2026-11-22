-- Sửa ghi chú đơn vé (nhập lúc bán) ngay trong chi tiết vé
create function public.set_booking_note(p_booking_id uuid, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('sell.edit') then raise exception 'Không có quyền sửa vé' using errcode = '42501'; end if;
  update public.bookings set note = nullif(left(trim(coalesce(p_note, '')), 500), '') where tenant_id = v_tid and id = p_booking_id;
  if not found then raise exception 'Không tìm thấy đơn vé' using errcode = 'P0002'; end if;
end;
$$;
revoke execute on function public.set_booking_note(uuid, text) from public, anon, authenticated;
grant execute on function public.set_booking_note(uuid, text) to authenticated, service_role;
