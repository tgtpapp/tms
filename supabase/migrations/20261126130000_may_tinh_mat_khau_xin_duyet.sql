-- =====================================================================
-- Máy tính chỉ đăng nhập bằng QR: người bấm "Được quản lý tạm cho phép? Đăng nhập bằng mật khẩu" trên máy tính
-- thì không bị đăng xuất ngay mà CHỜ QUẢN LÝ DUYỆT: quản lý (quyền Sửa tài khoản, không phải chính người đó) nhận
-- thông báo ở chuông + đẩy về điện thoại, bấm Cho phép / Từ chối như duyệt thiết bị lạ.
-- Thêm (không đổi cột cũ): session_devices.via thêm giá trị 'duyet', cột session_devices.asked_at; thông báo loại 'thiet_bi'.
-- =====================================================================

alter table public.session_devices drop constraint session_devices_via_check;
alter table public.session_devices add constraint session_devices_via_check check (via in ('mat_khau', 'qr', 'duyet'));
alter table public.session_devices add column asked_at timestamptz;
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in ('khach', 'xep_chuyen', 'lai_xe_bao', 'su_co', 'thiet_bi'));

/** Phiên đang chờ quản lý cho đăng nhập bằng mật khẩu trên máy tính */
create function app.desktop_pw_waiting(d public.session_devices)
returns boolean
language sql stable security definer set search_path = ''
as $$ select d.via = 'mat_khau' and d.desktop is true and app.desktop_qr_required(d.user_id) $$;
revoke execute on function app.desktop_pw_waiting(public.session_devices) from public, anon, authenticated;

/** Báo cho người quản lý tài khoản trong nhà xe (trừ chính người xin) – 1 lần cho mỗi phiên */
create function app.ask_desktop_pw(p_sid uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.session_devices; u public.app_users; m uuid;
begin
  update public.session_devices set asked_at = now() where session_id = p_sid and asked_at is null returning * into d;
  if not found then return; end if;
  select * into u from public.app_users where id = d.user_id;
  if u.tenant_id is null then return; end if;
  for m in select distinct ur.user_id from public.user_roles ur
           join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
           join public.app_users a on a.id = ur.user_id and a.status = 'active'
           where ur.tenant_id = u.tenant_id and ur.scope_type = 'tenant' and rp.permission_code in ('user.edit', 'user.manage')
             and ur.user_id <> d.user_id
             and not exists (select 1 from public.user_permission_denies x where x.tenant_id = ur.tenant_id and x.user_id = ur.user_id
                             and x.permission_code = rp.permission_code)
  loop
    perform app.notify_user(u.tenant_id, m, 'thiet_bi', 'Xin đăng nhập bằng mật khẩu trên máy tính',
      format('%s xin đăng nhập bằng mật khẩu trên %s. Mở app để Cho phép hoặc Từ chối.', u.full_name, coalesce(d.name, 'máy tính')), null);
  end loop;
end;
$$;
revoke execute on function app.ask_desktop_pw(uuid) from public, anon, authenticated;

-- Mở app: máy tính đăng nhập bằng mật khẩu → chờ quản lý duyệt (báo quản lý 1 lần), không đăng xuất ngay
do $$
declare v text;
begin
  v := pg_get_functiondef('public.device_hello(text, text, uuid, text, boolean)'::regprocedure);
  v := replace(v, E'  if v_row.via = ''mat_khau'' and v_row.desktop is true and app.desktop_qr_required(v_uid) then return ''chi_qr''; end if;',
               E'  if v_row.via = ''mat_khau'' and v_row.desktop is true and app.desktop_qr_required(v_uid) then\n'
               || E'    perform app.ask_desktop_pw(v_sid);\n    return ''cho_quan_ly'';\n  end if;');
  if v not like '%ask_desktop_pw%' then raise exception 'Không sửa được public.device_hello'; end if;
  execute v;
end;
$$;

-- Danh sách chờ duyệt: thêm phiên xin đăng nhập mật khẩu trên máy tính (chỉ người quản lý thấy, không tự duyệt cho mình)
create or replace function public.pending_devices()
returns table (session_id uuid, user_id uuid, full_name text, name text, ip text, created_at timestamptz, mine boolean)
language sql stable security definer set search_path = ''
as $$
  select d.session_id, d.user_id, coalesce(u.full_name, ''),
         case when app.desktop_pw_waiting(d) then coalesce(d.name, 'Máy tính') || ' · xin đăng nhập bằng mật khẩu' else d.name end,
         host(s.ip), d.created_at, d.user_id = auth.uid()
  from public.session_devices d
  join auth.sessions s on s.id = d.session_id
  left join public.app_users u on u.id = d.user_id
  where app.session_ok() and d.created_at > now() - interval '1 day'
    and ((not d.approved and (d.user_id = auth.uid() or (app.has_permission('user.edit') and u.tenant_id = app.current_tenant_id())))
         or (app.desktop_pw_waiting(d) and d.user_id <> auth.uid() and app.has_permission('user.edit') and u.tenant_id = app.current_tenant_id()))
  order by d.created_at desc
$$;

/** Cho phép (p_ok = true) hoặc từ chối (đăng xuất thiết bị đó) */
create or replace function public.approve_device(p_session_id uuid, p_ok boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_row public.session_devices; v_pw boolean;
begin
  if auth.uid() is null or not app.session_ok() then raise exception 'Thiết bị này chưa được duyệt' using errcode = '42501'; end if;
  select d.* into v_row from public.session_devices d left join public.app_users u on u.id = d.user_id
  where d.session_id = p_session_id
    and ((not d.approved and (d.user_id = auth.uid() or (app.has_permission('user.edit') and u.tenant_id = app.current_tenant_id())))
         or (app.desktop_pw_waiting(d) and d.user_id <> auth.uid() and app.has_permission('user.edit') and u.tenant_id = app.current_tenant_id()));
  if not found then raise exception 'Không tìm thấy thiết bị chờ duyệt' using errcode = 'P0002'; end if;
  v_pw := app.desktop_pw_waiting(v_row);
  if p_ok then
    update public.session_devices set approved = true, approved_by = auth.uid(), approved_at = now(),
           via = case when v_pw then 'duyet' else via end
     where session_id = p_session_id;
    if v_row.device_id is not null then
      insert into public.trusted_devices (user_id, device_id, name) values (v_row.user_id, v_row.device_id, v_row.name)
      on conflict (user_id, device_id) do update set last_seen = now();
    end if;
  else
    delete from auth.sessions where id = p_session_id;
  end if;
  if v_pw then
    insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
    values (app.current_tenant_id(), auth.uid(), case when p_ok then 'cho_mat_khau_may_tinh' else 'tu_choi_mat_khau_may_tinh' end,
            'app_users', v_row.user_id::text, jsonb_build_object('thiet_bi', v_row.name));
  end if;
end;
$$;
