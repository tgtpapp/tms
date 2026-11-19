// Đọc báo cáo km từ phần mềm GPS (Skysoft và các hãng khác): tìm dòng tiêu đề có cột km, cột ngày, cột biển số.
// Báo cáo 1 xe (biển số ở tiêu đề) hoặc tổng hợp nhiều xe đều đọc được; báo cáo cả kỳ không có cột ngày thì ghi vào ngày cuối kỳ.
import { norm } from './scheduleImport';

export interface KmRow { plate: string; date: string; km: number }
export interface KmParse { rows: KmRow[]; plate: string | null; from: string | null; to: string | null; noDate: boolean; noPlate: boolean; header: string[] }
type Cell = string | number | boolean | Date | null | undefined;

const PLATE5 = /(\d{2}[A-Z]{1,2})[\s.-]*(\d{3}[.\s]?\d{2})(?!\d)/;
const PLATE = /(\d{2}[A-Z]{1,2}\d?)[\s.-]*(\d{3}[.\s]?\d{2}|\d{4})(?!\d)/;
export const findPlate = (s: string): string | null => {
  const u = s.toUpperCase().replace(/Đ/g, 'D');
  const m = PLATE5.exec(u) ?? PLATE.exec(u);
  if (!m) return null;
  const tail = m[2].replace(/\D/g, '');
  return `${m[1]}-${tail.length === 5 ? `${tail.slice(0, 3)}.${tail.slice(3)}` : tail}`;
};
const iso = (y: number, m: number, d: number) => (y > 1990 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
export function cellDate(c: Cell): string | null {
  if (c instanceof Date && !Number.isNaN(c.getTime())) return iso(c.getFullYear(), c.getMonth() + 1, c.getDate());
  if (typeof c === 'number' && c > 30000 && c < 70000) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(c) * 86400000); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  const s = String(c ?? '');
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  return m ? iso(+m[3], +m[2], +m[1]) : null;
}
export function cellNum(c: Cell): number | null {
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  let s = String(c ?? '').trim().replace(/\s|km/gi, '');
  if (!s || !/^-?[\d.,]+$/.test(s)) return null;
  // 1.234,5 (kiểu VN) hoặc 1,234.5 (kiểu Mỹ) hoặc 123,4
  if (s.includes('.') && s.includes(',')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{3}$/.test(s) && s.split(',').length > 1 && !/^0,/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (/\.\d{3}$/.test(s) && s.split('.').length > 2) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const KM_BAD = /odo|dong ho|bat dau|ket thuc|dau ky|cuoi ky|vi tri|toc do|\/h|lit|nhien lieu|dung|do xe|qua toc|vuot/;
function kmScore(h: string): number {
  if (!/\bkm\b|quang duong|so km|\(km\)/.test(h) || KM_BAD.test(h)) return 0;
  return 1 + (/gps/.test(h) ? 3 : 0) + (/tong|quang duong/.test(h) ? 2 : 0) + (/thuc te|di chuyen|hoat dong/.test(h) ? 1 : 0);
}

export function parseKmReport(data: Cell[][]): KmParse {
  const txt = (c: Cell) => (c instanceof Date ? cellDate(c) ?? '' : String(c ?? '')).trim();
  const rows = data.map((r) => (r ?? []).map((c) => c));
  let hi = -1, kmCol = -1, dateCol = -1, plateCol = -1, header: string[] = [];
  // Lượt 1: dòng tiêu đề đứng riêng; lượt 2: tiêu đề 2 tầng (vd "Quãng đường" / "(km)")
  for (const merge of [false, true]) {
    for (let i = 0; i < Math.min(rows.length, 40) && hi < 0; i++) {
      const below = merge ? rows[i + 1] ?? [] : [];
      if (merge && (!below.length || below.some((c) => cellNum(c) != null || cellDate(c)))) continue;
      const width = Math.max(rows[i].length, below.length);
      const h = Array.from({ length: width }, (_, k) => norm(`${txt(rows[i][k])} ${txt(below[k])}`));
      if (h.filter(Boolean).length < 3 || h.some((x) => /^bao cao/.test(x))) continue;
      let best = 0, bc = -1;
      h.forEach((x, k) => { const sc = kmScore(x); if (sc > best) { best = sc; bc = k; } });
      if (bc < 0) continue;
      hi = merge ? i + 1 : i;
      kmCol = bc;
      header = h;
      dateCol = h.findIndex((x) => /^ngay\b|ngay chay|ngay hoat dong|^thoi gian$|^date/.test(x) && !/ngay sinh/.test(x));
      plateCol = h.findIndex((x) => /bien so|bien kiem soat|\bbks\b|phuong tien|^so xe|^xe$/.test(x));
    }
  }
  // Tiêu đề phía trên: biển số, khoảng ngày
  const top = rows.slice(0, hi < 0 ? 15 : hi).map((r) => r.map(txt).join(' ')).join(' \n ');
  const plate = plateCol < 0 ? findPlate(top) : null;
  const ds = [...top.matchAll(/(\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{2}-\d{2})/g)].map((m) => cellDate(m[1])).filter((x): x is string => !!x);
  const from = ds.length ? ds.slice().sort()[0] : null, to = ds.length ? ds.slice().sort()[ds.length - 1] : null;
  const out: KmRow[] = [];
  if (hi >= 0) {
    for (const r of rows.slice(hi + 1)) {
      const line = norm(r.map(txt).join(' '));
      if (!line || /^(tong|cong)\b|tong cong|\btong\s*:/.test(line)) continue;
      const km = cellNum(r[kmCol]);
      if (km == null || km < 0) continue;
      const p = plateCol >= 0 ? findPlate(txt(r[plateCol])) : plate;
      const d = dateCol >= 0 ? cellDate(r[dateCol]) : to;
      if (plateCol >= 0 && !p) continue;
      if (dateCol >= 0 && !d) continue;
      out.push({ plate: p ?? '', date: d ?? '', km: Math.round(km * 10) / 10 });
    }
  }
  return { rows: out, plate, from, to, noDate: dateCol < 0, noPlate: plateCol < 0 && !plate, header };
}
