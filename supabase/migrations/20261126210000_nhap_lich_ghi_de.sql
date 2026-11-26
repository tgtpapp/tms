-- =====================================================================
-- Nhập lịch điều hành (dán từ Vexere / Excel): lịch dán sau là mới nhất → ghi đè xe + lái xe 1 của các chuyến được chọn,
-- KỂ CẢ chuyến đã xuất bến; áp dụng cả lô trong 1 lần (đổi tài / đổi nốt giữa các chuyến không bị báo "trùng giờ"
-- vì làm trống các chuyến trong lô trước rồi mới xếp lại). Người có quyền xếp xe (Điều hành: Sửa hoặc Cấp lệnh –
-- nhân viên bán vé được cấp lệnh) dùng được. Không đổi bảng; không đổi hàm cũ (chỉ thêm cờ bỏ khóa xuất bến khi nhập lịch).
-- =====================================================================

/** Đang nhập lịch (cờ chỉ bật bên trong public.import_schedule) */
create function app.importing_schedule()
returns boolean language sql stable set search_path = '' as $$ select coalesce(current_setting('app.nhap_lich', true), '') = 'on' $$;
revoke execute on function app.importing_schedule() from public, anon;
grant execute on function app.importing_schedule() to authenticated, service_role;

create or replace function app.trip_lock_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- nhập lịch: chỉ cho đổi xe (và loại xe theo xe) của chuyến đã xuất bến; giờ / trạng thái / tuyến vẫn khóa
  if app.importing_schedule() and new.depart_at is not distinct from old.depart_at and new.arrive_at is not distinct from old.arrive_at
     and new.status is not distinct from old.status and new.route_id is not distinct from old.route_id then
    return new;
  end if;
  if old.departed_at is not null and old.edit_unlocked_at is null and new.departed_at is not null
     and (new.vehicle_id is distinct from old.vehicle_id or new.vehicle_type_id is distinct from old.vehicle_type_id
          or new.depart_at is distinct from old.depart_at or new.arrive_at is distinct from old.arrive_at
          or new.status is distinct from old.status or new.route_id is distinct from old.route_id) then
    raise exception 'Chuyến đã xuất bến: không sửa xe / giờ / trạng thái. Cần quản trị mở khóa' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function app.crew_lock_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if app.importing_schedule() then return coalesce(new, old); end if;
  if app.trip_locked(coalesce(new.tenant_id, old.tenant_id), coalesce(new.trip_id, old.trip_id)) then
    raise exception 'Chuyến đã xuất bến: không đổi tổ lái. Cần quản trị mở khóa' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

/** p_rows: [{trip_id, vehicle_id, driver1}] → [{trip_id, ok, warnings | error}] */
create function public.import_schedule(p_rows jsonb, p_src text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_ids uuid[];
  v_out jsonb := '[]';
  x record;
  v_old record;
  v_res jsonb;
begin
  if v_tid is null or not app.can_issue_order() then raise exception 'Không có quyền xếp xe' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'Dữ liệu không hợp lệ' using errcode = '22023'; end if;
  select array_agg((e ->> 'trip_id')::uuid) into v_ids from jsonb_array_elements(p_rows) e;
  if exists (select 1 from unnest(v_ids) i where not exists (select 1 from public.trips t where t.tenant_id = v_tid and t.id = i and t.status = 'mo')) then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  perform set_config('app.nhap_lich', 'on', true);
  -- giữ lịch cũ để trả lại nếu dòng nào không xếp được
  create temp table if not exists nhap_lich_cu (trip_id uuid, vehicle_id uuid, d1 uuid, d2 uuid, px uuid) on commit drop;
  delete from nhap_lich_cu;
  insert into nhap_lich_cu
  select t.id, t.vehicle_id,
         (select staff_id from public.trip_crew c where c.tenant_id = v_tid and c.trip_id = t.id and c.role = 'lai_xe_1'),
         (select staff_id from public.trip_crew c where c.tenant_id = v_tid and c.trip_id = t.id and c.role = 'lai_xe_2'),
         (select staff_id from public.trip_crew c where c.tenant_id = v_tid and c.trip_id = t.id and c.role = 'phu_xe')
  from public.trips t where t.tenant_id = v_tid and t.id = any(v_ids);
  -- làm trống xe + lái xe 1 của cả lô trước (đổi tài giữa các chuyến không bị chồng giờ)
  update public.trips set vehicle_id = null where tenant_id = v_tid and id = any(v_ids) and vehicle_id is not null;
  delete from public.trip_crew where tenant_id = v_tid and trip_id = any(v_ids) and role = 'lai_xe_1';
  for x in select (e ->> 'trip_id')::uuid trip_id, nullif(e ->> 'vehicle_id', '')::uuid vehicle_id, nullif(e ->> 'driver1', '')::uuid driver1
           from jsonb_array_elements(p_rows) e loop
    select * into v_old from nhap_lich_cu where trip_id = x.trip_id;
    begin
      v_res := public.assign_trip(x.trip_id, x.vehicle_id, x.driver1, case when x.driver1 is null then null else v_old.d2 end, v_old.px, null);
      if not (v_res ->> 'saved')::boolean then
        v_res := public.assign_trip(x.trip_id, x.vehicle_id, x.driver1, case when x.driver1 is null then null else v_old.d2 end, v_old.px,
                                    left(format('Nhập từ %s: %s', coalesce(nullif(trim(p_src), ''), 'lịch dán'),
                                                (select string_agg(w, '; ') from jsonb_array_elements_text(v_res -> 'warnings') w)), 500));
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object('trip_id', x.trip_id, 'ok', true, 'warnings', v_res -> 'warnings'));
    exception when others then
      v_out := v_out || jsonb_build_array(jsonb_build_object('trip_id', x.trip_id, 'ok', false,
               'error', case when sqlerrm ~ 'no_overlap|chồng giờ' then 'xe hoặc lái xe trùng giờ với chuyến khác' else sqlerrm end));
      -- trả lại lịch cũ của chuyến này (nếu được)
      begin
        update public.trips set vehicle_id = v_old.vehicle_id where tenant_id = v_tid and id = x.trip_id;
        insert into public.trip_crew (tenant_id, trip_id, role, staff_id, during)
        select v_tid, t.id, 'lai_xe_1', v_old.d1, tstzrange(t.depart_at, t.arrive_at) from public.trips t
        where v_old.d1 is not null and t.tenant_id = v_tid and t.id = x.trip_id;
      exception when others then null;
      end;
    end;
  end loop;
  perform set_config('app.nhap_lich', 'off', true);
  return v_out;
end;
$$;
revoke execute on function public.import_schedule(jsonb, text) from public, anon, authenticated;
grant execute on function public.import_schedule(jsonb, text) to authenticated;
