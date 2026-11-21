-- =====================================================================
-- Báo sự cố (bước 2): máy chủ tự kiểm tra ngay khi nhận sự cố, người quản lý xử lý bằng 1 nút.
-- - Trong app: tài khoản + quyền vào màn hình người dùng nhắc tới (app gửi mã quyền cần, máy chủ tự đối chiếu, không tin kết quả từ máy).
-- - Màn hình đăng nhập: số điện thoại có tài khoản không, có bị khóa không (chỉ người quản lý thấy, người gửi không thấy).
-- - Nút xử lý: Cấp quyền còn thiếu / Mở khóa tài khoản — gọi lại đúng hàm của màn hình Người dùng (kiểm tra quyền như cũ).
-- =====================================================================

/** Kiểm tra tài khoản + các quyền cần của 1 người trong nhà xe */
create function app.support_checks(p_tenant uuid, p_user uuid, p_need text[])
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'tai_khoan', (select status from public.app_users where tenant_id = p_tenant and id = p_user),
    'quyen', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', p.code, 'name', p.name,
        'ok', exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
                      where ur.tenant_id = p_tenant and ur.user_id = p_user and rp.permission_code = p.code)
              and not exists (select 1 from public.user_permission_denies d where d.tenant_id = p_tenant and d.user_id = p_user and d.permission_code = p.code),
        'chan', exists (select 1 from public.user_permission_denies d where d.tenant_id = p_tenant and d.user_id = p_user and d.permission_code = p.code))
        order by p.code)
      from public.permissions p
      where p.code = any ((coalesce(p_need, '{}'::text[]))[1:5])), '[]'::jsonb),
    'luc', now())
$$;
revoke execute on function app.support_checks(uuid, uuid, text[]) from public, anon, authenticated;

/** Câu máy báo kết quả kiểm tra */
create function app.support_check_text(c jsonb)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when c ->> 'tai_khoan' = 'locked' then 'Kiểm tra: tài khoản đang bị khóa.'
    when exists (select 1 from jsonb_array_elements(c -> 'quyen') q where not (q ->> 'ok')::boolean) then
      'Kiểm tra: tài khoản chưa có quyền ' ||
      (select string_agg('"' || (q ->> 'name') || '"' || case when (q ->> 'chan')::boolean then ' (bị chặn riêng)' else '' end, ', ')
       from jsonb_array_elements(c -> 'quyen') q where not (q ->> 'ok')::boolean) ||
      '. Đã gửi yêu cầu cấp quyền cho người quản lý.'
    when jsonb_array_length(coalesce(c -> 'quyen', '[]')) > 0 then
      'Kiểm tra: tài khoản và quyền ' || (select string_agg('"' || (q ->> 'name') || '"', ', ') from jsonb_array_elements(c -> 'quyen') q) || ' bình thường.'
    else 'Kiểm tra: tài khoản bình thường.'
  end
$$;
revoke execute on function app.support_check_text(jsonb) from public, anon, authenticated;

-- thông tin máy: thêm mã quyền cần (do app đoán từ màn hình), máy có bản mới chưa tải
create or replace function app.support_clean_context(p jsonb)
returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'screen', left(p ->> 'screen', 80),
    'path', left(p ->> 'path', 200),
    'ua', left(p ->> 'ua', 300),
    'online', case when jsonb_typeof(p -> 'online') = 'boolean' then p -> 'online' end,
    'new_version', case when jsonb_typeof(p -> 'new_version') = 'boolean' then p -> 'new_version' end,
    'session', case when p ->> 'session' in ('ok', 'loi') then p ->> 'session' end,
    'at', left(p ->> 'at', 40),
    'need', (select jsonb_agg(left(n, 40)) from (
               select n from jsonb_array_elements_text(case when jsonb_typeof(p -> 'need') = 'array' then p -> 'need' else '[]'::jsonb end) n limit 5) s),
    'errors', (select jsonb_agg(left(e, 500)) from (
                 select e from jsonb_array_elements_text(case when jsonb_typeof(p -> 'errors') = 'array' then p -> 'errors' else '[]'::jsonb end) with ordinality x(e, i)
                 order by i desc limit 10) s)))
$$;

