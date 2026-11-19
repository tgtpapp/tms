-- =====================================================================
-- Đánh dấu đã in vé (từng ghế) và đã in phơi (danh sách khách của chuyến) để các quầy khác biết.
-- =====================================================================
alter table public.seat_inventory add column printed_at timestamptz;
alter table public.seat_inventory add column print_count int not null default 0;
alter table public.trips add column manifest_printed_at timestamptz;
alter table public.trips add column manifest_printed_by uuid;

-- Đã in vé: không tính là sửa vé (chuyến đã xuất bến vẫn ghi nhận được)
create or replace function app.seat_lock_guard()
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
    continue when k in ('boarded', 'paid_at', 'paid_by', 'pay_method', 'hold_until', 'updated_at', 'status', 'printed_at', 'print_count');
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

create function public.mark_tickets_printed(p_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not (app.has_permission('ticket.sell') or app.has_permission('trip.manage')) then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  update public.seat_inventory set printed_at = now(), print_count = print_count + 1
  where tenant_id = v_tid and id = any (p_ids);
end;
$$;

create function public.mark_manifest_printed(p_trip_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not (app.has_permission('ticket.sell') or app.has_permission('trip.manage')) then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  update public.trips set manifest_printed_at = now(), manifest_printed_by = auth.uid() where tenant_id = v_tid and id = p_trip_id;
  if not found then raise exception 'Không tìm thấy chuyến' using errcode = 'P0002'; end if;
end;
$$;
revoke execute on function public.mark_tickets_printed(uuid[]), public.mark_manifest_printed(uuid) from public, anon, authenticated;
grant execute on function public.mark_tickets_printed(uuid[]), public.mark_manifest_printed(uuid) to authenticated;
