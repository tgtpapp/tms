-- =====================================================================
-- Rà soát bảo mật (kiểm thử 99_bao_mat quét toàn bộ database mỗi lần CI):
-- - tenant_backups: bỏ quyền mặc định của anon / ghi trực tiếp của trình duyệt (chỉ Chủ nhà xe đọc danh sách; ghi qua máy chủ).
-- - Hàm nội bộ app.*: không cho khách chưa đăng nhập (anon) gọi; chỉ người đã đăng nhập và máy chủ.
-- =====================================================================
revoke all on public.tenant_backups from public, anon, authenticated;
grant select on public.tenant_backups to authenticated;
grant select, insert, update, delete on public.tenant_backups to service_role;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.prorettype <> 'trigger'::regtype and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end;
$$;
