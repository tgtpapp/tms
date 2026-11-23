-- =====================================================================
-- Nhiên liệu theo từng người (như Xe / Sửa chữa):
-- - Ô Xem = chỉ thấy phiếu nhiên liệu của XE MÌNH CHẠY (có trong chuyến được xếp cho mình); ô Xem tất cả (fuel.view_all) = mọi phiếu.
-- - Nhóm đang có ô Xem (trừ Lái xe và quyền riêng từng người) được thêm Xem tất cả → giữ nguyên như trước.
-- - Nhóm Lái xe được ô Xem: vào mục Nhiên liệu chỉ thấy xe mình.
-- - Báo đổ dầu: lái xe chạy xe nào báo xe đó (xe có trong chuyến được xếp cho mình); điều hành (quyền Thêm phiếu) báo xe nào cũng được.
-- =====================================================================
insert into public.permissions (code, module, name) values ('fuel.view_all', 'fuel', 'Nhiên liệu: Xem tất cả')
on conflict (code) do nothing;
select app.grant_permission_to_admins('fuel.view_all');
insert into public.role_permissions (tenant_id, role_id, permission_code)
select rp.tenant_id, rp.role_id, 'fuel.view_all'
from public.role_permissions rp join public.roles r on r.tenant_id = rp.tenant_id and r.id = rp.role_id
where rp.permission_code = 'fuel.view' and r.code <> 'driver' and r.code not like 'rieng\_%'
on conflict do nothing;
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, 'fuel.view' from public.roles r where r.code = 'driver'
on conflict do nothing;

do $$
declare v text;
begin
  select pg_get_functiondef('app.seed_system_roles(uuid)'::regprocedure) into v;
  v := replace(v, '(''dispatcher'', ''fuel.view''),', '(''dispatcher'', ''fuel.view''), (''dispatcher'', ''fuel.view_all''), (''driver'', ''fuel.view''),');
  if v not like '%(''driver'', ''fuel.view'')%' then raise exception 'Không sửa được seed_system_roles'; end if;
  execute v;
end;
$$;

/** Chỉ được thấy nhiên liệu xe của mình: có ô Xem nhưng không có Xem tất cả / Thêm / Sửa / Xóa */
create function app.fuel_self_only()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select app.has_permission('fuel.view') and not (app.has_permission('fuel.view_all') or app.has_permission('fuel.add')
         or app.has_permission('fuel.edit') or app.has_permission('fuel.delete'))
$$;
revoke execute on function app.fuel_self_only() from public, anon;
grant execute on function app.fuel_self_only() to authenticated, service_role;

drop policy fuel_entries_select on public.fuel_entries;
create policy fuel_entries_select on public.fuel_entries for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('fuel.view')
         and (not app.fuel_self_only() or (vehicle_id is not null and app.is_my_vehicle(vehicle_id))));

-- Báo đổ dầu: chỉ xe mình chạy (người có quyền Thêm phiếu nhiên liệu thì xe nào cũng được)
do $$
declare v text;
begin
  v := pg_get_functiondef('public.report_fuel(jsonb)'::regprocedure);
  v := replace(v, E'  if v_veh is null then raise exception ''Không tìm thấy xe biển số %'', p ->> ''plate'' using errcode = ''P0002''; end if;\n',
    E'  if v_veh is null then raise exception ''Không tìm thấy xe biển số %'', p ->> ''plate'' using errcode = ''P0002''; end if;\n'
    || E'  if not (app.is_my_vehicle(v_veh) or app.has_permission(''fuel.add'')) then\n'
    || E'    raise exception ''Xe % không có trong chuyến được xếp cho bạn: lái xe chạy xe nào báo đổ dầu xe đó'', v_plate_txt using errcode = ''42501'';\n'
    || E'  end if;\n');
  if v not like '%is_my_vehicle(v_veh)%' then raise exception 'Không sửa được report_fuel'; end if;
  execute v;
end;
$$;
