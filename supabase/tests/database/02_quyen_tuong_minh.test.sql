-- Quyền phải được cấp TƯỜNG MINH bằng migration, không dựa vào quyền mặc định của project
-- (project thật tắt "tự cấp quyền API cho bảng mới").
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- Mô phỏng project thật: thu hồi mọi quyền mặc định rồi chỉ áp lại các câu GRANT của migration
-- là không làm được trong 1 file test, nên kiểm tra trực tiếp từng quyền cần có.

select ok(has_table_privilege('service_role', 'public.tenants', 'SELECT'), 'service_role đọc được tenants');
select ok(has_table_privilege('service_role', 'public.app_users', 'SELECT'), 'service_role đọc được app_users');
select ok(has_function_privilege('service_role', 'public.svc_register_app_user(uuid, uuid, text, text, text)', 'EXECUTE'),
  'service_role gọi được svc_register_app_user');

select ok(not has_function_privilege('anon', 'public.svc_register_app_user(uuid, uuid, text, text, text)', 'EXECUTE'),
  'Khách (anon) không gọi được svc_register_app_user');
select ok(not has_function_privilege('authenticated', 'public.svc_register_app_user(uuid, uuid, text, text, text)', 'EXECUTE'),
  'Người đăng nhập không gọi được svc_register_app_user');
select ok(not has_table_privilege('anon', 'public.app_users', 'SELECT'), 'Khách (anon) không đọc được app_users');
select ok(not has_table_privilege('authenticated', 'public.app_users', 'INSERT'), 'Trình duyệt không thêm thẳng app_users');
select ok(not has_table_privilege('authenticated', 'public.user_roles', 'INSERT'), 'Trình duyệt không gán vai trò thẳng vào bảng');
select ok(not has_table_privilege('authenticated', 'public.audit_logs', 'INSERT'), 'Trình duyệt không ghi được nhật ký');

-- Không hàm nội bộ svc_* nào gọi được từ trình duyệt
select is((
  select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'svc\_%'
    and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))
), 0, 'Không hàm svc_* nào mở cho trình duyệt');

-- Mọi câu GRANT cho service_role phải nằm trong migration (không phụ thuộc mặc định)
select ok(exists (
  select 1 from supabase_migrations.schema_migrations where name = 'quyen_service_role'
), 'Có migration cấp quyền tường minh cho service_role');

select * from finish();
rollback;
