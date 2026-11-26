\pset pager off
select v.plate, v.vehicle_type_id is not null co_loai_xe, vt.name loai_xe,
  (select count(*) from public.vehicle_type_seats s where s.tenant_id = v.tenant_id and s.vehicle_type_id = v.vehicle_type_id and s.is_sellable) ghe_ban,
  vt.reg_seats, vt.reg_berths
from public.vehicles v left join public.vehicle_types vt on vt.tenant_id = v.tenant_id and vt.id = v.vehicle_type_id
where v.plate in ('60F-008.56', '60F-007.86', '60F-004.41', '60H-194.65');
select to_char(t.depart_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI') gio, v.plate, t.vehicle_type_id is not null trip_co_loai, vt.name loai_chuyen,
  (select count(*) from public.vehicle_type_seats s where s.tenant_id = t.tenant_id and s.vehicle_type_id = t.vehicle_type_id and s.is_sellable) ghe_ban
from public.trips t left join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id
left join public.vehicle_types vt on vt.tenant_id = t.tenant_id and vt.id = t.vehicle_type_id
where t.service_date = (now() at time zone 'Asia/Ho_Chi_Minh')::date and v.plate in ('60F-008.56', '60F-007.86');
select vt.name, vt.is_active, vt.reg_seats, vt.reg_berths, (select count(*) from public.vehicle_type_seats s where s.tenant_id = vt.tenant_id and s.vehicle_type_id = vt.id and s.is_sellable) ghe_ban,
  (select count(*) from public.vehicles v where v.tenant_id = vt.tenant_id and v.vehicle_type_id = vt.id) so_xe from public.vehicle_types vt;
