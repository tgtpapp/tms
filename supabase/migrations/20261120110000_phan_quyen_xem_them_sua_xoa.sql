-- =====================================================================
-- Phân quyền theo màn hình × Xem / Thêm / Sửa / Xóa (như app cũ).
-- - Mỗi mục menu là 1 dòng; mỗi ô là 1 quyền: <màn hình>.view / .add / .edit / .delete.
-- - Nhóm quyền (vai trò) giữ nguyên; 1 người vào được nhiều nhóm (kiêm nhiệm), quyền cộng dồn; giữ phạm vi chi nhánh / phòng vé.
-- - Quyền cũ (gộp thêm-sửa-xóa) được chuyển sang các ô tương ứng → không ai mất quyền đang có.
-- - Mọi hàm / quy tắc truy cập kiểm tra đúng ô: viết lại từ ĐỊNH NGHĨA ĐANG CHẠY trong database (pg_get_functiondef,
--   pg_policies) theo bảng ánh xạ; còn sót mã quyền cũ ở đâu thì migration dừng báo lỗi.
-- =====================================================================

-- ---------------------------------------------------------------- 1. Danh mục quyền mới
insert into public.permissions (code, module, name)
select s.k || '.' || a.act, s.k, s.label || ': ' || a.label
from (values
  ('sell', 'Bán vé', 'vaed'), ('parcel', 'Gửi hàng', 'vaed'), ('charter', 'Hợp đồng vận chuyển', 'vaed'), ('trip', 'Điều hành', 'vaed'),
  ('route', 'Tuyến & giá vé', 'vaed'), ('repair', 'Sửa chữa', 'vaed'), ('fuel', 'Nhiên liệu', 'vaed'), ('km', 'Km xe', 'vaed'),
  ('report', 'Báo cáo', 'v'), ('vehicle', 'Xe', 'vaed'), ('staff', 'Lái xe & nhân viên', 'vaed'), ('labor', 'Hợp đồng lao động', 'vaed'),
  ('salary', 'BHXH & lương chuyển khoản', 've'), ('branch', 'Chi nhánh', 'vaed'), ('office', 'Phòng vé', 'vaed'), ('doc', 'Văn bản', 'vaed'),
  ('archive', 'Lưu trữ hồ sơ', 'vaed'), ('user', 'Người dùng', 'vaed'), ('role', 'Vai trò (phân quyền)', 'vaed'),
  ('settings', 'Cấu hình', 've'), ('audit', 'Nhật ký', 'v')) s(k, label, acts)
join (values ('v', 'view', 'Xem'), ('a', 'add', 'Thêm'), ('e', 'edit', 'Sửa'), ('d', 'delete', 'Xóa')) a(c, act, label) on position(a.c in s.acts) > 0
on conflict (code) do update set module = excluded.module, name = excluded.name;

-- ---------------------------------------------------------------- 2. Chuyển quyền cũ sang ô mới
create temporary table perm_map (legacy text, code text);
insert into perm_map
select l, s || '.' || a from (values
  ('ticket.sell',     array['sell'],                         array['view', 'add', 'edit', 'delete']),
  ('parcel.manage',   array['parcel'],                       array['view', 'add', 'edit', 'delete']),
  ('trip.manage',     array['trip', 'charter'],              array['view', 'add', 'edit', 'delete']),
  ('trip.manage',     array['repair', 'fuel', 'km'],         array['view']),
  ('route.manage',    array['route'],                        array['view', 'add', 'edit', 'delete']),
  ('fare.manage',     array['route'],                        array['view', 'edit']),
  ('vehicle.manage',  array['vehicle', 'repair', 'fuel', 'km'], array['view', 'add', 'edit', 'delete']),
  ('staff.manage',    array['staff'],                        array['view', 'add', 'edit', 'delete']),
  ('salary.manage',   array['salary'],                       array['view', 'edit']),
  ('salary.manage',   array['labor'],                        array['view', 'add', 'edit', 'delete']),
  ('doc.manage',      array['doc'],                          array['view', 'add', 'edit', 'delete']),
  ('archive.manage',  array['archive'],                      array['view', 'add', 'edit', 'delete']),
  ('branch.manage',   array['branch'],                       array['view', 'add', 'edit', 'delete']),
  ('office.manage',   array['office'],                       array['view', 'add', 'edit', 'delete']),
  ('user.read',       array['user'],                         array['view']),
  ('user.manage',     array['user'],                         array['view', 'add', 'edit', 'delete']),
  ('role.manage',     array['role'],                         array['view', 'add', 'edit', 'delete']),
  ('settings.manage', array['settings'],                     array['view', 'edit']),
  ('audit.read',      array['audit'],                        array['view'])) m(l, ss, acts),
  unnest(m.ss) s, unnest(m.acts) a;

