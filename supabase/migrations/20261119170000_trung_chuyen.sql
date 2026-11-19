-- =====================================================================
-- Giai đoạn 6.2 – Trung chuyển (đón / trả khách tận nơi)
-- - Vé đánh dấu cần đón tận nơi (tc_don) / trả tận nơi (tc_tra); địa chỉ = ghi chú điểm đón / trả của vé.
-- - Điều hành gom vé vào "lượt trung chuyển" theo ngày, giao cho người chạy trung chuyển (nhân viên có tài khoản).
-- - Người chạy trung chuyển xem danh sách, gọi khách, đánh dấu đã đón / đã trả.
-- =====================================================================

alter table public.seat_inventory add column tc_don boolean not null default false;
alter table public.seat_inventory add column tc_tra boolean not null default false;

create table public.transfer_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id),
  service_date  date not null,
  kind          text not null check (kind in ('don', 'tra')),
  staff_id      uuid,                          -- người chạy trung chuyển
  vehicle_note  text check (vehicle_note is null or length(vehicle_note) <= 100),   -- xe trung chuyển (biển số / ghi chú)
  start_time    time,
  note          text check (note is null or length(note) <= 500),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, staff_id) references public.staff_members (tenant_id, id)
);
create index transfer_runs_day_idx on public.transfer_runs (tenant_id, service_date);

create table public.transfer_items (
  tenant_id  uuid not null,
  run_id     uuid not null,
  ticket_id  uuid not null,
  kind       text not null check (kind in ('don', 'tra')),
  seq        int not null default 0,
  done_at    timestamptz,
  done_by    uuid,
  primary key (tenant_id, ticket_id, kind),   -- mỗi vé chỉ ở 1 lượt đón và 1 lượt trả
  foreign key (tenant_id, run_id) references public.transfer_runs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, ticket_id) references public.seat_inventory (tenant_id, id)
);
create index transfer_items_run_idx on public.transfer_items (tenant_id, run_id);

alter table public.transfer_runs enable row level security;
alter table public.transfer_items enable row level security;
revoke all on public.transfer_runs, public.transfer_items from anon, authenticated;
grant select on public.transfer_runs, public.transfer_items to authenticated;
grant select, insert, update, delete on public.transfer_runs, public.transfer_items to service_role;
create policy transfer_runs_select on public.transfer_runs for select to authenticated using (tenant_id = app.current_tenant_id());
create policy transfer_items_select on public.transfer_items for select to authenticated using (tenant_id = app.current_tenant_id());
create trigger transfer_runs_audit after insert or update or delete on public.transfer_runs for each row execute function app.write_audit();

-- Người đang đăng nhập có phải người chạy lượt này
create function app.is_my_run(p_run uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.transfer_runs r join public.staff_members m on m.tenant_id = r.tenant_id and m.id = r.staff_id
                 where r.tenant_id = app.current_tenant_id() and r.id = p_run and m.user_id = auth.uid())
$$;
revoke execute on function app.is_my_run(uuid) from public, anon;
grant execute on function app.is_my_run(uuid) to authenticated;

