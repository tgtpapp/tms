-- =====================================================================
-- Cấp lệnh đơn giản như app cũ: bấm giờ chuyến → cấp lệnh & in ngay, chưa xếp xe / lái xe vẫn cấp được (ô trống để ghi tay).
-- Trên lệnh: biển số, số ghế (16 / 29…), tên lái xe, hạng GPLX — tự điền theo xếp xe, sửa được, chỉ in lên lệnh (không đổi xếp xe).
-- =====================================================================
alter table public.transport_orders add column info jsonb not null default '{}'::jsonb check (length(info::text) <= 2000);

/** Giữ đúng 4 mục in trên lệnh */
create function app.order_info_clean(p jsonb)
returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'plate', nullif(left(trim(p ->> 'plate'), 20), ''),
    'seats', case when (p ->> 'seats') ~ '^[0-9]{1,3}$' then (p ->> 'seats')::int end,
    'driver', nullif(left(trim(p ->> 'driver'), 120), ''),
    'hang', nullif(left(trim(p ->> 'hang'), 10), '')))
$$;
revoke execute on function app.order_info_clean(jsonb) from public, anon, authenticated;

/** Mặc định theo xếp xe của chuyến */
create function app.order_info_default(p_tid uuid, p_trip uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'plate', v.plate, 'seats', vt.reg_seats + vt.reg_berths, 'driver', m.full_name,
    'hang', (select app.normalize_license(d.data ->> 'hang', d.issued_on) from public.documents d
             where d.tenant_id = p_tid and d.staff_id = m.id and d.doc_type = 'gplx' and d.is_current limit 1)))
  from public.trips t
  left join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id
  left join public.vehicle_types vt on vt.tenant_id = v.tenant_id and vt.id = v.vehicle_type_id
  left join public.trip_crew c on c.tenant_id = t.tenant_id and c.trip_id = t.id and c.role = 'lai_xe_1' and c.active
  left join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id
  where t.tenant_id = p_tid and t.id = p_trip
$$;
revoke execute on function app.order_info_default(uuid, uuid) from public, anon, authenticated;

/** Danh sách chọn nhanh khi cấp lệnh (người cấp lệnh không cần quyền xem hồ sơ xe / nhân viên) */
create function public.order_pick_lists()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.can_issue_order() then raise exception 'Không có quyền cấp lệnh' using errcode = '42501'; end if;
  return jsonb_build_object(
    'vehicles', (select coalesce(jsonb_agg(jsonb_build_object('plate', v.plate, 'seats', vt.reg_seats + vt.reg_berths) order by v.plate), '[]')
                 from public.vehicles v left join public.vehicle_types vt on vt.tenant_id = v.tenant_id and vt.id = v.vehicle_type_id
                 where v.tenant_id = v_tid and v.is_active),
    'drivers', (select coalesce(jsonb_agg(jsonb_build_object('name', m.full_name,
                  'hang', (select app.normalize_license(d.data ->> 'hang', d.issued_on) from public.documents d
                           where d.tenant_id = v_tid and d.staff_id = m.id and d.doc_type = 'gplx' and d.is_current limit 1)) order by m.full_name), '[]')
                from public.staff_members m where m.tenant_id = v_tid and m.is_active and m.position = 'lai_xe'));
end;
$$;
revoke execute on function public.order_pick_lists() from public, anon, authenticated;
grant execute on function public.order_pick_lists() to authenticated, service_role;

-- Lưu lệnh: thêm p_info; bỏ chặn "chưa đủ xe + lái xe"; số lệnh lấy 3 số cuối biển số đã điền (không có biển số thì bỏ phần này)
do $$
declare v text; n int;
begin
  v := pg_get_functiondef('public.save_transport_order(uuid, jsonb)'::regprocedure);
  n := length(v);
  v := replace(v, 'public.save_transport_order(p_trip_id uuid, p_legs jsonb)', 'public.save_transport_order(p_trip_id uuid, p_legs jsonb, p_info jsonb DEFAULT NULL::jsonb)');
  v := replace(v, E'  if t1.vehicle_id is null or not exists (select 1 from public.trip_crew where tenant_id = v_tid and trip_id = t1.id and role = ''lai_xe_1'' and active) then\n    raise exception ''Chuyến chưa đủ xe và lái xe, chưa cấp lệnh được'' using errcode = ''22023'';\n  end if;\n', '');
  v := replace(v, 'regexp_replace((select plate from public.vehicles where tenant_id = v_tid and id = t1.vehicle_id), ''\D'', '''', ''g'')',
                  'regexp_replace(coalesce(nullif(trim(p_info ->> ''plate''), ''''), (select plate from public.vehicles where tenant_id = v_tid and id = t1.vehicle_id), ''''), ''\D'', '''', ''g'')');
  v := replace(v, ' || ''-'' || v_plate;', ' || coalesce(''-'' || nullif(v_plate, ''''), '''');');
  v := replace(v, 'valid_to = v_to, print_count = print_count + 1', 'valid_to = v_to, print_count = print_count + 1, info = case when p_info is null then info else app.order_info_clean(p_info) end');
  if v like '%chưa đủ xe%' or v not like '%p_info jsonb DEFAULT%' or v not like '%nullif(v_plate%' or v not like '%order_info_clean%' or v not like '%p_info ->> ''plate''%' then
    raise exception 'Không sửa được save_transport_order';
  end if;
  drop function public.save_transport_order(uuid, jsonb);
  execute v;
end;
$$;
revoke execute on function public.save_transport_order(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_transport_order(uuid, jsonb, jsonb) to authenticated, service_role;

-- Bản nháp + dữ liệu in: thêm 4 mục in trên lệnh
do $$
declare v text;
begin
  v := pg_get_functiondef('public.transport_order_draft(uuid)'::regprocedure);
  v := replace(v, '''sign'', coalesce(o.print_sign, d_sign)', '''info'', coalesce(nullif(o.info, ''{}''::jsonb), app.order_info_default(v_tid, p_trip_id)), ''sign'', coalesce(o.print_sign, d_sign)');
  v := replace(v, '''order_no'', null, ''sign'', d_sign', '''order_no'', null, ''info'', app.order_info_default(v_tid, p_trip_id), ''sign'', d_sign');
  if (length(v) - length(replace(v, 'order_info_default', ''))) / length('order_info_default') <> 2 then raise exception 'Không sửa được transport_order_draft'; end if;
  execute v;
  v := pg_get_functiondef('public.transport_order_print(uuid)'::regprocedure);
  v := replace(v, '''legs'', (select coalesce(jsonb_agg(jsonb_build_object(''seq'', l.seq', '''info'', o.info, ''legs'', (select coalesce(jsonb_agg(jsonb_build_object(''seq'', l.seq');
  if v not like '%''info'', o.info%' then raise exception 'Không sửa được transport_order_print'; end if;
  execute v;
end;
$$;
