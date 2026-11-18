-- =====================================================================
-- VÁ BẢO MẬT: Supabase mặc định cho authenticated gọi mọi hàm trong schema
-- public. Hàm nội bộ svc_* chỉ dành cho service_role (Edge Function).
-- =====================================================================

revoke execute on function public.svc_register_app_user(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.svc_register_app_user(uuid, uuid, text, text, text) to service_role;

-- Hàm tạo sau này trong schema public: không tự mở cho anon/authenticated.
-- Mỗi hàm phải GRANT tường minh trong migration của nó.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
