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

/** Ảnh vuông bo góc (biểu tượng app) từ ảnh đại diện / logo; pad = chừa lề cho biểu tượng kiểu "maskable" của Android */
async function iconFrom(blob: Blob, size: number, pad: number): Promise<string> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) throw new Error('canvas');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  const inner = size - pad * 2, side = Math.min(bmp.width, bmp.height);
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, pad, pad, inner, inner);
  bmp.close();
  return c.toDataURL('image/png');
}

let lastKey = '';
/** Đổi tên + biểu tượng app trên máy này theo nhà xe và ảnh của người đăng nhập (chưa có ảnh: logo nhà xe, không có nữa: biểu tượng chung).
    Biểu tượng được trình duyệt lấy lúc cài app (cần xác minh việc tự đổi biểu tượng sau khi đã cài trên từng loại máy). */
export async function brandApp(name: string, imageUrl: string | null) {
  const key = `${name}|${imageUrl ?? ''}`;
  if (key === lastKey) return;
  lastKey = key;
  try {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const base = await (await fetch('/manifest.webmanifest', { cache: 'no-store' })).json() as Record<string, unknown>;
    const sh = shortName(name);
    let icons = base.icons as { src: string }[];
    let touch: string | null = null;
    if (imageUrl) {
      const blob = await (await fetch(imageUrl)).blob();
      const [i192, i512, mask] = await Promise.all([iconFrom(blob, 192, 0), iconFrom(blob, 512, 0), iconFrom(blob, 512, 56)]);
      icons = [{ src: i192, sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: i512, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: mask, sizes: '512x512', type: 'image/png', purpose: 'maskable' }] as unknown as { src: string }[];
      touch = i192;
    } else {
      icons = icons.map((i) => ({ ...i, src: new URL(i.src, location.origin).href }));
    }
    const abs = (u: unknown) => new URL(String(u ?? '/'), location.origin).href;
    const st = base.share_target as { action: string } | undefined;
    const m = { ...base, name, short_name: sh, start_url: abs(base.start_url), scope: abs(base.scope), id: abs(base.id), icons,
      ...(st ? { share_target: { ...st, action: abs(st.action) } } : {}) };
    if (link) {
      const old = link.href;
      link.href = URL.createObjectURL(new Blob([JSON.stringify(m)], { type: 'application/manifest+json' }));
      if (old.startsWith('blob:')) URL.revokeObjectURL(old);
    }
    const t = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
    if (t) t.content = sh;
    if (touch) {
      for (const rel of ['apple-touch-icon', 'icon']) {
        let l = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
        if (!l) { l = document.createElement('link'); l.rel = rel; document.head.appendChild(l); }
        l.href = touch;
      }
    }
  } catch { lastKey = ''; }
}
