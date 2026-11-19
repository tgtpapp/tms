// Nhập điều hành xe (như app cũ): dán trang "Điều hành xe" của Vexere, hoặc file Excel / CSV / bảng dán từ Excel.
// Chỉ đọc chữ có sẵn, không đoán. Kết quả là danh sách { ngày, tuyến, giờ, biển số, lái xe }.

export interface ImportItem { ngay: string; tuyen: string; gio: string; bks: string; lai: string; cho: number }
export interface Parsed { kind: 'vexere' | 'list' | 'grid' | ''; items: ImportItem[]; warn: string[]; routes: number; ngay: string; nHuy: number }

const pad = (n: number) => String(n).padStart(2, '0');
/** bỏ dấu, viết thường, gọn khoảng trắng */
export const norm = (s: string) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
/** so tên tuyến: bỏ dấu, bỏ "bx", mọi kiểu gạch / mũi tên coi như nhau */
export const routeKey = (s: string) => norm(s).replace(/\b(bx|ben xe)\b/g, ' ').replace(/[⇄→⇒>–—-]+/g, '|').replace(/\s*\|\s*/g, '|').replace(/\s+/g, ' ').trim();
export const plateKey = (s: string) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
/** NGUYỄN QUANG DUY → Nguyễn Quang Duy */
export const titleCase = (s: string) => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi').replace(/(^|\s)(\S)/g, (_m, a: string, b: string) => a + b.toLocaleUpperCase('vi'));

export function cellDate(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === 'number' && v > 20000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  return '';
}

