-- =====================================================================
-- Gửi hàng: nơi gửi / nơi nhận không cố định theo danh sách — gõ nơi chưa có thì thêm mới (chữ in hoa).
-- Tìm theo tên không phân biệt hoa thường; điểm đã ngừng dùng thì dùng lại. Không thêm vào lộ trình tuyến.
-- =====================================================================
create function public.parcel_stop(p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_name text := upper(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'));
begin
  if v_tid is null or not app.has_permission('parcel.add') then
    raise exception 'Không có quyền nhận hàng gửi' using errcode = '42501';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Nhập tên nơi gửi / nơi nhận' using errcode = '22023';
  end if;
  return app.fare_stop(v_tid, null, v_name);
end;
$$;
revoke execute on function public.parcel_stop(text) from public, anon, authenticated;
grant execute on function public.parcel_stop(text) to authenticated;
