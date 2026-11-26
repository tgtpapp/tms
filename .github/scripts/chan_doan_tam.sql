\pset pager off
select v.plate, count(o.id) phieu, min(o.repaired_on) tu, max(o.repaired_on) den
from public.vehicles v left join public.repair_orders o on o.tenant_id = v.tenant_id and o.vehicle_id = v.id group by v.plate order by v.plate;
-- moi tai khoan lai xe: so xe minh tung chay, so phieu sua chua cua cac xe do (khong in ten)
select row_number() over () lai_xe, x.so_xe, x.phieu, x.co_126_63 from (
  select m.id, count(distinct t.vehicle_id) so_xe,
    (select count(*) from public.repair_orders o where o.tenant_id = m.tenant_id and o.vehicle_id in
       (select t2.vehicle_id from public.trip_crew c2 join public.trips t2 on t2.tenant_id = c2.tenant_id and t2.id = c2.trip_id where c2.staff_id = m.id)) phieu,
    bool_or(v.plate = '60H-126.63') co_126_63
  from public.staff_members m join public.trip_crew c on c.tenant_id = m.tenant_id and c.staff_id = m.id
  join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id left join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id
  where m.user_id is not null group by m.id) x;
select 'trip_crew inactive' k, count(*) filter (where not active) v, count(*) tong from public.trip_crew;
