// Đầu trang in dùng chung (trừ giấy tờ hành chính có Quốc hiệu): logo bên trái; tên công ty, địa chỉ, liên hệ bên phải; đường kẻ ngang đen bên dưới.
// Dữ liệu lấy từ Cấu hình → Thông tin công ty (tên pháp lý, địa chỉ, điện thoại, hotline, email, website, logo).
import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { companyFileUrl } from './documents';
import { toDataUrl } from './pdfMaker';

export interface Brand { name: string; address: string; phone: string; hotline: string; email: string; website: string; logo: string | null }

let cur: Brand | null = null;
let memo: { at: number; p: Promise<Brand> } | null = null;

/** Thông tin đầu trang (logo dạng data URL để in và lưu PDF được), nhớ 5 phút */
export function loadBrand(): Promise<Brand> {
  if (memo && Date.now() - memo.at < 300_000) return memo.p;
  const p = (async () => {
    const [t, s] = await Promise.all([
      supabase.from('tenants').select('id, name, legal_name, address, phone').maybeSingle(),
      supabase.from('tenant_settings').select('key, value').in('key', ['cong_ty.email', 'cong_ty.website', 'cong_ty.hotline']),
    ]);
    const x = t.data as { id?: string; name?: string; legal_name?: string | null; address?: string | null; phone?: string | null } | null;
    const rows = (s.data ?? []) as { key: string; value: unknown }[];
    const v = (k: string) => String(rows.find((r) => r.key === k)?.value ?? '').trim();
    const logo = x?.id ? await toDataUrl(await companyFileUrl(x.id, 'logo.png').catch(() => null)).catch(() => null) : null;
    const b: Brand = { name: x?.legal_name || x?.name || '', address: x?.address ?? '', phone: x?.phone ?? '', hotline: v('cong_ty.hotline'),
      email: v('cong_ty.email'), website: v('cong_ty.website'), logo };
    cur = b;
    window.dispatchEvent(new Event('tms-brand'));
    return b;
  })();
  memo = { at: Date.now(), p };
  p.catch(() => { memo = null; });
  return p;
}
/** Gọi sau khi sửa Thông tin công ty / logo */
export function brandChanged(): void { memo = null; void loadBrand().catch(() => undefined); }

export function useBrand(): Brand | null {
  const [b, setB] = useState<Brand | null>(cur);
  useEffect(() => {
    const on = () => setB(cur);
    window.addEventListener('tms-brand', on);
    void loadBrand().then(setB).catch(() => undefined);
    return () => window.removeEventListener('tms-brand', on);
  }, []);
  return b;
}

export const contacts = (b: Brand) =>
  [b.phone && `ĐT: ${b.phone}`, b.hotline && `Hotline: ${b.hotline}`, b.email && `Email: ${b.email}`, b.website && `Website: ${b.website}`].filter(Boolean) as string[];

const esc = (t: unknown) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Đầu trang A4 dạng HTML (bảng 2 ô: ô logo cố định bề rộng nên chữ không bao giờ chồng lên logo) */
export function letterhead(b: Brand): string {
  const c = contacts(b);
  return `<table style="width:100%;border-collapse:collapse;margin:0"><tr>
  ${b.logo ? `<td style="width:32mm;padding:0 4mm 0 0;vertical-align:middle"><img src="${b.logo}" alt="" style="display:block;max-width:28mm;max-height:22mm;object-fit:contain"></td>` : ''}
  <td style="vertical-align:middle;line-height:1.4"><div style="font-weight:bold;font-size:15px">${esc(b.name.toUpperCase())}</div>
  ${b.address ? `<div style="font-size:12px">Địa chỉ: ${esc(b.address)}</div>` : ''}${c.length ? `<div style="font-size:12px">${esc(c.join(' · '))}</div>` : ''}</td></tr></table>
  <div style="border-top:1.5px solid #000;margin:5px 0 8px"></div>`;
}

/* ---------- Màn chờ lúc tải lại trang: tên nhà xe + logo chìm của nhà xe đăng nhập lần trước trên máy này ---------- */
const SPLASH_KEY = 'tms.man_cho';
export function splashBrand(): { name: string; logo: string | null } | null {
  try { return JSON.parse(localStorage.getItem(SPLASH_KEY) ?? 'null') as { name: string; logo: string | null } | null; } catch { return null; }
}
/** Nhớ tên + logo (thu nhỏ 256px cho nhẹ) */
export async function rememberSplash(name: string, logo: string | null) {
  let small: string | null = null;
  if (logo) {
    try {
      const img = new Image(); img.src = logo; await img.decode();
      const k = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
      small = c.toDataURL('image/png');
    } catch { small = null; }
  }
  try { localStorage.setItem(SPLASH_KEY, JSON.stringify({ name, logo: small })); } catch { /* bỏ qua */ }
  setFavicon(small);
}

/** Biểu tượng trên thanh địa chỉ / thẻ trình duyệt = logo nhà xe (vuông, nền trong); chưa có logo thì giữ biểu tượng mặc định */
export function setFavicon(logo: string | null | undefined) {
  if (!logo) return;
  const img = new Image();
  img.onload = () => {
    try {
      const n = 64, c = document.createElement('canvas'); c.width = n; c.height = n;
      const k = Math.min(n / img.naturalWidth, n / img.naturalHeight), w = img.naturalWidth * k, h = img.naturalHeight * k;
      c.getContext('2d')?.drawImage(img, (n - w) / 2, (n - h) / 2, w, h);
      let l = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); }
      l.type = 'image/png'; l.href = c.toDataURL('image/png');
    } catch { /* giữ biểu tượng mặc định */ }
  };
  img.src = logo;
}
