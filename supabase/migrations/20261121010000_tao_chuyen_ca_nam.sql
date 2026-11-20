-- =====================================================================
-- Tạo chuyến theo lịch chạy cả năm:
-- - chuyen.tao_chuyen_trong = 1 (tự động): mỗi đêm và khi lưu lịch chạy, tạo chuyến theo nốt đến hết năm;
--   từ 01/12 (trước năm mới 1 tháng) tạo luôn đến hết năm sau.
-- - chuyen.tao_chuyen_trong = 0 (thủ công): không tự tạo; bấm "Tạo chuyến theo lịch" ở Điều hành khi cần.
-- - chuyen.tao_ca_nam = 1: hạn tạo là hết năm như trên; 0 (mặc định nhà xe mới): như cũ, trước chuyen.tao_truoc_ngay ngày.
-- Chuyến chỉ thêm, không trùng (mỗi nốt 1 chuyến / ngày); đổi / bỏ giờ trong lịch vẫn tự hủy chuyến tương lai chưa bán, chưa xếp xe.
-- =====================================================================

/** Hạn tạo chuyến của nhà xe */
create function app.trip_until(p_tenant uuid)
returns date
language sql stable security definer set search_path = ''
as $$
  select case when app.setting_int(p_tenant, 'chuyen.tao_ca_nam', 0) = 1
              then make_date(extract(year from d)::int + case when extract(month from d) = 12 then 1 else 0 end, 12, 31)
              else d + app.setting_int(p_tenant, 'chuyen.tao_truoc_ngay', 7) end
  from (select (now() at time zone app.tenant_tz(p_tenant))::date d) x
$$;
revoke execute on function app.trip_until(uuid) from public, anon, authenticated;

/** Nhà xe có tự tạo chuyến không */
create function app.auto_trips(p_tenant uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select app.setting_int(p_tenant, 'chuyen.tao_chuyen_trong', 1) = 1 $$;
revoke execute on function app.auto_trips(uuid) from public, anon, authenticated;

do $$
declare v text; f text;
begin
  -- 1) Bỏ chặn trong hàm tạo chuyến (chặn chuyển ra các chỗ tự động; bấm tay luôn tạo được)
  select pg_get_functiondef('app.generate_trips_for(uuid, date, uuid)'::regprocedure) into v;
  v := regexp_replace(v, '\n  if app\.setting_int\(p_tenant, ''chuyen\.tao_chuyen_trong'', 1\) = 0 then\n    return 0;[^\n]*\n  end if;', '');
  if v like '%chuyen.tao_chuyen_trong%' then raise exception 'Không bỏ được chặn trong app.generate_trips_for'; end if;
  execute v;

  -- 2) Lưu nốt / lịch chạy: tự tạo chuyến tới hạn nếu bật tự động
  foreach f in array array['public.save_schedule(uuid, uuid, text, time, int[], date, date, text)', 'public.save_timetable(uuid, text, date, date, text, jsonb, uuid[])'] loop
    begin
      select pg_get_functiondef(f::regprocedure) into v;
    exception when others then
      continue;   -- hàm không có ở bản này
    end;
    if v not like '%app.local_today() + app.setting_int(v_tid, ''chuyen.tao_truoc_ngay'', 7)%' then raise exception 'Không sửa được %', f; end if;
    v := replace(v, 'app.local_today() + app.setting_int(v_tid, ''chuyen.tao_truoc_ngay'', 7)',
                    'case when app.auto_trips(v_tid) then app.trip_until(v_tid) else app.local_today() - 1 end');
    execute v;
  end loop;

  -- 3) Nút "Tạo chuyến theo lịch": luôn tạo tới hạn
  select pg_get_functiondef('public.generate_trips()'::regprocedure) into v;
  v := replace(v, 'app.local_today() + app.setting_int(v_tid, ''chuyen.tao_truoc_ngay'', 7)', 'app.trip_until(v_tid)');
  if v not like '%app.trip_until(v_tid)%' then raise exception 'Không sửa được public.generate_trips'; end if;
  execute v;
end;
$$;

-- 4) Việc hằng đêm 00:05: chỉ nhà xe bật tự động
create or replace function app.svc_generate_all_trips()
returns int
language plpgsql security definer set search_path = ''
as $$
declare r record; v_total int := 0;
begin
  for r in select id from public.tenants loop
    if app.auto_trips(r.id) then
      v_total := v_total + app.generate_trips_for(r.id, app.trip_until(r.id));
    end if;
  end loop;
  return v_total;
end;
$$;
revoke execute on function app.svc_generate_all_trips() from public, anon, authenticated;
grant execute on function app.svc_generate_all_trips() to service_role;

-- 5) Nhà xe đang chạy: bật tự động cả năm và tạo ngay chuyến đến hết năm
insert into public.tenant_settings (tenant_id, key, value)
select id, k, '1'::jsonb from public.tenants, unnest(array['chuyen.tao_chuyen_trong', 'chuyen.tao_ca_nam']) k
on conflict (tenant_id, key) do update set value = excluded.value;
select app.svc_generate_all_trips();
