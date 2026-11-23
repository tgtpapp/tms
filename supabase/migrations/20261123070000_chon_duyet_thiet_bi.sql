-- =====================================================================
-- Chọn có cần duyệt thiết bị lạ hay không:
-- - Cả nhà xe (Cấu hình › Bảo mật): bật thì nhân viên văn phòng / quản lý phải duyệt thiết bị lạ (lái xe, phụ xe không áp dụng). Mặc định tắt.
-- - Từng tài khoản (Người dùng): Theo cài đặt nhà xe / Luôn cần duyệt / Không cần duyệt — chọn riêng thì theo chọn riêng (kể cả lái xe).
-- Đăng nhập bằng mã QR vẫn dùng được dù có bật hay không.
-- =====================================================================
alter table public.app_users add column device_check text check (device_check in ('can', 'khong'));

create or replace function app.device_exempt(p_user uuid)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare v_mode text; v_tid uuid;
begin
  if exists (select 1 from public.platform_admins where user_id = p_user) then return true; end if;
  select device_check, tenant_id into v_mode, v_tid from public.app_users where id = p_user;
  if v_mode = 'can' then return false; end if;
  if v_mode = 'khong' or v_tid is null then return true; end if;
  if exists (select 1 from public.staff_members where user_id = p_user and position in ('lai_xe', 'phu_xe'))
     or (exists (select 1 from public.user_roles ur where ur.user_id = p_user)
         and not exists (select 1 from public.user_roles ur join public.roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
                         where ur.user_id = p_user and r.code <> 'driver')) then
    return true;
  end if;
  return not coalesce((select (value #>> '{}')::boolean from public.tenant_settings where tenant_id = v_tid and key = 'bao_mat.duyet_thiet_bi'), false);
end;
$$;

/** Người quản lý tài khoản chọn cho từng người: null = theo nhà xe, 'can' = luôn cần duyệt, 'khong' = không cần duyệt */
create function public.set_user_device_check(p_user_id uuid, p_mode text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('user.edit') then
    raise exception 'Không có quyền sửa tài khoản' using errcode = '42501';
  end if;
  if p_mode is not null and p_mode not in ('can', 'khong') then raise exception 'Lựa chọn không hợp lệ' using errcode = '22023'; end if;
  update public.app_users set device_check = p_mode, updated_at = now() where id = p_user_id and tenant_id = v_tid;
  if not found then raise exception 'Không tìm thấy tài khoản' using errcode = 'P0002'; end if;
end;
$$;
revoke execute on function public.set_user_device_check(uuid, text) from public, anon, authenticated;
grant execute on function public.set_user_device_check(uuid, text) to authenticated;
