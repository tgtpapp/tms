// Màu thẻ giờ chạy (Bán vé, Gửi hàng, Điều hành dạng thẻ): mỗi người tự chọn trong Giao diện của tôi, lưu trên máy này.
//   mac_dinh : màu chủ đạo của app
//   tuyen    : mỗi tuyến (theo chiều) 1 màu
//   gio      : mỗi giờ chạy 1 màu (ngẫu nhiên, cố định)
//   seed     : bấm "Đổi màu" để xáo bộ màu khác
import { useEffect, useState } from 'react';

export interface TripColorCfg { mode: 'mac_dinh' | 'tuyen' | 'gio'; seed: number }
const KEY = 'tms.mau_gio_chay';
export const TRIP_COLOR_DEF: TripColorCfg = { mode: 'tuyen', seed: 0 };
const PALETTE = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#db2777', '#b45309', '#0d9488', '#be123c', '#4f46e5', '#15803d', '#9333ea'];

export function tripColorCfg(): TripColorCfg {
  try { return { ...TRIP_COLOR_DEF, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } as TripColorCfg; } catch { return TRIP_COLOR_DEF; }
}
export function saveTripColorCfg(c: TripColorCfg) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* bỏ qua */ }
  window.dispatchEvent(new Event('tms-mau-gio'));
}
export function useTripColorCfg(): TripColorCfg {
  const [c, setC] = useState(tripColorCfg);
  useEffect(() => { const on = () => setC(tripColorCfg()); window.addEventListener('tms-mau-gio', on); return () => window.removeEventListener('tms-mau-gio', on); }, []);
  return c;
}
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
const shade = (hex: string, k: number) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('')}`;

/** Biến CSS cho 1 thẻ giờ: --tc (màu), --tc-d (đậm), --tc-bg (nền nhạt bên phải) */
export function tripColorVars(c: TripColorCfg, routeId: string, dir: string, hhmm: string): Record<string, string> {
  if (c.mode === 'mac_dinh') return { '--tc': 'var(--primary)', '--tc-d': 'var(--primary-d)', '--tc-bg': 'var(--primary-soft)' };
  const base = c.mode === 'tuyen' ? hash(`${routeId}|${dir}`) : hash(`${routeId}|${dir}|${hhmm}`);
  const col = PALETTE[(base + c.seed) % PALETTE.length]!;
  return { '--tc': col, '--tc-d': shade(col, 0.55), '--tc-bg': `${col}14` };
}
