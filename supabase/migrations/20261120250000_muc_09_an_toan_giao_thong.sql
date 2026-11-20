-- Kho hồ sơ: mục "An toàn giao thông" trong mỗi năm đánh số 09 (sau "08. Điều hành xe").
-- Chỉ đổi tên thư mục, không đụng hồ sơ bên trong. Mã thư mục Drive đã nhớ tự dò lại theo đường dẫn mới.
update public.archive_folders f
   set name = '09. An toàn giao thông'
 where lower(btrim(f.name)) = 'an toàn giao thông'
   and exists (select 1 from public.archive_folders p
                where p.tenant_id = f.tenant_id and p.id = f.parent_id and p.name ~ '^\d{4}$')
   and not exists (select 1 from public.archive_folders s
                    where s.tenant_id = f.tenant_id and s.parent_id = f.parent_id and s.id <> f.id
                      and lower(btrim(s.name)) = '09. an toàn giao thông');
