\pset pager off
select 'phien ban migration moi nhat' k, max(version) v from supabase_migrations.schema_migrations;
select 'tong phieu sua chua' k, count(*) v, count(driver_id) co_lai_xe from public.repair_orders;
select 'phieu cua xe chua tung co trong chuyen co lai xe' k, count(*) v from public.repair_orders o
  where not exists (select 1 from public.trips t join public.trip_crew c on c.tenant_id = t.tenant_id and c.trip_id = t.id where t.tenant_id = o.tenant_id and t.vehicle_id = o.vehicle_id);
select 'xe 60B-056.83: phieu' k, count(*) v from public.repair_orders o join public.vehicles v on v.tenant_id = o.tenant_id and v.id = o.vehicle_id where v.plate = '60B-056.83';
select 'xe 60B-056.83: so luot lai xe trong chuyen' k, count(*) v from public.trips t join public.trip_crew c on c.tenant_id = t.tenant_id and c.trip_id = t.id
  join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id where v.plate = '60B-056.83';
select 'tai khoan lai xe theo nhom' k, r.code, count(*) v,
  bool_and(exists (select 1 from public.role_permissions p where p.tenant_id = r.tenant_id and p.role_id = r.id and p.permission_code = 'repair.view')) co_repair_view
  from public.staff_members m join public.user_roles tu on tu.tenant_id = m.tenant_id and tu.user_id = m.user_id
  join public.roles r on r.tenant_id = tu.tenant_id and r.id = tu.role_id where m.position = 'lai_xe' group by r.code;
select 'lai xe co tai khoan: so phieu thay duoc (xe minh chay)' k, m.id::text is not null x, count(distinct o.id) v
  from public.staff_members m join public.trip_crew c on c.tenant_id = m.tenant_id and c.staff_id = m.id
  join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id
  join public.repair_orders o on o.tenant_id = t.tenant_id and o.vehicle_id = t.vehicle_id
  where m.user_id is not null group by 2;
select 'anh dai dien da luu' k, count(*) v from public.file_store where name like '%/anh_dai_dien/%';
