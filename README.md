# TMS – Transport Ecosystem

Nền tảng quản lý vận tải đa nhà xe, kèm sàn đặt vé (giai đoạn sau). Nhà xe chạy thử đầu tiên: Nhà Xe Thịnh Phát.

## Cấu trúc

| Thư mục | Nội dung |
| --- | --- |
| `web/` | Giao diện (React + TypeScript + Vite), đăng lên Cloudflare Pages |
| `supabase/` | Cấu trúc database (migration), hàm xử lý, Edge Functions |
| `docs/` | Tài liệu thiết kế và vận hành |
| `CLAUDE.md` | Quy tắc bắt buộc khi phát triển |

## Chạy giao diện trên máy

```bash
cd web
cp .env.example .env.local   # điền địa chỉ Supabase
npm install
npm run dev
```

## Môi trường

| Môi trường | Địa chỉ | Database | Cấu hình |
| --- | --- | --- | --- |
| production | https://tms-ebj.pages.dev | Supabase (Singapore) | `web/.env.production` |
| staging | (chưa dựng) | Neon (Singapore) | khai báo khi dựng bản thử |

Cloudflare Pages tự dựng lại trang mỗi khi có code mới trên nhánh `main` (root `web`, lệnh `npm install && npm run build`, thư mục `dist`, `NODE_VERSION=22`).

Đổi máy chủ chỉ cần đổi cấu hình, không sửa code (xem `CLAUDE.md` mục 3).
