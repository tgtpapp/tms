-- =====================================================================
-- Lệnh vận chuyển: hạng GPLX in đúng như ghi trong hồ sơ lái xe (giấy phép lái xe), không tự đổi sang hạng theo quy định mới.
-- (Việc kiểm tra bằng lái khi xếp xe vẫn quy đổi hạng như cũ.)
-- =====================================================================
create or replace function app.order_info_default(p_tid uuid, p_trip uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'plate', v.plate, 'seats', vt.reg_seats + vt.reg_berths, 'driver', m.full_name,
    'hang', (select nullif(trim(d.data ->> 'hang'), '') from public.documents d
             where d.tenant_id = p_tid and d.staff_id = m.id and d.doc_type = 'gplx' and d.is_current limit 1)))
  from public.trips t
  left join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id
  left join public.vehicle_types vt on vt.tenant_id = v.tenant_id and vt.id = v.vehicle_type_id
  left join public.trip_crew c on c.tenant_id = t.tenant_id and c.trip_id = t.id and c.role = 'lai_xe_1' and c.active
  left join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id
  where t.tenant_id = p_tid and t.id = p_trip
$$;

do $$
declare v text; n int;
begin
  foreach v in array array['public.order_pick_lists()', 'public.transport_order_print(uuid)'] loop
    v := pg_get_functiondef(v::regprocedure);
    n := length(v);
    v := replace(v, 'app.normalize_license(d.data ->> ''hang'', d.issued_on)', 'nullif(trim(d.data ->> ''hang''), '''')');
    if length(v) = n or v like '%normalize_license%' then raise exception 'Không sửa được hạng GPLX in lệnh'; end if;
    execute v;
  end loop;
end;
$$;

-- Lệnh đã cấp: hạng GPLX đã lưu theo hạng quy đổi → lấy lại đúng hạng trong hồ sơ của lái xe cùng tên
update public.transport_orders o
set info = jsonb_set(o.info, '{hang}', to_jsonb(g.hang))
from (select m.tenant_id, m.full_name, nullif(trim(d.data ->> 'hang'), '') hang
      from public.staff_members m join public.documents d on d.tenant_id = m.tenant_id and d.staff_id = m.id and d.doc_type = 'gplx' and d.is_current) g
where g.tenant_id = o.tenant_id and g.full_name = o.info ->> 'driver' and g.hang is not null and o.info ? 'hang';
