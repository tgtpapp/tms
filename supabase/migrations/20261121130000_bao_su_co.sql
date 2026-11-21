-- =====================================================================
-- Báo sự cố (bước 1): nhân viên nhắn sự cố trong app hoặc ngay ở màn hình đăng nhập.
-- - Nhà xe xác định từ phiên đăng nhập (app.current_tenant_id()), không từ nội dung người gửi.
-- - Màn hình đăng nhập (chưa xác minh): chỉ qua Edge Function "support" (service_role), giới hạn số lần theo máy / nhà xe;
--   không gắn vào tài khoản nào, chỉ ghi số điện thoại người gửi tự khai.
-- - Người xem / trả lời: người gửi + người có quyền Người dùng: Sửa (user.edit) của chính nhà xe đó.
-- =====================================================================
-- loại thông báo mới: sự cố
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in ('khach', 'xep_chuyen', 'lai_xe_bao', 'su_co'));
do $$ begin
  execute replace(pg_get_functiondef('public.set_notify_prefs(text[])'::regprocedure),
                  'x in (''khach'', ''xep_chuyen'', ''lai_xe_bao'')', 'x in (''khach'', ''xep_chuyen'', ''lai_xe_bao'', ''su_co'')');
end $$;

create table public.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id),
  no              int not null,
  channel         text not null check (channel in ('app', 'login')),
  status          text not null default 'mo' check (status in ('mo', 'dong')),
  created_by      uuid,
  reporter_name   text check (length(reporter_name) <= 120),
  reporter_phone  text check (reporter_phone ~ '^0[0-9]{9}$'),
  summary         text not null check (length(summary) between 1 and 300),
  context         jsonb not null default '{}'::jsonb check (length(context::text) <= 8000),
  ip_hash         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  closed_at       timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, no),
  foreign key (tenant_id, created_by) references public.app_users (tenant_id, id) on delete set null (created_by)
);
create index support_tickets_list_idx on public.support_tickets (tenant_id, status, updated_at desc);
create index support_tickets_user_idx on public.support_tickets (tenant_id, created_by, created_at desc);
create index support_tickets_ip_idx on public.support_tickets (tenant_id, ip_hash, created_at) where ip_hash is not null;

create table public.support_messages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id),
  ticket_id   uuid not null,
  sender      text not null check (sender in ('nguoi_bao', 'xu_ly', 'bot')),
  user_id     uuid,
  body        text not null check (length(body) between 1 and 2000),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, ticket_id) references public.support_tickets (tenant_id, id) on delete cascade
);
create index support_messages_ticket_idx on public.support_messages (tenant_id, ticket_id, created_at);

alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
revoke all on public.support_tickets, public.support_messages from public, anon, authenticated;
-- mã băm địa chỉ máy (chống gửi dồn) không cho trình duyệt đọc
grant select (id, tenant_id, no, channel, status, created_by, reporter_name, reporter_phone, summary, context, created_at, updated_at, closed_at)
  on public.support_tickets to authenticated;
grant select on public.support_messages to authenticated;
grant select, insert, update, delete on public.support_tickets, public.support_messages to service_role;

/** Người đang đăng nhập được xử lý sự cố của nhà xe mình */
create function app.support_can_handle()
returns boolean
language sql stable security definer set search_path = ''
as $$ select app.has_permission('user.edit') $$;
revoke execute on function app.support_can_handle() from public, anon, authenticated;
grant execute on function app.support_can_handle() to authenticated, service_role;

create policy support_tickets_select on public.support_tickets for select to authenticated
  using (tenant_id = app.current_tenant_id() and (created_by = auth.uid() or app.support_can_handle()));
create policy support_messages_select on public.support_messages for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and exists (select 1 from public.support_tickets t where t.tenant_id = support_messages.tenant_id and t.id = support_messages.ticket_id
                     and (t.created_by = auth.uid() or app.support_can_handle())));

/** Chỉ giữ các mục thông tin máy cần cho việc kiểm tra, cắt ngắn */
create function app.support_clean_context(p jsonb)
returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'screen', left(p ->> 'screen', 80),
    'path', left(p ->> 'path', 200),
    'ua', left(p ->> 'ua', 300),
    'online', case when jsonb_typeof(p -> 'online') = 'boolean' then p -> 'online' end,
    'at', left(p ->> 'at', 40),
    'errors', (select jsonb_agg(left(e, 500)) from (
                 select e from jsonb_array_elements_text(case when jsonb_typeof(p -> 'errors') = 'array' then p -> 'errors' else '[]'::jsonb end) with ordinality x(e, i)
                 order by i desc limit 10) s)))
$$;
revoke execute on function app.support_clean_context(jsonb) from public, anon, authenticated;

