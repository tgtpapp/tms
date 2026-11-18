// Quy tắc đổi "số điện thoại + mã nhà xe" thành email đăng nhập nội bộ.
// PHẢI giống hệt supabase/functions/_shared/login.ts.
export function loginEmail(phone: string, tenantCode: string, domain: string): string {
  return `${phone}.${tenantCode}@${domain}`.toLowerCase();
}

export const PHONE_RE = /^0[0-9]{9}$/;
export const MIN_PASSWORD = 6;
