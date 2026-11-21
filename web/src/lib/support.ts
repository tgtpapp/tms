// Báo sự cố: ghi lại các lỗi gần nhất trên máy (chỉ trong bộ nhớ, không gửi đi khi chưa báo sự cố)
// và gom thông tin máy gửi kèm khi người dùng bấm "Báo sự cố".
import { setOnRpcError, supabase } from './supabase';

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
