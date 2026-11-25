// Giao diện của tôi (như app cũ): mỗi người tự chọn trong Tài khoản của tôi, lưu trên máy này.
// Chế độ sáng / tối / tự động, 8 mẫu, màu nhấn (+ tự chọn), font, cỡ chữ, mật độ, bo góc, menu trái, dùng ngoài trời, hoạt cảnh đón khách.
// Màu nhấn đổi bằng biến CSS (--primary…); bản in luôn nền trắng.
import { useEffect, useState } from 'react';

export type Mode = 'light' | 'dark' | 'auto';
export interface UiCfg {
  mode: Mode; preset: string; acc: string; custom: string; font: string; size: number;
  den: 'compact' | 'std' | 'roomy'; rad: 'sm' | 'md' | 'lg'; menu: 'pin' | 'auto'; out: boolean; anim: boolean;
}
export const ACC = [
  { id: 'goc', name: 'Mặc định', c: '#635bff' }, { id: 'sky', name: 'Xanh biển', c: '#0ea5e9' }, { id: 'blue', name: 'Xanh dương', c: '#2563eb' },
  { id: 'violet', name: 'Tím', c: '#7c3aed' }, { id: 'teal', name: 'Ngọc lam', c: '#0d9488' }, { id: 'emerald', name: 'Lục bảo', c: '#059669' },
  { id: 'rose', name: 'Hồng', c: '#e11d48' }, { id: 'amber', name: 'Hổ phách', c: '#d97706' }, { id: 'gold', name: 'Vàng kim', c: '#b8892e' }, { id: 'slate', name: 'Than chì', c: '#475569' },
  { id: 'nhansu', name: 'Xanh đậm', c: '#2f5bea' },
];
export const FONTS = [
  { id: 'bvp', name: 'Be Vietnam Pro' }, { id: 'inter', name: 'Inter' }, { id: 'roboto', name: 'Roboto' }, { id: 'nunito', name: 'Nunito' },
  { id: 'lexend', name: 'Lexend' }, { id: 'montserrat', name: 'Montserrat' }, { id: 'noto', name: 'Noto Sans' },
];
export const PRESETS: { id: string; name: string; d: string; v: Partial<UiCfg> }[] = [
  { id: 'saas', name: 'Premium SaaS', d: 'Mặc định, sáng sủa', v: { acc: 'goc', font: 'bvp', rad: 'md', den: 'std' } },
  { id: 'ocean', name: 'Đại dương', d: 'Xanh biển dịu mắt', v: { acc: 'sky', font: 'inter', rad: 'lg', den: 'std' } },
  { id: 'corp', name: 'Doanh nghiệp', d: 'Xanh dương, góc vuông', v: { acc: 'blue', font: 'roboto', rad: 'sm', den: 'compact' } },
  { id: 'emerald', name: 'Lục bảo', d: 'Xanh lá thanh lịch', v: { acc: 'emerald', font: 'bvp', rad: 'md', den: 'std' } },
  { id: 'royal', name: 'Hoàng gia', d: 'Vàng kim sang trọng', v: { acc: 'gold', font: 'montserrat', rad: 'md', den: 'std' } },
  { id: 'midnight', name: 'Nửa đêm', d: 'Tím trên nền tối', v: { acc: 'violet', font: 'inter', rad: 'lg', den: 'std', mode: 'dark' } },
  { id: 'graphite', name: 'Than chì', d: 'Tối giản, nền tối', v: { acc: 'slate', font: 'inter', rad: 'sm', den: 'compact', mode: 'dark' } },
  { id: 'sunset', name: 'Hoàng hôn', d: 'Cam ấm áp', v: { acc: 'amber', font: 'nunito', rad: 'lg', den: 'roomy' } },
  { id: 'nhansu', name: 'Xanh đậm', d: 'Xanh đậm như mẫu Nhân Sự Pro', v: { acc: 'nhansu', font: 'bvp', rad: 'lg', den: 'std' } },
];
export const DEF: UiCfg = { mode: 'light', preset: 'saas', acc: 'goc', custom: '', font: 'bvp', size: 100, den: 'std', rad: 'md', menu: 'pin', out: false, anim: false };

const KEY = 'tms-giao-dien-2';   // không dùng tiền tố "tms:" (bị xóa khi đăng xuất)
const OLD = 'tms-giao-dien';
const MENU = 'menu.ghim';        // menu trái: dùng chung với nút ghim trên menu

