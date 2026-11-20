// Bảng chấm công (như app cũ): lái xe tự tính công từ chuyến đã chạy, văn phòng tự điền X ngày làm việc.
// Lọc theo phòng ban, nhóm tuyến, lái xe chạy chéo; công/chuyến theo từng tuyến; quy tắc trừ tiền khi không đủ;
// in / tải Excel bảng chấm công và bảng lái xe theo nhóm tuyến.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PaperView, type Me } from '../components/ProfilePapers';
import { boss, bossCol, company, head, signCol } from '../lib/profilePapers';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import {
  buildGroups, CODES, DOW, dow, makeTimesheet, pad, type Dir, type Group, type TPay, type TRoute, type TStaff, type TTrip, type TVeh, type Timesheet,
} from '../lib/timesheet';

const money = (n: number) => Math.round(n).toLocaleString('vi-VN');
const numf = (n: number) => (Math.round(n * 100) / 100).toLocaleString('vi-VN');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const nowYm = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).slice(0, 7);
const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
const PAGE = 20;

/** Lấy hết các dòng (Supabase trả tối đa 1000 dòng / lần). */
async function all<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await q(i, i + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

interface Data {
  staff: TStaff[]; routes: TRoute[]; vehicles: TVeh[]; trips: TTrip[]; driverOf: Map<string, string>; sched: { route_id: string; direction: Dir }[];
  congTuyen: Record<string, number>; cpPct: number; bh14: boolean; congChuan: number; offSat: boolean; groupsCfg: { id: string; name: string; routes: string[] }[] | null;
  pay: Map<string, TPay>; firstMonth: Map<string, string>;
}

export function TimesheetScreen({ ctx, perms }: { ctx: AccountContext; perms: Permissions }) {
  const toast = useToast();
  const viewAll = perms.has('timesheet.view_all');
  const canEdit = perms.has('timesheet.edit');
  // Lương: người xem bảng lương thấy tất cả; lái xe / nhân viên (chỉ xem của mình) thấy tiền của chính mình (như app cũ)
  const money_ = perms.has('salary.view') || !viewAll;
  const me: Me = { id: ctx.user_id, name: ctx.full_name ?? '' };
  const [ym, setYm] = useState(nowYm());
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [pbs, setPbs] = useState<string[]>([]);
  const [grs, setGrs] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [ctOpen, setCtOpen] = useState(false);
  const [poOpen, setPoOpen] = useState(false);
  const [view, setView] = useState<{ title: string; html: string; land?: boolean } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const from = `${ym}-01`, last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
      const [st, rt, vh, sc, ss, trips] = await Promise.all([
        supabase.from('staff_members').select('id, user_id, full_name, position, job_title, department, joined_on, left_on, is_active').order('full_name'),
        supabase.from('routes').select('id, name, name_ve'),
        supabase.from('vehicles').select('id, plate, driver_pay'),
        supabase.from('schedules').select('route_id, direction').eq('is_active', true),
        supabase.from('tenant_settings').select('key, value').in('key', ['cham_cong.cong_tuyen', 'cham_cong.cp_khac_lx', 'cham_cong.bh14', 'cham_cong.cong_chuan', 'hdld.ngay_nghi', 'dieu_hanh.nhom_tuyen']),
        all<TTrip>((a, b) => supabase.from('trips').select('id, route_id, direction, service_date, depart_at, vehicle_id').eq('status', 'mo').gte('service_date', from).lte('service_date', last).order('id').range(a, b)),
      ]);
      const e = st.error ?? rt.error ?? vh.error ?? sc.error ?? ss.error;
      if (e) throw new Error(e.message);
      const ids = trips.map((t) => t.id);
      const crew: { trip_id: string; staff_id: string }[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase.from('trip_crew').select('trip_id, staff_id').in('trip_id', ids.slice(i, i + 200)).eq('role', 'lai_xe_1').eq('active', true);
        if (error) throw new Error(error.message);
        crew.push(...((data ?? []) as { trip_id: string; staff_id: string }[]));
      }
      const set = (k: string) => ((ss.data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value;
      const [pm, fm] = await Promise.all([
        money_ ? supabase.from('staff_pay_months').select('staff_id, has_bhxh, transfer_pay, bhxh_pay, fixed_pay').eq('month', from) : Promise.resolve({ data: [], error: null }),
        rpc<{ staff_id: string; first_month: string }[]>('driver_first_months', {}),
      ]);
      const cp = set('cham_cong.cp_khac_lx');
      setD({
        staff: (st.data ?? []) as TStaff[], routes: (rt.data ?? []) as TRoute[],
        vehicles: ((vh.data ?? []) as TVeh[]).map((v) => ({ ...v, driver_pay: Number(v.driver_pay) || 0 })),
        trips, driverOf: new Map(crew.map((c) => [c.trip_id, c.staff_id])), sched: (sc.data ?? []) as { route_id: string; direction: Dir }[],
        congTuyen: (set('cham_cong.cong_tuyen') && typeof set('cham_cong.cong_tuyen') === 'object' ? set('cham_cong.cong_tuyen') : {}) as Record<string, number>,
        cpPct: cp == null ? 4 : Number(cp), bh14: set('cham_cong.bh14') === true, congChuan: Number(set('cham_cong.cong_chuan')) || 26,
        offSat: set('hdld.ngay_nghi') === 'T7CN',
        groupsCfg: Array.isArray(set('dieu_hanh.nhom_tuyen')) ? set('dieu_hanh.nhom_tuyen') as Data['groupsCfg'] : null,
        pay: new Map(((pm.data ?? []) as (TPay & { staff_id: string })[]).map((r) => [r.staff_id, { has_bhxh: r.has_bhxh, transfer_pay: Number(r.transfer_pay), bhxh_pay: Number(r.bhxh_pay), fixed_pay: Number(r.fixed_pay) }])),
        firstMonth: new Map((fm ?? []).map((r) => [r.staff_id, r.first_month.slice(0, 7)])),
      });
    } catch (x) { setErr(errMsg(x)); }
  }, [ym, money_]);
  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => (d ? buildGroups(d.routes, d.groupsCfg) : []), [d]);
  const T: Timesheet | null = useMemo(() => d && makeTimesheet({
    ym, today: todayStr(), offSat: d.offSat, cpRate: Math.max(0, d.cpPct) / 100, bh14: d.bh14, staff: d.staff,
    routes: new Map(d.routes.map((r) => [r.id, r])), vehicles: new Map(d.vehicles.map((v) => [v.id, v])), groups,
    trips: new Map(d.trips.map((t) => [t.id, t])), driverOf: d.driverOf, congTuyen: d.congTuyen, pay: d.pay, firstMonth: d.firstMonth,
  }), [d, ym, groups]);

  if (err) return <section className="card"><p className="error-text">{err}</p></section>;
  if (!d || !T) return <section className="card"><p className="muted">Đang tải…</p></section>;

  const end = `${ym}-31`;
  const mine = (e: TStaff) => e.user_id === ctx.user_id;
  // Người trong tháng: vào làm trước cuối tháng; đã nghỉ việc thì chỉ hiện khi có công
  const base = d.staff.filter((e) => (viewAll || mine(e)) && e.joined_on <= end && (e.is_active || T.summarize(e).has));
  const inSel = (e: TStaff, gs: string[]) => {
    const g = T.grp(e);
    return gs.some((v) => v.startsWith('x:') ? (g === v.slice(2) && T.cross(e) > 0) : (v === g || T.ran(e, v)));
  };
  const byPb = (L: TStaff[]) => L.filter((e) => !pbs.length || pbs.includes(e.department ?? ''));
  const all_ = byPb(base);                                            // trước khi lọc nhóm tuyến
  const found = all_.map((e, i) => ({ e, i, g: grs.length === 1 && T.ran(e, grs[0]!) ? grs[0]! : T.grp(e) }))
    .filter((x) => !grs.length || inSel(x.e, grs))
    .sort((a, b) => { const r = (g: string) => (g.startsWith('~~') ? 2 : g.startsWith('~') ? 1 : 0); return r(a.g) - r(b.g) || a.g.localeCompare(b.g, 'vi') || a.i - b.i; });
  const gCount: Record<string, number> = {};
  found.forEach((x) => { gCount[x.g] = (gCount[x.g] ?? 0) + 1; });
  const pages = Math.max(1, Math.ceil(found.length / PAGE)), pg = Math.min(page, pages - 1);
  const shown = found.slice(pg * PAGE, pg * PAGE + PAGE);
  const hideMoney = !money_;
  const days = Array.from({ length: T.n }, (_, i) => i + 1);
  const today = todayStr();

  // ---- thanh lọc
  const depts = [...new Set(base.map((e) => e.department ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
  const gAll: Record<string, number> = {};
  all_.forEach((e) => { const g = T.grp(e); gAll[g] = (gAll[g] ?? 0) + 1; groups.forEach((m) => { if (m.n !== g && T.ran(e, m.n)) gAll[m.n] = (gAll[m.n] ?? 0) + 1; }); });
  const rank = (g: string) => { const i = groups.findIndex((m) => m.n === g); return i < 0 ? 9 : i; };
  const G = Object.keys(gAll).filter((g) => !g.startsWith('~')).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'vi'));
  const XC = groups.map((m) => ({ v: `x:${m.n}`, m, n: all_.filter((e) => T.grp(e) === m.n && T.cross(e) > 0).length })).filter((x) => x.n || grs.includes(x.v));
  const toggle = (cur: string[], v: string) => (!v ? [] : cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);

  // ---- công / chuyến theo tuyến
  const rmap = new Map(d.routes.map((r) => [r.id, r]));
  const rkeys = [...new Set([...d.trips.map((t) => `${t.route_id}|${t.direction}`), ...d.sched.map((s) => `${s.route_id}|${s.direction}`)])]
    .map((k) => { const [rid, dir] = k.split('|') as [string, Dir]; const r = rmap.get(rid); return { k, rid, name: r ? (dir === 'di' ? r.name : r.name_ve?.trim() || r.name.split(/\s+[-–—]\s+/).reverse().join(' - ')) : '?' }; })
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  const groupName = (rid: string) => groups.find((g) => g.routes.has(rid))?.n ?? 'Chưa thuộc nhóm tuyến';
  const rGroups = new Map<string, typeof rkeys>();
  rkeys.forEach((x) => { const g = groupName(x.rid); rGroups.set(g, [...(rGroups.get(g) ?? []), x]); });
  async function saveSet(p: Record<string, unknown>, msg: string) {
    try { await rpc('save_timesheet_settings', { p }); toast('ok', msg); await load(); } catch (x) { toast('error', errMsg(x)); }
  }

  // ---- ô ngày
  function cell(e: TStaff, day: number): { text: string; num: boolean; title: string } {
    const s = T!.summarize(e);
    if (s.drv) {
      const c = T!.lcDays(e.id)[day];
      if (!c) return { text: '', num: false, title: '' };
      return { text: numf(c.cong), num: true, title: `${numf(c.cong)} công · ${c.n} chuyến${c.gio.length ? ` (${c.gio.join(', ')})` : ''}\n${Object.entries(c.tu).map(([g, k]) => `${g}: ${numf(k)} công`).join('\n')}\nXe: ${c.xe.join(', ') || 'chưa gán xe'} · tiền tài ${money(c.tt)} đ` };
    }
    return T!.autoDays(e)[day] ? { text: 'X', num: false, title: 'Tự điền X · ngày làm việc' } : { text: '', num: false, title: '' };
  }
  const tcNote = (e: TStaff, what: string) => {
    if (!T!.isDriver(e)) return what === 'BHXH' ? 'Bảo hiểm xã hội trong bảng BHXH & lương chuyển khoản tháng này' : 'Lương chuyển khoản trong bảng BHXH & lương chuyển khoản tháng này';
    const m = T!.main(e), other = T!.empTuyen(e.id).filter((x) => !m || x.t !== m.n);
    return `${what} trừ 1 lần ở nhóm tuyến chính: ${m?.n ?? 'chưa có'} (tự động: nhóm chạy nhiều công nhất tháng)${other.length && T!.cross(e) ? `\nKhông trừ ở: ${other.map((x) => `${x.t} (${numf(x.n)} công, chỉ tính tiền công)`).join(', ')}` : ''}`;
  };
  const poTip = (e: TStaff) => {
    const o = T!.payOf(e);
    if (!o.drv) return 'Tiền công − Chi phí khác − Lương CK − Trừ BHXH';
    if (o.chuaChay) return 'Lái xe chưa có chuyến nào đến tháng này: chưa trừ';
    return [`Tiền công ${money(o.tc)} đ`, `Trừ BHXH ${money(o.paid.bh)}${o.paid.bh < o.bh ? ` (thiếu ${money(o.bh - o.paid.bh)})` : ''}${o.bhSkip ? ` · tạm dừng BHXH: ${o.idle} ngày không chạy` : ''}`,
      `Chi phí khác ${money(o.paid.cp)}${o.paid.cp < o.cp ? ` (thiếu ${money(o.cp - o.paid.cp)})` : ''}`, `Lương CK ${money(o.paid.lck)}${o.paid.lck < o.lck ? ` (thiếu ${money(o.lck - o.paid.lck)})` : ''}`,
      `= Thực nhận ${money(o.thucNhan)} đ`].join('\n');
  };

  // ---- in / Excel
  const monthTxt = `tháng ${ym.slice(5)}/${ym.slice(0, 4)}`;
  const cols = ['Họ và tên', 'Phòng ban', ...days.map((x) => `${x}\n${DOW[dow(ym, x)]}`), 'Công làm', ...(hideMoney ? [] : ['Tiền công', 'Chi phí khác', 'Lương CK', 'Trừ BHXH', 'Thực nhận'])];
  const rowOf = (e: TStaff): (string | number)[] => {
    const s = T.summarize(e), o = T.payOf(e);
    return [e.full_name, e.department ?? '', ...days.map((x) => cell(e, x).text), s.lv,
      ...(hideMoney ? [] : [s.drv || s.tienCong ? s.tienCong : '', s.cpKhac, o.lck, o.bh, o.show ? o.thucNhan : ''])];
  };
  const legend = `Ký hiệu: ${Object.entries(CODES).map(([k, c]) => `${k} = ${c.n}`).join(' · ')}`;
  const csv = (name: string, sections: { title: string; cols: string[]; rows: (string | number)[][] }[]) => {
    const q = (v: unknown) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const body = sections.map((s) => [s.title, s.cols.map((c) => q(c.replace('\n', ' '))).join(','), ...s.rows.map((r) => r.map(q).join(','))].join('\r\n')).join('\r\n\r\n') + `\r\n\r\n${q(legend)}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿', body], { type: 'text/csv;charset=utf-8' }));
    a.download = `${name}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const tableHtml = (cs: string[], rows: (string | number)[][], first: number, totals: boolean, stt = false) => {
    const dayFrom = first, dayTo = first + T.n - 1;
    const th = (v: string) => `<th style="border:1px solid #000;padding:3px 1px;font-size:8.5px;background:#e2e8f0">${esc(v).replace('\n', '<br>')}</th>`;
    const td = (v: string | number, i: number) => { const c = typeof v === 'string' ? CODES[v] : undefined, day = i >= dayFrom && i <= dayTo;
      return `<td style="border:1px solid #000;padding:3px 1px;font-size:8.5px;${i === 0 ? 'text-align:left;white-space:nowrap;' : 'text-align:center;'}${i > dayTo ? 'white-space:nowrap;' : ''}${c && day ? `background:${c.bg};color:${c.c};font-weight:700` : ''}">${typeof v === 'number' ? (i > dayTo + 1 ? money(v) : numf(v)) : esc(v)}</td>`; };
    const tot = cs.map((_, i) => (i > dayTo ? rows.reduce((a, r) => a + (Number(r[i]) || 0), 0) : null));
    return `<table style="width:100%;border-collapse:collapse;table-layout:auto">${stt ? '' : ''}<tr>${(stt ? ['STT', ...cs] : cs).map(th).join('')}</tr>
      ${rows.map((r, k) => `<tr>${stt ? `<td style="border:1px solid #000;padding:3px 1px;font-size:8.5px;text-align:center">${k + 1}</td>` : ''}${r.map(td).join('')}</tr>`).join('')}
      ${totals ? `<tr style="font-weight:bold">${stt ? '<td style="border:1px solid #000"></td>' : ''}${tot.map((t, i) => `<td style="border:1px solid #000;padding:3px 1px;font-size:8.5px;text-align:center">${i === 0 ? 'Cộng' : t == null ? '' : (i > dayTo + 1 ? money(t) : numf(t))}</td>`).join('')}</tr>` : ''}</table>`;
  };
  async function printMain() {
    setBusy('Đang dựng bảng…');
    try {
      const [c, b] = await Promise.all([company(), boss(ctx.tenant_id ?? '', me)]);
      const rows = found.map((x) => rowOf(x.e));
      setView({ title: `Bảng chấm công ${monthTxt}`, html: `<div style="font-size:12px">${head(c)}<h2 style="text-align:center;margin:10px 0 6px;font-size:17px">BẢNG CHẤM CÔNG ${monthTxt.toUpperCase()}</h2>
        ${tableHtml(cols, rows, 2, money_)}<p style="font-size:10px;margin:4px 0">${esc(legend)}</p>
        <table style="width:100%;border-collapse:collapse;margin-top:8px"><tr>${signCol('NGƯỜI CHẤM CÔNG', '(Ký, họ tên)', '', '', null, 33)}${signCol('PHỤ TRÁCH BỘ PHẬN', '(Ký, họ tên)', '', '', null, 33)}${bossCol(b.b, 'GIÁM ĐỐC', 34)}</tr></table></div>` });
    } catch (x) { toast('error', errMsg(x)); } finally { setBusy(''); }
  }

  // ---- bảng lái xe theo nhóm tuyến
  const rtpPick = () => { const L = groups.filter((m) => grs.includes(m.n) || grs.includes(`x:${m.o.n}`)); return L.length ? L : groups; };
  const rtpEmps = (m: Group) => {
    const drv = byPb(base).filter((e) => T.isDriver(e));
    const L = grs.length ? drv.filter((e) => (grs.includes(`x:${m.n}`) ? T.grp(e) === m.n && T.cross(e) > 0 : T.ran(e, m.n))) : drv.filter((e) => T.grp(e) === m.n);
    return L.sort((a, b) => a.full_name.localeCompare(b.full_name, 'vi'));
  };
  const rtpCols = ['Họ và tên', ...cols.slice(2)];
  const rtpRows = (m: Group): (string | number)[][] => rtpEmps(m).map((e) => {
    const mn0 = T.main(e);
    if (mn0 && mn0.k !== m.k) {   // chạy chéo: chỉ công / tiền chạy trên nhóm này, lương nằm ở nhóm chính
      const dd = T.congNhom(e.id, [m.k]), tot = Object.values(dd).reduce((x, y) => x + y, 0), tien = T.tienNhom(e.id, [m.k]), cp = Math.round(tien * Math.max(0, d.cpPct) / 100);
      return [e.full_name, ...days.map((x) => dd[x] ?? ''), tot, ...(hideMoney ? [] : [tien, cp, '', '', tien - cp])];
    }
    const s = T.summarize(e), lc = T.lcDays(e.id), x = T.cross(e), ch = x > 0 && !!mn0 && mn0.k === m.k;
    const oc = ch ? T.congNhom(e.id, m.o.ks) : {}, ot = ch ? T.tienNhom(e.id, m.o.ks) : 0, cc = Math.round(ot * Math.max(0, d.cpPct) / 100), o = T.payOf(e);
    return [e.full_name, ...days.map((k) => (lc[k] ? (ch ? Math.max(0, lc[k]!.cong - (oc[k] ?? 0)) || '' : lc[k]!.cong) : '')), ch ? s.lv - x : s.lv,
      ...(hideMoney ? [] : [s.tienCong - ot, s.cpKhac - cc, o.lck, o.bh, o.show ? o.thucNhan - (ot - cc) : ''])];
  });
  async function printRtp() {
    setBusy('Đang dựng bảng…');
    try {
      const [c, b] = await Promise.all([company(), boss(ctx.tenant_id ?? '', me)]);
      const L = rtpPick();
      const sec = (m: Group) => { const R = rtpRows(m);
        return R.length ? `<h3 style="margin:14px 0 6px;font-size:14px">${esc(m.n)} <small style="font-weight:500">(${R.length} lái xe)</small></h3>${tableHtml(rtpCols, R, 1, true, true)}`
          : `<h3 style="margin:14px 0 6px;font-size:14px">${esc(m.n)}</h3><p>Không có lái xe nào chạy tuyến này trong ${monthTxt}.</p>`; };
      setView({ title: `Bảng chấm công lái xe theo tuyến ${monthTxt}`, html: `<div style="font-size:12px">${head(c)}<h2 style="text-align:center;margin:10px 0 2px;font-size:17px">BẢNG CHẤM CÔNG LÁI XE THEO TUYẾN ${monthTxt.toUpperCase()}</h2>
        <div style="text-align:center">${L.map((m) => esc(m.n)).join(' · ')}</div>${L.map(sec).join('')}
        <p style="font-size:10px;margin:6px 0">Ô ngày ghi số công của lái xe trong ngày. Mỗi nhóm tuyến gồm cả chiều đi và chiều về.</p>
        <table style="width:100%;border-collapse:collapse;margin-top:8px"><tr>${signCol('NGƯỜI CHẤM CÔNG', '(Ký, họ tên)', '', '', null, 33)}${signCol('ĐỘI TRƯỞNG ĐIỀU HÀNH', '(Ký, họ tên)', '', '', null, 33)}${bossCol(b.b, 'GIÁM ĐỐC', 34)}</tr></table></div>` });
    } catch (x) { toast('error', errMsg(x)); } finally { setBusy(''); }
  }

  let lastG: string | null = null;
  const span = days.length + (hideMoney ? 2 : 7);
  // ---- Công & lương của tôi (người chỉ xem của mình): ô tổng + in phiếu lương (như "Thông tin của tôi" app cũ)
  const meRow = !viewAll ? base.find(mine) : undefined;
  async function printSlip(e: TStaff) {
    const s = T!.summarize(e), o = T!.payOf(e);
    const [c, b] = await Promise.all([company(), boss(ctx.tenant_id ?? '', me)]);
    const B = 'border:1px solid #000;padding:5px 8px;font-size:13px';
    const r = (n: string, l: string, g: string, v: number | string) => `<tr><td style="${B};text-align:center">${n}</td><td style="${B}">${l}</td><td style="${B}">${esc(g)}</td><td style="${B};text-align:right">${typeof v === 'number' ? money(v) : v}</td></tr>`;
    setView({ title: `Phiếu lương ${e.full_name} ${monthTxt}`, land: false, html: `<div style="font-size:13px">${head(c)}
      <h2 style="text-align:center;margin:12px 0 2px;font-size:18px">PHIẾU LƯƠNG</h2><div style="text-align:center;margin-bottom:10px">Kỳ lương ${esc(monthTxt)}</div>
      <p>Họ và tên: <b>${esc(e.full_name)}</b>${e.job_title ? ` · ${esc(e.job_title)}` : ''}${e.department ? ` · ${esc(e.department)}` : ''}</p>
      <table style="width:100%;border-collapse:collapse;margin:6px 0"><tr style="background:#e2e8f0"><th style="${B}">STT</th><th style="${B}">Khoản mục</th><th style="${B}">Diễn giải</th><th style="${B}">Số tiền (đ)</th></tr>
        ${r('1', 'Công làm', '', numf(s.lv))}
        ${r('2', 'Tiền công', s.drv ? `${numf(s.lc)} công theo tuyến × tiền tài của xe` : 'Lương cố định của tháng', s.tienCong)}
        ${r('3', 'Chi phí khác', s.drv ? `Tiền công × ${numf(d!.cpPct)}%` : '', s.cpKhac)}
        ${r('4', 'Lương chuyển khoản', '', o.lck)}
        ${r('5', 'Trừ BHXH', o.bhSkip ? 'Tạm dừng tháng này' : '', o.bhSkip ? 0 : o.bh)}
        <tr style="font-weight:bold"><td style="${B}" colspan="3">THỰC NHẬN</td><td style="${B};text-align:right">${o.show ? money(o.thucNhan) : '–'}</td></tr></table>
      <table style="width:100%;border-collapse:collapse;margin-top:14px"><tr>${signCol('NGƯỜI NHẬN', '(Ký, họ tên)', '', e.full_name, null, 33)}${signCol('KẾ TOÁN', '(Ký, họ tên)', '', '', null, 33)}${bossCol(b.b, 'GIÁM ĐỐC', 34)}</tr></table></div>` });
  }

  return (
    <>
    {meRow && (() => {
      const s = T.summarize(meRow), o = T.payOf(meRow);
      return (
        <section className="card">
          <div className="item-head"><h2>Công &amp; lương của tôi · {monthTxt}</h2>
            <button type="button" className="btn small primary" onClick={() => void printSlip(meRow)}>In phiếu lương</button></div>
          <div className="dt-kpi me-pay">
            <div><b>{numf(s.lv)}</b><span>Công làm</span></div>
            <div><b>{money(s.tienCong)}</b><span>Tiền công</span></div>
            <div><b className="ok-text">{o.show ? money(o.thucNhan) : '–'}</b><span>Thực nhận</span></div>
          </div>
          <p className="small muted">Chi phí khác {money(s.cpKhac)} · Lương CK {money(o.lck)} · Trừ BHXH {money(o.bhSkip ? 0 : o.bh)}</p>
        </section>
      );
    })()}
    <section className="card cc-screen">
      <div className="item-head">
        <h2>Bảng chấm công {monthTxt}</h2>
        <span className="actions">
          <label className="inline">Kỳ lương <input type="month" value={ym} onChange={(e) => { if (e.target.value) { setYm(e.target.value); setPage(0); } }} /></label>
          <button type="button" className="btn small" disabled={!!busy} onClick={() => void printMain()}>Xem / in</button>
          <button type="button" className="btn small" onClick={() => csv(`Bang cham cong ${ym}`, [{ title: `BẢNG CHẤM CÔNG ${monthTxt.toUpperCase()}`, cols, rows: found.map((x) => rowOf(x.e)) }])}>Tải Excel (CSV)</button>
          {busy && <span className="small muted">{busy}</span>}
        </span>
      </div>

      {viewAll && <div className="cc-pb">
        <span className="cc-pbl">Phòng ban</span>
        <button type="button" className={!pbs.length ? 'chip on' : 'chip'} onClick={() => { setPbs([]); setPage(0); }}>Tất cả <b>{base.length}</b></button>
        {depts.map((p) => <button key={p} type="button" className={pbs.includes(p) ? 'chip on' : 'chip'} onClick={() => { setPbs(toggle(pbs, p)); setPage(0); }}>{p} <b>{base.filter((e) => e.department === p).length}</b></button>)}
        {pbs.length > 0 && <span className="small muted">Đang chọn {pbs.length} phòng ban · {all_.length} người</span>}
      </div>}
      {viewAll && G.length > 0 && <div className="cc-pb">
        <span className="cc-pbl">Nhóm tuyến</span>
        <button type="button" className={!grs.length ? 'chip on' : 'chip'} onClick={() => { setGrs([]); setPage(0); }}>Tất cả <b>{all_.length}</b></button>
        {G.map((g) => <button key={g} type="button" className={grs.includes(g) ? 'chip on' : 'chip'} onClick={() => { setGrs(toggle(grs, g)); setPage(0); }}>{g} <b>{gAll[g]}</b></button>)}
        {XC.length > 0 && <span className="cc-pbl">Chạy chéo</span>}
        {XC.map((x) => <button key={x.v} type="button" className={grs.includes(x.v) ? 'chip on cc-xb' : 'chip cc-xb'} title={`Lái xe nhóm ${x.m.n} có chạy tuyến ${x.m.o.n} (cả chiều đi và về)`}
                                onClick={() => { setGrs(toggle(grs, x.v)); setPage(0); }}>{x.m.s} chạy qua {x.m.o.s} <b>{x.n}</b></button>)}
        {grs.length > 0 && <span className="small muted">Đang chọn {grs.length} nhóm · {found.length} người</span>}
        <span className="cc-sp" />
        <button type="button" className="btn small" disabled={!!busy} title="In bảng lái xe theo nhóm tuyến đang chọn (chưa chọn = mọi nhóm)" onClick={() => void printRtp()}>In bảng lái xe theo tuyến</button>
        <button type="button" className="btn small" onClick={() => csv(`Cham cong lai xe theo tuyen ${ym}`, rtpPick().map((m) => ({ title: `BẢNG CHẤM CÔNG LÁI XE TUYẾN ${m.n} · ${monthTxt.toUpperCase()}`, cols: ['STT', ...rtpCols], rows: rtpRows(m).map((r, i) => [i + 1, ...r]) })))}>Excel</button>
      </div>}

      {viewAll && rkeys.length > 0 && <details className="cc-ct" open={ctOpen} onToggle={(e) => setCtOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Công lái xe theo tuyến <span className="muted small">{rkeys.length} tuyến · {rGroups.size} nhóm · bấm để chỉnh công/chuyến</span></summary>
        <div className="cc-ctb">
          {[...rGroups.entries()].map(([g, L]) => (
            <div key={g} className="cc-ctg"><b>{g}</b>
              {L.map((x) => (
                <label key={x.k}><span>{x.name}</span>
                  <input type="number" min={0} max={10} step={0.25} aria-label={`Công / chuyến ${x.name}`} disabled={!canEdit}
                         defaultValue={d.congTuyen[x.k] ?? d.congTuyen[x.rid] ?? 1}
                         onBlur={(e) => { const v = e.target.value === '' ? 1 : Math.max(0, Number(e.target.value)); if (v !== (d.congTuyen[x.k] ?? d.congTuyen[x.rid] ?? 1)) void saveSet({ cong_tuyen: { ...d.congTuyen, [x.k]: v } }, `Đã lưu: ${x.name} = ${numf(v)} công/chuyến`); }} />
                  <em>công / chuyến</em></label>
              ))}
            </div>
          ))}
          <p className="small muted">Mỗi tuyến (chiều đi, chiều về) chấm công riêng: số công trong ô ngày = số chuyến của từng tuyến × công/chuyến của tuyến đó. Danh sách lái xe được gom theo nhóm tuyến (sửa nhóm ở Điều hành › Nhóm tuyến đường).</p>
        </div>
      </details>}

      {viewAll && money_ && <details className="cc-ct" open={poOpen} onToggle={(e) => setPoOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Xử lý khi lái xe không đủ tiền trừ <span className="muted small">Phần thiếu không chuyển sang tháng sau</span></summary>
        <div className="cc-ctb po-rules">
          <div className="po-r"><b>1 · Không chuyển nợ</b><span>Thực nhận không bao giờ âm. Phần thiếu tiền bỏ qua, không chuyển sang tháng sau.</span></div>
          <div className="po-r"><b>2 · Thứ tự trừ</b><span>BHXH → Chi phí khác → Lương CK. Hết tiền ở bước nào thì các khoản sau không trừ.</span></div>
          <div className="po-r"><b>3 · Tạm dừng BHXH</b><span><label className="check"><input type="checkbox" checked={d.bh14} disabled={!canEdit}
            onChange={(e) => void saveSet({ bh14: e.target.checked }, 'Đã lưu quy tắc xử lý thiếu tiền')} /> Không trừ BHXH tháng lái xe có từ 14 ngày làm việc không chạy</label> <em>(hỏi kế toán trước khi bật)</em></span></div>
          <div className="po-r"><b>Chi phí khác</b><span><label className="inline"><input type="number" min={0} max={100} step={0.1} aria-label="Chi phí khác lái xe (% tiền công)" disabled={!canEdit} defaultValue={d.cpPct}
            onBlur={(e) => { const v = Math.max(0, Math.min(100, Number(e.target.value) || 0)); if (v !== d.cpPct) void saveSet({ cp_khac_lx: v }, `Đã lưu: chi phí khác lái xe ${numf(v)}% tiền công`); }} /> % tiền công của lái xe</label></span></div>
          <div className="po-r"><b>Công chuẩn</b><span><label className="inline"><input type="number" min={1} max={31} aria-label="Công chuẩn / tháng" disabled={!canEdit} defaultValue={d.congChuan}
            onBlur={(e) => { const v = Math.max(1, Math.min(31, Math.round(Number(e.target.value) || 26))); if (v !== d.congChuan) void saveSet({ cong_chuan: v }, `Đã lưu: công chuẩn ${v} ngày/tháng`); }} /> ngày / tháng</label></span></div>
        </div>
      </details>}

      <div className="cc-wrap">
        <table className="cc">
          <thead><tr>
            <th className="nm">Nhân viên<br /><small>{monthTxt}</small></th>
            {days.map((x) => <th key={x} className={`${ym}-${pad(x)}` === today ? 'td' : T.isOff(x) ? 'we' : ''}>{x}<br />{DOW[dow(ym, x)]}</th>)}
            <th>Công<br />làm</th>
            {!hideMoney && <><th>Tiền<br />công</th><th>Chi phí<br />khác</th><th>Lương<br />CK</th><th>Trừ<br />BHXH</th><th>Thực<br />nhận</th></>}
          </tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td className="nm">Chưa có nhân viên</td></tr>}
            {shown.map(({ e, g }) => {
              const gh = g !== lastG;
              lastG = g;
              const s = T.summarize(e), o = T.payOf(e), m = T.main(e), x = T.cross(e);
              return [
                gh && <tr key={`g:${g}`} className="cc-grp"><td colSpan={span}><div className="cc-gs">{g.replace(/^~+/, '')} <span>{gCount[g]} người</span></div></td></tr>,
                <tr key={e.id}>
                  <td className="nm"><b>{e.full_name}</b>{s.drv && <span className="cc-drv" title="Ngày công tự lấy từ chuyến đã chạy"> 🚌</span>}
                    {m && x > 0 && <span className="cc-x" title={`Nhóm ${m.n}, có chạy ${m.o.n} (chiều đi và về) ${numf(x)} công`}>+{numf(x)} công {m.o.s}</span>}</td>
                  {days.map((k) => {
                    const c = cell(e, k), col = c.text ? CODES.X : undefined;
                    return <td key={k} className={`d${T.isOff(k) ? ' we' : ''}${c.num ? ' num' : ''}`} title={c.title || undefined}
                               style={col ? { background: col.bg, color: col.c } : undefined}>{c.text}</td>;
                  })}
                  <td className="sum">{numf(s.lv)}</td>
                  {!hideMoney && <>
                    <td className="sum" title={s.drv ? `${numf(s.lc)} công (theo tuyến) × tiền tài của xe` : 'Lương cố định của tháng (bảng BHXH & lương chuyển khoản)'}>{s.drv || s.tienCong ? money(s.tienCong) : '–'}</td>
                    <td className="sum" title={s.drv ? `Tiền công × ${numf(d.cpPct)}%` : 'Chỉ áp dụng cho lái xe'}>{money(s.cpKhac)}</td>
                    <td className="sum hl" title={tcNote(e, 'Lương CK')}>{money(o.lck)}</td>
                    <td className="sum" title={o.bhSkip ? `Tạm dừng BHXH tháng này: ${o.idle} ngày làm việc không có chuyến (từ 14 ngày)` : tcNote(e, 'BHXH')}>{o.bhSkip ? <><s className="muted">{money(d.pay.get(e.id)?.bhxh_pay ?? 0)}</s> 0</> : money(o.bh)}</td>
                    <td className="sum tn" title={poTip(e)}>{o.show ? money(o.thucNhan) : '–'}</td>
                  </>}
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && <div className="actions cc-pager">
        <button type="button" className="btn small" disabled={pg === 0} onClick={() => setPage(pg - 1)}>‹ Trước</button>
        <span className="small">Trang {pg + 1}/{pages} · {found.length} người</span>
        <button type="button" className="btn small" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Sau ›</button>
      </div>}
      <p className="small muted">Công chuẩn: <b>{d.congChuan}</b> ngày/tháng · Ngày nghỉ tuần: <b>{d.offSat ? 'Thứ 7 và Chủ nhật' : 'Chủ nhật'}</b> (theo cài đặt Hợp đồng lao động) · Lái xe: công lấy từ chuyến đã chạy (lái xe 1); văn phòng: tự điền X ngày làm việc đã qua.
        {money_ && ' Lương CK, BHXH, lương cố định nhập ở Cấu hình › BHXH & lương chuyển khoản theo tháng; tiền tài nhập ở hồ sơ xe.'}</p>
      {view && <PaperView title={view.title} pages={[{ html: view.html, land: view.land ?? true }]} onClose={() => setView(null)} />}
    </section>
    </>
  );
}