insert into public.role_permissions (tenant_id, role_id, permission_code)
select distinct rp.tenant_id, rp.role_id, pm.code
from public.role_permissions rp join perm_map pm on pm.legacy = rp.permission_code
on conflict do nothing;
-- Trước đây ai cũng mở được Tuyến, Xe, Chi nhánh & phòng vé (và Điều hành, trừ lái xe / nhân viên): giữ nguyên
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, c from public.roles r,
  unnest(case when r.code in ('driver', 'staff') then array['route.view', 'vehicle.view', 'branch.view', 'office.view']
              else array['route.view', 'vehicle.view', 'branch.view', 'office.view', 'trip.view'] end) c
on conflict do nothing;

-- ---------------------------------------------------------------- 3. Viết lại các hàm theo ô quyền
create temporary table fn_map (fn text, legacy text, repl text);
insert into fn_map values
  ('app.can_manage_documents', 'vehicle.manage', '''vehicle.edit'''), ('app.can_manage_documents', 'staff.manage', '''staff.edit'''),
  ('app.can_read_company_file', 'settings.manage', '''settings.view'''),
  ('app.can_read_documents', 'staff.manage', '''staff.view'''),
  ('app.can_read_signature', 'settings.manage', '''settings.view'''), ('app.can_read_signature', 'staff.manage', '''staff.view'''),
  ('app.can_read_signature', 'trip.manage', '''trip.edit'''),
  ('app.can_read_user', 'user.read', '''user.view'''),
  ('app.can_write_avatar', 'staff.manage', '''staff.edit'''),
  ('app.can_write_signature', 'settings.manage', '''settings.edit'''), ('app.can_write_signature', 'staff.manage', '''staff.edit'''),
  ('app.require_user_manager', 'user.manage', '''user.edit'''),
  ('public.add_extra_trip', 'trip.manage', '''trip.add'''),
  ('public.assign_trip', 'trip.manage', '''trip.edit'''),
  ('public.cancel_labor_contract', 'salary.manage', '''labor.delete'''),
  ('public.cancel_official_doc', 'doc.manage', '''doc.delete'''),
  ('public.cancel_quote', 'ticket.sell', '''sell.delete'''),
  ('public.cancel_tickets', 'ticket.sell', '''sell.delete'''), ('public.cancel_tickets', 'settings.manage', '''settings.edit'''),
  ('public.cancel_trip', 'trip.manage', '''trip.delete'''),
  ('public.change_ticket', 'ticket.sell', '''sell.edit'''),
  ('public.charter_paid', 'trip.manage', '''charter.edit'''),
  ('public.charter_payment', 'trip.manage', '''charter.edit'''),
  ('public.confirm_booking', 'ticket.sell', '''sell.add'''),
  ('public.create_role', 'role.manage', '''role.add'''),
  ('public.create_shipment', 'parcel.manage', '''parcel.add'''),
  ('public.delete_transfer_run', 'trip.manage', '''trip.delete'''),
  ('public.deliver_shipment', 'parcel.manage', '''parcel.edit'''),
  ('public.drive_status', 'archive.manage', '''archive.add'''), ('public.drive_status', 'settings.manage', '''settings.view'''),
  ('public.extend_booking', 'ticket.sell', '''sell.edit'''),
  ('public.generate_trips', 'trip.manage', '''trip.add'''),
  ('public.hold_seat', 'ticket.sell', '''sell.add'''),
  ('public.import_legacy_charters', 'trip.manage', '''charter.add'''),
  ('public.import_legacy_ops', 'vehicle.manage', '''repair.add'''),
  ('public.import_legacy_trips', 'trip.manage', '''trip.add'''),
  ('public.import_vehicle_km', 'vehicle.manage', '''km.add'''),
  ('public.issue_transport_order', 'trip.manage', '''trip.edit'''),
  ('public.mark_manifest_printed', 'ticket.sell', '''sell.view'''), ('public.mark_manifest_printed', 'trip.manage', '''trip.view'''),
  ('public.mark_tickets_printed', 'ticket.sell', '''sell.view'''), ('public.mark_tickets_printed', 'trip.manage', '''trip.view'''),
  ('public.merge_my_holds', 'ticket.sell', '''sell.add'''),
  ('public.my_account_context', 'user.manage', '''user.add'''),
  ('public.pay_booking', 'ticket.sell', '''sell.add'''),
  ('public.pay_out_cod', 'parcel.manage', '''parcel.edit'''),
  ('public.refresh_trip_seats', 'ticket.sell', '''sell.view'''),
  ('public.reopen_trip', 'trip.manage', '''trip.edit'''),
  ('public.report_sales', 'report.view', '''report.view'''), ('public.report_transport', 'report.view', '''report.view'''),
  ('public.save_charter', 'trip.manage', '(case when p_id is null then ''charter.add'' else ''charter.edit'' end)'),
  ('app.save_charter_core', 'trip.manage', '(case when p_id is null then ''charter.add'' else ''charter.edit'' end)'),
  ('public.save_drive_config', 'settings.manage', '''settings.edit'''),
  ('public.save_fuel', 'vehicle.manage', '(case when p_id is null then ''fuel.add'' else ''fuel.edit'' end)'),
  ('public.save_labor_contract', 'salary.manage', '(case when p_id is null then ''labor.add'' else ''labor.edit'' end)'),
  ('public.save_official_doc', 'doc.manage', '(case when p_id is null then ''doc.add'' else ''doc.edit'' end)'),
  ('public.save_pay_month', 'salary.manage', '''salary.edit'''),
  ('public.save_repair', 'vehicle.manage', '(case when p_id is null then ''repair.add'' else ''repair.edit'' end)'),
  ('public.save_schedule', 'trip.manage', '(case when p_id is null then ''trip.add'' else ''trip.edit'' end)'),
  ('public.save_staff_record', 'staff.manage', '''staff.edit'''),
  ('public.save_staff', 'staff.manage', '(case when exists (select 1 from public.staff_members x where x.id = p_id) then ''staff.edit'' else ''staff.add'' end)'),
  ('public.save_timetable', 'trip.manage', '''trip.edit'''),
  ('public.save_transfer_run', 'trip.manage', '(case when p_id is null then ''trip.add'' else ''trip.edit'' end)'),
  ('public.save_zalo_template', 'settings.manage', '''settings.edit'''),
  ('public.set_boarded', 'ticket.sell', '''sell.edit'''), ('public.set_boarded', 'trip.manage', '''trip.edit'''),
  ('public.set_charter_status', 'trip.manage', '''charter.edit'''),
  ('public.set_fare', 'fare.manage', '''route.edit'''),
  ('public.set_role_permissions', 'role.manage', '''role.edit'''),
  ('public.set_route_stops', 'route.manage', '''route.edit'''),
  ('public.set_schedule_vehicle_type', 'trip.manage', '''trip.edit'''),
  ('public.set_seat_layout', 'vehicle.manage', '''vehicle.edit'''),
  ('public.set_shipment_status', 'parcel.manage', '''parcel.edit'''), ('public.set_shipment_status', 'trip.manage', '''trip.edit'''),
  ('public.set_signature_has_name', 'settings.manage', '''settings.edit'''), ('public.set_signature_has_name', 'staff.manage', '''staff.edit'''),
  ('public.set_staff_job_title', 'staff.manage', '''staff.edit'''),
  ('public.set_ticket_transfer', 'ticket.sell', '''sell.edit'''), ('public.set_ticket_transfer', 'trip.manage', '''trip.edit'''),
  ('public.set_trip_edit_lock', 'settings.manage', '''settings.edit'''),
  ('public.set_trip_vehicle_type', 'trip.manage', '''trip.edit'''),
  ('public.stop_schedule', 'trip.manage', '''trip.edit'''),
  ('public.storage_usage', 'settings.manage', '''settings.view'''),
  ('public.sync_offline_sale', 'ticket.sell', '''sell.add'''),
  ('public.ticket_history', 'ticket.sell', '''sell.view'''), ('public.ticket_history', 'trip.manage', '''trip.view'''),
  ('public.transfer_done', 'trip.manage', '''trip.edit'''),
  ('public.trip_fares', 'ticket.sell', '''sell.view'''),
  ('public.trip_mark', 'trip.manage', '''trip.edit'''),
  ('public.unhold_seat', 'ticket.sell', '''sell.add'''),
  ('public.update_tenant_profile', 'settings.manage', '''settings.edit'''),
  ('public.update_ticket_info', 'ticket.sell', '''sell.edit'''),
  ('public.zalo_disconnect', 'settings.manage', '''settings.edit'''),
  ('public.zalo_retry_failed', 'settings.manage', '''settings.edit'''),
  ('public.zalo_status', 'settings.manage', '''settings.view'''),
  ('public.delete_record', 'route.manage', '''route.delete'''), ('public.delete_record', 'vehicle.manage', '''vehicle.delete'''),
  ('public.delete_record', 'staff.manage', '''staff.delete'''), ('public.delete_record', 'branch.manage', '''branch.delete'''),
  ('public.delete_record', 'office.manage', '''office.delete''');

