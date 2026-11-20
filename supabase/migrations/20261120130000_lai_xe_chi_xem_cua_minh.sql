-- =====================================================================
-- Lái xe chỉ xem được những gì liên quan đến mình: nhóm "Lái xe" không còn ô Xem của Tuyến, Xe, Chi nhánh,
-- Phòng vé, Điều hành (chỉ còn Việc của tôi, hồ sơ / hợp đồng / lý lịch của chính mình, Tài khoản của tôi).
-- Chủ nhà xe vẫn tích thêm được nếu cần.
-- =====================================================================
delete from public.role_permissions rp using public.roles r
where r.tenant_id = rp.tenant_id and r.id = rp.role_id and r.code = 'driver'
  and rp.permission_code in ('route.view', 'vehicle.view', 'branch.view', 'office.view', 'trip.view');

create or replace function app.seed_system_roles(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.roles (tenant_id, code, name, is_system) values
    (p_tenant_id, 'owner',          'Chủ nhà xe',         true),
    (p_tenant_id, 'admin',          'Quản trị',            true),
    (p_tenant_id, 'branch_manager', 'Quản lý chi nhánh',   true),
    (p_tenant_id, 'office_manager', 'Quản lý phòng vé',    true),
    (p_tenant_id, 'seller',         'Bán vé',              true),
    (p_tenant_id, 'dispatcher',     'Điều hành',           true),
    (p_tenant_id, 'accountant',     'Kế toán',             true),
    (p_tenant_id, 'driver',         'Lái xe',              true),
    (p_tenant_id, 'staff',          'Nhân viên',           true);
  -- Chủ / Quản trị: tất cả
  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select p_tenant_id, r.id, p.code from public.roles r, public.permissions p
  where r.tenant_id = p_tenant_id and r.code in ('owner', 'admin');
  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select p_tenant_id, r.id, x.code
  from public.roles r
  join (values
    ('branch_manager', 'office.*'), ('branch_manager', 'user.view'), ('branch_manager', 'archive.view'),
    ('dispatcher', 'trip.*'), ('dispatcher', 'charter.*'), ('dispatcher', 'sell.*'), ('dispatcher', 'parcel.*'),
    ('dispatcher', 'repair.view'), ('dispatcher', 'fuel.view'), ('dispatcher', 'km.view'), ('dispatcher', 'archive.view'),
    ('office_manager', 'sell.*'), ('office_manager', 'parcel.*'), ('office_manager', 'archive.view'),
    ('seller', 'sell.*'), ('seller', 'parcel.*'),
    ('accountant', 'archive.view'), ('accountant', 'report.view'), ('accountant', 'salary.*'), ('accountant', 'labor.*'))
    v(role, pat) on v.role = r.code
  join public.permissions x on x.code = v.pat or (v.pat like '%.*' and x.module = split_part(v.pat, '.', 1))
  where r.tenant_id = p_tenant_id
  on conflict do nothing;
  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select p_tenant_id, r.id, c from public.roles r,
    unnest(case when r.code = 'driver' then array[]::text[]
                when r.code = 'staff' then array['route.view', 'vehicle.view', 'branch.view', 'office.view']
                else array['route.view', 'vehicle.view', 'branch.view', 'office.view', 'trip.view'] end) c
  where r.tenant_id = p_tenant_id and r.code not in ('owner', 'admin')
  on conflict do nothing;
end;
$$;

