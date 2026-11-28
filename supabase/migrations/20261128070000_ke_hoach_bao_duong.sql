-- =====================================================================
-- Kế hoạch bảo dưỡng xe: hạn bảo dưỡng theo km hoặc theo tháng, cái nào đến trước thì nhắc trước.
-- - Lần bảo dưỡng gần nhất = phiếu sửa chữa loại "Bảo dưỡng" mới nhất của xe.
-- - Km đã chạy từ lần đó = tổng km xe (vehicle_km) sau ngày bảo dưỡng.
-- - Cấu hình của nhà xe: chu kỳ km, chu kỳ tháng, báo trước bao nhiêu km / bao nhiêu ngày.
-- - Hàm chạy theo quyền người xem (security invoker): RLS của xe, phiếu sửa chữa, km xe vẫn áp dụng.
-- =====================================================================
do $$
declare f record; v text;
begin
  select pr.oid into f from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = 'app' and pr.proname = 'validate_tenant_setting';
  v := pg_get_functiondef(f.oid);
  if position('"lai_xe.gio_tuan_toi_da":' in v) = 0 then raise exception 'Không tìm thấy bảng giới hạn cấu hình'; end if;
  v := replace(v, '"lai_xe.gio_tuan_toi_da":',
    '"bao_duong.chu_ky_km":         [500, 200000, "Chu kỳ bảo dưỡng phải từ 500 đến 200.000 km"],
    "bao_duong.chu_ky_thang":       [1, 36, "Chu kỳ bảo dưỡng phải từ 1 đến 36 tháng"],
    "bao_duong.bao_truoc_km":       [0, 50000, "Báo trước phải từ 0 đến 50.000 km"],
    "bao_duong.bao_truoc_ngay":     [0, 180, "Báo trước phải từ 0 đến 180 ngày"],
    "lai_xe.gio_tuan_toi_da":');
  execute v;
end;
$$;

create function public.vehicle_maintenance()
returns table (vehicle_id uuid, last_on date, last_odo int, last_code text, km_since numeric)
language sql stable security invoker set search_path = ''
as $$
  select v.id, l.repaired_on, l.odo_km, l.code,
         case when l.repaired_on is null then null
              else coalesce((select sum(k.km) from public.vehicle_km k
                             where k.tenant_id = v.tenant_id and k.vehicle_id = v.id and k.run_date > l.repaired_on), 0) end
  from public.vehicles v
  left join lateral (
    select r.repaired_on, r.odo_km, r.code from public.repair_orders r
    where r.tenant_id = v.tenant_id and r.vehicle_id = v.id and r.kind = 'bao_duong'
    order by r.repaired_on desc, r.created_at desc limit 1) l on true
  where v.tenant_id = app.current_tenant_id() and v.is_active and v.retired_on is null;
$$;
revoke execute on function public.vehicle_maintenance() from public, anon, authenticated;
grant execute on function public.vehicle_maintenance() to authenticated, service_role;
