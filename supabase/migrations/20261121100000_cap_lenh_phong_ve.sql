-- =====================================================================
-- Cấp lệnh vận chuyển ngay tại Bán vé (nhân viên phòng vé):
-- - Ô quyền mới "Cấp lệnh vận chuyển" (order.add): vai trò Bán vé, Quản lý phòng vé, Điều hành có sẵn; Chủ / Quản trị có tất cả.
--   Người có ô này (hoặc Điều hành: sửa) cấp / in lệnh được và xem được chữ ký in trên lệnh.
-- - In chữ ký Giám đốc / con dấu: chọn ngay khi cấp lệnh, lưu theo từng lệnh (in lại giữ nguyên); mặc định theo Cấu hình.
-- - Dữ liệu in lệnh lấy qua 1 hàm (tên lái xe, hạng GPLX, người cấp…) để người bán vé không cần quyền xem hồ sơ nhân viên.
-- =====================================================================
insert into public.permissions (code, module, name) values ('order.add', 'order', 'Cấp lệnh vận chuyển: Cấp')
on conflict (code) do nothing;
select app.grant_permission_to_admins('order.add');
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, 'order.add' from public.roles r where r.code in ('seller', 'office_manager', 'dispatcher')
on conflict do nothing;
do $$
declare v text;
begin
  select pg_get_functiondef('app.seed_system_roles(uuid)'::regprocedure) into v;
  v := replace(v, '(''seller'', ''sell.*''),', '(''seller'', ''sell.*''), (''seller'', ''order.add''), (''office_manager'', ''order.add''), (''dispatcher'', ''order.add''),');
  if v not like '%order.add%' then raise exception 'Không sửa được seed_system_roles'; end if;
  execute v;
end;
$$;

-- chữ ký in trên lệnh: người cấp lệnh xem được
do $$
declare v text;
begin
  select pg_get_functiondef('app.can_read_signature(text)'::regprocedure) into v;
  v := regexp_replace(v, 'select app\.has_permission\(', 'select app.has_permission(''order.add'') or app.has_permission(');
  if v not like '%order.add%' then raise exception 'Không sửa được can_read_signature'; end if;
  execute v;
end;
$$;

alter table public.transport_orders add column print_sign boolean, add column print_seal boolean;

create or replace function app.can_issue_order()
returns boolean
language sql stable security definer set search_path = ''
as $$ select app.has_permission('order.add') or app.has_permission('trip.edit') $$;
revoke execute on function app.can_issue_order() from public, anon;
grant execute on function app.can_issue_order() to authenticated, service_role;

create or replace function public.transport_order_draft(p_trip_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); o public.transport_orders;
  d_sign boolean; d_seal boolean;
