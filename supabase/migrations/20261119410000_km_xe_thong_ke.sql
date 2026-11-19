-- =====================================================================
-- Thống kê km xe theo ngày / tuần / tháng / năm (như app cũ "Km xe": nhập báo cáo Skysoft, xem theo kỳ).
-- SECURITY INVOKER: đi qua RLS của vehicle_km. Khoảng [p_from, p_to).
-- =====================================================================
create function public.vehicle_km_stats(p_from date, p_to date, p_unit text)
returns table (vehicle_id uuid, period date, km numeric, days int)
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if p_unit not in ('day', 'week', 'month', 'year') then
    raise exception 'Kỳ thống kê không hợp lệ' using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > 3700 then
    raise exception 'Chọn khoảng ngày (tối đa 10 năm)' using errcode = '22023';
  end if;
  return query
    select k.vehicle_id, date_trunc(p_unit, k.run_date)::date, sum(k.km), (count(*) filter (where k.km > 0))::int
    from public.vehicle_km k
    where k.run_date >= p_from and k.run_date < p_to
    group by 1, 2;
end;
$$;
revoke execute on function public.vehicle_km_stats(date, date, text) from public, anon, authenticated;
grant execute on function public.vehicle_km_stats(date, date, text) to authenticated;
