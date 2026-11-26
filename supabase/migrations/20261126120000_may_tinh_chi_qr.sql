-- =====================================================================
-- Máy tính chỉ đăng nhập bằng quét mã QR (Cấu hình › Bảo mật đăng nhập), mặc định tắt.
-- - Bật: người thuộc các nhóm quyền được chọn (mặc định mọi nhóm trừ Lái xe) đăng nhập trên MÁY TÍNH bằng mật khẩu
--   thì phiên đó không dùng được dữ liệu (app.current_tenant_id() trả null) và app tự đăng xuất; trên điện thoại vẫn dùng mật khẩu.
-- - Máy tính / điện thoại: theo trình duyệt lúc đăng nhập (auth.sessions.user_agent; không có thì app báo), ghi 1 lần khi mở phiên.
--   Trình duyệt có thể giả làm điện thoại: lớp chặn cuối vẫn là Duyệt thiết bị lạ.
-- - Mất điện thoại: người có quyền Sửa tài khoản tạm cho phép 1 người đăng nhập bằng mật khẩu trên máy tính trong 1 ngày.
-- Thêm cột (không đổi cột cũ): session_devices.via ('mat_khau' / 'qr'), session_devices.desktop; app_users.pw_desktop_until.
-- =====================================================================

alter table public.session_devices add column via text check (via in ('mat_khau', 'qr')), add column desktop boolean;
alter table public.app_users add column pw_desktop_until timestamptz;

/** Người này trên máy tính có bắt buộc đăng nhập bằng QR không (theo cài đặt nhà xe + tạm cho phép) */
create function app.desktop_qr_required(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((s.value ->> 'on')::boolean, false)
     and (u.pw_desktop_until is null or u.pw_desktop_until < now())
     and exists (select 1 from public.user_roles ur join public.roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
                 where ur.user_id = p_user and ur.tenant_id = u.tenant_id
                   and r.code in (select jsonb_array_elements_text(coalesce(s.value -> 'roles', '[]'))))
  from public.app_users u
  join public.tenant_settings s on s.tenant_id = u.tenant_id and s.key = 'bao_mat.may_tinh_qr'
  where u.id = p_user
$$;
revoke execute on function app.desktop_qr_required(uuid) from public, anon;
grant execute on function app.desktop_qr_required(uuid) to authenticated, service_role;

-- Phiên mật khẩu trên máy tính của người bắt buộc QR: không dùng được dữ liệu
do $$
declare v text;
begin
  v := pg_get_functiondef('app.session_ok()'::regprocedure);
  v := replace(v, E'  v_ok boolean;\nbegin', E'  v_ok boolean;\n  v_pw boolean;\nbegin');
  v := replace(v, 'select approved into v_ok from public.session_devices where session_id::text = v_sid;',
    E'select approved, (via = ''mat_khau'' and desktop is true) into v_ok, v_pw from public.session_devices where session_id::text = v_sid;\n'
    || E'  if v_pw and app.desktop_qr_required(auth.uid()) then return false; end if;');
  if v not like '%desktop_qr_required%' or v not like '%v_pw boolean%' then raise exception 'Không sửa được app.session_ok'; end if;
  execute v;
end;
$$;

-- Mở app: ghi cách đăng nhập (mật khẩu / QR) + máy tính hay điện thoại; trả thêm 'chi_qr' khi máy tính phải đăng nhập bằng QR
do $$
declare v text;
begin
  v := pg_get_functiondef('public.device_hello(text, text, uuid, text)'::regprocedure);
  v := replace(v, 'p_qr_secret text DEFAULT NULL::text)', 'p_qr_secret text DEFAULT NULL::text, p_desktop boolean DEFAULT NULL::boolean)');
  v := replace(v, E'insert into public.session_devices (session_id, user_id, device_id, name, approved, approved_at)\n    values (v_sid, v_uid, v_dev, v_name, v_ok, case when v_ok then now() end)',
               E'insert into public.session_devices (session_id, user_id, device_id, name, approved, approved_at, via, desktop)\n    values (v_sid, v_uid, v_dev, v_name, v_ok, case when v_ok then now() end, ''mat_khau'',
'
               || E'      coalesce((select s.user_agent !~* ''(iphone|ipad|android|mobile)'' from auth.sessions s where s.id = v_sid and s.user_agent is not null), p_desktop))');
  -- QR hợp lệ thì ghi 'qr' cả khi thiết bị đã quen (đã được duyệt sẵn)
  v := replace(v, 'if not v_row.approved and p_qr is not null and p_qr_secret is not null then',
               'if coalesce(v_row.via, '''') <> ''qr'' and p_qr is not null and p_qr_secret is not null then');
  v := replace(v, 'update public.session_devices set approved = true, approved_by = v_uid, approved_at = now() where session_id = v_sid returning * into v_row;',
               'update public.session_devices set approved = true, approved_by = v_uid, approved_at = now(), via = ''qr'' where session_id = v_sid returning * into v_row;');
  v := replace(v, E'  return case when v_row.approved then ''ok'' else ''cho_duyet'' end;',
               E'  if v_row.via = ''mat_khau'' and v_row.desktop is true and app.desktop_qr_required(v_uid) then return ''chi_qr''; end if;\n'
               || E'  return case when v_row.approved then ''ok'' else ''cho_duyet'' end;');
  if v not like '%p_desktop boolean%' or v not like '%auth.sessions s where s.id = v_sid%' or v not like '%via = ''qr''%' or v not like '%''chi_qr''%' or v not like '%coalesce(v_row.via%' then
    raise exception 'Không sửa được public.device_hello';
  end if;
  drop function public.device_hello(text, text, uuid, text);
  execute v;
end;
$$;
revoke execute on function public.device_hello(text, text, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.device_hello(text, text, uuid, text, boolean) to authenticated;

/** Màn đăng nhập (chưa đăng nhập): nhà xe này có bật "máy tính chỉ đăng nhập bằng QR" không – chỉ trả đúng/sai */
create function public.login_policy(p_code text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('may_tinh_qr', coalesce((select (s.value ->> 'on')::boolean from public.tenants t
    join public.tenant_settings s on s.tenant_id = t.id and s.key = 'bao_mat.may_tinh_qr'
    where t.code = lower(trim(p_code)) and t.status = 'active'), false))
$$;
revoke execute on function public.login_policy(text) from public, anon, authenticated;
grant execute on function public.login_policy(text) to anon, authenticated;

/** Tạm cho 1 người đăng nhập bằng mật khẩu trên máy tính trong 1 ngày (mất / hỏng điện thoại). p_on = false: thôi cho phép */
create function public.allow_desktop_password(p_user_id uuid, p_on boolean)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); v_until timestamptz;
begin
  if v_tid is null or not app.has_permission('user.edit') then
    raise exception 'Không có quyền sửa tài khoản' using errcode = '42501';
  end if;
  update public.app_users set pw_desktop_until = case when p_on then now() + interval '1 day' end, updated_at = now()
   where id = p_user_id and tenant_id = v_tid returning pw_desktop_until into v_until;
  if not found then raise exception 'Không tìm thấy tài khoản' using errcode = 'P0002'; end if;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
  values (v_tid, auth.uid(), 'cho_mat_khau_may_tinh', 'app_users', p_user_id::text, jsonb_build_object('on', p_on, 'until', v_until));
  return v_until;
end;
$$;
revoke execute on function public.allow_desktop_password(uuid, boolean) from public, anon, authenticated;
grant execute on function public.allow_desktop_password(uuid, boolean) to authenticated;
