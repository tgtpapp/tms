-- =====================================================================
-- Cấp quyền tường minh cho service_role (Edge Function).
-- Project Supabase thật tắt "tự cấp quyền API cho bảng mới", nên không được
-- dựa vào quyền mặc định. service_role chỉ dùng trong Edge Function.
-- =====================================================================

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Bảng / sequence tạo sau này (bởi migration) cũng tự cấp cho service_role
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