-- Đánh dấu vé cần đón / trả tận nơi
create function public.set_ticket_transfer(p_ticket_id uuid, p_don boolean, p_tra boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not (app.has_permission('ticket.sell') or app.has_permission('trip.manage')) then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  update public.seat_inventory set tc_don = coalesce(p_don, false), tc_tra = coalesce(p_tra, false)
  where id = p_ticket_id and tenant_id = v_tid and status in ('giu', 'dat', 'da_tt', 'cho_xep');
  if not found then
    raise exception 'Không tìm thấy vé' using errcode = 'P0002';
  end if;
  -- bỏ đánh dấu thì rút khỏi lượt trung chuyển chưa làm
  delete from public.transfer_items where tenant_id = v_tid and ticket_id = p_ticket_id and done_at is null
    and ((kind = 'don' and not coalesce(p_don, false)) or (kind = 'tra' and not coalesce(p_tra, false)));
end;
$$;

-- Tạo / sửa lượt trung chuyển và danh sách vé (thứ tự = thứ tự đón / trả)
create function public.save_transfer_run(p_id uuid, p_date date, p_kind text, p_staff_id uuid, p_vehicle_note text,
                                         p_start time, p_note text, p_ticket_ids uuid[])
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid := p_id;
  v_bad int;
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  if p_kind not in ('don', 'tra') or p_date is null then
    raise exception 'Chọn ngày và loại lượt (đón / trả)' using errcode = '22023';
  end if;
  if p_staff_id is not null and not exists (select 1 from public.staff_members where id = p_staff_id and tenant_id = v_tid and is_active) then
    raise exception 'Không tìm thấy người chạy trung chuyển' using errcode = 'P0002';
  end if;
  select count(*) into v_bad
  from unnest(coalesce(p_ticket_ids, '{}')) x(id)
  where not exists (select 1 from public.seat_inventory s join public.trips t on t.tenant_id = s.tenant_id and t.id = s.trip_id
                    where s.tenant_id = v_tid and s.id = x.id and s.status in ('dat', 'da_tt', 'cho_xep') and t.service_date = p_date
                      and ((p_kind = 'don' and s.tc_don) or (p_kind = 'tra' and s.tc_tra)));
  if v_bad > 0 then
    raise exception 'Có % vé không cần trung chuyển % trong ngày này', v_bad, case p_kind when 'don' then 'đón' else 'trả' end using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.transfer_runs (tenant_id, service_date, kind, staff_id, vehicle_note, start_time, note, created_by)
    values (v_tid, p_date, p_kind, p_staff_id, nullif(trim(p_vehicle_note), ''), p_start, nullif(trim(p_note), ''), auth.uid())
    returning id into v_id;
  else
    update public.transfer_runs set staff_id = p_staff_id, vehicle_note = nullif(trim(p_vehicle_note), ''), start_time = p_start,
           note = nullif(trim(p_note), '')
    where id = v_id and tenant_id = v_tid and kind = p_kind and service_date = p_date;
    if not found then
      raise exception 'Không tìm thấy lượt trung chuyển' using errcode = 'P0002';
    end if;
  end if;
  delete from public.transfer_items where tenant_id = v_tid and run_id = v_id and done_at is null
    and not (ticket_id = any (coalesce(p_ticket_ids, '{}')));
  insert into public.transfer_items (tenant_id, run_id, ticket_id, kind, seq)
  select v_tid, v_id, x.id, p_kind, x.ord from unnest(coalesce(p_ticket_ids, '{}')) with ordinality x(id, ord)
  on conflict (tenant_id, ticket_id, kind) do update set run_id = excluded.run_id, seq = excluded.seq
    where public.transfer_items.done_at is null;
  return v_id;
end;
$$;

create function public.delete_transfer_run(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  if exists (select 1 from public.transfer_items where tenant_id = v_tid and run_id = p_id and done_at is not null) then
    raise exception 'Lượt đã có khách được đón / trả, không xóa được' using errcode = '22023';
  end if;
  delete from public.transfer_runs where id = p_id and tenant_id = v_tid;
  if not found then
    raise exception 'Không tìm thấy lượt trung chuyển' using errcode = 'P0002';
  end if;
end;
$$;

-- Đánh dấu đã đón / đã trả (người chạy lượt hoặc điều hành)
create function public.transfer_done(p_run_id uuid, p_ticket_id uuid, p_done boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not (app.is_my_run(p_run_id) or app.has_permission('trip.manage')) then
    raise exception 'Không tìm thấy lượt trung chuyển' using errcode = 'P0002';
  end if;
  update public.transfer_items set done_at = case when p_done then now() end, done_by = case when p_done then auth.uid() end
  where tenant_id = v_tid and run_id = p_run_id and ticket_id = p_ticket_id;
  if not found then
    raise exception 'Không tìm thấy khách trong lượt' using errcode = 'P0002';
  end if;
end;
$$;

-- Lượt trung chuyển của tôi
create function public.my_transfer_runs(p_date date)
returns setof public.transfer_runs
language sql stable security definer set search_path = ''
as $$
  select r.* from public.transfer_runs r join public.staff_members m on m.tenant_id = r.tenant_id and m.id = r.staff_id
  where r.tenant_id = app.current_tenant_id() and m.user_id = auth.uid() and r.service_date = coalesce(p_date, app.local_today())
  order by r.start_time nulls last, r.created_at
$$;

revoke execute on function public.set_ticket_transfer(uuid, boolean, boolean), public.save_transfer_run(uuid, date, text, uuid, text, time, text, uuid[]),
  public.delete_transfer_run(uuid), public.transfer_done(uuid, uuid, boolean), public.my_transfer_runs(date) from public, anon, authenticated;
grant execute on function public.set_ticket_transfer(uuid, boolean, boolean), public.save_transfer_run(uuid, date, text, uuid, text, time, text, uuid[]),
  public.delete_transfer_run(uuid), public.transfer_done(uuid, uuid, boolean), public.my_transfer_runs(date) to authenticated;
