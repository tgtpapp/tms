# Tài liệu dự án TMS

- **Thiết kế Giai đoạn 1** (đã phê duyệt 14/11/2026): tài liệu "TMS – Hệ sinh thái vận tải: Giai đoạn 1 – Phân tích & Thiết kế" trên claude.ai. Gồm 20 mục: mô hình kinh doanh, kiến trúc, multi-tenant, database, phân quyền, bán vé đa kênh, sổ cái, pháp lý, lộ trình, các quyết định đã chốt.
- Quy tắc bắt buộc khi phát triển: `../CLAUDE.md`.

## Lộ trình

| Giai đoạn | Nội dung | Trạng thái |
| --- | --- | --- |
| 1 | Phân tích & thiết kế | Đã duyệt 14/11/2026 |
| 2 | Nền tảng SaaS: đăng nhập, nhà xe, chi nhánh, người dùng, phân quyền, cấu hình, vai trò, nhật ký | Xong 18/11/2026 (tổ chức + nhà xe tự đăng ký để GĐ 8) |
| 3 | Tuyến, xe, ghế, chuyến, lái xe, nhân viên, đại lý, hồ sơ giấy tờ | Xong 19/11/2026: 3.1 tuyến + giá, 3.2 loại xe + sơ đồ ghế + xe + giấy tờ (AI đọc), 3.3 lái xe / nhân viên + lý lịch hành nghề, 3.4 lịch chạy + chuyến + xếp xe + in lệnh vận chuyển. **3.5 đại lý: tạm hoãn (chủ đầu tư chưa duyệt làm)** |
| 4 | Kho ghế, bán vé quầy, QR chuyển khoản, đổi/hủy/hoàn | Xong 19/11/2026: 4.1 bán vé quầy + in vé nhiệt, 4.2 QR chuyển khoản xác nhận tay, 4.3 đổi / hủy / hoàn theo mốc phí, 4.4 bán khi mất mạng + nhập vé giấy. Thêm: nhập dữ liệu app cũ, lịch chạy theo tuyến kiểu Vexere, giao diện mới |
| 5 | Marketplace | Chưa |
| 6 | Điều hành, app lái xe, trung chuyển, hợp đồng, hàng hóa, Zalo Bot, quét ảnh AI | Chưa |
| 7 | Tài chính, báo cáo | Chưa |
| 8 | Hoàn thiện thương mại | Chưa |
