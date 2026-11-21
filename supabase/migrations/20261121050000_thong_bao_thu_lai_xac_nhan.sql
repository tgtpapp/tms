-- =====================================================================
-- Thông báo: thử lại khi gửi lỗi, chống trùng, giới hạn, nhật ký gửi; máy chủ tự gửi mỗi phút; mở / xác nhận đã nhận.
-- Trạng thái tách riêng, không đánh đồng: gửi đi (delivered_at = máy chủ thông báo đã nhận) ≠ đọc (read_at, thấy trong danh sách)
-- ≠ mở (opened_at, xem chi tiết) ≠ xác nhận (acked_at, bấm "Đã nhận").
-- =====================================================================
alter table public.notifications
  add column priority     text not null default 'thuong' check (priority in ('thuong', 'quan_trong', 'khan_cap')),
  add column ack_required boolean not null default false,
  add column opened_at    timestamptz,
  add column acked_at     timestamptz,
  add column attempts     int not null default 0,
  add column next_try_at  timestamptz not null default now(),
  add column claimed_at   timestamptz,
  add column delivered_at timestamptz,
  add column last_error   text;
alter table public.notifications drop constraint notifications_push_state_check;
-- cho: chờ gửi · dang_gui · da_gui · loi: lỗi tạm, chờ thử lại · that_bai: hết lượt thử · khong_may: người nhận chưa bật trên máy nào
-- bo: không gửi đẩy (quá giới hạn / tin cũ), vẫn xem trong app
alter table public.notifications add constraint notifications_push_state_check
  check (push_state in ('cho', 'dang_gui', 'da_gui', 'loi', 'that_bai', 'khong_may', 'bo'));
drop index public.notifications_push_idx;
create index notifications_push_idx on public.notifications (next_try_at) where push_state in ('cho', 'loi', 'dang_gui');

-- Nhật ký từng lần gửi tới từng máy (chỉ máy chủ ghi / đọc)
create table public.notification_delivery_logs (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references public.tenants (id),
  notification_id uuid not null,
  subscription_id uuid,
  attempt         int not null,
  result          text not null check (result in ('ok', 'loi', 'het_han', 'khong_may')),
  http_code       int,
  error           text,
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, notification_id) references public.notifications (tenant_id, id) on delete cascade
);
create index notification_delivery_logs_idx on public.notification_delivery_logs (tenant_id, notification_id);
alter table public.notification_delivery_logs enable row level security;
revoke all on public.notification_delivery_logs from public, anon, authenticated;
grant select, insert, delete on public.notification_delivery_logs to service_role;

-- Cấu hình gửi định kỳ: mã bí mật cho lịch chạy mỗi phút gọi Edge Function, địa chỉ hàm (CI ghi lúc triển khai)
alter table public.push_config alter column public_key drop not null, alter column private_key drop not null,
  add column cron_secret text, add column fn_url text;
