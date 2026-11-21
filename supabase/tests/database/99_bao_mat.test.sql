-- Kiểm tra bảo mật toàn bộ database (chạy mỗi lần CI): bảng / hàm / view / storage mới thêm sau này cũng bị quét,
-- vi phạm là CI đỏ, không đưa lên được bản chạy thật.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

-- 1. Mọi bảng trong public bật RLS
select is(array(select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1), '{}'::text[],
          'Mọi bảng public đều bật RLS');

-- 2. Khách chưa đăng nhập (anon) không đọc / ghi trực tiếp bảng nào
select is(array(select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
                  and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')
                       or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE')) order by 1), '{}'::text[],
          'anon không có quyền trên bảng / view nào');

-- 3. Bảng có tenant_id: mọi chính sách RLS cho người dùng đều lọc theo nhà xe của phiên đăng nhập
select is(array(select distinct p.tablename::text from pg_policies p
                join information_schema.columns col on col.table_schema = p.schemaname and col.table_name = p.tablename and col.column_name = 'tenant_id'
                where p.schemaname = 'public' and p.cmd in ('SELECT', 'ALL', 'UPDATE', 'DELETE')
                  and coalesce(p.qual, '') !~ '(current_tenant_id|is_platform_admin|auth\.uid)' order by 1), '{}'::text[],
          'Chính sách đọc / sửa / xóa của bảng nhà xe đều lọc theo nhà xe (hoặc chính chủ)');
select is(array(select distinct p.tablename::text from pg_policies p
                join information_schema.columns col on col.table_schema = p.schemaname and col.table_name = p.tablename and col.column_name = 'tenant_id'
                where p.schemaname = 'public' and p.cmd in ('INSERT', 'ALL', 'UPDATE')
                  and coalesce(p.with_check, p.qual, '') !~ '(current_tenant_id|is_platform_admin|auth\.uid)' order by 1), '{}'::text[],
          'Chính sách thêm / sửa của bảng nhà xe đều ép đúng nhà xe');
select is(array(select p.tablename || '.' || p.policyname from pg_policies p
                where p.schemaname = 'public' and ('anon' = any (p.roles) or 'public' = any (p.roles)) order by 1), '{}'::text[],
          'Không có chính sách RLS mở cho anon / public');

-- 4. Hàm SECURITY DEFINER (chạy bằng quyền chủ) phải cố định search_path (chống chiếm quyền qua đối tượng giả)
select is(array(select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public', 'app') and p.prosecdef
                  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) x where x like 'search_path=%') order by 1), '{}'::text[],
          'Hàm SECURITY DEFINER đều đặt search_path');

-- 5. Khách chưa đăng nhập chỉ gọi được các hàm công khai đã duyệt (platform_initialized: màn hình khởi tạo lần đầu)
select is(array(select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public', 'app') and p.prokind = 'f'
                  and has_function_privilege('anon', p.oid, 'EXECUTE')
                  and p.proname not in (select unnest(array['platform_initialized']))
                  and p.prorettype <> 'trigger'::regtype order by 1), '{}'::text[],
          'anon chỉ gọi được hàm công khai đã duyệt');

-- 6. Hàm nội bộ svc_* chỉ cho service_role
select is(array(select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname in ('public', 'app') and p.proname like 'svc\_%'
                  and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')) order by 1), '{}'::text[],
          'Hàm svc_* không gọi được từ trình duyệt');

-- 7. Hàm trong schema app (nội bộ) không mở cho anon
select is(array(select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'app' and has_function_privilege('anon', p.oid, 'EXECUTE') and p.prorettype <> 'trigger'::regtype order by 1), '{}'::text[],
          'Hàm app.* không mở cho anon');

-- 8. Trình duyệt không ghi thẳng bảng ghế / tiền / lệnh / nhật ký (chỉ qua hàm có kiểm tra quyền)
select is(array(select t::text from unnest(array['seat_inventory', 'bookings', 'payments', 'ledger_entries', 'cash_ledger', 'transport_orders', 'transport_order_legs',
                  'audit_logs', 'notifications', 'notification_delivery_logs', 'push_config', 'order_scans', 'tenant_backups', 'tenant_drive']) t
                where to_regclass('public.' || t) is not null
                  and (has_table_privilege('authenticated', ('public.' || t)::regclass, 'INSERT') or has_table_privilege('authenticated', ('public.' || t)::regclass, 'UPDATE')
                       or has_table_privilege('authenticated', ('public.' || t)::regclass, 'DELETE')) order by 1), '{}'::text[],
          'Bảng ghế / tiền / lệnh / nhật ký / cấu hình bí mật: trình duyệt không ghi trực tiếp');
select is(array(select t::text from unnest(array['push_config', 'tenant_drive', 'notification_delivery_logs']) t
                where to_regclass('public.' || t) is not null and has_table_privilege('authenticated', ('public.' || t)::regclass, 'SELECT') order by 1), '{}'::text[],
          'Bảng chứa khóa / mã bí mật: trình duyệt không đọc');

-- 9. View chạy theo quyền người xem (không vượt RLS)
select is(array(select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind = 'v'
                  and not coalesce(c.reloptions @> array['security_invoker=true'] or c.reloptions @> array['security_invoker=on'], false) order by 1), '{}'::text[],
          'View public đều security_invoker');

-- 10. Kho tệp không công khai
select is(array(select id::text from storage.buckets where public order by 1), '{}'::text[], 'Không có bucket công khai');

select * from finish();
rollback;
