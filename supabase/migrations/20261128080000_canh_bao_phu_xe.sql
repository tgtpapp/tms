-- =====================================================================
-- Xếp xe chạy tuyến: xe trên 30 chỗ (chỗ ngồi + giường nằm theo đăng ký) mà chưa có nhân viên phục vụ (phụ xe)
-- thì cảnh báo như các cảnh báo xếp xe khác (xem rồi ghi lý do vẫn xếp được). Xe từ 30 chỗ trở xuống không cảnh báo.
-- =====================================================================
do $$
declare f record; v text; k text := '  if cardinality(v_warn) > 0 and nullif(trim(p_reason), '''') is null then';
begin
  select pr.oid into f from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = 'public' and pr.proname = 'assign_trip';
  v := pg_get_functiondef(f.oid);
  if position(k in v) = 0 then raise exception 'Không tìm thấy chỗ trả cảnh báo xếp xe'; end if;
  v := replace(v, k, '  if p_vehicle_id is not null and p_assistant is null and coalesce(v_type.reg_seats, 0) + coalesce(v_type.reg_berths, 0) > 30 then
    v_warn := v_warn || format(''Xe %s trên 30 chỗ chưa có nhân viên phục vụ trên xe (phụ xe)'', v_veh.plate);
  end if;
' || k);
  execute v;
end;
$$;
revoke execute on function public.assign_trip(uuid, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.assign_trip(uuid, uuid, uuid, uuid, uuid, text) to authenticated, service_role;
