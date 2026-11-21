-- =====================================================================
-- Super Admin chỉ tạo nhà xe mới, không can thiệp vào bên trong nhà xe (Luật BVDLCN 91/2025: nền tảng là bên xử lý,
-- chỉ làm theo phần nhà xe giao). Chỉ tạo được Chủ nhà xe khi nhà xe chưa có Chủ (Edge Function admin-users kiểm tra);
-- danh sách nhà xe chỉ cho biết đã có Chủ hay chưa, không lộ ai là Chủ.
-- =====================================================================
create function public.platform_tenants()
returns table (id uuid, code text, name text, status text, has_owner boolean)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not app.is_platform_admin() then raise exception 'Chỉ Super Admin' using errcode = '42501'; end if;
  return query
  select t.id, t.code, t.name, t.status,
         exists (select 1 from public.user_roles ur join public.roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
                 where ur.tenant_id = t.id and r.code = 'owner')
  from public.tenants t order by t.created_at;
end;
$$;
revoke execute on function public.platform_tenants() from public, anon, authenticated;
grant execute on function public.platform_tenants() to authenticated, service_role;
