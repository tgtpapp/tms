-- =====================================================================
-- Dung lượng đã dùng (Cấu hình → Dung lượng): database của cả hệ thống, file của cả hệ thống,
-- file của riêng nhà xe (bucket giay-to/<nhà xe>/…). Chỉ người có settings.manage xem. Chỉ đọc số tổng, không lộ dữ liệu.
-- Hồ sơ trong Lưu trữ hồ sơ nằm trên Google Drive của nhà xe nên không tính ở đây (chỉ đếm số hồ sơ, tổng dung lượng ghi nhận).
-- =====================================================================
create function public.storage_usage()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('settings.manage') then
    raise exception 'Không có quyền xem dung lượng' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'files_bytes', (select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects),
    'tenant_files_bytes', (select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects
                           where bucket_id = 'giay-to' and (storage.foldername(name))[1] = v_tid::text),
    'tenant_files_count', (select count(*) from storage.objects where bucket_id = 'giay-to' and (storage.foldername(name))[1] = v_tid::text),
    'drive_items', (select count(*) from public.archive_items where tenant_id = v_tid and kind = 'file'),
    'drive_bytes', (select coalesce(sum(size_bytes), 0) from public.archive_items where tenant_id = v_tid and kind = 'file')
  );
end;
$$;
revoke execute on function public.storage_usage() from public, anon, authenticated;
grant execute on function public.storage_usage() to authenticated;
