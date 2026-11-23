-- =====================================================================
-- Bảo vệ tài khoản nhân viên văn phòng và quản lý (lái xe, phụ xe không áp dụng):
-- 1) Duyệt thiết bị lạ: đăng nhập bằng mật khẩu trên thiết bị chưa quen thì phải được cho phép từ thiết bị đang dùng
--    của chính người đó (hoặc người quản lý có quyền Sửa tài khoản trong nhà xe). Chưa được duyệt thì không xem / ghi được dữ liệu
--    nhà xe nào (app.current_tenant_id() trả null), kể cả gọi thẳng API.
-- 2) Đăng nhập máy tính bằng mã QR (như Zalo PC): máy tính hiện mã, điện thoại đang đăng nhập quét và bấm Đồng ý;
--    máy tính không phải gõ mật khẩu. Thiết bị vào bằng QR được coi là đã duyệt.
-- Đăng xuất 1 thiết bị (Quản lý thiết bị đăng nhập) thì thiết bị đó hết "quen": đăng nhập lại phải được duyệt lại.
-- Thiết bị đầu tiên của mỗi người, và các phiên đang đăng nhập lúc cập nhật, được coi là quen (không ai bị khóa ngoài).
-- =====================================================================

-- Thiết bị quen của từng người (mã thiết bị do app tạo, lưu trên máy)
create table public.trusted_devices (
  user_id     uuid not null references auth.users (id) on delete cascade,
  device_id   text not null check (length(device_id) between 8 and 64),
  name        text,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  primary key (user_id, device_id)
);
-- Mỗi phiên đăng nhập: thuộc thiết bị nào, đã được duyệt chưa
create table public.session_devices (
  session_id   uuid primary key references auth.sessions (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  device_id    text,
  name         text,
  approved     boolean not null default false,
  approved_by  uuid,
  approved_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index session_devices_user_idx on public.session_devices (user_id, approved);
-- Đăng nhập bằng mã QR
create table public.qr_logins (
  id           uuid primary key default gen_random_uuid(),
  secret_hash  text not null,
  name         text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '2 minutes',
  user_id      uuid references auth.users (id) on delete cascade,
  decided_at   timestamptz,
  ok           boolean,
  taken_at     timestamptz,
  bound_session uuid
);
create index qr_logins_created_idx on public.qr_logins (created_at);

alter table public.trusted_devices enable row level security;
alter table public.session_devices enable row level security;
alter table public.qr_logins enable row level security;
revoke all on public.trusted_devices, public.session_devices, public.qr_logins from public, anon, authenticated;
grant select on public.trusted_devices, public.session_devices to authenticated;
grant select, insert, update, delete on public.trusted_devices, public.session_devices, public.qr_logins to service_role;
create policy trusted_devices_own on public.trusted_devices for select to authenticated using (user_id = auth.uid());
create policy session_devices_own on public.session_devices for select to authenticated using (user_id = auth.uid());

-- Phiên đang đăng nhập lúc cập nhật: coi như đã duyệt
insert into public.session_devices (session_id, user_id, approved, approved_at)
select id, user_id, true, now() from auth.sessions
on conflict do nothing;

-- ---------------------------------------------------------------- Ai phải duyệt thiết bị
/** Lái xe / phụ xe (hồ sơ nhân sự hoặc chỉ có nhóm Lái xe) và Super Admin không phải duyệt thiết bị */
create function app.device_exempt(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.platform_admins where user_id = p_user)
      or exists (select 1 from public.staff_members where user_id = p_user and position in ('lai_xe', 'phu_xe'))
      or (exists (select 1 from public.user_roles ur where ur.user_id = p_user)
          and not exists (select 1 from public.user_roles ur join public.roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
                          where ur.user_id = p_user and r.code <> 'driver'))
$$;

/** Phiên đăng nhập đang dùng có được phép dùng dữ liệu không */
create function app.session_ok()
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_sid text := auth.jwt() ->> 'session_id';
  v_ok boolean;
begin
  if v_sid is null or auth.uid() is null then return true; end if;           -- khóa hệ thống / kiểm thử không có phiên
  select approved into v_ok from public.session_devices where session_id::text = v_sid;
  if v_ok then return true; end if;
  if app.device_exempt(auth.uid()) then return true; end if;
  if v_ok is null then
    -- chưa từng dùng app trên thiết bị nào (chưa có thiết bị quen): thiết bị đầu tiên được dùng
    return not exists (select 1 from public.trusted_devices where user_id = auth.uid())
       and not exists (select 1 from public.session_devices where user_id = auth.uid() and approved);
  end if;
  return false;
end;
$$;
revoke execute on function app.device_exempt(uuid), app.session_ok() from public, anon;
grant execute on function app.device_exempt(uuid), app.session_ok() to authenticated, service_role;

-- Mọi quy tắc dữ liệu nhà xe dựa vào app.current_tenant_id(): phiên chưa được duyệt thì không thuộc nhà xe nào
create or replace function app.current_tenant_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select u.tenant_id
  from public.app_users u
  join public.tenants t on t.id = u.tenant_id
  where u.id = auth.uid() and u.status = 'active' and t.status = 'active' and app.session_ok()
$$;

-- ---------------------------------------------------------------- App báo thiết bị khi mở
/** Mở app: ghi phiên này thuộc thiết bị nào. Trả 'ok' (được dùng) hoặc 'cho_duyet'.
 *  p_qr / p_qr_secret: vừa đăng nhập bằng mã QR thì phiên được duyệt luôn. */
create function public.device_hello(p_device_id text, p_name text, p_qr uuid default null, p_qr_secret text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_dev text := nullif(left(trim(coalesce(p_device_id, '')), 64), '');
  v_name text := nullif(left(trim(coalesce(p_name, '')), 120), '');
  v_row public.session_devices;
  v_ok boolean;
begin
  if v_uid is null then raise exception 'Chưa đăng nhập' using errcode = '42501'; end if;
  if v_sid is null then return 'ok'; end if;
  if v_dev is not null and length(v_dev) < 8 then v_dev := null; end if;
  select * into v_row from public.session_devices where session_id = v_sid;
  if not found then
    v_ok := app.device_exempt(v_uid)
         or (v_dev is not null and exists (select 1 from public.trusted_devices where user_id = v_uid and device_id = v_dev))
         or (not exists (select 1 from public.trusted_devices where user_id = v_uid)
             and not exists (select 1 from public.session_devices where user_id = v_uid and approved));
    insert into public.session_devices (session_id, user_id, device_id, name, approved, approved_at)
    values (v_sid, v_uid, v_dev, v_name, v_ok, case when v_ok then now() end)
    on conflict (session_id) do nothing;
    select * into v_row from public.session_devices where session_id = v_sid;
  elsif v_row.device_id is null and v_dev is not null then
    update public.session_devices set device_id = v_dev, name = coalesce(v_name, name) where session_id = v_sid returning * into v_row;
  end if;
  -- Vừa đăng nhập bằng mã QR (điện thoại đã đồng ý)
  if not v_row.approved and p_qr is not null and p_qr_secret is not null then
    update public.qr_logins set bound_session = v_sid
     where id = p_qr and user_id = v_uid and ok and taken_at > now() - interval '5 minutes' and bound_session is null
       and secret_hash = encode(extensions.digest(p_qr_secret, 'sha256'), 'hex');
    if found then
      update public.session_devices set approved = true, approved_by = v_uid, approved_at = now() where session_id = v_sid returning * into v_row;
    end if;
  end if;
  if not v_row.approved and app.device_exempt(v_uid) then
    update public.session_devices set approved = true, approved_at = now() where session_id = v_sid returning * into v_row;
  end if;
  if v_row.approved and v_row.device_id is not null then
    insert into public.trusted_devices (user_id, device_id, name) values (v_uid, v_row.device_id, v_row.name)
    on conflict (user_id, device_id) do update set last_seen = now(), name = coalesce(excluded.name, public.trusted_devices.name);
  end if;
  return case when v_row.approved then 'ok' else 'cho_duyet' end;
end;
$$;

-- ---------------------------------------------------------------- Duyệt thiết bị lạ
/** Thiết bị đang chờ duyệt: của chính mình; người có quyền Sửa tài khoản thấy thêm của người trong nhà xe */
create function public.pending_devices()
returns table (session_id uuid, user_id uuid, full_name text, name text, ip text, created_at timestamptz, mine boolean)
language sql stable security definer set search_path = ''
as $$
  select d.session_id, d.user_id, coalesce(u.full_name, ''), d.name, host(s.ip), d.created_at, d.user_id = auth.uid()
  from public.session_devices d
  join auth.sessions s on s.id = d.session_id
  left join public.app_users u on u.id = d.user_id
  where not d.approved and app.session_ok() and d.created_at > now() - interval '1 day'
    and (d.user_id = auth.uid()
         or (app.has_permission('user.edit') and u.tenant_id = app.current_tenant_id()))
  order by d.created_at desc
$$;

/** Cho phép (p_ok = true) hoặc từ chối (đăng xuất thiết bị đó) */
create function public.approve_device(p_session_id uuid, p_ok boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_row public.session_devices;
begin
  if auth.uid() is null or not app.session_ok() then raise exception 'Thiết bị này chưa được duyệt' using errcode = '42501'; end if;
  select d.* into v_row from public.session_devices d left join public.app_users u on u.id = d.user_id
  where d.session_id = p_session_id and not d.approved
    and (d.user_id = auth.uid() or (app.has_permission('user.edit') and u.tenant_id = app.current_tenant_id()));
  if not found then raise exception 'Không tìm thấy thiết bị chờ duyệt' using errcode = 'P0002'; end if;
  if p_ok then
    update public.session_devices set approved = true, approved_by = auth.uid(), approved_at = now() where session_id = p_session_id;
    if v_row.device_id is not null then
      insert into public.trusted_devices (user_id, device_id, name) values (v_row.user_id, v_row.device_id, v_row.name)
      on conflict (user_id, device_id) do update set last_seen = now();
    end if;
  else
    delete from auth.sessions where id = p_session_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------- Đăng xuất thiết bị: hết "quen"
create or replace function public.sign_out_session(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Chưa đăng nhập' using errcode = '42501'; end if;
  delete from public.trusted_devices t using public.session_devices d
   where d.session_id = p_id and d.user_id = auth.uid() and t.user_id = d.user_id and t.device_id = d.device_id;
  delete from auth.sessions where id = p_id and user_id = auth.uid();
  if not found then raise exception 'Không tìm thấy thiết bị' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.sign_out_other_sessions()
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  n int;
  v_sid text := coalesce(auth.jwt() ->> 'session_id', '');
  v_dev text := (select device_id from public.session_devices where session_id::text = v_sid);
begin
  if auth.uid() is null then raise exception 'Chưa đăng nhập' using errcode = '42501'; end if;
  delete from public.trusted_devices where user_id = auth.uid() and device_id is distinct from v_dev;
  delete from auth.sessions where user_id = auth.uid() and id::text <> v_sid;
  get diagnostics n = row_count;
  return n;
end;
$$;

drop function public.my_sessions();
create function public.my_sessions()
returns table (id uuid, created_at timestamptz, last_active timestamptz, user_agent text, ip text, is_current boolean, approved boolean)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.created_at, coalesce(s.refreshed_at, s.updated_at, s.created_at), s.user_agent, host(s.ip),
         s.id::text = coalesce(auth.jwt() ->> 'session_id', ''), coalesce(d.approved, false) or app.device_exempt(s.user_id)
  from auth.sessions s left join public.session_devices d on d.session_id = s.id
  where s.user_id = auth.uid() and (s.not_after is null or s.not_after > now())
  order by (s.id::text = coalesce(auth.jwt() ->> 'session_id', '')) desc, coalesce(s.refreshed_at, s.updated_at, s.created_at) desc
$$;

-- ---------------------------------------------------------------- Đăng nhập bằng mã QR
/** Máy tính (chưa đăng nhập) xin mã QR. Trả {id, secret}; mã sống 2 phút. */
create function public.qr_start(p_name text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_secret text := encode(extensions.gen_random_bytes(24), 'hex');
  v_id uuid;
begin
  delete from public.qr_logins where created_at < now() - interval '1 day';
  if (select count(*) from public.qr_logins where created_at > now() - interval '10 minutes') > 5000 then
    raise exception 'Đang quá tải, thử lại sau ít phút' using errcode = '53000';
  end if;
  insert into public.qr_logins (secret_hash, name) values (encode(extensions.digest(v_secret, 'sha256'), 'hex'), nullif(left(trim(coalesce(p_name, '')), 120), ''))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'secret', v_secret);
end;
$$;

/** Điện thoại quét mã: xem máy nào đang xin đăng nhập */
create function public.qr_info(p_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('name', name, 'created_at', created_at,
    'status', case when decided_at is not null then case when ok then 'da_dong_y' else 'tu_choi' end when expires_at < now() then 'het_han' else 'cho' end)
  from public.qr_logins where id = p_id and auth.uid() is not null
$$;

/** Điện thoại (đang đăng nhập, thiết bị đã duyệt) đồng ý / từ chối cho máy tính đăng nhập tài khoản của mình */
create function public.qr_approve(p_id uuid, p_ok boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not app.session_ok() then raise exception 'Thiết bị này chưa được duyệt' using errcode = '42501'; end if;
  update public.qr_logins set user_id = auth.uid(), ok = p_ok, decided_at = now()
   where id = p_id and decided_at is null and expires_at > now();
  if not found then raise exception 'Mã QR đã hết hạn hoặc đã dùng, bấm Làm mới mã trên máy tính' using errcode = 'P0002'; end if;
end;
$$;

/** (Edge Function) Máy tính hỏi kết quả: đồng ý thì trả email đăng nhập để cấp phiên, chỉ 1 lần */
create function public.svc_qr_take(p_id uuid, p_secret text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.qr_logins; v_email text;
begin
  select * into r from public.qr_logins where id = p_id and secret_hash = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex') for update;
  if not found then return jsonb_build_object('status', 'khong_thay'); end if;
  if r.decided_at is null then
    return jsonb_build_object('status', case when r.expires_at < now() then 'het_han' else 'cho' end);
  end if;
  if not r.ok then return jsonb_build_object('status', 'tu_choi'); end if;
  if r.taken_at is not null or r.decided_at < now() - interval '2 minutes' then return jsonb_build_object('status', 'het_han'); end if;
  select email into v_email from auth.users where id = r.user_id;
  update public.qr_logins set taken_at = now() where id = p_id;
  return jsonb_build_object('status', 'ok', 'email', v_email);
end;
$$;

revoke execute on function public.device_hello(text, text, uuid, text), public.pending_devices(), public.approve_device(uuid, boolean),
  public.my_sessions(), public.qr_start(text), public.qr_info(uuid), public.qr_approve(uuid, boolean), public.svc_qr_take(uuid, text)
  from public, anon, authenticated;
grant execute on function public.device_hello(text, text, uuid, text), public.pending_devices(), public.approve_device(uuid, boolean),
  public.my_sessions(), public.qr_info(uuid), public.qr_approve(uuid, boolean) to authenticated;
grant execute on function public.qr_start(text) to anon, authenticated;
grant execute on function public.svc_qr_take(uuid, text) to service_role;
