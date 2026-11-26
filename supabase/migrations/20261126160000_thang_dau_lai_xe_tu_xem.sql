-- Công & lương của tôi (lái xe tự xem): trước đây hàm tháng chạy đầu tiên chỉ trả kết quả cho người có quyền Xem chấm công,
-- lái xe tự xem nhận rỗng → bị coi là "chưa chạy chuyến nào", không trừ BHXH / chi phí khác / lương CK → Thực nhận sai.
-- Sửa: người tự xem nhận được dòng của chính mình. Không đổi bảng.
create or replace function public.driver_first_months()
returns table (staff_id uuid, first_month date)
language sql stable security definer set search_path = ''
as $$
  select c.staff_id, date_trunc('month', min(t.service_date))::date
  from public.trip_crew c join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id
  where c.tenant_id = app.current_tenant_id() and (app.has_permission('timesheet.view') or app.is_my_staff(c.staff_id::text))
    and c.role = 'lai_xe_1' and c.active and t.status = 'mo'
  group by c.staff_id
$$;
