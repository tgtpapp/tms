-- =====================================================================
-- Bảng giá vé: thêm bảng giá mới thì bảng cũ của cùng tuyến, cùng chiều (bắt đầu trước) tự ghi ngày kết thúc
-- = ngày trước ngày áp dụng giá mới. Chỉ khi bảng cũ nằm gọn trước / trong khoảng của bảng mới (bảng mới không giới hạn
-- hoặc bảng cũ kết thúc trước ngày kết thúc bảng mới); còn lại vẫn báo trùng khoảng ngày như trước.
-- Vé đã bán giữ nguyên giá; vé bán sau lấy giá theo ngày chạy.
-- =====================================================================
do $$
declare f record; v text; k text := '  select valid_from, valid_to into c from public.fare_tables';
begin
  select pr.oid into f from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = 'public' and pr.proname = 'save_fare_table';
  v := pg_get_functiondef(f.oid);
  if position(k in v) = 0 then raise exception 'Không tìm thấy chỗ kiểm tra trùng khoảng ngày'; end if;
  v := replace(v, k, '  if p_id is null then
    update public.fare_tables set valid_to = p_valid_from - 1, updated_at = now(), updated_by = auth.uid()
    where tenant_id = v_tid and route_id = p_route_id and direction = v_dir and valid_from < p_valid_from
      and (valid_to is null or valid_to >= p_valid_from)
      and (p_valid_to is null or (valid_to is not null and valid_to <= p_valid_to));
  end if;
' || k);
  execute v;
end;
$$;
revoke execute on function public.save_fare_table(uuid, uuid, date, date, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.save_fare_table(uuid, uuid, date, date, text, jsonb, jsonb, text) to authenticated, service_role;
