// Quy tắc đặt tên + thư mục lưu Lệnh vận chuyển / Hợp đồng vận chuyển đã scan (như app cũ).
// BẢN SAO của phần quy tắc trong web/src/lib/scan.ts: máy chủ tự đặt tên / thư mục khi lái xe lưu lệnh. Sửa một bên thì sửa cả hai.
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').trim();
/* ---------- quy tắc lưu hồ sơ (như app cũ) ---------- */
export interface DocRead {
  loai: string | null; tieu_de: string | null; so_van_ban: string | null; ngay: string | null; tom_tat: string | null; noi_dung: string | null;
  lenh_so: string | null; lenh_tu_ngay: string | null; lenh_den_ngay: string | null; lai_xe_1: string | null; lai_xe_2: string | null; bien_so: string | null;
  tuyen: string | null; ma_tuyen: string | null; ben_di: string | null; ben_ve: string | null; ngay_xuat: string | null;
}
export interface RouteRow { name: string; registered_code: string | null }
const isLenh = (v: DocRead) => /lệnh/i.test(v.loai ?? '');
const isHd = (v: DocRead) => /hợp đồng/i.test(v.loai ?? '');
export const ruleApplies = (v: DocRead) => isLenh(v) || isHd(v);
/** phần số của số lệnh (vd "Số: 26040714/LVC-CT" → "26040714"); không có dãy số thì giữ chữ đọc được */
export function soLenh(so: string): string {
  const t = so.trim(), m = t.match(/\d{4,}/);
  return m ? m[0] : safeName(t.replace(/^s[ốo]\s*[:.]?\s*/i, ''));
}
/** Tên tài liệu: Lệnh → <số>/LVC-<hậu tố lệnh của nhà xe> (vd 26070706/LVC-TGTP); khác → loại, số, biển số, ngày */
export function docName(v: DocRead, suffix: string): string {
  if (isLenh(v) && v.lenh_so) return `${soLenh(v.lenh_so)}${suffix ? `/LVC-${suffix}` : ''}`;
  const d = (v.lenh_tu_ngay ?? v.ngay ?? '').split('-').reverse().join('-');
  return safeName([v.loai || 'Tài liệu', v.lenh_so ?? v.so_van_ban, v.bien_so, d].filter(Boolean).join(' '));
}
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toUpperCase().replace(/\b(BX|B\.X|BEN XE)\.?\s*/g, '').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const ends = (name: string) => name.split(/\s*(?:⇄|<>|->|→|–|-)\s*/).map((x) => x.trim()).filter(Boolean);
const clean = (t: string) => t.replace(/\b(BX|B\.X|Bến xe)\.?\s*/gi, '').replace(/\s*(?:⇄|<>|->|→|–|-)\s*/g, ' - ').replace(/\s+/g, ' ').trim();
/** Thư mục tuyến: ưu tiên mã tuyến, rồi 2 bến khớp tuyến trong app; dòng "Tuyến" (thường là tên tỉnh) dùng sau cùng */
export function routeFolder(v: DocRead, routes: RouteRow[]): string {
  const out = (r: RouteRow) => ends(r.name).map((x) => x.toUpperCase()).join(' - ');
  const dig = (x: string | null) => (x ?? '').replace(/\D/g, '');
  if (dig(v.ma_tuyen).length >= 4) { const m = routes.filter((r) => dig(r.registered_code) === dig(v.ma_tuyen)); if (m.length === 1) return out(m[0]!); }
  const B0 = [v.ben_di, v.ben_ve].filter((x): x is string => !!x), B = B0.map(norm);
  if (B.length) {
    const C = routes.map((r) => ({ r, e: ends(r.name).map(norm) }));
    const has = (c: { e: string[] }, b: string) => c.e.some((x) => x && b.includes(x));
    const m = C.filter((c) => c.e.length >= 2 && B.every((b) => has(c, b)) && c.e.every((x) => B.some((b) => b.includes(x))));
    if (m.length === 1) return out(m[0]!.r);
    const m2 = C.filter((c) => B.every((b) => has(c, b)));
    if (m2.length === 1) return out(m2[0]!.r);
    if (B0.length >= 2) return clean(B0.join(' - ')).toUpperCase();
  }
  const t = clean(v.tuyen ?? '');
  if (!t) return 'Chưa rõ tuyến';
  const m = routes.find((r) => norm(r.name) === norm(t) || norm(ends(r.name).reverse().join(' - ')) === norm(t));
  return m ? out(m) : t.toUpperCase();
}
/** Lệnh → Năm / 08. Điều hành xe / Lệnh vận chuyển / Tuyến / Tháng MM-YYYY; Hợp đồng → Năm / 08. Điều hành xe / Hợp đồng vận chuyển / Tháng MM-YYYY */
export function docPath(v: DocRead, routes: RouteRow[], today: string): string[] | null {
  const d = [v.lenh_tu_ngay, v.ngay_xuat, v.ngay].find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x ?? '')) ?? today, y = d.slice(0, 4), mm = d.slice(5, 7);
  if (isLenh(v)) return [y, '08. Điều hành xe', 'Lệnh vận chuyển', routeFolder(v, routes), `Tháng ${mm}-${y}`];
  return isHd(v) ? [y, '08. Điều hành xe', 'Hợp đồng vận chuyển', `Tháng ${mm}-${y}`] : null;
}

