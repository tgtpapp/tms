// Giao diện: mẫu (màu chủ đạo, bo góc…) + chế độ sáng / tối / tự động. Lưu trên máy này.
// Thêm mẫu mới: thêm 1 dòng vào THEMES và 1 khối CSS html[data-theme="<id>"] trong styles.css (chỉ đổi biến màu).
import { useEffect, useState } from 'react';

export interface ThemeDef { id: string; name: string; note: string; swatch: string }
export const THEMES: ThemeDef[] = [
  { id: 'hien-dai', name: 'Hiện đại', note: 'Mặc định: xanh dương, sạch, thoáng', swatch: '#2563eb' },
  { id: 'luc-bao', name: 'Lục bảo', note: 'Xanh lá dịu mắt', swatch: '#059669' },
  { id: 'hoang-hon', name: 'Hoàng hôn', note: 'Cam ấm', swatch: '#ea580c' },
  { id: 'than-chi', name: 'Than chì', note: 'Tối giản, góc vuông hơn', swatch: '#334155' },
];
export type Mode = 'light' | 'dark' | 'auto';
export interface ThemeCfg { theme: string; mode: Mode }

const KEY = 'tms-giao-dien';   // không dùng tiền tố "tms:" (bị xóa khi đăng xuất)
const DEFAULT: ThemeCfg = { theme: 'hien-dai', mode: 'light' };

export function loadTheme(): ThemeCfg {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ThemeCfg> | null;
    return {
      theme: THEMES.some((t) => t.id === c?.theme) ? c!.theme! : DEFAULT.theme,
      mode: c?.mode === 'dark' || c?.mode === 'auto' ? c.mode : 'light',
    };
  } catch {
    return DEFAULT;
  }
}

const darkQuery = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);

export function applyTheme(c: ThemeCfg) {
  const h = document.documentElement;
  const dark = c.mode === 'dark' || (c.mode === 'auto' && !!darkQuery()?.matches);
  h.dataset.theme = c.theme;
  h.dataset.mode = dark ? 'dark' : 'light';
  h.style.colorScheme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f172a' : '#ffffff');
}

/** Gọi 1 lần lúc mở app: áp giao diện đã lưu, theo dõi máy đổi sáng / tối (chế độ tự động). */
export function initTheme() {
  applyTheme(loadTheme());
  darkQuery()?.addEventListener?.('change', () => applyTheme(loadTheme()));
}

export function useTheme(): [ThemeCfg, (c: ThemeCfg) => void] {
  const [cfg, setCfg] = useState(loadTheme);
  useEffect(() => applyTheme(cfg), [cfg]);
  return [cfg, (c: ThemeCfg) => {
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* bỏ qua */ }
    setCfg(c);
  }];
}
