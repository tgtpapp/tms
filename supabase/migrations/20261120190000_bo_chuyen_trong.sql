-- =====================================================================
-- Bỏ chuyến trống (không có xe và không có tài xế) ở Điều hành và Bán vé:
-- 1) Cấu hình mới chuyen.tao_chuyen_trong (1 = mỗi đêm tự tạo chuyến trống theo nốt như trước, 0 = không tạo).
--    Nhà xe đang chạy đặt 0: chuyến chỉ có khi nhập lịch Vexere / Excel, thêm chuyến tăng cường hoặc xếp xe.
-- 2) Xóa hẳn các chuyến hiện có chưa có xe và chưa có tài xế. Chuyến đã có vé, hàng, lệnh… (dù đã hủy) giữ nguyên:
--    không xóa dữ liệu bán hàng / tiền.
-- =====================================================================
insert into public.tenant_settings (tenant_id, key, value)
select id, 'chuyen.tao_chuyen_trong', '0'::jsonb from public.tenants
on conflict (tenant_id, key) do update set value = excluded.value;

do $$
declare v text;
begin
  select pg_get_functiondef('app.generate_trips_for(uuid, date, uuid)'::regprocedure) into v;
  v := regexp_replace(v, '\nbegin\n', E'\nbegin\n  if app.setting_int(p_tenant, ''chuyen.tao_chuyen_trong'', 1) = 0 then\n    return 0;   -- nhà xe không dùng chuyến trống: chuyến chỉ có khi nhập lịch / thêm tăng cường\n  end if;\n');
  if v not like '%chuyen.tao_chuyen_trong%' then raise exception 'Không sửa được app.generate_trips_for'; end if;
  execute v;
end;
$$;

/** Xóa chuyến chưa có xe và chưa có tài xế của 1 nhà xe; chuyến đã có dữ liệu liên quan thì giữ. Trả số chuyến đã xóa. */
create function app.purge_empty_trips(p_tid uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare t record; v_n int := 0;
begin
  for t in select x.id from public.trips x
           where x.tenant_id = p_tid and x.vehicle_id is null
             and not exists (select 1 from public.trip_crew c where c.tenant_id = x.tenant_id and c.trip_id = x.id and c.active and c.role in ('lai_xe_1', 'lai_xe_2'))
  loop
    begin
      delete from public.trips where tenant_id = p_tid and id = t.id;
      v_n := v_n + 1;
    exception when foreign_key_violation then
      null;   -- đã có vé / hàng / lệnh: giữ
    end;
  end loop;
  return v_n;
end;
$$;
revoke execute on function app.purge_empty_trips(uuid) from public, anon, authenticated;

do $$
declare r record; n int := 0;
begin
  for r in select id from public.tenants loop
    n := n + app.purge_empty_trips(r.id);
  end loop;
  raise notice 'Đã xóa % chuyến trống', n;
end;
$$;
