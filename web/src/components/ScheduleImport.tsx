// Nhập điều hành xe (như app cũ): dán lịch từ Vexere, hoặc file Excel / CSV / bảng dán từ Excel.
// Xem trước từng dòng (khớp / khác / chuyến mới / không áp dụng được), chọn dòng rồi áp dụng: xếp xe + lái xe cho chuyến.
import { useEffect, useMemo, useRef, useState } from 'react';
import readXlsxFile from 'read-excel-file';
import { Modal } from './Modal';
import { fmtDate } from './Documents';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { dirName, reverseName, type Dir } from '../lib/routes';
import { norm, parseRows, parseVexere, plateKey, routeKey, templateCsv, textToRows, titleCase, type Parsed } from '../lib/scheduleImport';

interface Route { id: string; code: string; name: string; name_ve: string | null; is_active: boolean }
interface Trip { id: string; route_id: string; direction: Dir; service_date: string; depart_at: string; vehicle_id: string | null; status: string;
  departed_at: string | null; edit_unlocked_at: string | null }
interface Crew { trip_id: string; role: 'lai_xe_1' | 'lai_xe_2' | 'phu_xe'; staff_id: string; active: boolean }
interface Veh { id: string; plate: string; is_active: boolean }
interface Staff { id: string; full_name: string; position: string; is_active: boolean }
interface VType { id: string; name: string; reg_seats: number; reg_berths: number; is_active: boolean }

interface Row {
  ngay: string; tuyen: string; gio: string; rb: string; rl: string; cho: number;
  route: { id: string | null; dir: Dir; newName?: string; newCode?: string } | null;
  trip: Trip | null; v: Veh | null; e: Staff | null; addV: string | null; addE: string | null;
  curV: string; curE: string; same: boolean; ok: boolean; st: string; tone: 'ok' | 'warn' | 'bad' | 'muted';
  /** del: giờ không có tài xế → xóa (hủy) chuyến; reopen: chuyến đã xóa trước đó, nay có tài xế → khôi phục rồi cập nhật */
  del?: boolean; reopen?: Trip | null;
}

const TZ = 'Asia/Ho_Chi_Minh';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const initials = (s: string) => s.split(/\s+/).filter(Boolean).map((w) => norm(w)[0]?.toUpperCase() ?? '').join('');

