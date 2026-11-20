// Bảng chấm công (như app cũ) – phần tính toán, không phụ thuộc giao diện.
// - Lái xe: công mỗi ngày = số chuyến (lái xe 1) × công/chuyến của tuyến; tiền công = công × Tiền tài của xe.
// - Văn phòng: tự điền X mọi ngày làm việc đã qua (trừ ngày nghỉ tuần, trước ngày vào làm, sau ngày nghỉ việc);
//   tiền công = Lương cố định của tháng.
// - Chi phí khác (lái xe) = % tiền công. Lương CK, Trừ BHXH: bảng BHXH & lương chuyển khoản theo tháng.
// - Thực nhận không âm; lái xe trừ lần lượt BHXH → Chi phí khác → Lương CK, hết tiền thì khoản sau không trừ, phần thiếu bỏ qua.
// - Nhóm tuyến (gộp chiều đi + về): nhóm chính của lái xe = nhóm chạy nhiều công nhất tháng; chạy nhóm khác là chạy chéo.

export type Dir = 'di' | 've';
export interface TStaff {
  id: string; user_id: string | null; full_name: string; position: string; job_title: string | null; department: string | null;
  joined_on: string; left_on: string | null; is_active: boolean;
}
export interface TRoute { id: string; name: string; name_ve: string | null }
export interface TTrip { id: string; route_id: string; direction: Dir; service_date: string; depart_at: string; vehicle_id: string | null }
export interface TVeh { id: string; plate: string; driver_pay: number }
export interface TPay { has_bhxh: boolean; transfer_pay: number; bhxh_pay: number; fixed_pay: number }
export interface Group { k: string; n: string; s: string; routes: Set<string>; o: Other }
export interface Other { k: string; n: string; s: string; ks: string[] }

/** Ký hiệu chấm công (như app cũ). Ngày làm tự điền = X. */
export const CODES: Record<string, { n: string; bg: string; c: string }> = {
  X: { n: 'Đi làm cả ngày', bg: '#dcfce7', c: '#15803d' },
  N: { n: 'Làm nửa ngày', bg: '#ccfbf1', c: '#0f766e' },
  CT: { n: 'Đi công tác', bg: '#e0f2fe', c: '#0369a1' },
  P: { n: 'Nghỉ phép năm', bg: '#dbeafe', c: '#1d4ed8' },
  L: { n: 'Nghỉ lễ, Tết', bg: '#ede9fe', c: '#6d28d9' },
  O: { n: 'Nghỉ ốm (BHXH trả)', bg: '#fef3c7', c: '#b45309' },
  KP: { n: 'Nghỉ không lương', bg: '#fee2e2', c: '#b91c1c' },
};
export const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
export const pad = (n: number) => String(n).padStart(2, '0');
export const daysIn = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y!, m!, 0)).getUTCDate(); };
export const dow = (ym: string, d: number) => new Date(`${ym}-${pad(d)}T00:00:00Z`).getUTCDay();
const dirName = (r: TRoute | undefined, d: Dir) => {
  if (!r) return '';
  if (d === 'di') return r.name;
  if (r.name_ve?.trim()) return r.name_ve.trim();
  const m = /^(.*?)\s+([-–—])\s+(.*)$/.exec(r.name);
  return m ? `${m[3]} ${m[2]} ${m[1]}` : r.name;
};
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd');
/** "Biên Hòa ⇄ Vũng Tàu" → "BH" (chữ cái đầu của điểm đi) */
export const shortOf = (name: string) => {
  const first = name.split(/\s*(?:⇄|<>|->|→|–|—|\s-\s)\s*/)[0] ?? name;
  return fold(first).toUpperCase().replace(/^(BX|BEN XE)\s+/, '').split(/[^A-Z0-9]+/).filter(Boolean).map((w) => w[0]).join('') || '?';
};
const pairName = (r: TRoute) => r.name.replace(/\s+[-–—]\s+/g, ' ⇄ ').toUpperCase();

/** Nhóm tuyến: theo cài đặt Điều hành (Nhóm tuyến đường); chưa có thì mỗi tuyến (2 chiều) là 1 nhóm. */
export function buildGroups(routes: TRoute[], cfg: { id: string; name: string; routes: string[] }[] | null): Group[] {
  const base = cfg && cfg.length
    ? cfg.filter((g) => g.routes?.length).map((g) => ({ k: g.id, n: g.name.trim() || 'Nhóm', routes: new Set(g.routes) }))
    : [...routes].sort((a, b) => a.name.localeCompare(b.name, 'vi')).map((r) => ({ k: `a:${r.id}`, n: pairName(r), routes: new Set([r.id]) }));
  const L = base.map((g) => ({ ...g, s: shortOf(g.n), o: { k: '', n: '', s: '', ks: [] } as Other }));
  for (const m of L) {
    const O = L.filter((x) => x !== m);
    m.o = O.length === 1 ? { k: O[0]!.k, n: O[0]!.n, s: O[0]!.s, ks: [O[0]!.k] } : { k: `~o:${m.k}`, n: O.map((x) => x.n).join(' + ') || 'nhóm khác', s: O.map((x) => x.s).join('+'), ks: O.map((x) => x.k) };
  }
  return L;
}

