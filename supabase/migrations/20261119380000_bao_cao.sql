-- =====================================================================
-- Báo cáo vận tải và bán vé (như app cũ "Báo cáo vận tải", "Báo cáo bán vé").
-- Chỉ đọc; tổng hợp theo khoảng ngày chạy [p_from, p_to] (cả hai đầu).
-- Quyền mới report.view: Chủ / Quản trị có sẵn; Kế toán, Quản lý chi nhánh, Quản lý phòng vé được cấp sẵn.
-- =====================================================================
insert into public.permissions (code, module, name) values ('report.view', 'bao_cao', 'Xem báo cáo vận tải, bán vé, doanh thu');
select app.grant_permission_to_admins('report.view');
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, 'report.view' from public.roles r where r.code in ('accountant', 'branch_manager', 'office_manager')
on conflict do nothing;

-- Báo cáo vận tải: theo tuyến (chiều), theo xe, theo lái xe, hợp đồng.
create function public.report_transport(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('report.view') then
    raise exception 'Không có quyền xem báo cáo' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Chọn khoảng ngày (tối đa 400 ngày)' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'routes', coalesce((
      select jsonb_agg(x order by x.name) from (
        select case when t.direction = 've' then coalesce(r.name_ve, r.name || ' (về)') else r.name end as name,
               count(*) filter (where t.status = 'mo') as trips,
               count(*) filter (where t.status = 'huy') as cancelled,
               count(*) filter (where t.status = 'mo' and t.vehicle_id is null) as no_vehicle,
               coalesce(sum(r.distance_km) filter (where t.status = 'mo'), 0) as km
        from public.trips t join public.routes r on r.tenant_id = t.tenant_id and r.id = t.route_id
        where t.tenant_id = v_tid and t.service_date between p_from and p_to
        group by 1) x), '[]'),
    'vehicles', coalesce((
      select jsonb_agg(x order by x.plate) from (
        select v.plate,
               (select count(*) from public.trips t where t.tenant_id = v_tid and t.vehicle_id = v.id and t.status = 'mo' and t.service_date between p_from and p_to) as trips,
               (select count(distinct t.service_date) from public.trips t where t.tenant_id = v_tid and t.vehicle_id = v.id and t.status = 'mo' and t.service_date between p_from and p_to) as days,
               (select coalesce(sum(k.km), 0) from public.vehicle_km k where k.tenant_id = v_tid and k.vehicle_id = v.id and k.run_date between p_from and p_to) as km_gps,
               (select coalesce(sum(f.liters), 0) from public.fuel_entries f where f.tenant_id = v_tid and f.vehicle_id = v.id and f.kind <> 'nhap' and f.entry_date between p_from and p_to) as fuel_l,
               (select coalesce(sum(i.qty * i.unit_price), 0) from public.repair_orders o join public.repair_items i on i.tenant_id = o.tenant_id and i.order_id = o.id
                 where o.tenant_id = v_tid and o.vehicle_id = v.id and o.repaired_on between p_from and p_to) as repair_cost,
               (select count(*) from public.charters c where c.tenant_id = v_tid and c.vehicle_id = v.id and c.status in ('da_ky', 'dang_chay', 'xong')
                 and (c.start_at at time zone 'Asia/Ho_Chi_Minh')::date between p_from and p_to) as charters
        from public.vehicles v where v.tenant_id = v_tid) x
      where x.trips + x.km_gps + x.fuel_l + x.repair_cost + x.charters > 0), '[]'),
    'drivers', coalesce((
      select jsonb_agg(x order by x.name) from (
        select s.full_name as name,
               count(*) filter (where c.role = 'lai_xe_1') as main,
               count(*) filter (where c.role = 'lai_xe_2') as second,
               count(*) filter (where c.role = 'phu_xe') as assistant,
               count(distinct t.service_date) as days
        from public.trip_crew c
        join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id and t.status = 'mo' and t.service_date between p_from and p_to
        join public.staff_members s on s.tenant_id = c.tenant_id and s.id = c.staff_id
        where c.tenant_id = v_tid and c.active
        group by s.id, s.full_name) x), '[]'),
    'charters', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(price), 0))
                 from public.charters c where c.tenant_id = v_tid and c.status in ('da_ky', 'dang_chay', 'xong')
                 and (c.start_at at time zone 'Asia/Ho_Chi_Minh')::date between p_from and p_to)
  );
end;
$$;