/** Người xử lý sự cố của nhà xe (quyền Người dùng: Sửa, toàn nhà xe, tài khoản đang dùng, không bị tước quyền riêng) */
create function app.support_handlers(p_tenant uuid)
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select distinct ur.user_id from public.user_roles ur
  join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
  join public.app_users u on u.tenant_id = ur.tenant_id and u.id = ur.user_id and u.status = 'active'
  where ur.tenant_id = p_tenant and ur.scope_type = 'tenant' and rp.permission_code = 'user.edit'
    and not exists (select 1 from public.user_permission_denies d where d.tenant_id = ur.tenant_id and d.user_id = ur.user_id and d.permission_code = 'user.edit')
$$;
revoke execute on function app.support_handlers(uuid) from public, anon, authenticated;

/** Tạo phiếu sự cố + tin đầu + lời máy báo đã nhận + báo người xử lý */
create function app.support_create(p_tenant uuid, p_channel text, p_user uuid, p_name text, p_phone text, p_text text, p_context jsonb, p_ip text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_no int; v_id uuid; v_txt text := trim(p_text); h uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('support:' || p_tenant::text, 0));
  select coalesce(max(no), 0) + 1 into v_no from public.support_tickets where tenant_id = p_tenant;
  insert into public.support_tickets (tenant_id, no, channel, created_by, reporter_name, reporter_phone, summary, context, ip_hash)
  values (p_tenant, v_no, p_channel, p_user, left(p_name, 120), p_phone, left(v_txt, 300), app.support_clean_context(coalesce(p_context, '{}'::jsonb)), p_ip)
  returning id into v_id;
  insert into public.support_messages (tenant_id, ticket_id, sender, user_id, body) values (p_tenant, v_id, 'nguoi_bao', p_user, left(v_txt, 2000));
  insert into public.support_messages (tenant_id, ticket_id, sender, body) values (p_tenant, v_id, 'bot',
    'Đã nhận sự cố #' || v_no || '. Đã báo người quản lý tài khoản của nhà xe' ||
    case when p_channel = 'login' then '. Người gửi từ màn hình đăng nhập, chưa xác minh.' else '; trả lời sẽ hiện ở đây.' end);
  for h in select app.support_handlers(p_tenant) loop
    if h is distinct from p_user then
      perform app.notify_user(p_tenant, h, 'su_co', 'Sự cố #' || v_no,
        coalesce(p_name, p_phone, 'Người dùng') || case when p_channel = 'login' then ' (màn hình đăng nhập)' else '' end || ': ' || left(v_txt, 200), null);
    end if;
  end loop;
  return v_id;
end;
$$;
revoke execute on function app.support_create(uuid, text, uuid, text, text, text, jsonb, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- Trong app (đã đăng nhập)
create function public.support_open(p_text text, p_context jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); v_me uuid := auth.uid(); v_id uuid; u record;
begin
  if v_tid is null or v_me is null then raise exception 'Chưa đăng nhập nhà xe' using errcode = '42501'; end if;
  if length(trim(coalesce(p_text, ''))) < 3 then raise exception 'Mô tả sự cố quá ngắn' using errcode = '22023'; end if;
  if length(p_text) > 2000 then raise exception 'Mô tả tối đa 2000 ký tự' using errcode = '22023'; end if;
  -- bấm gửi 2 lần: trả lại phiếu vừa tạo
  select id into v_id from public.support_tickets where tenant_id = v_tid and created_by = v_me and summary = left(trim(p_text), 300)
    and created_at > now() - interval '2 minutes' order by created_at desc limit 1;
  if v_id is not null then return v_id; end if;
  if (select count(*) from public.support_tickets where tenant_id = v_tid and created_by = v_me and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Đã gửi 10 sự cố trong 1 giờ, nhắn tiếp vào sự cố đang mở' using errcode = '54000';
  end if;
  select full_name, phone into u from public.app_users where tenant_id = v_tid and id = v_me;
  return app.support_create(v_tid, 'app', v_me, u.full_name, u.phone, p_text, p_context, null);
end;
$$;

create function public.support_reply(p_ticket uuid, p_text text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); v_me uuid := auth.uid(); t record; v_mine boolean; v_who text; h uuid;
begin
  select * into t from public.support_tickets where tenant_id = v_tid and id = p_ticket for update;
  if not found or v_me is null or not (t.created_by is not distinct from v_me or app.support_can_handle()) then
    raise exception 'Không tìm thấy sự cố' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_text, ''))) < 1 then raise exception 'Chưa nhập nội dung' using errcode = '22023'; end if;
  if length(p_text) > 2000 then raise exception 'Tối đa 2000 ký tự' using errcode = '22023'; end if;
  v_mine := t.created_by is not distinct from v_me;
  insert into public.support_messages (tenant_id, ticket_id, sender, user_id, body)
  values (v_tid, t.id, case when v_mine then 'nguoi_bao' else 'xu_ly' end, v_me, trim(p_text));
  update public.support_tickets set updated_at = now(),
    status = case when v_mine then 'mo' else status end, closed_at = case when v_mine then null else closed_at end
  where tenant_id = v_tid and id = t.id;
  v_who := coalesce((select full_name from public.app_users where tenant_id = v_tid and id = v_me), 'Người dùng');
  if v_mine then
    for h in select app.support_handlers(v_tid) loop
      perform app.notify_user(v_tid, h, 'su_co', 'Sự cố #' || t.no, v_who || ': ' || left(trim(p_text), 200), null);
    end loop;
  elsif t.created_by is not null then
    perform app.notify_user(v_tid, t.created_by, 'su_co', 'Trả lời sự cố #' || t.no, v_who || ': ' || left(trim(p_text), 200), null);
  end if;
