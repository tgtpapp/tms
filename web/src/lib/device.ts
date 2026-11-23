// Mã thiết bị (lưu trên máy) + tên thiết bị đọc từ trình duyệt: dùng cho Quản lý thiết bị đăng nhập / duyệt thiết bị lạ.
const KEY = 'tms.thiet_bi';
const QR_KEY = 'tms.qr_vua_dang_nhap';

export function deviceId(): string {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
    return id;
  } catch {
    return '';
  }
}

/** "Chrome · Windows", "Samsung Internet · Android"… từ chuỗi trình duyệt */
export function deviceName(ua: string | null = typeof navigator === 'undefined' ? null : navigator.userAgent): { name: string; mobile: boolean } {
  const u = ua ?? '';
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows'
    : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : '';
  const br = /Zalo/i.test(u) ? 'Zalo' : /SamsungBrowser/.test(u) ? 'Samsung Internet' : /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera'
    : /CocCoc|coc_coc/i.test(u) ? 'Cốc Cốc' : /Firefox|FxiOS/.test(u) ? 'Firefox' : /Chrome|CriOS/.test(u) ? 'Chrome' : /Safari/.test(u) ? 'Safari' : '';
  const name = [br, os].filter(Boolean).join(' · ') || 'Thiết bị không rõ';
  return { name, mobile: /iPhone|Android|iPad|Mobile/.test(u) };
}

/** Vừa đăng nhập bằng mã QR: giữ mã để lần báo thiết bị đầu tiên được duyệt luôn */
export function setQrJustUsed(v: { id: string; secret: string } | null) {
  try { if (v) sessionStorage.setItem(QR_KEY, JSON.stringify(v)); else sessionStorage.removeItem(QR_KEY); } catch { /* bỏ qua */ }
}
export function qrJustUsed(): { id: string; secret: string } | null {
  try { const s = sessionStorage.getItem(QR_KEY); return s ? JSON.parse(s) as { id: string; secret: string } : null; } catch { return null; }
}
