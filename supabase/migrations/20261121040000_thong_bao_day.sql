-- =====================================================================
-- Thông báo trong app (chuông) + thông báo đẩy lên điện thoại / máy tính (Web Push, kể cả khi đóng app).
-- - Lái xe / phụ xe: chuyến HÔM NAY của mình có khách đặt thêm, hủy vé, chuyển vé, nhả chỗ hết hạn;
--   được xếp / bỏ khỏi chuyến hôm nay hoặc ngày mai.
-- - Người bán vé: lái xe báo khách thuê bao / khách báo hủy với vé mình bán.
-- - Mỗi người chỉ đọc thông báo của chính mình. Cài đặt nhận (bật / tắt từng loại) trong Tài khoản của tôi.
-- - Gửi đẩy: Edge Function "push" (khóa VAPID tự sinh, chỉ service_role đọc).
-- =====================================================================

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id),
  user_id     uuid not null,
  kind        text not null check (kind in ('khach', 'xep_chuyen', 'lai_xe_bao')),
  title       text not null,
  body        text not null,
  trip_id     uuid,
  push_state  text not null default 'cho' check (push_state in ('cho', 'da_gui', 'bo')),
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id)
);
create index notifications_user_idx on public.notifications (tenant_id, user_id, created_at desc);
create index notifications_push_idx on public.notifications (tenant_id, push_state) where push_state = 'cho';
alter table public.notifications enable row level security;
revoke all on public.notifications from public, anon, authenticated;
grant select on public.notifications to authenticated;
grant select, insert, update, delete on public.notifications to service_role;
create policy notifications_select_mine on public.notifications for select to authenticated
  using (tenant_id = app.current_tenant_id() and user_id = auth.uid());

-- Máy đã bật nhận thông báo đẩy của từng người
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id),
  user_id     uuid not null,
  endpoint    text not null unique check (endpoint ~ '^https://'),
  p256dh      text not null,
  auth        text not null,
  device      text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id)
);
create index push_subscriptions_user_idx on public.push_subscriptions (tenant_id, user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select on public.push_subscriptions to authenticated;
grant select, insert, update, delete on public.push_subscriptions to service_role;
create policy push_subscriptions_select_mine on public.push_subscriptions for select to authenticated
  using (tenant_id = app.current_tenant_id() and user_id = auth.uid());

-- Cài đặt nhận của từng người (loại tắt thì không tạo thông báo)
create table public.notify_prefs (
  tenant_id   uuid not null references public.tenants (id),
  user_id     uuid not null,
  off_kinds   text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
alter table public.notify_prefs enable row level security;
revoke all on public.notify_prefs from public, anon, authenticated;
grant select on public.notify_prefs to authenticated;
grant select, insert, update, delete on public.notify_prefs to service_role;
create policy notify_prefs_select_mine on public.notify_prefs for select to authenticated
  using (tenant_id = app.current_tenant_id() and user_id = auth.uid());

-- Khóa VAPID của nền tảng (Edge Function tự sinh lần đầu). Chỉ service_role.
create table public.push_config (
  id          int primary key default 1 check (id = 1),
  public_key  text not null,
  private_key text not null,
  created_at  timestamptz not null default now()
);
alter table public.push_config enable row level security;
revoke all on public.push_config from public, anon, authenticated;
grant select, insert on public.push_config to service_role;

-- ---------------------------------------------------------------- RPC của người dùng
create function public.mark_notifications_read()
returns void
language sql security definer set search_path = ''
as $$
  update public.notifications set read_at = now()
  where tenant_id = app.current_tenant_id() and user_id = auth.uid() and read_at is null
$$;

create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_device text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or auth.uid() is null then raise exception 'Chưa đăng nhập' using errcode = '42501'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Đăng ký thông báo không hợp lệ' using errcode = '22023';
  end if;
  insert into public.push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth, device)
  values (v_tid, auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_device, 120))
  on conflict (endpoint) do update set tenant_id = excluded.tenant_id, user_id = excluded.user_id, p256dh = excluded.p256dh,
    auth = excluded.auth, device = excluded.device, created_at = now();
