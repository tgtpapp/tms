-- =====================================================================
-- Phòng vé sửa nhanh xe + lái xe ngay trên giờ chạy ở màn Bán vé (người có quyền Cấp lệnh hoặc Điều hành: Sửa).
-- Dùng đúng hàm xếp xe của Điều hành (cảnh báo giờ lái, giấy tờ, bằng lái… như cũ), chỉ mở thêm quyền.
-- =====================================================================
do $$
declare v text;
begin
  v := pg_get_functiondef('public.assign_trip(uuid, uuid, uuid, uuid, uuid, text)'::regprocedure);
  v := replace(v, 'if v_tid is null or not app.has_permission(''trip.edit'') then', 'if v_tid is null or not app.can_issue_order() then');
  if v not like '%can_issue_order()%' then raise exception 'Không sửa được assign_trip'; end if;
  execute v;
end;
$$;

/** Danh sách xe + lái xe để xếp nhanh ở màn Bán vé (không cần quyền xem hồ sơ xe / nhân viên) */
create function public.assign_pick_lists()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.can_issue_order() then raise exception 'Không có quyền xếp xe' using errcode = '42501'; end if;
  return jsonb_build_object(
    'vehicles', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'plate', v.plate, 'seats', vt.reg_seats + vt.reg_berths) order by v.plate), '[]')
                 from public.vehicles v left join public.vehicle_types vt on vt.tenant_id = v.tenant_id and vt.id = v.vehicle_type_id
                 where v.tenant_id = v_tid and v.is_active),
    'drivers', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.full_name) order by m.full_name), '[]')
                from public.staff_members m where m.tenant_id = v_tid and m.is_active and m.position = 'lai_xe'));
end;
$$;
revoke execute on function public.assign_pick_lists() from public, anon, authenticated;
grant execute on function public.assign_pick_lists() to authenticated, service_role;
