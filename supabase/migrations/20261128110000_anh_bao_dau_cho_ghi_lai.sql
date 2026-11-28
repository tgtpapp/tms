-- =====================================================================
-- Ảnh báo đổ dầu: lái xe được ghi lại (thay) ảnh của chính mình cùng tên.
-- Lỗi gốc: lần tải đầu đã lưu xong trên máy chủ nhưng máy lái xe báo lỗi mạng → app thử lại cùng tên tệp →
-- thành "sửa" dòng đã có, mà chưa có quy tắc cho phép sửa → báo "Không có quyền lưu tệp này".
-- =====================================================================
create policy f_bao_dau_update on public.file_store for update to authenticated
  using ((storage.foldername(name))[1] = app.current_tenant_id()::text and (storage.foldername(name))[2] = 'bao_dau'
         and app.is_my_staff((storage.foldername(name))[3]))
  with check ((storage.foldername(name))[1] = app.current_tenant_id()::text and (storage.foldername(name))[2] = 'bao_dau'
              and app.is_my_staff((storage.foldername(name))[3]));