-- tạo phiếu: thêm kết quả kiểm tra vào thông tin + lời máy báo
drop function app.support_create(uuid, text, uuid, text, text, text, jsonb, text);
create function app.support_create(p_tenant uuid, p_channel text, p_user uuid, p_name text, p_phone text, p_text text, p_context jsonb, p_ip text,
                                   p_checks jsonb, p_check_text text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_no int; v_id uuid; v_txt text := trim(p_text); h uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('support:' || p_tenant::text, 0));
  select coalesce(max(no), 0) + 1 into v_no from public.support_tickets where tenant_id = p_tenant;
  insert into public.support_tickets (tenant_id, no, channel, created_by, reporter_name, reporter_phone, summary, context, ip_hash)
  values (p_tenant, v_no, p_channel, p_user, left(p_name, 120), p_phone, left(v_txt, 300),
          app.support_clean_context(coalesce(p_context, '{}'::jsonb)) || jsonb_build_object('checks', coalesce(p_checks, '{}'::jsonb)), p_ip)
  returning id into v_id;
  insert into public.support_messages (tenant_id, ticket_id, sender, user_id, body) values (p_tenant, v_id, 'nguoi_bao', p_user, left(v_txt, 2000));
  insert into public.support_messages (tenant_id, ticket_id, sender, body) values (p_tenant, v_id, 'bot', left(
    'Đã nhận sự cố #' || v_no || '. ' || coalesce(p_check_text || ' ', '') || 'Đã báo người quản lý tài khoản của nhà xe' ||
    case when p_channel = 'login' then '. Người gửi từ màn hình đăng nhập, chưa xác minh.' else '; trả lời sẽ hiện ở đây.' end, 2000));
  for h in select app.support_handlers(p_tenant) loop
    if h is distinct from p_user then
      perform app.notify_user(p_tenant, h, 'su_co', 'Sự cố #' || v_no,
        coalesce(p_name, p_phone, 'Người dùng') || case when p_channel = 'login' then ' (màn hình đăng nhập)' else '' end || ': ' || left(v_txt, 200), null);
    end if;
  end loop;
  return v_id;
end;
$$;
revoke execute on function app.support_create(uuid, text, uuid, text, text, text, jsonb, text, jsonb, text) from public, anon, authenticated;

create or replace function public.support_open(p_text text, p_context jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); v_me uuid := auth.uid(); v_id uuid; u record; c jsonb;
begin
  if v_tid is null or v_me is null then raise exception 'Chưa đăng nhập nhà xe' using errcode = '42501'; end if;
  if length(trim(coalesce(p_text, ''))) < 3 then raise exception 'Mô tả sự cố quá ngắn' using errcode = '22023'; end if;
  if length(p_text) > 2000 then raise exception 'Mô tả tối đa 2000 ký tự' using errcode = '22023'; end if;
  select id into v_id from public.support_tickets where tenant_id = v_tid and created_by = v_me and summary = left(trim(p_text), 300)
    and created_at > now() - interval '2 minutes' order by created_at desc limit 1;
  if v_id is not null then return v_id; end if;
  if (select count(*) from public.support_tickets where tenant_id = v_tid and created_by = v_me and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Đã gửi 10 sự cố trong 1 giờ, nhắn tiếp vào sự cố đang mở' using errcode = '54000';
  end if;
  select full_name, phone into u from public.app_users where tenant_id = v_tid and id = v_me;
  c := app.support_checks(v_tid, v_me,
         array(select jsonb_array_elements_text(case when jsonb_typeof(p_context -> 'need') = 'array' then p_context -> 'need' else '[]'::jsonb end)));
  return app.support_create(v_tid, 'app', v_me, u.full_name, u.phone, p_text, p_context, null, c, app.support_check_text(c));
end;
$$;

create or replace function public.svc_support_login(p_code text, p_phone text, p_text text, p_context jsonb, p_ip_hash text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid; v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), ''); v_uid uuid; v_name text; v_status text; c jsonb; t text;
begin
  if length(trim(coalesce(p_text, ''))) < 3 or length(p_text) > 2000 then return false; end if;
  select id into v_tid from public.tenants where code = lower(trim(coalesce(p_code, ''))) and status = 'active';
  if v_tid is null then return false; end if;
  if v_phone !~ '^0[0-9]{9}$' then v_phone := null; end if;
  if p_ip_hash is null
     or (select count(*) from public.support_tickets where tenant_id = v_tid and ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.support_tickets where tenant_id = v_tid and channel = 'login' and created_at > now() - interval '1 hour') >= 20 then
    return false;
  end if;
  if exists (select 1 from public.support_tickets where tenant_id = v_tid and ip_hash = p_ip_hash and summary = left(trim(p_text), 300)
             and created_at > now() - interval '10 minutes') then
    return true;
  end if;
  -- kiểm tra theo số điện thoại (chỉ người quản lý thấy); phiếu không gắn vào tài khoản đó
  if v_phone is not null then select id, full_name, status into v_uid, v_name, v_status from public.app_users where tenant_id = v_tid and phone = v_phone; end if;
  if v_phone is null then
    c := jsonb_build_object('tai_khoan', 'khong_ro'); t := 'Kiểm tra: người gửi không ghi số điện thoại.';
  elsif v_uid is null then
    c := jsonb_build_object('tai_khoan', 'khong_co'); t := 'Kiểm tra: số điện thoại này chưa có tài khoản trong nhà xe.';
  elsif v_status = 'locked' then
    c := jsonb_build_object('tai_khoan', 'locked', 'user_id', v_uid); t := 'Kiểm tra: tài khoản của số điện thoại này đang bị khóa.';
  else
    c := jsonb_build_object('tai_khoan', 'active', 'user_id', v_uid); t := 'Kiểm tra: tài khoản đang hoạt động (có thể nhập sai mật khẩu).';
  end if;
  perform app.support_create(v_tid, 'login', null, v_name, v_phone, p_text, p_context, p_ip_hash, c, t);
  return true;
