-- =====================================================================
-- Bảng chấm công của lái xe (Thông tin của tôi) báo "statement timeout":
-- driver_first_months kiểm tra quyền + app.is_my_staff(id::text) cho TỪNG dòng tổ lái (so chuỗi, không dùng chỉ mục).
-- Tính quyền và hồ sơ của tôi 1 lần rồi lọc theo staff_id. Kết quả và phạm vi xem giữ nguyên. Không đổi bảng.
-- =====================================================================
create or replace function public.driver_first_months()
returns table (staff_id uuid, first_month date)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_all boolean := app.has_permission('timesheet.view');
  v_mine uuid[];
begin
  if v_tid is null then return; end if;
  if not v_all then
    select coalesce(array_agg(m.id), '{}') into v_mine from public.staff_members m where m.tenant_id = v_tid and m.user_id = auth.uid();
    if cardinality(v_mine) = 0 then return; end if;
  end if;
  return query
  select c.staff_id, date_trunc('month', min(t.service_date))::date
  from public.trip_crew c join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id
  where c.tenant_id = v_tid and (v_all or c.staff_id = any (v_mine))
    and c.role = 'lai_xe_1' and c.active and t.status = 'mo'
  group by c.staff_id;
end;
$$;
revoke execute on function public.driver_first_months() from public, anon, authenticated;
grant execute on function public.driver_first_months() to authenticated;
