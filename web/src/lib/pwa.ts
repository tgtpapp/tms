import { config } from '../config';
// Cài app vào máy (như app cũ): nhớ lời mời cài của trình duyệt, đổi tên / biểu tượng app theo nhà xe và người đăng nhập.
interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let ev: InstallEvent | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Gọi 1 lần khi mở app */
export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ev = e as InstallEvent; emit(); });
  window.addEventListener('appinstalled', () => { ev = null; emit(); });
}
export const onPwa = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const canPrompt = () => !!ev;
export const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches
  || (navigator as unknown as { standalone?: boolean }).standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = () => /android/i.test(navigator.userAgent);

/** Hiện hộp cài của trình duyệt; trả true nếu người dùng đồng ý */
export async function promptInstall(): Promise<boolean> {
  if (!ev) return false;
  const e = ev; ev = null; emit();
  await e.prompt();
  const r = await e.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
  return r.outcome === 'accepted';
}

/** Tên ngắn dưới biểu tượng: bỏ chữ "Nhà xe" đầu tên */
export const shortName = (name: string) => name.replace(/^\s*nhà\s*xe\s+/i, '').trim().slice(0, 24) || name;

let lastKey = '';
/** Đổi tên + biểu tượng app trên máy này theo nhà xe và ảnh đại diện của người đăng nhập (chưa có ảnh: logo nhà xe, không có nữa: biểu tượng chung).
    Tệp cài app và biểu tượng lấy từ hàm app-install (địa chỉ mở công khai): Chrome trên Android dựng app trên máy chủ Google nên
    không dùng được tệp tạo tạm trên máy. Biểu tượng được lấy lúc cài app; đổi ảnh sau khi cài thì máy có thể vài ngày sau mới đổi (cần xác minh). */
export function brandApp(name: string, tenantId: string, staffId: string | null, version: string) {
  const key = `${name}|${tenantId}|${staffId ?? ''}|${version}`;
  if (key === lastKey) return;
  lastKey = key;
  const fn = `${config.supabaseUrl}/functions/v1/app-install`;
  const qs = new URLSearchParams({ t: tenantId, ...(staffId ? { s: staffId } : {}), ...(version ? { v: version } : {}) });
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (link) link.href = `${fn}?${new URLSearchParams({ m: '1', o: location.origin, n: name, ...Object.fromEntries(qs) })}`;
  const t = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
  if (t) t.content = shortName(name);
  let l = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (!l) { l = document.createElement('link'); l.rel = 'apple-touch-icon'; document.head.appendChild(l); }
  l.href = `${fn}?${qs}&z=192`;
}