end;
$$;

-- ---------------------------------------------------------------- Nút xử lý của người quản lý
/** p_action: 'cap_quyen' (cấp quyền p_perm cho người gửi) | 'mo_khoa' (mở khóa tài khoản người gửi / số điện thoại đã khai) */
create function public.support_fix(p_ticket uuid, p_action text, p_perm text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); v_me uuid := auth.uid(); t record; v_user uuid; v_role text; v_who text; v_msg text;
  v_grants text[]; v_denies text[]; v_name text;
begin
  select * into t from public.support_tickets where tenant_id = v_tid and id = p_ticket for update;
  if not found or v_me is null or not app.support_can_handle() then raise exception 'Không tìm thấy sự cố' using errcode = 'P0002'; end if;
  v_user := coalesce(t.created_by, nullif(t.context -> 'checks' ->> 'user_id', '')::uuid);
  if v_user is null then raise exception 'Sự cố không gắn với tài khoản nào' using errcode = '22023'; end if;
  v_who := coalesce((select full_name from public.app_users where tenant_id = v_tid and id = v_me), 'Người quản lý');
  if p_action = 'mo_khoa' then
    perform public.set_user_status(v_user, 'active');
    v_msg := v_who || ' đã mở khóa tài khoản.';
  elsif p_action = 'cap_quyen' then
    if t.created_by is null then raise exception 'Chỉ cấp quyền cho sự cố gửi từ trong app' using errcode = '22023'; end if;
    select name into v_name from public.permissions where code = p_perm;
    if v_name is null then raise exception 'Quyền không hợp lệ' using errcode = '22023'; end if;
    v_role := 'rieng_' || left(replace(v_user::text, '-', ''), 24);
    select coalesce(array_agg(rp.permission_code), '{}') into v_grants from public.role_permissions rp join public.roles r on r.tenant_id = rp.tenant_id and r.id = rp.role_id
      where rp.tenant_id = v_tid and r.code = v_role;
    select coalesce(array_agg(permission_code), '{}') into v_denies from public.user_permission_denies where tenant_id = v_tid and user_id = v_user;
    if p_perm = any (v_denies) then
      v_denies := array_remove(v_denies, p_perm);
    elsif not p_perm = any (v_grants) then
      v_grants := v_grants || p_perm;
    end if;
    perform public.set_user_permissions(v_user, v_grants, v_denies);
    v_msg := v_who || ' đã cấp quyền "' || v_name || '". Tải lại app để thấy màn hình.';
  else
    raise exception 'Không rõ thao tác' using errcode = '22023';
  end if;
  -- kiểm tra lại sau khi xử lý
  update public.support_tickets set updated_at = now(),
    context = jsonb_set(context, '{checks}', case when t.created_by is not null
      then app.support_checks(v_tid, v_user, array(select jsonb_array_elements_text(coalesce(t.context -> 'need', '[]'::jsonb))))
      else (t.context -> 'checks') || jsonb_build_object('tai_khoan', (select status from public.app_users where tenant_id = v_tid and id = v_user)) end)
  where tenant_id = v_tid and id = t.id;
  insert into public.support_messages (tenant_id, ticket_id, sender, body) values (v_tid, t.id, 'bot', v_msg);
  if t.created_by is not null then
    perform app.notify_user(v_tid, t.created_by, 'su_co', 'Sự cố #' || t.no, v_msg, null);
  end if;
end;
$$;
revoke execute on function public.support_fix(uuid, text, text) from public, anon, authenticated;
grant execute on function public.support_fix(uuid, text, text) to authenticated, service_role;
