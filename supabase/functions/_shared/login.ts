// Quy tắc đổi "số điện thoại + mã nhà xe" thành email đăng nhập nội bộ.
// Nhân viên chỉ thấy số điện thoại; email này không dùng để gửi thư.
// Giao diện web dùng cùng quy tắc (web/src/lib/login.ts) – hai nơi phải giống hệt.
export function loginEmail(phone: string, tenantCode: string, domain: string): string {
  return `${phone}.${tenantCode}@${domain}`.toLowerCase();
}
