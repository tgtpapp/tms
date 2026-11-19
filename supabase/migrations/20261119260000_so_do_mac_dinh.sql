-- =====================================================================
-- Sơ đồ ghế mặc định cho chuyến chưa xếp xe:
-- - Cấu hình "chuyen.loai_xe_mac_dinh" (mã loại xe); chưa chọn thì lấy loại xe 16 chỗ đầu tiên đang dùng.
-- - Điều hành xếp xe nào thì chuyến tự đổi sang sơ đồ của xe đó (trigger trips_vehicle_type có sẵn).
-- =====================================================================

create function app.default_vehicle_type(p_tenant uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_raw text;
  v_id uuid;
begin
  select value #>> '{}' into v_raw from public.tenant_settings where tenant_id = p_tenant and key = 'chuyen.loai_xe_mac_dinh';
  if v_raw ~ '^[0-9a-fA-F-]{36}$' then
    select id into v_id from public.vehicle_types where tenant_id = p_tenant and id = v_raw::uuid and is_active;
    if v_id is not null then return v_id; end if;
  end if;
  select id into v_id from public.vehicle_types
  where tenant_id = p_tenant and is_active and reg_seats + reg_berths = 16
  order by (exists (select 1 from public.vehicle_type_seats s where s.tenant_id = p_tenant and s.vehicle_type_id = vehicle_types.id)) desc, code
  limit 1;
  return v_id;
end;
$$;

create function app.trips_default_type()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.vehicle_type_id is null then
    if new.vehicle_id is not null then
      select vehicle_type_id into new.vehicle_type_id from public.vehicles where tenant_id = new.tenant_id and id = new.vehicle_id;
    else
      new.vehicle_type_id := app.default_vehicle_type(new.tenant_id);
    end if;
  end if;
  return new;
end;
$$;
create trigger trips_default_type before insert on public.trips for each row execute function app.trips_default_type();
revoke execute on function app.default_vehicle_type(uuid), app.trips_default_type() from public, anon, authenticated;

-- Chuyến sắp tới chưa xếp xe, chưa có sơ đồ: gán sơ đồ mặc định
update public.trips t set vehicle_type_id = app.default_vehicle_type(t.tenant_id)
where t.vehicle_type_id is null and t.vehicle_id is null and t.service_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date;