begin
  if v_tid is null or not app.can_issue_order() then raise exception 'Không có quyền cấp lệnh' using errcode = '42501'; end if;
  if not exists (select 1 from public.trips where tenant_id = v_tid and id = p_trip_id) then raise exception 'Không tìm thấy chuyến' using errcode = 'P0002'; end if;
  d_sign := coalesce((select (value #>> '{}')::boolean from public.tenant_settings where tenant_id = v_tid and key = 'in.chu_ky_giam_doc'), true);
  d_seal := coalesce((select (value #>> '{}')::boolean from public.tenant_settings where tenant_id = v_tid and key = 'in.con_dau'), true);
  select o2.* into o from public.transport_order_legs l join public.transport_orders o2 on o2.tenant_id = l.tenant_id and o2.id = l.order_id
  where l.tenant_id = v_tid and l.trip_id = p_trip_id;
  if found then
    return jsonb_build_object('order_id', o.id, 'order_no', o.order_no, 'sign', coalesce(o.print_sign, d_sign), 'seal', coalesce(o.print_seal, d_seal), 'legs',
      (select jsonb_agg(jsonb_build_object('seq', l.seq, 'trip_id', l.trip_id, 'time', l.depart_time, 'date', l.depart_date) order by l.seq)
       from public.transport_order_legs l where l.tenant_id = v_tid and l.order_id = o.id));
  end if;
  return jsonb_build_object('order_id', null, 'order_no', null, 'sign', d_sign, 'seal', d_seal, 'legs',
    (select jsonb_agg(e || jsonb_build_object('seq', i)) from jsonb_array_elements(app.order_auto_legs(v_tid, p_trip_id, null)) with ordinality a(e, i)));
end;
$$;

-- Lưu lệnh: quyền Cấp lệnh hoặc Điều hành: sửa (in chữ ký / con dấu lưu riêng bằng set_order_print)
do $$
declare v text;
begin
  select pg_get_functiondef('public.save_transport_order(uuid, jsonb)'::regprocedure) into v;
  v := replace(v, 'not app.has_permission(''trip.edit'')', 'not app.can_issue_order()');
  if v not like '%can_issue_order%' then raise exception 'Không sửa được save_transport_order'; end if;
  execute v;
end;
$$;
create function public.set_order_print(p_order_id uuid, p_sign boolean, p_seal boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not app.can_issue_order() then raise exception 'Không có quyền cấp lệnh' using errcode = '42501'; end if;
  update public.transport_orders set print_sign = p_sign, print_seal = p_seal where tenant_id = app.current_tenant_id() and id = p_order_id;
  if not found then raise exception 'Không tìm thấy lệnh' using errcode = 'P0002'; end if;
end;
$$;

/** Dữ liệu in 1 lệnh (đủ cho mẫu lệnh, không cần quyền xem hồ sơ nhân viên) */
create function public.transport_order_print(p_order_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); o public.transport_orders; t public.trips; r public.routes; out jsonb;
begin
  if v_tid is null or not app.can_issue_order() then raise exception 'Không có quyền cấp lệnh' using errcode = '42501'; end if;
  select * into o from public.transport_orders where tenant_id = v_tid and id = p_order_id;
  if not found then raise exception 'Không tìm thấy lệnh' using errcode = 'P0002'; end if;
  select * into t from public.trips where tenant_id = v_tid and id = o.trip_id;
  select * into r from public.routes where tenant_id = v_tid and id = t.route_id;
  out := jsonb_build_object(
    'order_no', o.order_no, 'issued_at', o.issued_at, 'valid_from', o.valid_from, 'valid_to', o.valid_to, 'issued_by', o.issued_by,
    'sign', coalesce(o.print_sign, (select (value #>> '{}')::boolean from public.tenant_settings where tenant_id = v_tid and key = 'in.chu_ky_giam_doc'), true),
    'seal', coalesce(o.print_seal, (select (value #>> '{}')::boolean from public.tenant_settings where tenant_id = v_tid and key = 'in.con_dau'), true),
    'issuer', (select jsonb_build_object('staff_id', m.id, 'name', m.full_name) from public.staff_members m where m.tenant_id = v_tid and m.user_id = o.issued_by limit 1),
    'issuer_name', (select u.full_name from public.app_users u where u.tenant_id = v_tid and u.id = o.issued_by),
    'company', (select coalesce(nullif(legal_name, ''), name) from public.tenants where id = v_tid),
    'signer_title', (select value #>> '{}' from public.tenant_settings where tenant_id = v_tid and key = 'cong_ty.chuc_danh_ky'),
    'signer_name', (select value #>> '{}' from public.tenant_settings where tenant_id = v_tid and key = 'cong_ty.giam_doc'),
    'plate', (select plate from public.vehicles where tenant_id = v_tid and id = t.vehicle_id),
    'seats', (select vt.reg_seats + vt.reg_berths from public.vehicles v join public.vehicle_types vt on vt.tenant_id = v.tenant_id and vt.id = v.vehicle_type_id
              where v.tenant_id = v_tid and v.id = t.vehicle_id),
    'direction', t.direction,
    'route', jsonb_build_object('name', r.name, 'name_ve', r.name_ve, 'distance_km', r.distance_km, 'registered_code', r.registered_code,
                                'itinerary', r.itinerary, 'itinerary_ve', r.itinerary_ve),
    'stop_a', (select s.name from public.route_stops rs join public.stops s on s.tenant_id = rs.tenant_id and s.id = rs.stop_id
               where rs.tenant_id = v_tid and rs.route_id = t.route_id order by rs.seq limit 1),
    'stop_b', (select s.name from public.route_stops rs join public.stops s on s.tenant_id = rs.tenant_id and s.id = rs.stop_id
               where rs.tenant_id = v_tid and rs.route_id = t.route_id order by rs.seq desc limit 1),
    'crew', (select coalesce(jsonb_agg(jsonb_build_object('role', c.role, 'staff_id', m.id, 'user_id', m.user_id, 'name', m.full_name,
               'hang', (select app.normalize_license(d.data ->> 'hang', d.issued_on) from public.documents d
                        where d.tenant_id = v_tid and d.staff_id = m.id and d.doc_type = 'gplx' and d.is_current limit 1))), '[]')
             from public.trip_crew c join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id
             where c.tenant_id = v_tid and c.trip_id = t.id and c.active),
    'legs', (select coalesce(jsonb_agg(jsonb_build_object('seq', l.seq, 'time', l.depart_time, 'date', l.depart_date) order by l.seq), '[]')
             from public.transport_order_legs l where l.tenant_id = v_tid and l.order_id = o.id));
  return out;
end;
$$;
revoke execute on function public.set_order_print(uuid, boolean, boolean), public.transport_order_print(uuid) from public, anon, authenticated;
grant execute on function public.set_order_print(uuid, boolean, boolean), public.transport_order_print(uuid) to authenticated, service_role;
