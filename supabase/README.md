# supabase/

- `migrations/` – các bước tạo / sửa cấu trúc database, đặt tên `YYYYMMDDHHMMSS_mo_ta.sql`, chỉ thêm mới, không sửa migration đã chạy.
- `functions/` – Supabase Edge Functions (webhook thanh toán, tích hợp ngoài).

Migration phải chạy được trên cả Supabase Cloud, Supabase tự cài và Neon (bản thử).
