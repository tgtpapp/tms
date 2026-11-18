-- =====================================================================
-- Giai đoạn 2.3 – Danh sách quyền của người đang đăng nhập (giao diện dùng
-- để ẩn/hiện nút; database vẫn tự kiểm tra quyền ở mọi thao tác).
-- =====================================================================

create function public.my_permissions()
returns table (permission_code text, scope_type text, scope_id uuid)
language sql stable security definer set search_path = ''
as $$
  select rp.permission_code, ur.scope_type, ur.scope_id
  from public.user_roles ur
  join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
  where ur.user_id = auth.uid()
    and ur.tenant_id = app.current_tenant_id()
$$;

revoke execute on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;
