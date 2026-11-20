-- =====================================================================
-- Cột "Xem tất cả" như app cũ cho dữ liệu theo từng người:
-- - Lái xe & nhân viên, Hợp đồng lao động: ô Xem = mở mục, chỉ thấy của CHÍNH MÌNH; ô Xem tất cả = thấy của mọi người.
-- - Nhóm đang có ô Xem (trừ Lái xe, Nhân viên và quyền riêng từng người) được thêm ô Xem tất cả → giữ nguyên như trước.
-- =====================================================================
insert into public.permissions (code, module, name) values
  ('staff.view_all', 'staff', 'Lái xe & nhân viên: Xem tất cả'),
  ('labor.view_all', 'labor', 'Hợp đồng lao động: Xem tất cả')
on conflict (code) do nothing;

insert into public.role_permissions (tenant_id, role_id, permission_code)
select rp.tenant_id, rp.role_id, rp.permission_code || '_all'
from public.role_permissions rp join public.roles r on r.tenant_id = rp.tenant_id and r.id = rp.role_id
where rp.permission_code in ('staff.view', 'labor.view') and r.code not in ('driver', 'staff') and r.code not like 'rieng\_%'
on conflict do nothing;

-- Đọc hồ sơ riêng / lý lịch / giấy tờ / chữ ký của người khác: cần Xem tất cả (của chính mình vẫn xem được)
do $$
declare p record; f record; v text;
begin
  for p in select tablename, policyname, qual from pg_policies
           where schemaname = 'public' and tablename in ('staff_private', 'staff_records', 'labor_contracts') and cmd = 'SELECT'
  loop
    v := replace(replace(p.qual, '''staff.view''', '''staff.view_all'''), '''labor.view''', '''labor.view_all''');
    if v <> p.qual then execute format('alter policy %I on public.%I using (%s)', p.policyname, p.tablename, v); end if;
  end loop;
  for f in select pr.oid from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
           where n.nspname = 'app' and pr.proname in ('can_read_documents', 'can_read_signature')
  loop
    v := pg_get_functiondef(f.oid);
    execute replace(v, '''staff.view''', '''staff.view_all''');
  end loop;
end;
$$;
