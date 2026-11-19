-- =====================================================================
-- Chuyến đã xuất bến: khóa sửa thông tin (vé, ghế, xe, tổ lái). Quản trị (settings.manage) mở khóa mới sửa được.
-- Vẫn cho phép sau xuất bến: đánh dấu khách lên xe, lái xe thu tiền vé đặt chỗ, ghế giữ hết hạn tự nhả, báo đến bến.
-- =====================================================================

alter table public.trips add column edit_unlocked_at timestamptz;
alter table public.trips add column edit_unlocked_by uuid;

create function app.trip_locked(p_tenant uuid, p_trip uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select departed_at is not null and edit_unlocked_at is null from public.trips where tenant_id = p_tenant and id = p_trip), false)
$$;

-- Vé / ghế
create function app.seat_lock_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  o jsonb;
  n jsonb;
  k text;
begin
  if tg_op = 'INSERT' then
    if app.trip_locked(new.tenant_id, new.trip_id) then
      raise exception 'Chuyến đã xuất bến: không bán thêm. Cần quản trị mở khóa' using errcode = '42501';
    end if;
    return new;
  end if;
  if not app.trip_locked(old.tenant_id, old.trip_id) and not app.trip_locked(new.tenant_id, new.trip_id) then
    return new;
  end if;
  o := to_jsonb(old);
  n := to_jsonb(new);
  for k in select jsonb_object_keys(n) loop
    continue when k in ('boarded', 'paid_at', 'paid_by', 'pay_method', 'hold_until', 'updated_at', 'status');
    if o -> k is distinct from n -> k then
      raise exception 'Chuyến đã xuất bến: không sửa vé. Cần quản trị mở khóa' using errcode = '42501';
    end if;
  end loop;
  if old.status is distinct from new.status
     and not ((old.status = 'dat' and new.status = 'da_tt') or (old.status in ('giu', 'dat') and new.status = 'het_han')) then
    raise exception 'Chuyến đã xuất bến: không hủy / đổi vé. Cần quản trị mở khóa' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger seat_inventory_lock before insert or update on public.seat_inventory
  for each row execute function app.seat_lock_guard();

-- Chuyến: không đổi xe, giờ, trạng thái khi đã xuất bến (trừ báo đến bến, hủy xuất bến, mở / khóa)
create function app.trip_lock_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.departed_at is not null and old.edit_unlocked_at is null and new.departed_at is not null
     and (new.vehicle_id is distinct from old.vehicle_id or new.vehicle_type_id is distinct from old.vehicle_type_id
          or new.depart_at is distinct from old.depart_at or new.arrive_at is distinct from old.arrive_at
          or new.status is distinct from old.status or new.route_id is distinct from old.route_id) then
    raise exception 'Chuyến đã xuất bến: không sửa xe / giờ / trạng thái. Cần quản trị mở khóa' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger trips_lock before update on public.trips for each row execute function app.trip_lock_guard();

-- Tổ lái
create function app.crew_lock_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if app.trip_locked(coalesce(new.tenant_id, old.tenant_id), coalesce(new.trip_id, old.trip_id)) then
    raise exception 'Chuyến đã xuất bến: không đổi tổ lái. Cần quản trị mở khóa' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger trip_crew_lock before insert or update or delete on public.trip_crew
  for each row execute function app.crew_lock_guard();

revoke execute on function app.trip_locked(uuid, uuid), app.seat_lock_guard(), app.trip_lock_guard(), app.crew_lock_guard()
  from public, anon, authenticated;

-- Quản trị mở / khóa lại việc sửa chuyến đã xuất bến
create function public.set_trip_edit_lock(p_trip_id uuid, p_unlock boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('settings.manage') then
    raise exception 'Chỉ quản trị nhà xe mới mở khóa được' using errcode = '42501';
  end if;
  update public.trips
  set edit_unlocked_at = case when p_unlock then now() end,
      edit_unlocked_by = case when p_unlock then auth.uid() end
  where tenant_id = v_tid and id = p_trip_id and departed_at is not null;
  if not found then
    raise exception 'Không tìm thấy chuyến đã xuất bến' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.set_trip_edit_lock(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_trip_edit_lock(uuid, boolean) to authenticated;
