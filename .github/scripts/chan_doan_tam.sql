\pset pager off
-- các tài khoản lái xe: vai trò + phạm vi + quyền sửa chữa (không in tên)
with d as (select distinct m.user_id, m.tenant_id from public.staff_members m where m.user_id is not null and m.position = 'lai_xe')
select row_number() over () lx, r.code, ur.scope_type,
  exists (select 1 from public.role_permissions rp where rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id and rp.permission_code = 'repair.view') role_co,
  exists (select 1 from public.user_permission_denies x where x.tenant_id = d.tenant_id and x.user_id = d.user_id and x.permission_code = 'repair.view') bi_chan
from d left join public.user_roles ur on ur.tenant_id = d.tenant_id and ur.user_id = d.user_id left join public.roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
order by 1;