end;
$$;

create function public.support_set_status(p_ticket uuid, p_status text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); v_me uuid := auth.uid(); t record; v_who text;
begin
  if p_status not in ('mo', 'dong') then raise exception 'Trạng thái không hợp lệ' using errcode = '22023'; end if;
  select * into t from public.support_tickets where tenant_id = v_tid and id = p_ticket for update;
  if not found or v_me is null or not (t.created_by is not distinct from v_me or app.support_can_handle()) then
    raise exception 'Không tìm thấy sự cố' using errcode = 'P0002';
  end if;
  if t.status = p_status then return; end if;
  v_who := coalesce((select full_name from public.app_users where tenant_id = v_tid and id = v_me), 'Người dùng');
  update public.support_tickets set status = p_status, updated_at = now(), closed_at = case when p_status = 'dong' then now() end
  where tenant_id = v_tid and id = t.id;
  insert into public.support_messages (tenant_id, ticket_id, sender, body)
  values (v_tid, t.id, 'bot', case when p_status = 'dong' then v_who || ' đã đóng sự cố.' else v_who || ' đã mở lại sự cố.' end);
  if p_status = 'dong' and t.created_by is not null then
    perform app.notify_user(v_tid, t.created_by, 'su_co', 'Đã xử lý sự cố #' || t.no, v_who || ' đã đóng sự cố.', null);
  end if;
end;
$$;

revoke execute on function public.support_open(text, jsonb), public.support_reply(uuid, text), public.support_set_status(uuid, text)
  from public, anon, authenticated;
grant execute on function public.support_open(text, jsonb), public.support_reply(uuid, text), public.support_set_status(uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------- Màn hình đăng nhập (qua Edge Function "support")
/** Lưu sự cố gửi từ màn hình đăng nhập. Trả false khi không lưu (sai mã nhà xe, gửi dồn); Edge Function luôn trả lời chung một câu. */
create function public.svc_support_login(p_code text, p_phone text, p_text text, p_context jsonb, p_ip_hash text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid; v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), ''); v_name text;
begin
  if length(trim(coalesce(p_text, ''))) < 3 or length(p_text) > 2000 then return false; end if;
  select id into v_tid from public.tenants where code = lower(trim(coalesce(p_code, ''))) and status = 'active';
  if v_tid is null then return false; end if;
  if v_phone !~ '^0[0-9]{9}$' then v_phone := null; end if;
  -- mỗi máy tối đa 5 lần / giờ, mỗi nhà xe tối đa 20 lần / giờ từ màn hình đăng nhập
  if p_ip_hash is null
     or (select count(*) from public.support_tickets where tenant_id = v_tid and ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.support_tickets where tenant_id = v_tid and channel = 'login' and created_at > now() - interval '1 hour') >= 20 then
    return false;
  end if;
  -- cùng nội dung từ cùng máy trong 10 phút: không tạo lại
  if exists (select 1 from public.support_tickets where tenant_id = v_tid and ip_hash = p_ip_hash and summary = left(trim(p_text), 300)
             and created_at > now() - interval '10 minutes') then
    return true;
  end if;
  -- tên theo số điện thoại (nếu có tài khoản) chỉ để người xử lý biết; phiếu không gắn vào tài khoản đó
  if v_phone is not null then select full_name into v_name from public.app_users where tenant_id = v_tid and phone = v_phone; end if;
  perform app.support_create(v_tid, 'login', null, v_name, v_phone, p_text, p_context, p_ip_hash);
  return true;
end;
$$;
revoke execute on function public.svc_support_login(text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.svc_support_login(text, text, text, jsonb, text) to service_role;