export interface DayCell { n: number; tt: number; cong: number; tien: number; xe: string[]; gio: string[]; tu: Record<string, number> }
export interface Summary { lv: number; lc: number; tienCong: number; cpKhac: number; drv: boolean; has: boolean }
export interface Pay {
  drv: boolean; tc: number; cp: number; lck: number; bh: number; bhSkip: boolean; idle: number; show: boolean;
  paid: { bh: number; cp: number; lck: number }; thucNhan: number; thieu: number; chuaChay?: boolean;
}

export interface Ctx {
  ym: string; today: string; offSat: boolean; cpRate: number; bh14: boolean;
  staff: TStaff[]; routes: Map<string, TRoute>; vehicles: Map<string, TVeh>; groups: Group[];
  trips: Map<string, TTrip>; driverOf: Map<string, string>;          // trip_id → lái xe 1
  congTuyen: Record<string, number>; pay: Map<string, TPay>; firstMonth: Map<string, string>; // staff → YYYY-MM
}

export function makeTimesheet(c: Ctx) {
  const n = daysIn(c.ym);
  const isOff = (d: number) => { const w = dow(c.ym, d); return w === 0 || (c.offSat && w === 6); };
  const congOf = (t: TTrip) => { const v = c.congTuyen[`${t.route_id}|${t.direction}`] ?? c.congTuyen[t.route_id]; return v == null ? 1 : Number(v); };
  const groupOf = new Map<string, Group>();
  for (const g of c.groups) for (const r of g.routes) if (!groupOf.has(r)) groupOf.set(r, g);
  // chuyến theo lái xe
  const byDriver = new Map<string, TTrip[]>();
  for (const [tid, sid] of c.driverOf) { const t = c.trips.get(tid); if (!t) continue; (byDriver.get(sid) ?? byDriver.set(sid, []).get(sid)!).push(t); }
  const DRV = /l[aá]i\s*xe|t[aà]i\s*x[eế]|driver/i;
  const isDriver = (e: TStaff) => e.position === 'lai_xe' || DRV.test(e.job_title ?? '') || byDriver.has(e.id) || c.firstMonth.has(e.id);

  const lcMemo = new Map<string, Record<number, DayCell>>();
  function lcDays(eid: string): Record<number, DayCell> {
    if (lcMemo.has(eid)) return lcMemo.get(eid)!;
    const out: Record<number, DayCell> = {};
    for (const t of byDriver.get(eid) ?? []) {
      const d = Number(t.service_date.slice(8, 10)), v = t.vehicle_id ? c.vehicles.get(t.vehicle_id) : undefined, tt = v?.driver_pay ?? 0;
      const k = congOf(t), name = dirName(c.routes.get(t.route_id), t.direction) || 'Chưa có tuyến';
      const o = out[d] ??= { n: 0, tt: 0, cong: 0, tien: 0, xe: [], gio: [], tu: {} };
      o.n++; o.tt = Math.max(o.tt, tt); o.cong += k; o.tien += k * tt; o.tu[name] = (o.tu[name] ?? 0) + k;
      if (v && !o.xe.includes(v.plate)) o.xe.push(v.plate);
      o.gio.push(new Date(t.depart_at).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false }));
    }
    for (const o of Object.values(out)) o.gio.sort();
    lcMemo.set(eid, out);
    return out;
  }
  function autoDays(e: TStaff): Record<number, 1> {
    const out: Record<number, 1> = {};
    if (isDriver(e)) return out;
    for (let d = 1; d <= n; d++) {
      const ds = `${c.ym}-${pad(d)}`;
      if (ds > c.today) break;
      if (isOff(d) || ds < e.joined_on || (e.left_on && ds > e.left_on) || (!e.is_active && !e.left_on)) continue;
      out[d] = 1;
    }
    return out;
  }
  /** Công từng nhóm tuyến trong tháng (cả 2 chiều) */
  function congGroups(eid: string): Record<string, number> {
    const o: Record<string, number> = {};
    for (const t of byDriver.get(eid) ?? []) { const g = groupOf.get(t.route_id); if (g) o[g.k] = (o[g.k] ?? 0) + congOf(t); }
    return o;
  }
  /** Công theo cặp tuyến (khi tuyến không thuộc nhóm nào): tuyến chính dự phòng */
  function topPair(eid: string): string {
    const o: Record<string, number> = {};
    for (const t of byDriver.get(eid) ?? []) { const r = c.routes.get(t.route_id); if (r) o[pairName(r)] = (o[pairName(r)] ?? 0) + congOf(t); }
    return Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  }
  const main = (e: TStaff): Group | null => {
    const cg = congGroups(e.id);
    return c.groups.filter((g) => (cg[g.k] ?? 0) > 0).sort((a, b) => (cg[b.k] ?? 0) - (cg[a.k] ?? 0))[0] ?? null;
  };
  const grp = (e: TStaff) => { if (!isDriver(e)) return '~Văn phòng'; const m = main(e); return m ? m.n : (topPair(e.id) || '~~Lái xe chưa có lịch chạy'); };
  const ran = (e: TStaff, name: string) => { const g = c.groups.find((x) => x.n === name); return !!g && isDriver(e) && (congGroups(e.id)[g.k] ?? 0) > 0; };
  const cross = (e: TStaff) => {
    if (!isDriver(e)) return 0;
    const m = main(e); if (!m) return 0;
    const cg = congGroups(e.id);
    return Object.keys(cg).filter((k) => k !== m.k).reduce((s, k) => s + (cg[k] ?? 0), 0);
  };
  /** Công / tiền của lái xe chỉ trên các tuyến thuộc nhóm (hoặc các nhóm) đã cho, theo ngày */
  const inG = (ks: string[], t: TTrip) => { const g = groupOf.get(t.route_id); return !!g && ks.includes(g.k); };
  const congNhom = (eid: string, ks: string[]) => { const d: Record<number, number> = {}; for (const t of byDriver.get(eid) ?? []) if (inG(ks, t)) { const k = Number(t.service_date.slice(8, 10)); d[k] = (d[k] ?? 0) + congOf(t); } return d; };
  const tienNhom = (eid: string, ks: string[]) => (byDriver.get(eid) ?? []).filter((t) => inG(ks, t)).reduce((s, t) => s + congOf(t) * (t.vehicle_id ? c.vehicles.get(t.vehicle_id)?.driver_pay ?? 0 : 0), 0);

  const sumMemo = new Map<string, Summary>();
  function summarize(e: TStaff): Summary {
    if (sumMemo.has(e.id)) return sumMemo.get(e.id)!;
    const drv = isDriver(e), lc = drv ? lcDays(e.id) : {};
    const o: Summary = { lv: 0, lc: 0, tienCong: 0, cpKhac: 0, drv, has: Object.keys(lc).length > 0 };
    for (const v of Object.values(lc)) { o.lc += v.cong; o.tienCong += v.tien; o.lv += v.cong; }
    if (!drv) { o.tienCong = c.pay.get(e.id)?.fixed_pay ?? 0; o.lv = Object.keys(autoDays(e)).length; }
    o.cpKhac = drv ? Math.round(o.tienCong * c.cpRate) : 0;
    sumMemo.set(e.id, o);
    return o;
  }
  function idle(eid: string): number {
    const lc = lcDays(eid);
    let k = 0;
    for (let d = 1; d <= n; d++) { if (`${c.ym}-${pad(d)}` > c.today) break; if (!isOff(d) && !lc[d]) k++; }
    return k;
  }
  const payMemo = new Map<string, Pay>();
  function payOf(e: TStaff): Pay {
    if (payMemo.has(e.id)) return payMemo.get(e.id)!;
    const a = summarize(e), drv = a.drv, rc = c.pay.get(e.id);
    const tc = a.tienCong, cp = a.cpKhac, lck = rc?.transfer_pay ?? 0;
    let bh = rc?.has_bhxh ? rc.bhxh_pay : 0, bhSkip = false;
    const idl = drv ? idle(e.id) : 0;
    if (drv && c.bh14 && bh && idl >= 14) { bh = 0; bhSkip = true; }
    const base = { drv, tc, cp, lck, bh, bhSkip, idle: idl, paid: { bh: 0, cp: 0, lck: 0 }, thieu: 0 };
    let o: Pay;
    const f0 = c.firstMonth.get(e.id) ?? '';
    if (drv && (!f0 || c.ym < f0)) o = { ...base, idle: 0, show: tc > 0, thucNhan: tc, chuaChay: true };   // chưa chạy chuyến nào: không trừ
    else if (!drv) o = { ...base, show: tc > 0, thucNhan: tc ? Math.max(0, tc - cp - lck - bh) : 0 };
    else {
      let con = tc;
      const take = (v: number) => { const x = Math.min(con, v); con -= x; return x; };
      const paid = { bh: take(bh), cp: take(cp), lck: take(lck) };
      o = { ...base, show: true, paid, thucNhan: con, thieu: bh - paid.bh + (cp - paid.cp) + (lck - paid.lck) };
    }
    payMemo.set(e.id, o);
    return o;
  }
  /** Danh sách công theo cặp tuyến của lái xe trong tháng (để hiện khi tìm kiếm / chú thích) */
  function empTuyen(eid: string): { t: string; n: number }[] {
    const o: Record<string, number> = {};
    for (const t of byDriver.get(eid) ?? []) { const r = c.routes.get(t.route_id); if (r) o[pairName(r)] = (o[pairName(r)] ?? 0) + congOf(t); }
    return Object.entries(o).sort((a, b) => b[1] - a[1]).map(([t, k]) => ({ t, n: k }));
  }
  return { n, isOff, isDriver, lcDays, autoDays, congGroups, main, grp, ran, cross, congNhom, tienNhom, summarize, payOf, empTuyen };
}
export type Timesheet = ReturnType<typeof makeTimesheet>;