export function loadUi(): UiCfg {
  try {
    let c = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<UiCfg> | null;
    if (!c) {   // cấu hình cũ (4 mẫu) → mẫu gần nhất
      const o = JSON.parse(localStorage.getItem(OLD) ?? 'null') as { theme?: string; mode?: Mode } | null;
      const map: Record<string, string> = { 'luc-bao': 'emerald', 'hoang-hon': 'sunset', 'than-chi': 'corp' };
      const p = PRESETS.find((x) => x.id === map[o?.theme ?? '']);
      c = { ...(p?.v ?? {}), preset: p?.id ?? 'saas', mode: o?.mode ?? 'light' };
    }
    const menu = localStorage.getItem(MENU) === '0' ? 'auto' : 'pin';
    return { ...DEF, ...c, menu };
  } catch {
    return DEF;
  }
}

const darkQuery = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);
export const isDark = (c: UiCfg) => c.mode === 'dark' || (c.mode === 'auto' && !!darkQuery()?.matches);

function hsl(hex: string): [number, number, number] {
  const h = hex.replace('#', ''), r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let s = 0, H = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    H = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    H *= 60;
  }
  return [H, s, l];
}
const css = (H: number, s: number, l: number) => `hsl(${H.toFixed(0)} ${(Math.max(0, Math.min(1, s)) * 100).toFixed(0)}% ${(Math.max(0, Math.min(1, l)) * 100).toFixed(0)}%)`;
export const accHex = (c: UiCfg) => (c.acc === 'custom' && /^#[0-9a-f]{6}$/i.test(c.custom) ? c.custom : (ACC.find((a) => a.id === c.acc) ?? ACC[0]!).c);

function loadFont(id: string): string {
  const f = FONTS.find((x) => x.id === id) ?? FONTS[0]!;
  if (!document.getElementById(`uxf-${f.id}`)) {
    const l = document.createElement('link');
    l.id = `uxf-${f.id}`;
    l.rel = 'stylesheet';
    l.href = `https://fonts.googleapis.com/css2?family=${f.name.replace(/ /g, '+')}:wght@400;500;600;700&display=swap`;
    document.head.appendChild(l);
  }
  return `'${f.name}'`;
}

export function applyUi(c: UiCfg) {
  const h = document.documentElement, dark = isDark(c);
  const [H, S, L] = hsl(accHex(c));
  h.dataset.mode = dark ? 'dark' : 'light';
  h.dataset.den = c.den;
  h.dataset.out = c.out ? '1' : '0';
  h.style.colorScheme = dark ? 'dark' : 'light';
  const R = { sm: [8, 6], md: [14, 10], lg: [20, 14] }[c.rad] ?? [14, 10];
  const v: Record<string, string> = {
    '--primary': dark ? css(H, S, Math.max(L, 0.62)) : css(H, S, Math.min(L, 0.5)),
    '--primary-d': dark ? css(H, S, Math.max(L, 0.62) + 0.1) : css(H, S, Math.min(L, 0.5) - 0.08),
    '--primary-soft': dark ? css(H, S * 0.5, 0.18) : css(H, Math.min(S, 0.9), 0.96),
    '--primary-ring': dark ? css(H, S * 0.55, 0.36) : css(H, Math.min(S, 0.85), 0.85),
    '--sidebar': css(H, Math.min(S, 0.5) * 0.6, dark ? 0.07 : 0.1),
    '--radius': `${R[0]}px`, '--radius-s': `${R[1]}px`,
    '--ux-font': `${loadFont(c.font)}, Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`,
    '--ux-zoom': String((c.size / 100) * (c.out ? 1.08 : 1)),
  };
  for (const [k, x] of Object.entries(v)) h.style.setProperty(k, x);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f172a' : '#ffffff');
}

export function saveUi(c: UiCfg) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
    localStorage.setItem(MENU, c.menu === 'auto' ? '0' : '1');
  } catch { /* bỏ qua */ }
  applyUi(c);
  window.dispatchEvent(new Event('tms-ui'));
}

export function useUi(): [UiCfg, (c: UiCfg) => void] {
  const [cfg, setCfg] = useState(loadUi);
  useEffect(() => {
    const on = () => setCfg(loadUi());
    window.addEventListener('tms-ui', on);
    return () => window.removeEventListener('tms-ui', on);
  }, []);
  return [cfg, (c: UiCfg) => { saveUi(c); setCfg(c); }];
}

/** Gọi 1 lần lúc mở app: áp giao diện đã lưu, theo dõi máy đổi sáng / tối (chế độ tự động). */
export function initTheme() {
  applyUi(loadUi());
  darkQuery()?.addEventListener?.('change', () => applyUi(loadUi()));
}

/** Tên nhà xe ngắn in trên thân xe trong hoạt cảnh đón khách (bỏ chữ "Nhà xe" đầu tên) */
let BUS = '';
export const setBusName = (tenantName: string) => { BUS = tenantName.replace(/^\s*nhà\s*xe\s+/i, '').trim(); };
export const busName = () => BUS || 'Nhà xe';
