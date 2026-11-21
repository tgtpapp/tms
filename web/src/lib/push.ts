// Thông báo đẩy (Web Push): bật / tắt trên máy này, gửi các thông báo đang chờ sau mỗi thao tác ghi.
import { rpc, setAfterWrite, supabase } from './supabase';

let timer: ReturnType<typeof setTimeout> | undefined;
/** Gửi ngay các thông báo đang chờ của nhà xe (gom nhiều thao tác liền nhau thành 1 lần gọi) */
export function pushKick(): void {
  clearTimeout(timer);
  timer = setTimeout(() => { void supabase.functions.invoke('push', { body: { action: 'flush' } }).catch(() => undefined); }, 1200);
}
// Các lệnh ghi có thể tạo thông báo: bán / hủy / chuyển vé, xếp chuyến, lái xe báo khách…
const WRITES = /^(sell|book|quick|confirm|cancel|move|assign|crew_|trip_mark|release|refund|swap|reopen|add_extra|import|save_paper|pay_booking|change|sync)/;
setAfterWrite((fn) => { if (WRITES.test(fn)) pushKick(); });

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64: string): Uint8Array {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
async function reg(): Promise<ServiceWorkerRegistration> {
  const r = await navigator.serviceWorker.getRegistration();
  if (r) return r;
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}
/** Máy này đang nhận thông báo đẩy chưa */
export async function pushStatus(): Promise<'khong_ho_tro' | 'bi_chan' | 'tat' | 'bat'> {
  if (!pushSupported()) return 'khong_ho_tro';
  if (Notification.permission === 'denied') return 'bi_chan';
  const r = await navigator.serviceWorker.getRegistration();
  return (await r?.pushManager.getSubscription()) ? 'bat' : 'tat';
}
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('Trình duyệt này không hỗ trợ thông báo. Trên iPhone: cài app vào màn hình chính (iOS 16.4 trở lên) rồi mở từ biểu tượng app.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Bạn chưa cho phép thông báo. Vào cài đặt trình duyệt / điện thoại, cho phép thông báo của app rồi bấm lại.');
  const { data, error } = await supabase.functions.invoke('push', { body: { action: 'key' } });
  if (error || !data?.key) throw new Error('Chưa lấy được khóa thông báo, thử lại sau');
  const r = await reg();
  const sub = (await r.pushManager.getSubscription()) ?? await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(String(data.key)) as BufferSource });
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_device: navigator.userAgent.slice(0, 120) });
}
export async function disablePush(): Promise<void> {
  const r = await navigator.serviceWorker.getRegistration();
  const sub = await r?.pushManager.getSubscription();
  if (!sub) return;
  await rpc('remove_push_subscription', { p_endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}
