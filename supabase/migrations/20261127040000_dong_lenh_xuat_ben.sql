-- =====================================================================
-- Đóng lệnh xuất bến sau N phút (cấu hình lenh.dong_sau_phut, mặc định 0 = đúng giờ chạy như trước):
-- quá giờ chạy N phút mà lái xe chưa bấm → tự ghi xuất bến (giờ xuất bến = giờ chạy + N phút).
-- Xuất bến là khóa chuyến như cũ (không bán / đổi vé, không đổi xe, tổ lái).
-- Chỉ thay thân hàm tự ghi; không đổi bảng, không đổi API.
-- =====================================================================
create or replace function app.svc_auto_trip_marks()
returns int
language plpgsql security definer set search_path = ''
as $$
declare n int; m int;
begin
  update public.trips t
     set departed_at = t.depart_at + make_interval(mins => greatest(app.setting_int(t.tenant_id, 'lenh.dong_sau_phut', 0), 0)),
         departed_auto = true
  where t.status = 'mo' and t.departed_at is null and t.vehicle_id is not null
    and t.depart_at > now() - interval '1 day'
    and t.depart_at + make_interval(mins => greatest(app.setting_int(t.tenant_id, 'lenh.dong_sau_phut', 0), 0)) <= now()
    and app.setting_int(t.tenant_id, 'chuyen.tu_den_ben_gio', 4) > 0
    and exists (select 1 from public.trip_crew c where c.tenant_id = t.tenant_id and c.trip_id = t.id and c.role = 'lai_xe_1' and c.active);
  get diagnostics n = row_count;
  update public.trips t set arrived_at = t.departed_at + make_interval(hours => app.setting_int(t.tenant_id, 'chuyen.tu_den_ben_gio', 4)), arrived_auto = true
  where t.status = 'mo' and t.departed_at is not null and t.arrived_at is null
    and t.departed_at > now() - interval '1 day'
    and app.setting_int(t.tenant_id, 'chuyen.tu_den_ben_gio', 4) > 0
    and t.departed_at + make_interval(hours => app.setting_int(t.tenant_id, 'chuyen.tu_den_ben_gio', 4)) <= now();
  get diagnostics m = row_count;
  return n + m;
end;
$$;
revoke execute on function app.svc_auto_trip_marks() from public, anon, authenticated;

-- Kiểm tra giá trị cấu hình: số nguyên 0–240 phút
do $$
declare v text;
begin
  v := pg_get_functiondef('app.validate_tenant_setting()'::regprocedure);
  v := replace(v, E'  elsif new.key = ''lenh.hau_to'' then',
       E'  elsif new.key = ''lenh.dong_sau_phut'' then\n'
    || E'    if jsonb_typeof(new.value) <> ''number'' then\n'
    || E'      raise exception ''Đóng lệnh xuất bến sau: 0–240 phút'' using errcode = ''22023'';\n'
    || E'    elsif (new.value #>> ''{}'')::numeric <> trunc((new.value #>> ''{}'')::numeric) or (new.value #>> ''{}'')::numeric not between 0 and 240 then\n'
    || E'      raise exception ''Đóng lệnh xuất bến sau: 0–240 phút'' using errcode = ''22023'';\n    end if;\n'
    || E'  elsif new.key = ''lenh.hau_to'' then');
  if v not like '%lenh.dong_sau_phut%' then raise exception 'Không sửa được validate_tenant_setting'; end if;
  execute v;
end;
$$;
