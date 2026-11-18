-- =====================================================================
-- Giai đoạn 2.2 – Ngữ cảnh người đang đăng nhập (dùng cho giao diện và
-- Edge Function quản lý tài khoản). Chỉ trả về thông tin của chính mình.
-- =====================================================================

create function public.my_account_context()
returns table (
  user_id            uuid,
  tenant_id          uuid,
  tenant_code        text,
  tenant_name        text,
  full_name          text,
  can_manage_users   boolean,
  is_platform_admin  boolean
)
language sql stable security definer set search_path = ''
as $$
  select
    auth.uid(),
    t.id,
    t.code,
    t.name,
    u.full_name,
    coalesce(app.has_permission('user.manage'), false),
    app.is_platform_admin()
  from (select 1) as one
  left join public.app_users u on u.id = auth.uid() and u.status = 'active'
  left join public.tenants t on t.id = u.tenant_id and t.status = 'active'
$$;

revoke execute on function public.my_account_context() from public, anon;
grant execute on function public.my_account_context() to authenticated;

-- Hệ thống đã có Super Admin chưa? (màn hình khởi tạo lần đầu cần biết, kể cả khi chưa đăng nhập)
create function public.platform_initialized()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.platform_admins)
$$;

revoke execute on function public.platform_initialized() from public;
grant execute on function public.platform_initialized() to anon, authenticated;