-- Báo cáo bán vé: vé theo ngày chạy (đã thanh toán / đặt chưa trả), lấp đầy, theo ngày, tuyến, kênh, người bán;
-- tiền thực thu theo sổ cái (theo ngày ghi sổ) của từng người.
create function public.report_sales(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('report.view') then
    raise exception 'Không có quyền xem báo cáo' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Chọn khoảng ngày (tối đa 400 ngày)' using errcode = '22023';
  end if;
  return (
    with tk as (
      select s.price, s.status, t.service_date, t.id as trip_id,
             case when t.direction = 've' then coalesce(r.name_ve, r.name || ' (về)') else r.name end as route,
             b.channel, coalesce(u.full_name, 'Khác') as seller
      from public.seat_inventory s
      join public.trips t on t.tenant_id = s.tenant_id and t.id = s.trip_id
      join public.routes r on r.tenant_id = t.tenant_id and r.id = t.route_id
      join public.bookings b on b.tenant_id = s.tenant_id and b.id = s.booking_id
      left join public.app_users u on u.tenant_id = s.tenant_id and u.id = coalesce(s.paid_by, s.created_by)
      where s.tenant_id = v_tid and s.status in ('dat', 'da_tt') and t.service_date between p_from and p_to
    ),
    cap as (
      select t.service_date, coalesce(sum(vt.reg_seats + vt.reg_berths), 0) as seats, count(*) as trips
      from public.trips t
      left join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id
      left join public.vehicle_types vt on vt.tenant_id = v.tenant_id and vt.id = v.vehicle_type_id
      where t.tenant_id = v_tid and t.status = 'mo' and t.service_date between p_from and p_to
      group by t.service_date
    ),
    agg as (
      select jsonb_build_object('tickets', count(*), 'paid', count(*) filter (where status = 'da_tt'),
                                'revenue', coalesce(sum(price) filter (where status = 'da_tt'), 0),
                                'unpaid', coalesce(sum(price) filter (where status = 'dat'), 0)) as o from tk
    )
    select jsonb_build_object(
      'total', (select o from agg) || jsonb_build_object('seats', (select coalesce(sum(seats), 0) from cap), 'trips', (select coalesce(sum(trips), 0) from cap)),
      'days', coalesce((select jsonb_agg(x order by x.day) from (
          select c.service_date as day, c.trips, c.seats,
                 (select count(*) from tk where tk.service_date = c.service_date) as tickets,
                 (select coalesce(sum(price), 0) from tk where tk.service_date = c.service_date and tk.status = 'da_tt') as revenue,
                 (select coalesce(sum(price), 0) from tk where tk.service_date = c.service_date and tk.status = 'dat') as unpaid
          from cap c) x), '[]'),
      'routes', coalesce((select jsonb_agg(x order by x.revenue desc) from (
          select route as name, count(distinct trip_id) as trips, count(*) as tickets,
                 coalesce(sum(price) filter (where status = 'da_tt'), 0) as revenue, coalesce(sum(price) filter (where status = 'dat'), 0) as unpaid
          from tk group by route) x), '[]'),
      'channels', coalesce((select jsonb_agg(x order by x.tickets desc) from (
          select channel as name, count(*) as tickets, coalesce(sum(price) filter (where status = 'da_tt'), 0) as revenue
          from tk group by channel) x), '[]'),
      'sellers', coalesce((select jsonb_agg(x order by x.tickets desc) from (
          select seller as name, count(*) as tickets, coalesce(sum(price) filter (where status = 'da_tt'), 0) as revenue
          from tk group by seller) x), '[]'),
      'cash', coalesce((select jsonb_agg(x order by x.amount desc) from (
          select coalesce(u.full_name, 'Khác') as name,
                 sum(l.credit - l.debit) filter (where l.account = 'doanh_thu_ve') as tickets,
                 sum(l.credit - l.debit) filter (where l.account = 'doanh_thu_hang') as parcels,
                 sum(l.credit - l.debit) filter (where l.account = 'doanh_thu_hop_dong') as charters,
                 sum(l.credit - l.debit) as amount
          from public.ledger_transactions x2
          join public.ledger_lines l on l.tenant_id = x2.tenant_id and l.txn_id = x2.id
            and l.account in ('doanh_thu_ve', 'doanh_thu_hang', 'doanh_thu_hop_dong')
          left join public.app_users u on u.tenant_id = x2.tenant_id and u.id = x2.created_by
          where x2.tenant_id = v_tid and (x2.created_at at time zone 'Asia/Ho_Chi_Minh')::date between p_from and p_to
          group by u.id, u.full_name) x), '[]')
    )
  );
end;
$$;
revoke execute on function public.report_transport(date, date), public.report_sales(date, date) from public, anon, authenticated;
grant execute on function public.report_transport(date, date), public.report_sales(date, date) to authenticated;
