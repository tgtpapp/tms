-- Lưu hồ sơ hàng loạt nhanh: nhớ mã thư mục Google Drive của từng thư mục hồ sơ (theo đường dẫn lúc tạo),
-- để Apps Script ghi thẳng vào thư mục, không phải dò từng cấp thư mục (trước đây khóa lần lượt, ~2 giây / tệp).
alter table public.archive_folders add column drive_id text, add column drive_path text;
