-- =====================================================================
-- Xóa danh mục (tuyến, điểm dừng, loại xe, xe, nhân viên, chi nhánh, quầy vé) – không khóa cứng.
-- - Xóa được khi chưa phát sinh dữ liệu nghiệp vụ (vé, hàng, lệnh vận chuyển, hợp đồng, chuyến đã xếp...).
--   Đã phát sinh thì báo rõ và gợi ý "Ngừng dùng" (ẩn) để giữ lịch sử – không xóa tiền / vé đã bán.
-- - Kèm theo: xóa tuyến thì xóa luôn giờ chạy + chuyến CHƯA có vé / hàng / lệnh của chính tuyến đó;
--   xóa xe / nhân viên thì xóa luôn giấy tờ, lý lịch của chính xe / người đó.
-- - Chỉ trong nhà xe của người gọi; sai nhà xe trả "không tìm thấy".
-- =====================================================================

create function public.delete_record(p_kind text, p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid := app.current_tenant_id();
  v_table text;
  v_perm text;
  v_name text;
  n int;
begin
  select t, p into v_table, v_perm from (values
    ('stop', 'stops', 'route.manage'), ('route', 'routes', 'route.manage'),
    ('vehicle_type', 'vehicle_types', 'vehicle.manage'), ('vehicle', 'vehicles', 'vehicle.manage'),
    ('staff', 'staff_members', 'staff.manage'),
    ('branch', 'branches', 'branch.manage'), ('office', 'ticket_offices', 'office.manage')) x(k, t, p)
  where k = p_kind;
  if v_table is null then raise exception 'Loại dữ liệu không hợp lệ' using errcode = '22023'; end if;
  if v_tenant is null then raise exception 'Không có quyền' using errcode = '42501'; end if;

  execute format('select to_jsonb(r) ->> %L from public.%I r where r.tenant_id = $1 and r.id = $2',
                 case when p_kind in ('staff') then 'full_name' when p_kind = 'vehicle' then 'plate' else 'name' end, v_table)
    into v_name using v_tenant, p_id;
  if v_name is null then raise exception 'Không tìm thấy' using errcode = 'P0002'; end if;   -- tên luôn có (not null)
  if not (case p_kind when 'branch' then app.has_permission(v_perm, p_id)
                     when 'office' then app.has_permission(v_perm, null, p_id)
                     else app.has_permission(v_perm) end) then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;

  begin
    if p_kind = 'route' then
      delete from public.trips where tenant_id = v_tenant and route_id = p_id;          -- tổ lái xe đi theo (cascade)
      delete from public.schedules where tenant_id = v_tenant and route_id = p_id;
    elsif p_kind = 'vehicle' then
      delete from public.documents where tenant_id = v_tenant and vehicle_id = p_id and staff_id is null;
    elsif p_kind = 'staff' then
      delete from public.documents where tenant_id = v_tenant and staff_id = p_id;
      delete from public.staff_records where tenant_id = v_tenant and staff_id = p_id;
    end if;
    execute format('delete from public.%I where tenant_id = $1 and id = $2', v_table) using v_tenant, p_id;
    get diagnostics n = row_count;
  exception when foreign_key_violation then
    raise exception '% đã có dữ liệu liên quan (chuyến, vé, hàng, lệnh, hợp đồng, tài khoản...) nên không xóa được. Hãy bấm "Ngừng dùng" để ẩn.',
      coalesce(v_name, 'Mục này') using errcode = '23503';
  end;
  if n = 0 then raise exception 'Không tìm thấy' using errcode = 'P0002'; end if;
  -- Nhật ký xóa: trigger app.write_audit có sẵn trên các bảng này tự ghi
end;
$$;
revoke execute on function public.delete_record(text, uuid) from public, anon, authenticated;
grant execute on function public.delete_record(text, uuid) to authenticated;
