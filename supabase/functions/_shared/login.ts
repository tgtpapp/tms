// Quy tắc đổi "số điện thoại + mã nhà xe" thành email đăng nhập nội bộ.
// Nhân viên chỉ thấy số điện thoại; email này không dùng để gửi thư.
// Giao diện web dùng cùng quy tắc (web/src/lib/login.ts) – hai nơi phải giống hệt.
export function loginEmail(phone: string, tenantCode: string, domain: string): string {
  return `${phone}.${tenantCode}@${domain}`.toLowerCase();
}

/** Mật khẩu quá dễ đoán (bị dò ra trong vài giây): dãy số liền nhau, một ký tự lặp lại, mật khẩu phổ biến, trùng số điện thoại */
const COMMON = ['123456', '1234567', '12345678', '123456789', '1234567890', '123123', '112233', '111222', '000000', '111111', '666666', '888888',
  'password', 'matkhau', 'qwerty', 'iloveyou', 'admin123', 'abcdef', 'abcd1234', '12345678a'];
export function weakPassword(pw: string, phone?: string): string | null {
  const p = pw.trim().toLowerCase();
  if (/^(.)\1+$/.test(p)) return 'Mật khẩu không được là một ký tự lặp lại';
  const seq = (s: string) => s.length >= 6 && /^\d+$/.test(s) && [...s].every((c, i) => i === 0 || Math.abs(Number(c) - Number(s[i - 1])) === 1)
    && [...s].every((c, i) => i < 2 || Number(c) - Number(s[i - 1]) === Number(s[1]) - Number(s[0]));
  if (seq(p)) return 'Mật khẩu không được là dãy số liền nhau (vd 123456)';
  if (COMMON.includes(p)) return 'Mật khẩu quá phổ biến, dễ bị dò ra';
  if (phone && p.replace(/\D/g, '') === phone.replace(/\D/g, '')) return 'Mật khẩu không được trùng số điện thoại';
  return null;
}