end;
$$;

create function public.remove_push_subscription(p_endpoint text)
returns void
language sql security definer set search_path = ''
as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid() and tenant_id = app.current_tenant_id()
$$;

create function public.set_notify_prefs(p_off text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or auth.uid() is null then raise exception 'Chưa đăng nhập' using errcode = '42501'; end if;
  insert into public.notify_prefs (tenant_id, user_id, off_kinds, updated_at)
  values (v_tid, auth.uid(), array(select x from unnest(coalesce(p_off, '{}')) x where x in ('khach', 'xep_chuyen', 'lai_xe_bao')), now())
  on conflict (tenant_id, user_id) do update set off_kinds = excluded.off_kinds, updated_at = now();
end;
$$;

revoke execute on function public.mark_notifications_read(), public.save_push_subscription(text, text, text, text),
  public.remove_push_subscription(text), public.set_notify_prefs(text[]) from public, anon, authenticated;
grant execute on function public.mark_notifications_read(), public.save_push_subscription(text, text, text, text),
  public.remove_push_subscription(text), public.set_notify_prefs(text[]) to authenticated, service_role;

-- ---------------------------------------------------------------- Tạo thông báo
/** "09:00 · Biên Hòa - Vũng Tàu" */
create function app.trip_label(p_tid uuid, p_trip uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select to_char(t.depart_at at time zone app.tenant_tz(t.tenant_id), 'HH24:MI') || ' · ' ||
         case when t.direction = 'di' then r.name
              else coalesce(nullif(trim(r.name_ve), ''),
                            (select string_agg(p, ' - ' order by o desc) from regexp_split_to_table(r.name, '\s+[-–]\s+') with ordinality x(p, o))) end
  from public.trips t join public.routes r on r.tenant_id = t.tenant_id and r.id = t.route_id
  where t.tenant_id = p_tid and t.id = p_trip
$$;
revoke execute on function app.trip_label(uuid, uuid) from public, anon, authenticated;

/** Gửi 1 thông báo cho 1 người (bỏ qua nếu người đó tắt loại này hoặc chính họ là người thao tác) */
create function app.notify_user(p_tid uuid, p_user uuid, p_kind text, p_title text, p_body text, p_trip uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_user is null or p_user is not distinct from auth.uid() then return; end if;
  if exists (select 1 from public.notify_prefs n where n.tenant_id = p_tid and n.user_id = p_user and p_kind = any (n.off_kinds)) then return; end if;
  insert into public.notifications (tenant_id, user_id, kind, title, body, trip_id) values (p_tid, p_user, p_kind, left(p_title, 120), left(p_body, 300), p_trip);
end;
$$;
revoke execute on function app.notify_user(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;

/** Báo cho tổ lái (có tài khoản) của 1 chuyến */
create function app.notify_crew(p_tid uuid, p_trip uuid, p_body text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare u uuid; v_title text := 'Chuyến ' || coalesce(app.trip_label(p_tid, p_trip), '');
begin
  for u in select distinct m.user_id from public.trip_crew c
           join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id
           where c.tenant_id = p_tid and c.trip_id = p_trip and c.active and m.user_id is not null
  loop
    perform app.notify_user(p_tid, u, 'khach', v_title, p_body, p_trip);
  end loop;
end;
$$;
revoke execute on function app.notify_crew(uuid, uuid, text) from public, anon, authenticated;

/** Chỉ chuyến hôm nay (giờ của nhà xe) và còn chạy */
create function app.trip_today(p_tid uuid, p_trip uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.trips t where t.tenant_id = p_tid and t.id = p_trip and t.status = 'mo'
                 and t.service_date = (now() at time zone app.tenant_tz(p_tid))::date)
$$;
revoke execute on function app.trip_today(uuid, uuid) from public, anon, authenticated;

-- Khách đặt thêm (vé mới hoặc giữ chỗ → đặt / đã thanh toán)
create function app.notify_seats_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare r record;
begin
  for r in select n.tenant_id, n.trip_id, coalesce(nullif(n.passenger_phone, ''), b.customer_phone, '') phone, count(*) k
           from new_rows n left join public.bookings b on b.tenant_id = n.tenant_id and b.id = n.booking_id
           where n.status in ('dat', 'da_tt')
           group by 1, 2, 3
  loop
    if app.trip_today(r.tenant_id, r.trip_id) then
      perform app.notify_crew(r.tenant_id, r.trip_id, format('Thêm %s khách %s', r.k, nullif(r.phone, '')));
    end if;
  end loop;
  return null;
end;
$$;

create function app.notify_seats_update()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare r record;
begin
  -- khách mới (giữ chỗ → đặt / đã thanh toán)
  for r in select n.tenant_id, n.trip_id, coalesce(nullif(n.passenger_phone, ''), b.customer_phone, '') phone, count(*) k
           from new_rows n join old_rows o on o.id = n.id
           left join public.bookings b on b.tenant_id = n.tenant_id and b.id = n.booking_id
           where n.status in ('dat', 'da_tt') and o.status not in ('dat', 'da_tt') and n.trip_id = o.trip_id
           group by 1, 2, 3
  loop
    if app.trip_today(r.tenant_id, r.trip_id) then
      perform app.notify_crew(r.tenant_id, r.trip_id, format('Thêm %s khách %s', r.k, nullif(r.phone, '')));
    end if;
  end loop;
  -- hủy vé / hết hạn giữ chỗ
  for r in select n.tenant_id, n.trip_id, n.status, coalesce(nullif(n.passenger_phone, ''), b.customer_phone, '') phone, count(*) k
           from new_rows n join old_rows o on o.id = n.id
           left join public.bookings b on b.tenant_id = n.tenant_id and b.id = n.booking_id
           where o.status in ('dat', 'da_tt') and n.status in ('huy', 'het_han') and n.trip_id = o.trip_id
           group by 1, 2, 3, 4
  loop
    if app.trip_today(r.tenant_id, r.trip_id) then
      perform app.notify_crew(r.tenant_id, r.trip_id,
        format('Khách %s %s (%s ghế)', coalesce(nullif(r.phone, ''), 'không SĐT'), case when r.status = 'huy' then 'hủy vé' else 'hết hạn giữ chỗ, đã nhả' end, r.k));
    end if;
  end loop;
  -- chuyển vé sang chuyến khác
  for r in select n.tenant_id, o.trip_id old_trip, n.trip_id new_trip, coalesce(nullif(n.passenger_phone, ''), b.customer_phone, '') phone, count(*) k
           from new_rows n join old_rows o on o.id = n.id
           left join public.bookings b on b.tenant_id = n.tenant_id and b.id = n.booking_id
           where n.trip_id <> o.trip_id and n.status in ('dat', 'da_tt')
           group by 1, 2, 3, 4
  loop
    if app.trip_today(r.tenant_id, r.old_trip) then
      perform app.notify_crew(r.tenant_id, r.old_trip, format('Khách %s chuyển sang chuyến %s', coalesce(nullif(r.phone, ''), 'không SĐT'),
        coalesce(split_part(app.trip_label(r.tenant_id, r.new_trip), ' · ', 1), '?')));
    end if;
    if app.trip_today(r.tenant_id, r.new_trip) then
      perform app.notify_crew(r.tenant_id, r.new_trip, format('Thêm %s khách %s (chuyển từ chuyến %s)', r.k, coalesce(nullif(r.phone, ''), ''),
        coalesce(split_part(app.trip_label(r.tenant_id, r.old_trip), ' · ', 1), '?')));
    end if;
  end loop;
  -- lái xe báo khách thuê bao / khách báo hủy → người bán vé đó
  for r in select n.tenant_id, n.trip_id, n.crew_call, b.created_by, coalesce(nullif(n.passenger_phone, ''), b.customer_phone, '') phone
           from new_rows n join old_rows o on o.id = n.id
           join public.bookings b on b.tenant_id = n.tenant_id and b.id = n.booking_id
           where n.crew_call in ('thue_bao', 'bao_huy') and o.crew_call is distinct from n.crew_call
           group by 1, 2, 3, 4, 5
  loop
    perform app.notify_user(r.tenant_id, r.created_by, 'lai_xe_bao', 'Lái xe báo · chuyến ' || coalesce(app.trip_label(r.tenant_id, r.trip_id), ''),
      format('Khách %s %s', coalesce(nullif(r.phone, ''), 'không SĐT'), case when r.crew_call = 'thue_bao' then 'thuê bao / không nghe máy' else 'báo hủy, cần xử lý vé' end),
      r.trip_id);
  end loop;
  return null;
end;
$$;
revoke execute on function app.notify_seats_insert(), app.notify_seats_update() from public, anon, authenticated;
create trigger seat_inventory_notify_ins after insert on public.seat_inventory
  referencing new table as new_rows for each statement execute function app.notify_seats_insert();
create trigger seat_inventory_notify_upd after update on public.seat_inventory
  referencing old table as old_rows new table as new_rows for each statement execute function app.notify_seats_update();

-- Được xếp / bỏ khỏi chuyến hôm nay hoặc ngày mai (xếp xe xóa rồi ghi lại tổ lái: kiểm tra lúc kết thúc giao dịch)
create function app.notify_crew_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare r record; v_user uuid; v_day date; v_today date; v_still boolean; v_plate text;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  select m.user_id into v_user from public.staff_members m where m.tenant_id = r.tenant_id and m.id = r.staff_id;
  if v_user is null then return null; end if;
  select t.service_date, v.plate into v_day, v_plate from public.trips t left join public.vehicles v on v.tenant_id = t.tenant_id and v.id = t.vehicle_id
  where t.tenant_id = r.tenant_id and t.id = r.trip_id and t.status = 'mo';
  v_today := (now() at time zone app.tenant_tz(r.tenant_id))::date;
  if v_day is null or v_day not between v_today and v_today + 1 then return null; end if;
  select exists (select 1 from public.trip_crew c where c.tenant_id = r.tenant_id and c.trip_id = r.trip_id and c.staff_id = r.staff_id and c.active) into v_still;
  if v_still and not exists (select 1 from public.notifications n where n.tenant_id = r.tenant_id and n.user_id = v_user and n.trip_id = r.trip_id
                              and n.kind = 'xep_chuyen' and n.title like 'Được xếp%' and n.created_at > now() - interval '12 hours') then
    perform app.notify_user(r.tenant_id, v_user, 'xep_chuyen', 'Được xếp chuyến ' || coalesce(app.trip_label(r.tenant_id, r.trip_id), ''),
      format('%s%s', case when v_day = v_today then 'Hôm nay' else 'Ngày mai ' || to_char(v_day, 'DD/MM') end, coalesce(' · xe ' || v_plate, '')), r.trip_id);
  elsif not v_still and exists (select 1 from public.notifications n where n.tenant_id = r.tenant_id and n.user_id = v_user and n.trip_id = r.trip_id
                                  and n.kind = 'xep_chuyen' and n.title like 'Được xếp%') then
    perform app.notify_user(r.tenant_id, v_user, 'xep_chuyen', 'Bỏ khỏi chuyến ' || coalesce(app.trip_label(r.tenant_id, r.trip_id), ''),
      case when v_day = v_today then 'Hôm nay' else 'Ngày mai ' || to_char(v_day, 'DD/MM') end, r.trip_id);
  end if;
  return null;
end;
$$;
revoke execute on function app.notify_crew_change() from public, anon, authenticated;
create constraint trigger trip_crew_notify after insert or update or delete on public.trip_crew
  deferrable initially deferred for each row execute function app.notify_crew_change();
