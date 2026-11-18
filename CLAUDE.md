# CLAUDE.md – Quy tắc bắt buộc của dự án TMS

Tệp này là "hiến pháp" của dự án. Mọi phiên làm việc phải đọc và tuân theo. Tài liệu thiết kế gốc (Giai đoạn 1, đã phê duyệt 14/11/2026): xem `docs/README.md`.

## 1. Cách làm việc với chủ đầu tư

- Trao đổi bằng tiếng Việt, ngắn gọn, không báo cáo dài.
- Làm từng bước một. Hỏi từng câu khi thiếu thông tin quan trọng.
- Chỉ làm đúng việc được giao. Không tự ý làm thêm khi chưa được duyệt; được đề xuất nhưng phải hỏi trước.
- Mỗi bước xong: kiểm tra kỹ rồi **tự đẩy lên GitHub** (nhánh `main`), không bắt chủ đầu tư tải tệp thủ công.
- Không đẩy code có thể làm mất dữ liệu hoặc hỏng chức năng đang chạy. CI phải xanh.
- Suy nghĩ như chuyên gia nghiệp vụ vận tải Việt Nam; chủ động đề xuất, nhưng chờ duyệt.

## 2. Công nghệ đã chốt

- TypeScript cho mọi phần.
- Giao diện: React + Vite trong `web/`, đăng lên Cloudflare Pages.
- Dữ liệu: Supabase (PostgreSQL, Auth, Storage, Realtime). **Không có máy chủ NestJS.**
- Logic ghế / tiền / phân quyền: hàm PostgreSQL (RPC) trong `supabase/migrations/`.
- Webhook và tích hợp ngoài: Supabase Edge Functions trong `supabase/functions/`.
- Việc định kỳ (nhả ghế hết hạn, sao lưu): `pg_cron`.
- Bản chạy thật: Supabase Free (Singapore). Bản thử + sao lưu đêm: Neon Free (Singapore).

## 3. Hạ tầng chỉ đổi bằng cấu hình

- Không viết cứng địa chỉ máy chủ, khóa, tên miền, tên nhà xe, tên tuyến, giá… trong code.
- Giao diện đọc cấu hình từ biến môi trường `VITE_*` (xem `web/.env.example`), qua một chỗ duy nhất `web/src/config.ts`.
- Chỉ dùng tính năng có ở cả Supabase Cloud lẫn Supabase tự cài, để có thể chuyển sang VPS mà không sửa code.
- Cấu trúc database chỉ thay đổi bằng migration trong `supabase/migrations/`, chạy lại được trên máy mới.
- Khóa bí mật (`service_role`, mật khẩu DB, chuỗi kết nối Neon) **không bao giờ** nằm trong kho code hay trình duyệt. Chỉ đặt trong secret của GitHub / Supabase / Cloudflare.

## 4. Đa nhà xe (multi-tenant) – không được vi phạm

- Mọi bảng nghiệp vụ có `tenant_id uuid not null`; mọi index bắt đầu bằng `tenant_id`.
- Khóa ngoại giữa bảng nghiệp vụ là khóa kép `(tenant_id, x_id)`.
- Bật `ENABLE ROW LEVEL SECURITY` trên mọi bảng tenant (không dùng FORCE: hàm SECURITY DEFINER của chủ bảng cần đọc/ghi để kiểm tra quyền; app không bao giờ kết nối bằng chủ bảng). Policy xác định nhà xe từ phiên đăng nhập (`auth.uid()` → `app.current_tenant_id()`), không bao giờ từ tham số client.
- Bảng mới không tự mở cho API; cấp quyền tường minh cho `authenticated` **và** `service_role` (project thật tắt tự cấp quyền; không dựa vào quyền mặc định của Supabase local).
- Trình duyệt **không được** INSERT/UPDATE/DELETE trực tiếp bảng ghế và bảng tiền; chỉ qua hàm RPC có kiểm tra quyền.
- Hàm mới trong schema public: `revoke execute ... from public, anon, authenticated` rồi GRANT tường minh. Hàm nội bộ đặt tên `svc_*`, chỉ GRANT cho `service_role`.
- Truy cập sai tenant phải trả "không tìm thấy". Mỗi module mới phải có kiểm thử truy cập chéo tenant.
- Super Admin không mặc nhiên đọc dữ liệu cá nhân / tài chính của nhà xe.
- Người dùng luôn xem được dữ liệu của chính mình, không xem được của người khác.

## 5. Ghế và tiền

- Một kho ghế duy nhất (`seat_inventory`) cho mọi kênh; giữ ghế bằng UPDATE có điều kiện trong transaction; ràng buộc EXCLUDE chống chồng chặng.
- Bán vé theo chặng: bật. Giữ ghế: quầy 5 phút, online/QR 15 phút (cấu hình được).
- Ghế dành cho Vexere tự nhả cho quầy trước giờ chạy (mặc định 2 tiếng, cấu hình được).
- Mọi API ghi có `Idempotency-Key`; webhook thanh toán chống lặp bằng UNIQUE event id.
- Tiền ghi bằng sổ cái kép, chỉ INSERT; sai thì bút toán đảo. Không sửa / xóa giao dịch tài chính.
- Không gộp tiền vé (doanh thu nhà xe) với hoa hồng / phí nền tảng.

## 6. Nghiệp vụ vận tải

- Chuyến hợp lệ chỉ khi đủ: giờ chạy + xe + lái xe.
- Vận tải hợp đồng là phân hệ riêng: không bán vé lẻ, không thu tiền theo từng khách.
- Không tự động xóa dữ liệu điều hành (giờ trống…) của tuyến khác.
- Tính năng giấy tờ cũ phải có nút ẩn/hiện giấy tờ cũ.
- Thông báo trong app tự ẩn sau khi đã báo.
- Điểm pháp lý chưa chắc chắn ghi rõ "cần xác minh"; không khẳng định tuân thủ khi chưa có căn cứ.

## 7. Chất lượng

- Mỗi thay đổi: `npm run check` trong `web/` phải đạt (typecheck + build). CI trên GitHub chạy lại toàn bộ.
- Không có nút bấm giả, không dùng dữ liệu demo thay nghiệp vụ thật.
- Giao diện ưu tiên dễ dùng cho nhân viên, chạy tốt trên điện thoại.
