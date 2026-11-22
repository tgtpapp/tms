// Báo sự cố: ghi lại các lỗi gần nhất trên máy (chỉ trong bộ nhớ, không gửi đi khi chưa báo sự cố)
// và gom thông tin máy gửi kèm khi người dùng bấm "Báo sự cố".
import { setOnRpcError, supabase } from './supabase';
import { newVersionAvailable } from './version';
import { clearCache } from './offline';

const MAX = 10;
const recent: string[] = [];

export function noteError(where: string, e: unknown) {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
  const line = `${new Date().toLocaleTimeString('vi-VN', { hour12: false })} ${where}: ${String(msg).slice(0, 400)}`;
  if (recent[recent.length - 1] === line) return;
  recent.push(line);
  if (recent.length > MAX) recent.shift();
}

let installed = false;
export function installErrorLog() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => noteError('Lỗi trang', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => noteError('Lỗi chưa xử lý', e.reason));
  setOnRpcError((fn, msg) => noteError(fn, msg));
}

export interface SupportContext { screen?: string; path: string; ua: string; online: boolean; at: string; errors: string[] }

export function supportContext(screen?: string): SupportContext {
  return { screen, path: location.pathname, ua: navigator.userAgent, online: navigator.onLine, at: new Date().toISOString(), errors: [...recent] };
}

/** Gửi sự cố từ màn hình đăng nhập (chưa đăng nhập) */
export async function reportFromLogin(code: string, phone: string, text: string): Promise<void> {
  const { error } = await supabase.functions.invoke('support', {
    body: { action: 'login_report', code, phone, text, context: supportContext('Đăng nhập') },
  });
  if (error) throw new Error('Chưa gửi được, kiểm tra mạng rồi thử lại');
}

/** Màn hình và quyền cần để thấy màn hình đó (giống điều kiện hiện mục ở TenantShell) + từ người dùng hay gọi */
export const SCREENS: { key: string; label: string; perm: string; words: string[] }[] = [
  { key: 'sell', label: 'Bán vé', perm: 'sell.view', words: ['ban ve', 'dat ve', 'so do ghe', 'ghe', 've xe', 'quay ve'] },
  { key: 'parcels', label: 'Gửi hàng', perm: 'parcel.view', words: ['gui hang', 'hang hoa', 'kien hang'] },
  { key: 'charters', label: 'Hợp đồng', perm: 'charter.view', words: ['hop dong van chuyen', 'xe hop dong', 'thue xe'] },
  { key: 'trips', label: 'Điều hành', perm: 'trip.view', words: ['dieu hanh', 'xep xe', 'xep chuyen', 'lich chay', 'cap lenh', 'lenh van chuyen'] },
  { key: 'safety', label: 'Giám sát ATGT', perm: 'safety.view', words: ['atgt', 'an toan giao thong', 'giam sat'] },
  { key: 'routes', label: 'Tuyến', perm: 'route.view', words: ['tuyen', 'diem dung', 'gia ve', 'bang gia', 'chang'] },
  { key: 'repairs', label: 'Sửa chữa', perm: 'repair.view', words: ['sua chua', 'sua xe', 'phieu sua'] },
  { key: 'fuel', label: 'Nhiên liệu', perm: 'fuel.view', words: ['nhien lieu', 'do dau', 'phieu dau', 'dau'] },
  { key: 'reports', label: 'Báo cáo', perm: 'report.view', words: ['bao cao', 'doanh thu'] },
  { key: 'km', label: 'Km xe', perm: 'km.view', words: ['km xe', 'so km'] },
  { key: 'vehicles', label: 'Xe', perm: 'vehicle.view', words: ['danh sach xe', 'ho so xe', 'giay to xe', 'dang kiem'] },
  { key: 'staff', label: 'Lái xe & nhân viên', perm: 'staff.view', words: ['nhan vien', 'lai xe', 'tai xe', 'ho so lai xe'] },
  { key: 'labor', label: 'Hợp đồng lao động', perm: 'labor.view', words: ['hop dong lao dong'] },
  { key: 'timesheet', label: 'Bảng chấm công', perm: 'timesheet.view', words: ['cham cong'] },
  { key: 'docs', label: 'Văn bản', perm: 'doc.view', words: ['van ban', 'cong van'] },
  { key: 'archive', label: 'Lưu trữ hồ sơ', perm: 'archive.view', words: ['luu tru', 'ho so', 'drive'] },
  { key: 'users', label: 'Người dùng', perm: 'user.view', words: ['nguoi dung', 'tai khoan nhan vien'] },
  { key: 'roles', label: 'Vai trò', perm: 'role.view', words: ['vai tro', 'phan quyen'] },
  { key: 'settings', label: 'Cấu hình', perm: 'settings.view', words: ['cau hinh', 'cai dat'] },
  { key: 'audit', label: 'Nhật ký', perm: 'audit.view', words: ['nhat ky'] },
];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

/** Đoán màn hình người dùng nói tới: theo chữ trong nội dung, không có thì màn hình vừa mở */
export function guessScreen(text: string, lastKey?: string) {
  const t = norm(text);
  let best: (typeof SCREENS)[number] | undefined, len = 0;
  for (const s of SCREENS) for (const w of s.words) if (w.length > len && new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(t)) { best = s; len = w.length; }
  return best ?? SCREENS.find((s) => s.key === lastKey);
}

export interface ClientChecks { online: boolean; new_version: boolean | null; session: 'ok' | 'loi' }

/** Kiểm tra trên máy: mạng, bản app, phiên đăng nhập (làm mới phiên nếu hết hạn) */
export async function clientChecks(): Promise<ClientChecks> {
  const [nv, ss] = await Promise.all([
    newVersionAvailable(),
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return 'loi' as const;
      if ((data.session.expires_at ?? 0) * 1000 > Date.now() + 30_000) return 'ok' as const;
      const r = await supabase.auth.refreshSession();
      return r.error || !r.data.session ? ('loi' as const) : ('ok' as const);
    })().catch(() => 'loi' as const),
  ]);
  return { online: navigator.onLine, new_version: nv, session: ss };
}

/** Xóa bộ nhớ tạm của app (giữ vé chờ gửi và phiên đăng nhập) rồi tải lại */
export async function clearAppCacheAndReload() {
  clearCache();
  try { if ('caches' in window) for (const k of await caches.keys()) if (k !== 'tms-share') await caches.delete(k); } catch { /* bỏ qua */ }
  window.location.reload();
}