grant update on public.push_config to service_role;
insert into public.push_config (id, cron_secret) values (1, encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (id) do update set cron_secret = coalesce(public.push_config.cron_secret, excluded.cron_secret);

create function app.set_push_url(p_url text)
returns void
language sql security definer set search_path = ''
as $$ update public.push_config set fn_url = p_url where id = 1 $$;
revoke execute on function app.set_push_url(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- Tạo thông báo: chống trùng, giao nhiệm vụ cần xác nhận
create or replace function app.notify_user(p_tid uuid, p_user uuid, p_kind text, p_title text, p_body text, p_trip uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_user is null or p_user is not distinct from auth.uid() then return; end if;
  if exists (select 1 from public.notify_prefs n where n.tenant_id = p_tid and n.user_id = p_user and p_kind = any (n.off_kinds)) then return; end if;
  -- cùng nội dung, cùng người, cùng chuyến trong 2 phút: chỉ báo 1 lần
  if exists (select 1 from public.notifications n where n.tenant_id = p_tid and n.user_id = p_user and n.kind = p_kind
             and n.trip_id is not distinct from p_trip and n.body = left(p_body, 300) and n.title = left(p_title, 120)
             and n.created_at > now() - interval '2 minutes') then return; end if;
  insert into public.notifications (tenant_id, user_id, kind, title, body, trip_id, ack_required)
  values (p_tid, p_user, p_kind, left(p_title, 120), left(p_body, 300), p_trip, p_kind = 'xep_chuyen' and p_title like 'Được xếp%');
end;
$$;

-- ---------------------------------------------------------------- Người nhận: mở, xác nhận
create function public.open_notification(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.notifications set opened_at = coalesce(opened_at, now()), read_at = coalesce(read_at, now())
  where tenant_id = app.current_tenant_id() and id = p_id and user_id = auth.uid();
  if not found then raise exception 'Không tìm thấy thông báo' using errcode = 'P0002'; end if;
end;
$$;
create function public.ack_notification(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.notifications set acked_at = coalesce(acked_at, now()), opened_at = coalesce(opened_at, now()), read_at = coalesce(read_at, now())
  where tenant_id = app.current_tenant_id() and id = p_id and user_id = auth.uid();
  if not found then raise exception 'Không tìm thấy thông báo' using errcode = 'P0002'; end if;
end;
$$;
revoke execute on function public.open_notification(uuid), public.ack_notification(uuid) from public, anon, authenticated;
grant execute on function public.open_notification(uuid), public.ack_notification(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- Máy chủ gửi: nhận việc, ghi kết quả
/** Nhận tối đa p_limit tin cần gửi (của 1 nhà xe, hoặc mọi nhà xe khi p_tenant null). Tin quá giới hạn / quá cũ chuyển "bo". */
create function public.svc_push_claim(p_tenant uuid, p_limit int)
returns table (id uuid, tenant_id uuid, user_id uuid, title text, body text, priority text, attempt int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  -- tin chờ quá 6 giờ (vd chưa có máy nhận lúc đó) thì thôi gửi đẩy, vẫn xem trong app
  update public.notifications n set push_state = 'bo'
  where n.push_state in ('cho', 'loi') and n.created_at < now() - interval '6 hours' and (p_tenant is null or n.tenant_id = p_tenant);
  -- giới hạn: mỗi người tối đa 20 tin đẩy trong 10 phút, quá thì chỉ hiện trong app
  update public.notifications n set push_state = 'bo', last_error = 'Quá giới hạn 20 tin / 10 phút'
  where n.push_state = 'cho' and (p_tenant is null or n.tenant_id = p_tenant)
    and (select count(*) from public.notifications x where x.tenant_id = n.tenant_id and x.user_id = n.user_id and x.delivered_at > now() - interval '10 minutes') >= 20;
  return query
  update public.notifications n set push_state = 'dang_gui', claimed_at = now(), attempts = n.attempts + 1
  where n.id in (select x.id from public.notifications x
                 where (p_tenant is null or x.tenant_id = p_tenant)
                   and ((x.push_state in ('cho', 'loi') and x.next_try_at <= now())
                        or (x.push_state = 'dang_gui' and x.claimed_at < now() - interval '5 minutes'))
                 order by x.created_at limit greatest(1, least(coalesce(p_limit, 100), 500))
                 for update skip locked)
  returning n.id, n.tenant_id, n.user_id, n.title, n.body, n.priority, n.attempts;
end;
$$;

/** Kết quả gửi 1 tin: ok (ít nhất 1 máy nhận) / khong_may / loi (thử lại sau 1, 5, 15 phút; quá 4 lần thì thất bại) */
create function public.svc_push_result(p_id uuid, p_result text, p_error text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.notifications n set
    push_state = case p_result when 'ok' then 'da_gui' when 'khong_may' then 'khong_may'
                               else case when n.attempts >= 4 then 'that_bai' else 'loi' end end,
    delivered_at = case when p_result = 'ok' then now() else n.delivered_at end,
    next_try_at = now() + case n.attempts when 1 then interval '1 minute' when 2 then interval '5 minutes' else interval '15 minutes' end,
    last_error = case when p_result = 'ok' then null else left(p_error, 300) end,
    claimed_at = null
  where n.id = p_id;
end;
$$;
revoke execute on function public.svc_push_claim(uuid, int), public.svc_push_result(uuid, text, text) from public, anon, authenticated;
grant execute on function public.svc_push_claim(uuid, int), public.svc_push_result(uuid, text, text) to service_role;

-- ---------------------------------------------------------------- Mỗi phút: có tin chờ thì gọi Edge Function gửi (không cần ai mở app)
create function app.svc_push_tick()
returns void
language plpgsql security definer set search_path = ''
as $$
declare c record;
begin
  select fn_url, cron_secret into c from public.push_config where id = 1;
  if c.fn_url is null or c.cron_secret is null then return; end if;
  if not exists (select 1 from public.notifications where push_state in ('cho', 'loi', 'dang_gui') and next_try_at <= now()) then return; end if;
  perform net.http_post(url := c.fn_url, body := jsonb_build_object('action', 'cron', 'secret', c.cron_secret),
                        headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 55000);
end;
$$;
revoke execute on function app.svc_push_tick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') and exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_net;
    create extension if not exists pg_cron;
    perform cron.schedule('gui-thong-bao', '* * * * *', 'select app.svc_push_tick()');
  else
    raise notice 'Máy chủ không có pg_net / pg_cron: thông báo chỉ gửi khi có người thao tác trong app';
  end if;
exception when others then
  raise notice 'Không bật được gửi thông báo định kỳ (%)', sqlerrm;
end;
$$;