do $$
declare
  f record; m record; v_def text; v_left text;
  v_legacy text[] := array(select distinct legacy from perm_map where legacy not in ('report.view'));
begin
  for f in
    select p.oid, n.nspname || '.' || p.proname as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app') and p.prokind = 'f'
      and p.proname <> 'seed_system_roles'   -- viết lại riêng ở mục 6
      and exists (select 1 from unnest(v_legacy) l where p.prosrc like '%''' || l || '''%')
  loop
    v_def := pg_get_functiondef(f.oid);
    for m in select * from fn_map where fn = f.fn loop
      v_def := replace(v_def, '''' || m.legacy || '''', m.repl);
    end loop;
    select string_agg(l, ', ') into v_left from unnest(v_legacy) l where v_def like '%''' || l || '''%';
    if v_left is not null then
      raise exception 'Hàm % còn mã quyền cũ chưa ánh xạ: %', f.fn, v_left;
    end if;
    execute v_def;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- 4. Viết lại quy tắc truy cập bảng (RLS) theo ô quyền
create temporary table pol_map (tbl text, cmd text, legacy text, code text);
insert into pol_map
select t, c, l, s from (values
  ('archive_folders', 'SELECT', 'archive.manage', 'archive.view'), ('archive_folders', 'INSERT', 'archive.manage', 'archive.add'),
  ('archive_folders', 'UPDATE', 'archive.manage', 'archive.edit'), ('archive_folders', 'DELETE', 'archive.manage', 'archive.delete'),
  ('archive_items', 'SELECT', 'archive.manage', 'archive.view'), ('archive_items', 'INSERT', 'archive.manage', 'archive.add'),
  ('archive_items', 'UPDATE', 'archive.manage', 'archive.edit'), ('archive_items', 'DELETE', 'archive.manage', 'archive.delete'),
  ('audit_logs', 'SELECT', 'audit.read', 'audit.view'),
  ('branches', 'INSERT', 'branch.manage', 'branch.add'), ('branches', 'UPDATE', 'branch.manage', 'branch.edit'),
  ('charter_passengers', 'SELECT', 'trip.manage', 'charter.view'), ('charters', 'SELECT', 'trip.manage', 'charter.view'),
  ('customers', 'SELECT', 'ticket.sell', 'sell.view'),
  ('doc_counters', 'SELECT', 'doc.manage', 'doc.view'), ('official_docs', 'SELECT', 'doc.manage', 'doc.view'),
  ('fuel_entries', 'SELECT', 'trip.manage', 'fuel.view'), ('fuel_entries', 'SELECT', 'vehicle.manage', 'fuel.view'),
  ('fuel_entries', 'INSERT', 'vehicle.manage', 'fuel.add'), ('fuel_entries', 'UPDATE', 'vehicle.manage', 'fuel.edit'), ('fuel_entries', 'DELETE', 'vehicle.manage', 'fuel.delete'),
  ('fuel_settings', 'SELECT', 'trip.manage', 'fuel.view'), ('fuel_settings', 'SELECT', 'vehicle.manage', 'fuel.view'),
  ('fuel_settings', 'INSERT', 'vehicle.manage', 'fuel.edit'), ('fuel_settings', 'UPDATE', 'vehicle.manage', 'fuel.edit'), ('fuel_settings', 'DELETE', 'vehicle.manage', 'fuel.edit'),
  ('labor_contracts', 'SELECT', 'salary.manage', 'labor.view'),
  ('ledger_lines', 'SELECT', 'settings.manage', 'settings.view'), ('ledger_transactions', 'SELECT', 'settings.manage', 'settings.view'),
  ('repair_items', 'SELECT', 'trip.manage', 'repair.view'), ('repair_items', 'SELECT', 'vehicle.manage', 'repair.view'),
  ('repair_items', 'INSERT', 'vehicle.manage', 'repair.add'), ('repair_items', 'UPDATE', 'vehicle.manage', 'repair.edit'), ('repair_items', 'DELETE', 'vehicle.manage', 'repair.delete'),
  ('repair_orders', 'SELECT', 'trip.manage', 'repair.view'), ('repair_orders', 'SELECT', 'vehicle.manage', 'repair.view'),
  ('repair_orders', 'INSERT', 'vehicle.manage', 'repair.add'), ('repair_orders', 'UPDATE', 'vehicle.manage', 'repair.edit'), ('repair_orders', 'DELETE', 'vehicle.manage', 'repair.delete'),
  ('routes', 'INSERT', 'route.manage', 'route.add'), ('routes', 'UPDATE', 'route.manage', 'route.edit'),
  ('stops', 'INSERT', 'route.manage', 'route.add'), ('stops', 'UPDATE', 'route.manage', 'route.edit'),
  ('shipments', 'SELECT', 'parcel.manage', 'parcel.view'), ('shipments', 'SELECT', 'trip.manage', 'trip.view'),
  ('staff_pay_months', 'SELECT', 'salary.manage', 'salary.view'),
  ('staff_private', 'SELECT', 'staff.manage', 'staff.view'), ('staff_records', 'SELECT', 'staff.manage', 'staff.view'),
  ('tenant_private', 'SELECT', 'settings.manage', 'settings.view'),
  ('tenant_settings', 'INSERT', 'settings.manage', 'settings.edit'), ('tenant_settings', 'UPDATE', 'settings.manage', 'settings.edit'),
  ('ticket_offices', 'INSERT', 'office.manage', 'office.add'), ('ticket_offices', 'UPDATE', 'office.manage', 'office.edit'),
  ('vehicle_incidents', 'SELECT', 'trip.manage', 'trip.edit'), ('vehicle_incidents', 'SELECT', 'vehicle.manage', 'vehicle.edit'),
  ('vehicle_incidents', 'INSERT', 'vehicle.manage', 'vehicle.edit'), ('vehicle_incidents', 'UPDATE', 'vehicle.manage', 'vehicle.edit'), ('vehicle_incidents', 'DELETE', 'vehicle.manage', 'vehicle.edit'),
  ('vehicle_km', 'SELECT', 'trip.manage', 'km.view'), ('vehicle_km', 'SELECT', 'vehicle.manage', 'km.view'),
  ('vehicle_km', 'INSERT', 'vehicle.manage', 'km.add'), ('vehicle_km', 'UPDATE', 'vehicle.manage', 'km.edit'), ('vehicle_km', 'DELETE', 'vehicle.manage', 'km.delete'),
  ('vehicle_types', 'INSERT', 'vehicle.manage', 'vehicle.add'), ('vehicle_types', 'UPDATE', 'vehicle.manage', 'vehicle.edit'),
  ('vehicles', 'INSERT', 'vehicle.manage', 'vehicle.add'), ('vehicles', 'UPDATE', 'vehicle.manage', 'vehicle.edit'),
  ('zalo_messages', 'SELECT', 'settings.manage', 'settings.view'), ('zalo_templates', 'SELECT', 'settings.manage', 'settings.view'),
  ('objects', 'INSERT', 'settings.manage', 'settings.edit'), ('objects', 'UPDATE', 'settings.manage', 'settings.edit'), ('objects', 'DELETE', 'settings.manage', 'settings.edit')
) x(t, c, l, s);

do $$
declare
  p record; m record; c text; v_q text; v_w text; v_left text; v_name text;
  v_legacy text[] := array(select distinct legacy from perm_map where legacy not in ('report.view'));
begin
  for p in
    select schemaname, tablename, policyname, cmd, roles, qual, with_check, permissive from pg_policies
    where schemaname in ('public', 'storage')
      and exists (select 1 from unnest(v_legacy) l where coalesce(qual, '') || coalesce(with_check, '') like '%''' || l || '''%')
  loop
    -- quy tắc "ALL" tách thành Thêm / Sửa / Xóa riêng
    foreach c in array case when p.cmd = 'ALL' then array['INSERT', 'UPDATE', 'DELETE'] else array[p.cmd] end loop
      v_q := p.qual; v_w := p.with_check;
      for m in select * from pol_map where tbl = p.tablename and cmd = c loop
        v_q := replace(v_q, '''' || m.legacy || '''', '''' || m.code || '''');
        v_w := replace(v_w, '''' || m.legacy || '''', '''' || m.code || '''');
      end loop;
      select string_agg(l, ', ') into v_left from unnest(v_legacy) l where coalesce(v_q, '') || coalesce(v_w, '') like '%''' || l || '''%';
      if v_left is not null then
        raise exception 'Quy tắc %.% (%) còn mã quyền cũ chưa ánh xạ: %', p.tablename, p.policyname, c, v_left;
      end if;
      if p.cmd = 'ALL' then
        v_name := p.policyname || '_' || lower(left(c, 3));
        execute format('create policy %I on %I.%I as %s for %s to %s %s %s', v_name, p.schemaname, p.tablename,
          case when p.permissive = 'PERMISSIVE' then 'permissive' else 'restrictive' end, c, array_to_string(p.roles, ', '),
          case when c in ('UPDATE', 'DELETE') then 'using (' || coalesce(v_q, v_w) || ')' else '' end,
          case when c in ('INSERT', 'UPDATE') then 'with check (' || coalesce(v_w, v_q) || ')' else '' end);
      else
        execute format('alter policy %I on %I.%I %s %s', p.policyname, p.schemaname, p.tablename,
          case when v_q is not null then 'using (' || v_q || ')' else '' end,
          case when v_w is not null then 'with check (' || v_w || ')' else '' end);
      end if;
    end loop;
    if p.cmd = 'ALL' then
      execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- 5. Bỏ mã quyền cũ
delete from public.role_permissions where permission_code in (select legacy from perm_map where legacy not in ('report.view'));
delete from public.permissions where code in (select legacy from perm_map where legacy not in ('report.view'));

-- ---------------------------------------------------------------- 6. Vai trò mẫu cho nhà xe mới (theo ô mới)
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
    unnest(case when r.code in ('driver', 'staff') then array['route.view', 'vehicle.view', 'branch.view', 'office.view']
                else array['route.view', 'vehicle.view', 'branch.view', 'office.view', 'trip.view'] end) c
  where r.tenant_id = p_tenant_id and r.code not in ('owner', 'admin')
  on conflict do nothing;
end;
$$;

drop table perm_map, fn_map, pol_map;