export function cellTime(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // Excel lưu giờ như ngày 1899-12-30 hh:mm (giờ UTC)
    return v.getUTCFullYear() < 1901 ? `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` : `${pad(v.getHours())}:${pad(v.getMinutes())}`;
  }
  if (typeof v === 'number' && v >= 0 && v < 1) { const t = Math.round(v * 1440); return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`; }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 24) return `${pad(v)}:00`;
  const m = String(v ?? '').trim().match(/^(\d{1,2})\s*[:hg.]\s*(\d{2})?$/i);
  if (!m) return '';
  const h = +m[1], mi = +(m[2] ?? 0);
  return h < 24 && mi < 60 ? `${pad(h)}:${pad(mi)}` : '';
}

/** "60F-004.39 Vũ Tiến Hùng" → biển số + tên */
export function splitCell(txt: string): { bks: string; lai: string } {
  const s = String(txt ?? '').trim();
  if (!s) return { bks: '', lai: '' };
  const m = s.match(/\b\d{2}[A-ZĐ]{1,2}[\s-]?\d{3,4}[.\s]?\d{0,2}\b/i);
  const bks = m ? m[0] : '';
  const lai = (m ? s.replace(m[0], ' ') : s).replace(/[-–|,;/\n]+/g, ' ').replace(/\(\s*\d+\s*(vé|ve|khách)?\s*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  return { bks, lai };
}

/** Bảng (Excel / CSV / dán từ Excel): kiểu danh sách (cột Ngày, Tuyến, Giờ, Biển số, Lái xe) hoặc bảng điều hành (hàng = tuyến, cột = giờ) */
export function parseRows(rows: unknown[][]): Parsed {
  const empty: Parsed = { kind: '', items: [], warn: [], routes: 0, ngay: '', nHuy: 0 };
  const H = (s: unknown) => norm(String(s ?? '')).replace(/\s/g, '');
  const find = (hdr: string[], keys: string[]) => hdr.findIndex((h) => keys.some((k) => h === k || h.includes(k)));
  for (let hi = 0; hi < Math.min(rows.length, 10); hi++) {
    const hdr = rows[hi].map(H);
    const cT = find(hdr, ['tuyen', 'route']), cG = find(hdr, ['gio', 'time']);
    let cX = find(hdr, ['bienso', 'bks', 'soxe']);
    if (cX < 0) cX = hdr.findIndex((h) => h === 'xe');
    const cL = find(hdr, ['laixe', 'taixe', 'tenlai']);
    if (cT >= 0 && cG >= 0 && (cX >= 0 || cL >= 0)) {
      const cN = find(hdr, ['ngay', 'date']);
      const items = rows.slice(hi + 1).map((r) => ({
        ngay: cN >= 0 ? cellDate(r[cN]) : '', tuyen: String(r[cT] ?? '').trim(), gio: cellTime(r[cG]),
        bks: cX >= 0 ? String(r[cX] ?? '').trim() : '', lai: cL >= 0 ? String(r[cL] ?? '').trim() : '', cho: 0,
      })).filter((x) => x.tuyen || x.gio || x.bks || x.lai);
      return { ...empty, kind: 'list', items, routes: new Set(items.map((x) => x.tuyen)).size };
    }
    const times = rows[hi].map(cellTime);
    if (times.filter(Boolean).length >= 2) {
      const items: ImportItem[] = [];
      for (const r of rows.slice(hi + 1)) {
        const tuyen = String(r[0] ?? '').trim();
        if (!tuyen) continue;
        r.forEach((c, j) => {
          if (!j || !times[j] || String(c ?? '').trim() === '') return;
          const p = splitCell(String(c));
          items.push({ ngay: '', tuyen, gio: times[j], bks: p.bks, lai: p.lai, cho: 0 });
        });
      }
      return { ...empty, kind: 'grid', items, routes: new Set(items.map((x) => x.tuyen)).size };
    }
  }
  return empty;
}

/** Văn bản dán từ Excel (tab) hoặc CSV → bảng */
export function textToRows(txt: string): string[][] {
  const lines = String(txt ?? '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  const tab = lines.some((l) => l.includes('\t'));
  return lines.map((l) => (tab ? l.split('\t') : splitCsv(l)).map((c) => c.trim()));
}
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',' || ch === ';') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Trang "Điều hành xe" của Vexere (bôi đen toàn trang, sao chép, dán vào) */
export function parseVexere(txt: string): Parsed {
  const T = String(txt ?? '').replace(/\r/g, '');
  const L = T.split('\n').map((x) => x.trim());
  const warn: string[] = [];
  const hdr: Record<string, { n: number; h: number }> = {};
  const cnt: Record<string, number> = {};
  const dm = T.match(/(\d{2})\/(\d{2})\/(\d{4})/) ?? T.match(/(\d{2})-(\d{2})-(\d{4})/);
  const ngay = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : '';
  const plateRe = /^\d{2}[A-ZĐ]{1,2}-\d{3,4}\.\d{2}$/i;
  const tmRe = /^(?:Đổi giờ)?\s*(\d{1,2}):(\d{2})$/;
  const chon = /^Chọn loại xe$/i;
  const NOISE = /^(Chuyến bán vé|Chuyến chở hàng|Vị trí xe|AUTO$|-$|Ghế ngồi|Giường|Chọn loại|Ẩn các|Giờ\b|Tuyến đường|Nhóm tuyến|ĐHX|Đổi giờ$|Chưa XB|Đã XB)/i;
  type Cur = { tuyen: string; gio: string; bks: string; lai: string; fin: boolean; huy: boolean; cho: number };
  const out: Cur[] = [];
  let route = '';
  let cur: Cur | null = null;
  const nextNon = (i: number) => { let k = i + 1; while (k < L.length && !L[k]) k++; return k < L.length ? L[k] : ''; };
  for (let i = 0; i < L.length; i++) {
    const s = L[i];
    if (!s) continue;
    if (chon.test(s)) { cur = null; continue; }
    if (chon.test(nextNon(i))) { route = s; cur = null; continue; }   // dòng ngay trước "Chọn loại xe" là tên tuyến
    const h = s.match(/^(\d+)\s+Chuyến\s*\(([^)]*)\)/i);
    if (h && route) { hdr[route] = { n: +h[1], h: +((h[2].match(/(\d+)\s*Hủy/i) ?? [0, 0])[1]) }; continue; }
    const t = s.match(tmRe);
    if (t && route) { cur = { tuyen: route, gio: `${pad(+t[1])}:${t[2]}`, bks: '', lai: '', fin: false, huy: false, cho: 0 }; out.push(cur); cnt[route] = (cnt[route] ?? 0) + 1; continue; }
    if (!cur || cur.fin) continue;
    if (/^(đã\s*)?hủy\b/i.test(s)) { cur.huy = true; continue; }
    if (plateRe.test(s)) { cur.bks = s; continue; }
    const gh = s.match(/^(?:Ghế ngồi|Giường nằm|Limousine)\s+(\d+)\s*(chỗ|giường)/i);
    if (gh) { cur.cho = +gh[1]; continue; }
    if (/^\d+%\s*\(\s*\d+\s*vé/i.test(s)) { if (/hủy/i.test(s.slice(s.indexOf(')') + 1))) cur.huy = true; cur.fin = true; continue; }
    if (NOISE.test(s)) continue;
    if (!cur.lai) cur.lai = s;
  }
  for (const r of Object.keys(hdr)) {
    const p = cnt[r] ?? 0, H = hdr[r];
    if (p !== H.n && p !== H.n - H.h) warn.push(`Tuyến ${r}: đọc được ${p} chuyến nhưng Vexere ghi ${H.n} chuyến${H.h ? ` (${H.h} hủy)` : ''}. Có thể dán thiếu hoặc đang ẩn chuyến.`);
  }
  const routes = Object.keys(cnt).length;
  if (routes && !ngay) warn.push('Không thấy ngày trong nội dung dán: dùng ngày đang xem.');
  const items = out.filter((x) => !x.huy).map((x) => ({ ngay, tuyen: x.tuyen, gio: x.gio, bks: x.bks, lai: x.lai, cho: x.cho }));
  return { kind: routes ? 'vexere' : '', items, warn, routes, ngay, nHuy: out.length - items.length };
}

/** File mẫu CSV (mở bằng Excel được) */
export function templateCsv(rows: string[][]): string {
  const esc = (c: string) => (/[",;\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return `﻿${[['Ngày', 'Tuyến', 'Giờ', 'Biển số', 'Lái xe'], ...rows].map((r) => r.map(esc).join(',')).join('\n')}`;
}