export function ScheduleImport({ day, onClose, onDone }: { day: string; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [txt, setTxt] = useState('');
  const [msg, setMsg] = useState<{ ok: string; warn: string[] } | null>(null);
  const [P, setP] = useState<Parsed | null>(null);
  const [src, setSrc] = useState('');
  const [opt, setOpt] = useState({ e: true, v: true, n: true });
  const [base, setBase] = useState<{ routes: Route[]; vehicles: Veh[]; staff: Staff[]; types: VType[]; defType: string } | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [crew, setCrew] = useState<Crew[]>([]);
  const [gone, setGone] = useState<Trip[]>([]);          // chuyến đã hủy cùng ngày (để khôi phục khi có tài xế lại)
  const [busyTrips, setBusyTrips] = useState<Set<string>>(new Set());   // chuyến đã có vé / hàng: không xóa
  const [pick, setPick] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      const [r, v, s, t, d] = await Promise.all([
        supabase.from('routes').select('id, code, name, name_ve, is_active'),
        supabase.from('vehicles').select('id, plate, is_active'),
        supabase.from('staff_members').select('id, full_name, position, is_active'),
        supabase.from('vehicle_types').select('id, name, reg_seats, reg_berths, is_active'),
        supabase.from('tenant_settings').select('value').eq('key', 'chuyen.loai_xe_mac_dinh').maybeSingle(),
      ]);
      setBase({ routes: (r.data ?? []) as Route[], vehicles: (v.data ?? []) as Veh[], staff: (s.data ?? []) as Staff[], types: (t.data ?? []) as VType[],
        defType: typeof d.data?.value === 'string' ? d.data.value : '' });
    })();
  }, []);

  // chuyến + tổ lái của các ngày trong dữ liệu nhập
  const days = useMemo(() => [...new Set((P?.items ?? []).map((x) => x.ngay || day))].sort(), [P, day]);
  useEffect(() => {
    if (!days.length) return;
    void (async () => {
      const t = await supabase.from('trips').select('id, route_id, direction, service_date, depart_at, vehicle_id, status, departed_at, edit_unlocked_at')
        .in('service_date', days).in('status', ['mo', 'huy']);
      const all = (t.data ?? []) as Trip[];
      const list = all.filter((x) => x.status === 'mo');
      setTrips(list);
      setGone(all.filter((x) => x.status === 'huy'));
      if (list.length) {
        const ids = list.map((x) => x.id);
        const [c, si, sh] = await Promise.all([
          supabase.from('trip_crew').select('trip_id, role, staff_id, active').in('trip_id', ids).eq('active', true),
          supabase.from('seat_inventory').select('trip_id').in('trip_id', ids).in('status', ['giu', 'dat', 'da_tt']),
          supabase.from('shipments').select('trip_id').in('trip_id', ids),
        ]);
        setCrew((c.data ?? []) as Crew[]);
        setBusyTrips(new Set([...(si.data ?? []), ...(sh.data ?? [])].map((x) => (x as { trip_id: string }).trip_id)));
      } else { setCrew([]); setBusyTrips(new Set()); }
    })();
  }, [days]);

  const rows: Row[] = useMemo(() => {
    if (!P || !base) return [];
    const opts = base.routes.filter((r) => r.is_active).flatMap((r) => (['di', 've'] as Dir[]).map((d) => ({ r, d, k: routeKey(dirName(r, d)) })));
    const newRoutes: { k: string; kr: string; name: string; code: string }[] = [];
    const usedCodes = new Set(base.routes.map((r) => r.code.toUpperCase()));
    const resolveRoute = (t: string): Row['route'] => {
      const k = routeKey(t);
      const hit = opts.find((o) => o.k === k);
      if (hit) return { id: hit.r.id, dir: hit.d };
      if (!opt.n || !t.trim()) return null;
      const nr = newRoutes.find((x) => x.k === k || x.kr === k);
      if (nr) return { id: null, dir: nr.k === k ? 'di' : 've', newName: nr.name, newCode: nr.code };
      const name = t.trim().replace(/\s*[⇄→–—]\s*|\s+-\s+/g, ' - ').replace(/\s+/g, ' ');
      const parts = name.split(' - ');
      let code = parts.map(initials).join('-').slice(0, 20) || 'TUYEN';
      for (let i = 2; usedCodes.has(code.toUpperCase()); i++) code = `${parts.map(initials).join('-')}${i}`;
      usedCodes.add(code.toUpperCase());
      newRoutes.push({ k, kr: routeKey(reverseName(name)), name, code });
      return { id: null, dir: 'di', newName: name, newCode: code };
    };
    const findVeh = (b: string) => (b ? base.vehicles.find((v) => plateKey(v.plate) === plateKey(b)) ?? null : null);
    const empCands = (n: string) => base.staff.filter((s) => s.is_active && norm(s.full_name) === norm(n));
    const findEmp = (n: string) => {
      if (!n) return null;
      const c = empCands(n);
      const drivers = c.filter((s) => s.position === 'lai_xe');
      return drivers.length === 1 ? drivers[0] : c.length === 1 ? c[0] : null;
    };
    return P.items.map((it) => {
      const ngay = it.ngay || day;
      const route = resolveRoute(it.tuyen);
      const v = findVeh(it.bks), e = findEmp(it.lai);
      const addV = !v && it.bks && opt.v ? it.bks.toUpperCase() : null;
      const addE = !e && it.lai && opt.e && empCands(it.lai).length === 0 ? titleCase(it.lai) : null;
      const trip = route?.id && it.gio ? trips.find((t) => t.route_id === route.id && t.direction === route.dir && t.service_date === ngay && hhmm(t.depart_at) === it.gio) ?? null : null;
      const d1 = trip ? crew.find((c) => c.trip_id === trip.id && c.role === 'lai_xe_1') : undefined;
      const curV = trip?.vehicle_id ? base.vehicles.find((x) => x.id === trip.vehicle_id)?.plate ?? '' : '';
      const curE = d1 ? base.staff.find((x) => x.id === d1.staff_id)?.full_name ?? '' : '';
      const r: Row = { ngay, tuyen: it.tuyen, gio: it.gio, rb: it.bks, rl: it.lai, cho: it.cho, route, trip, v, e, addV, addE, curV, curE, same: false, ok: false, st: '', tone: 'bad' };
      const vOk = !!(v || addV), eOk = !!(e || addE);
      if (ngay !== day) { r.st = `Khác ngày: lịch ngày ${fmtDate(ngay)}, đang xem ${fmtDate(day)} nên không áp dụng`; r.tone = 'muted'; }
      else if (!route) r.st = 'Không xác định được tuyến';
      else if (!it.gio) r.st = 'Không đọc được giờ';
      else if (!it.lai) {
        // Giờ không có tài xế trên Vexere: xóa chuyến đó (hủy, khôi phục được khi bản dán sau có tài xế)
        const locked = !!(trip?.departed_at && !trip.edit_unlocked_at);
        if (!trip) { r.st = 'Không có tài xế: không tạo chuyến'; r.tone = 'muted'; }
        else if (locked) { r.st = 'Không có tài xế nhưng chuyến đã xuất bến: không xóa'; r.tone = 'muted'; }
        else if (busyTrips.has(trip.id)) { r.st = 'Không có tài xế nhưng chuyến đã có vé / hàng: không xóa, xử lý tay'; r.tone = 'bad'; }
        else { r.ok = true; r.del = true; r.st = 'Không có tài xế: sẽ xóa chuyến này'; r.tone = 'warn'; }
      }
      else if ((it.bks && !vOk) || (it.lai && !eOk)) r.st = `Có ${[it.bks && !vOk && 'xe', it.lai && !eOk && 'lái xe'].filter(Boolean).join(', ')} không khớp danh sách, nhập tay`;
      else if (!vOk || !eOk) r.st = !vOk && !eOk ? 'Thiếu cả lái xe và xe' : !eOk ? 'Thiếu lái xe: không có lái xe thì xe không chạy được' : 'Thiếu xe: lái xe chưa biết chạy xe nào';
      else {
        r.same = !!(trip && v && e && trip.vehicle_id === v.id && d1?.staff_id === e.id);
        const locked = !!(trip?.departed_at && !trip.edit_unlocked_at);
        if (trip && locked) { r.st = r.same ? 'Khớp lịch hiện có (chuyến đã xuất bến)' : 'Khác lịch hiện có, chuyến đã xuất bến nên không sửa'; r.tone = r.same ? 'ok' : 'muted'; }
        else if (trip) { r.ok = true; r.st = r.same ? 'Khớp lịch hiện có' : !trip.vehicle_id && !d1 ? 'Điền vào chuyến đang trống' : 'Khác lịch hiện có, sẽ cập nhật'; r.tone = r.same ? 'ok' : 'warn'; }
        else if (route.id && (r.reopen = gone.find((t) => t.route_id === route.id && t.direction === route.dir && t.service_date === ngay && hhmm(t.depart_at) === it.gio) ?? null)) {
          r.ok = true; r.st = 'Chuyến đã xóa trước đó, nay có tài xế: khôi phục và cập nhật'; r.tone = 'warn';
        }
        else if (opt.n) { r.ok = true; r.st = route.id ? 'Tạo chuyến mới' : 'Tạo chuyến (tuyến mới)'; r.tone = 'warn'; }
        else r.st = 'Chưa có chuyến này';
        if (r.ok && !r.same && (addE || addV)) r.st += ` + thêm ${[addE && 'lái xe', addV && 'xe'].filter(Boolean).join(', ')} mới`;
      }
      return r;
    });
  }, [P, base, trips, crew, opt, day, gone, busyTrips]);

  // mặc định chọn các dòng cần áp dụng (bỏ dòng đã khớp)
  useEffect(() => { setPick(new Set(rows.map((r, i) => (r.ok && !r.same ? i : -1)).filter((i) => i >= 0))); }, [rows]);

  function readText(raw: string) {
    const v = parseVexere(raw);
    if (v.items.length) {
      setP(v); setSrc('lịch Vexere');
      setMsg({ ok: `Đọc được ${v.items.length} chuyến, ${v.routes} tuyến${v.ngay ? `, ngày ${fmtDate(v.ngay)}` : ''}${v.nHuy ? `, bỏ ${v.nHuy} chuyến hủy` : ''}.`,
        warn: [...(v.ngay && v.ngay !== day ? [`Lịch dán là ngày ${fmtDate(v.ngay)} nhưng đang xem ngày ${fmtDate(day)}: không áp dụng. Chọn đúng ngày ở Điều hành hoặc dán lịch đúng ngày.`] : []), ...v.warn] });
      return;
    }
    const t = parseRows(textToRows(raw));
    if (t.items.length) { setP(t); setSrc('bảng dán từ Excel'); setMsg({ ok: `Đọc được ${t.items.length} chuyến, ${t.routes} tuyến.`, warn: [] }); return; }
    setP(null);
    setMsg({ ok: '', warn: ['Không nhận ra bảng lịch. Mở trang Điều hành xe của Vexere, chọn Chọn tất cả, Sao chép rồi dán lại; hoặc dán bảng từ Excel có cột Tuyến, Giờ, Biển số, Lái xe.'] });
  }
  // Dán vào là đọc + so sánh ngay; ô dán tự xóa để dán lần khác (so sánh nhiều lần)
  useEffect(() => {
    if (!txt.trim()) return;
    const t = setTimeout(() => { readText(txt); setTxt(''); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txt]);

  async function readFile(f: File) {
    try {
      const data: unknown[][] = /\.csv$/i.test(f.name) ? textToRows(await f.text()) : (await readXlsxFile(f)) as unknown[][];
      const t = parseRows(data.filter((r) => r.some((c) => String(c ?? '').trim() !== '')));
      if (!t.items.length) { setP(null); setMsg({ ok: '', warn: ['Không nhận ra dữ liệu. Cần cột Tuyến, Giờ và Biển số hoặc Lái xe, hoặc bảng có hàng tiêu đề là các giờ chạy. Bấm "Tải file mẫu" để xem cách ghi.'] }); return; }
      setP(t); setSrc(`file ${f.name}`);
      setMsg({ ok: `Đọc được ${t.items.length} chuyến từ ${f.name} (${t.kind === 'grid' ? 'bảng điều hành' : 'danh sách'}).`, warn: [] });
    } catch (e) {
      toast('error', `Không đọc được file: ${errMsg(e)}`);
    }
  }
  function template() {
    const csv = templateCsv([[fmtDate(day), 'Biên Hòa - Vũng Tàu', '06:00', '60F-004.39', 'Nguyễn Văn A']]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'Mau nhap dieu hanh xe.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  async function apply() {
    if (!base) return;
    const sel = rows.filter((r, i) => pick.has(i) && r.ok && !r.same);
    if (!sel.length) { toast('error', 'Chưa chọn dòng nào để áp dụng'); return; }
    let up = 0, nw = 0, warnN = 0, del = 0, back = 0;
    const errs: string[] = [], madeE: string[] = [], madeV: string[] = [], madeR: string[] = [];
    const routeIds = new Map<string, string>(), vehIds = new Map<string, string>(), empIds = new Map<string, string>();
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
    const pickType = (cho: number) => {
      const act = base.types.filter((t) => t.is_active);
      const tot = (t: VType) => t.reg_seats + t.reg_berths;
      return (cho ? act.find((t) => [cho, cho + 1, cho + 2].includes(tot(t))) : undefined)
        ?? act.find((t) => t.id === base.defType) ?? act.find((t) => tot(t) === 16) ?? act[0];
    };
    for (const r of sel) {
      const label = `${fmtDate(r.ngay)} ${r.gio} ${r.tuyen}`;
      setBusy(`Đang áp dụng ${label}…`);
      if (r.del && r.trip) {
        try { await rpc('cancel_trip', { p_trip_id: r.trip.id, p_reason: `Không có tài xế trên ${src}` }); del++; }
        catch (e) { errs.push(`${label}: ${errMsg(e)}`); }
        continue;
      }
      try {
        // tuyến
        let routeId = r.route?.id ?? null;
        if (!routeId && r.route?.newName) {
          routeId = routeIds.get(r.route.newCode ?? '') ?? null;
          if (!routeId) {
            const ins = await supabase.from('routes').insert({ code: r.route.newCode, name: r.route.newName }).select('id').single();
            if (ins.error) throw new Error(`Không tạo được tuyến ${r.route.newName}: ${ins.error.message}`);
            routeId = (ins.data as { id: string }).id;
            routeIds.set(r.route.newCode ?? '', routeId);
            madeR.push(r.route.newName);
          }
        }
        if (!routeId || !r.route) throw new Error('Không xác định được tuyến');
        // xe
        let vehId = r.v?.id ?? vehIds.get(plateKey(r.rb)) ?? null;
        if (!vehId && r.addV) {
          const ty = pickType(r.cho);
          if (!ty) throw new Error('Chưa có loại xe nào để thêm xe mới');
          const id = crypto.randomUUID();
          const ins = await supabase.from('vehicles').insert({ id, plate: r.addV, vehicle_type_id: ty.id });
          if (ins.error) throw new Error(`Không thêm được xe ${r.addV}: ${ins.error.message}`);
          vehId = id; vehIds.set(plateKey(r.rb), id); madeV.push(r.addV);
        }
        // lái xe
        let empId = r.e?.id ?? empIds.get(norm(r.rl)) ?? null;
        if (!empId && r.addE) {
          const id = crypto.randomUUID();
          await rpc('save_staff', { p_id: id, p: { full_name: r.addE, position: 'lai_xe', joined_on: today,
            note: `Thêm tự động từ ${src} ngày ${fmtDate(r.ngay)}, cần bổ sung hồ sơ` } });
          empId = id; empIds.set(norm(r.rl), id); madeE.push(r.addE);
        }
        // chuyến
        let tripId = r.trip?.id ?? null;
        if (!tripId && r.reopen) { await rpc('reopen_trip', { p_trip_id: r.reopen.id }); tripId = r.reopen.id; back++; }
        else if (!tripId) {
          tripId = await rpc<string>('add_extra_trip', { p_route_id: routeId, p_direction: r.route.dir, p_date: r.ngay, p_time: r.gio, p_note: `Nhập từ ${src}` });
          nw++;
        } else up++;
        const keep = (role: Crew['role']) => crew.find((c) => c.trip_id === tripId && c.role === role)?.staff_id ?? null;
        const args = { p_trip_id: tripId, p_vehicle_id: vehId, p_driver1: empId, p_driver2: keep('lai_xe_2'), p_assistant: keep('phu_xe') };
        const res = await rpc<{ saved: boolean; warnings: string[] }>('assign_trip', { ...args, p_reason: null });
        if (!res.saved) {
          warnN++;
          await rpc('assign_trip', { ...args, p_reason: `Nhập từ ${src}: ${res.warnings.join('; ')}`.slice(0, 500) });
        }
      } catch (e) {
        const m = errMsg(e);
        errs.push(`${label}: ${/no_overlap/.test(m) ? 'xe hoặc lái xe trùng giờ với chuyến khác' : m}`);
      }
    }
    setBusy(null);
    const done = `Đã nhập lịch: cập nhật ${up} chuyến, tạo mới ${nw} chuyến`
      + (madeE.length ? `, thêm ${madeE.length} lái xe` : '') + (madeV.length ? `, thêm ${madeV.length} xe` : '') + (madeR.length ? `, thêm ${madeR.length} tuyến` : '')
      + (warnN ? `, ${warnN} chuyến có cảnh báo (đã ghi lý do)` : '') + (del ? `, xóa ${del} chuyến không có tài xế` : '') + (back ? `, khôi phục ${back} chuyến` : '');
    toast(errs.length ? 'error' : 'ok', errs.length ? `${done}. ${errs.length} dòng lỗi: ${errs.slice(0, 3).join(' · ')}` : done);
    await onDone();
    setP((p) => (p ? { ...p } : p));   // so sánh lại với lịch vừa cập nhật (dán tiếp được)
  }

  const nSame = rows.filter((r) => r.same).length;
  const nDiff = rows.filter((r) => r.ok && r.trip && !r.same && r.st.startsWith('Khác')).length;
  const nNew = rows.filter((r) => r.ok && !r.trip && !r.reopen).length;
  const nBad = rows.filter((r) => !r.ok && r.tone === 'bad').length;
  const nDel = rows.filter((r) => r.del).length;
  const cell = (r: Row, k: 'v' | 'e') => {
    const o = k === 'v' ? r.v?.plate : r.e?.full_name, raw = k === 'v' ? r.rb : r.rl, add = k === 'v' ? r.addV : r.addE, cur = k === 'v' ? r.curV : r.curE;
    return (
      <>
        {o ? <span className="state-con_han">{o}</span> : add ? <span className="state-sap_het" title="Chưa có trong danh sách, sẽ được thêm">+ {add} (mới)</span>
          : raw ? <span className="state-het_han" title="Không khớp danh sách">{raw} ?</span> : <span className="muted">—</span>}
        {r.trip && !r.same && cur && <div className="small muted">App: {cur}</div>}
      </>
    );
  };

  return (
    <Modal wide title="Nhập điều hành xe (Vexere / Excel)" onClose={onClose}>
      <div className="form">
        <div>
          <b>Dán lịch từ Vexere</b>
          <p className="small muted">Chỉ áp dụng lịch đúng ngày <b>{fmtDate(day)}</b>. Mở trang Điều hành xe của Vexere, chọn ngày, bôi đen toàn trang (Ctrl+A), Sao chép (Ctrl+C), rồi dán vào ô dưới (Ctrl+V). Cũng dán được bảng chép từ Excel.</p>
          <textarea rows={8} className="paste-box" value={txt} onChange={(e) => setTxt(e.target.value)} aria-label="Nội dung dán từ Vexere"
                    placeholder="Dán nội dung trang Vexere vào đây: dán xong tự đọc và so sánh với lịch ngày đang xem. Dán lại bao nhiêu lần cũng được." />
          {msg && <div className="small">{msg.ok && <span className="state-con_han">{msg.ok}</span>}{msg.warn.map((w) => <div key={w} className="state-het_han">{w}</div>)}</div>}
        </div>
        <div className="chips small">
          <label className="check"><input type="checkbox" checked={opt.e} onChange={(e) => setOpt({ ...opt, e: e.target.checked })} /> Thêm lái xe chưa có trong danh sách</label>
          <label className="check"><input type="checkbox" checked={opt.v} onChange={(e) => setOpt({ ...opt, v: e.target.checked })} /> Thêm biển số chưa có trong danh sách</label>
          <label className="check"><input type="checkbox" checked={opt.n} onChange={(e) => setOpt({ ...opt, n: e.target.checked })} /> Cho phép tạo tuyến / chuyến mới</label>
        </div>
        <div className={drag ? 'drop-zone on' : 'drop-zone'} role="button" tabIndex={0} onClick={() => fileRef.current?.click()}
             onKeyDown={(e) => { if (e.key === 'Enter') fileRef.current?.click(); }}
             onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
             onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) void readFile(f); }}>
          <b>📄 Bấm để chọn file Excel (.xlsx) hoặc CSV, hoặc kéo thả vào đây</b>
          <div className="small muted">Nhận 2 kiểu: <b>danh sách</b> (cột Ngày, Tuyến, Giờ, Biển số, Lái xe) hoặc <b>bảng điều hành</b> (hàng = tuyến, cột = giờ, ô = biển số + lái xe).
            Không có cột Ngày thì nhập vào ngày <b>{fmtDate(day)}</b>.</div>
          <input ref={fileRef} type="file" hidden accept=".xlsx,.csv" aria-label="File lịch điều hành"
                 onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readFile(f); }} />
        </div>

        {P && rows.length > 0 && (
          <>
            <div>
              <b>{src}</b> · <b>{rows.length}</b> chuyến · {days.length === 1 ? `ngày ${fmtDate(days[0])}` : `${days.length} ngày (${fmtDate(days[0])} → ${fmtDate(days[days.length - 1])})`}
              <span className="muted small"> · chữ đỏ là chỗ không khớp danh sách, sẽ không được điền; chữ cam là tên / xe mới sẽ được thêm</span>
              <div className="small">Khớp lịch hiện có <b>{nSame}</b> · Khác lịch hiện có <b className="state-sap_het">{nDiff}</b> · Chuyến mới <b>{nNew}</b> · Xóa (không có tài xế) <b className="state-sap_het">{nDel}</b> · Không áp dụng được <b className="state-het_han">{nBad}</b></div>
            </div>
            <div className="table-wrap import-tbl">
              <table className="plist">
                <thead><tr>
                  <th><input type="checkbox" aria-label="Chọn tất cả" checked={rows.every((r, i) => !r.ok || pick.has(i))}
                             onChange={(e) => setPick(new Set(e.target.checked ? rows.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0) : []))} /></th>
                  <th>Ngày</th><th>Tuyến</th><th>Giờ</th><th>Xe</th><th>Lái xe</th><th>Kết quả</th>
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td><input type="checkbox" aria-label={`Chọn dòng ${r.gio} ${r.tuyen}`} disabled={!r.ok} checked={pick.has(i)}
                                 onChange={(e) => setPick((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })} /></td>
                      <td>{fmtDate(r.ngay)}</td>
                      <td>{r.route?.id && base ? dirName(base.routes.find((x) => x.id === r.route?.id), r.route.dir) : r.tuyen}</td>
                      <td>{r.gio || '?'}</td>
                      <td>{cell(r, 'v')}</td>
                      <td>{cell(r, 'e')}</td>
                      <td><span className={`imp-st ${r.tone}`}>{r.st}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {busy && <p className="small state-sap_het">{busy}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={template}>⬇ Tải file mẫu</button>
          <button type="button" className="btn link" onClick={onClose}>Đóng</button>
          {rows.some((r) => r.ok) && <button type="button" className="btn primary" disabled={!!busy} onClick={() => void apply()}>✔ Áp dụng các dòng đã chọn ({rows.filter((r, i) => pick.has(i) && r.ok && !r.same).length})</button>}
        </div>
      </div>
    </Modal>
  );
}
