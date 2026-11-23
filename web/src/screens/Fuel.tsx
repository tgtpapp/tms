// Nhiên liệu (như app cũ): nhập dầu vào bồn, cấp dầu từ bồn cho xe, đổ ngoài cây xăng; tồn bồn, giá bình quân, tiêu hao theo xe.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { MonthPicker } from '../components/MonthPicker';
import { Modal } from '../components/Modal';
import { FilePreviews, FilesViewButton } from '../components/FilePreview';
import { fmtDate, today } from '../components/Documents';
import { prepareFile, uploadFiles } from '../lib/documents';
import { matchPlate, readFuelPhotos } from '../lib/fuelPhoto';
import { FuelSlip, type FuelSlipData } from '../components/FuelSlip';
import { PaperView } from '../components/ProfilePapers';
import { company, head, signCol } from '../lib/profilePapers';
import { DEFAULT_FUEL, FUEL_KIND, fuelLedger, fuelSort, normLevel, type FuelEntry, type FuelKind, type FuelSettings } from '../lib/fuel';
import { loadMarket, MK, mkChanges, mkKey, mkPrice, mkWhen, type Market } from '../lib/fuelMarket';
import type { Permissions } from '../lib/permissions';
import { errMsg, fetchAll, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Veh { id: string; plate: string; is_active: boolean; fuel_norm: number | null }
interface Drv { id: string; full_name: string; position: string; is_active: boolean }
interface Form { id: string | null; kind: FuelKind; entry_date: string; entry_time: string; vehicle_id: string; driver_id: string; odo_km: string; liters: string;
  unit_price: string; supplier: string; invoice_no: string; note: string; files: string[]; add: File[]; market_price: boolean;
  report?: { id: string; who: string } }
/** Phiếu lái xe gửi từ app, chờ điều hành duyệt */
export interface FuelReport { id: string; staff_id: string; vehicle_id: string; entry_date: string; entry_time: string | null; odo_km: number | null; liters: number;
  unit_price: number; amount: number | null; supplier: string | null; invoice_no: string | null; note: string | null; files: string[]; status: 'cho' | 'duyet' | 'bo';
  reject_reason: string | null; created_at: string }
export const REPORT_COLS = 'id, staff_id, vehicle_id, entry_date, entry_time, odo_km, liters, unit_price, amount, supplier, invoice_no, note, files, status, reject_reason, created_at';

const num = (n: number, d = 0) => n.toLocaleString('vi-VN', { maximumFractionDigits: d });
const money = (n: number) => `${num(Math.round(n))} đ`;
const nowTime = () => new Date().toTimeString().slice(0, 5);
const monthEnd = (ym: string) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; };

export function FuelScreen({ ctx, perms, shareFiles, onShareDone }: { ctx: AccountContext; perms: Permissions; shareFiles?: File[] | null; onShareDone?: () => void }) {
  const toast = useToast();
  const canAdd = perms.has('fuel.add'), canEdit = perms.has('fuel.edit'), canDel = perms.has('fuel.delete');
  // Chỉ ô Xem (lái xe): chỉ thấy phiếu xe mình chạy, không xem bồn / giá vốn / sổ
  const self = !perms.has('fuel.view_all') && !canAdd && !canEdit && !canDel;
  const [rows, setRows] = useState<FuelEntry[]>([]);
  const [set, setSet] = useState<FuelSettings>(DEFAULT_FUEL);
  const [vehicles, setVehicles] = useState<Veh[]>([]);
  const [drivers, setDrivers] = useState<Drv[]>([]);
  const [tab, setTab] = useState<'phieu' | 'xe' | 'cai'>('phieu');
  const [month, setMonth] = useState(today().slice(0, 7));
  const [veh, setVeh] = useState('');
  const [kind, setKind] = useState<FuelKind | ''>('');
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [mk, setMk] = useState<Market | null>(null);
  const [mkEdit, setMkEdit] = useState<Record<string, string> | null>(null);
  const [mkAt, setMkAt] = useState('');
  const [slips, setSlips] = useState<FuelSlipData[] | null>(null);
  const [gps, setGps] = useState<Map<string, number>>(new Map());
  const [book, setBook] = useState<string | null>(null);
  const [ai, setAi] = useState('');
  const [reports, setReports] = useState<FuelReport[]>([]);

  const load = useCallback(async () => {
    const [e, s, v, d] = await Promise.all([
      fetchAll<FuelEntry>(() => supabase.from('fuel_entries').select('id, code, kind, entry_date, entry_time, vehicle_id, driver_id, odo_km, liters, unit_price, supplier, invoice_no, note, files, market_price').order('id'))
        .then((data) => ({ data, error: null }), (err: Error) => ({ data: null, error: err })),
      supabase.from('fuel_settings').select('tank_name, fuel_type, capacity_l, opening_l, opening_price, opening_on, alert_l, issue_price_mode').maybeSingle(),
      supabase.from('vehicles').select('id, plate, is_active, fuel_norm').order('plate'),
      supabase.from('staff_members').select('id, full_name, position, is_active').order('full_name'),
    ]);
    if (e.error) { toast('error', e.error.message); return null; }
    const fresh = (e.data ?? []).map((r) => ({ ...r, liters: Number(r.liters), entry_time: r.entry_time?.slice(0, 5) ?? null }));
    setRows(fresh);
    if (s.data) setSet({ ...(s.data as FuelSettings), capacity_l: Number(s.data.capacity_l), opening_l: Number(s.data.opening_l), alert_l: Number(s.data.alert_l) });
    setVehicles(((v.data ?? []) as Veh[]).map((x) => ({ ...x, fuel_norm: x.fuel_norm == null ? null : Number(x.fuel_norm) })));
    setDrivers((d.data ?? []) as Drv[]);
    setMk(await loadMarket().catch(() => null));
    const rp = await supabase.from('fuel_reports').select(REPORT_COLS).eq('status', 'cho').order('created_at');
    setReports(((rp.data ?? []) as FuelReport[]).map((x) => ({ ...x, liters: Number(x.liters) })));
    return fresh;
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  // Km GPS của tháng (Km xe): dùng tính tiêu hao khi không nhập km đồng hồ (như app cũ)
  useEffect(() => {
    if (!month) { setGps(new Map()); return; }
    void supabase.from('vehicle_km').select('vehicle_id, km').gte('run_date', `${month}-01`).lt('run_date', monthEnd(month)).then(({ data }) => {
      const m = new Map<string, number>();
      for (const r of (data ?? []) as { vehicle_id: string; km: number }[]) m.set(r.vehicle_id, (m.get(r.vehicle_id) ?? 0) + Number(r.km));
      setGps(m);
    });
  }, [month]);

  const led = useMemo(() => fuelLedger(rows, set), [rows, set]);
  const plate = (id: string | null) => (id ? vehicles.find((v) => v.id === id)?.plate ?? '?' : '');
  const driver = (id: string | null) => (id ? drivers.find((v) => v.id === id)?.full_name ?? '' : '');
  const inMonth = (r: FuelEntry) => !month || (r.entry_date >= `${month}-01` && r.entry_date < monthEnd(month));
  const shown = led.list.filter((r) => inMonth(r) && (!veh || r.vehicle_id === veh) && (!kind || r.kind === kind)).reverse();
  const out = shown.filter((r) => r.kind !== 'nhap');
  const pct = set.capacity_l > 0 ? Math.max(0, Math.min(100, (led.tank / set.capacity_l) * 100)) : 0;
  const low = led.tank <= set.alert_l;

  function open(r: FuelEntry | null, k: FuelKind = 'bon') {
    if (r) setF({ id: r.id, kind: r.kind, entry_date: r.entry_date, entry_time: r.entry_time ?? '', vehicle_id: r.vehicle_id ?? '', driver_id: r.driver_id ?? '',
      odo_km: r.odo_km?.toString() ?? '', liters: String(r.liters), unit_price: r.unit_price?.toString() ?? '', supplier: r.supplier ?? '', invoice_no: r.invoice_no ?? '',
      note: r.note ?? '', files: r.files, add: [], market_price: !!r.market_price });
    else {
      // Như app cũ: nhập bồn lấy nhà cung cấp + giá lần nhập trước; đổ ngoài lấy cây xăng lần trước + giá niêm yết;
      // cấp từ bồn lấy giá niêm yết (Thiết lập chọn "giá niêm yết") hoặc để trống = giá bình quân bồn.
      const last = led.list.filter((r) => r.kind === k).slice(-1)[0], mp = mkPrice(mk, set.fuel_type);
      const useMk = (k === 'bon' && set.issue_price_mode === 'tt' && mp > 0) || (k === 'ngoai' && mp > 0);
      const price = useMk ? String(mp) : k === 'nhap' && last?.unit_price ? String(last.unit_price) : k === 'ngoai' && last?.unit_price ? String(last.unit_price) : '';
      setF({ id: null, kind: k, entry_date: today(), entry_time: nowTime(), vehicle_id: k === 'nhap' ? '' : veh, driver_id: '', odo_km: '', liters: '',
        unit_price: price, supplier: k !== 'bon' ? last?.supplier ?? '' : '', invoice_no: '', note: '', files: [], add: [], market_price: useMk });
    }
  }
  async function save(printAfter = false) {
    if (!f || !ctx.tenant_id) return;
    setBusy(true);
    try {
      let files = f.files;
      if (f.add.length) {
        const prepared = await Promise.all(f.add.map(prepareFile));
        const owner = f.kind === 'nhap' || !f.vehicle_id ? 'bon-dau' : f.vehicle_id;
        files = [...files, ...(await uploadFiles(ctx.tenant_id, 'xe', owner, f.kind === 'nhap' ? 'BON' : plate(f.vehicle_id), 'nhien_lieu', prepared))];
      }
      const mp = mkPrice(mk, set.fuel_type);
      const p = { ...f, add: undefined, report: undefined, files, market_price: f.kind !== 'nhap' && !!mp && Number(f.unit_price) === mp };
      const id = f.report ? await rpc<string>('approve_fuel_report', { p_id: f.report.id, p })
        : await rpc<string>('save_fuel', { p_id: f.id, p });
      toast('ok', f.report ? `Đã duyệt phiếu đổ dầu của ${f.report.who}` : f.id ? 'Đã lưu phiếu' : `Đã thêm phiếu ${FUEL_KIND[f.kind].short.toLowerCase()}`);
      setF(null);
      const fresh = await load();
      if (printAfter && fresh) await printSlips([id], fresh);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  /** In phiếu 80mm (dùng sổ mới nhất để có tồn bồn, km chạy, tiêu hao đúng) */
  async function printSlips(ids: string[], all: FuelEntry[] = rows) {
    const c = await company();
    const L = fuelLedger(all, set);
    setSlips(ids.map((id) => all.find((r) => r.id === id)).filter((r): r is FuelEntry => !!r).map((r) => {
      const m = L.map.get(r.id);
      return { company: c.name, address: c.address, kind: r.kind, code: r.code, date: r.entry_date, time: r.entry_time, tank: set.tank_name, fuelType: set.fuel_type,
        plate: plate(r.vehicle_id), driver: driver(r.driver_id), supplier: r.supplier ?? '', invoice: r.invoice_no ?? '', odo: r.odo_km, kmRun: m?.km ?? 0, per100: m?.per100 ?? 0,
        norm: vehicles.find((v) => v.id === r.vehicle_id)?.fuel_norm ?? null, liters: r.liters, price: m?.price ?? 0, avgPrice: r.kind === 'bon' && r.unit_price == null,
        market: !!r.market_price, tankAfter: m?.tank ?? 0, note: r.note ?? '', by: '' };
    }));
  }
  /** Tạo phiếu đổ dầu ngoài từ ảnh (trụ bơm, hóa đơn, biển số, đồng hồ km): AI đọc rồi điền sẵn, người dùng kiểm tra rồi lưu (như app cũ). */
  async function fromPhotos(files: File[]) {
    const fs = files.slice(0, 4);
    if (!fs.length) return;
    setAi('AI đang đọc trụ bơm, hóa đơn, biển số… (khoảng 10–30 giây)');
    const base: Form = { id: null, kind: 'ngoai', entry_date: today(), entry_time: '', vehicle_id: '', driver_id: '', odo_km: '', liters: '', unit_price: '', supplier: '',
      invoice_no: '', note: 'Tạo từ ảnh', files: [], add: fs, market_price: false };
    try {
      const prepared = await Promise.all(fs.map(prepareFile));
      const v = await readFuelPhotos(prepared), xe = matchPlate(vehicles, v.plate), day = v.date;
      let drv = '';
      if (xe) {   // lái xe 1 của chuyến xe này trong ngày
        const t = await supabase.from('trips').select('id').eq('vehicle_id', xe.id).eq('service_date', day).eq('status', 'mo').order('depart_at').limit(5);
        const ids = ((t.data ?? []) as { id: string }[]).map((x) => x.id);
        if (ids.length) drv = (((await supabase.from('trip_crew').select('staff_id').in('trip_id', ids).eq('role', 'lai_xe_1').eq('active', true).limit(1)).data ?? []) as { staff_id: string }[])[0]?.staff_id ?? '';
      }
      const warn = [!xe && v.plate ? `AI đọc biển số "${v.plate}" nhưng không thấy trong danh sách xe` : '', ...v.warnings].filter(Boolean);
      setF({ ...base, entry_date: day, entry_time: v.time, vehicle_id: xe?.id ?? '', driver_id: drv, odo_km: v.km, liters: v.liters ? String(v.liters) : '',
        unit_price: v.price ? String(v.price) : '', supplier: v.supplier, invoice_no: v.invoice, market_price: false });
      toast('ok', `AI đã điền sẵn phiếu, kiểm tra lại số lít, tiền, biển số rồi Lưu${warn.length ? ` (${warn.join('; ')})` : ''}`);
    } catch (e) {
      setF(base);
      toast('error', `${errMsg(e)}. Ảnh đã gắn vào phiếu, nhập tay giúp.`);
    } finally { setAi(''); }
  }
  /** Mở phiếu lái xe gửi để điều hành kiểm tra, sửa rồi duyệt (thành phiếu Đổ ngoài) */
  function review(r: FuelReport) {
    setF({ id: null, kind: 'ngoai', entry_date: r.entry_date, entry_time: r.entry_time?.slice(0, 5) ?? '', vehicle_id: r.vehicle_id, driver_id: r.staff_id,
      odo_km: r.odo_km?.toString() ?? '', liters: String(r.liters), unit_price: String(r.unit_price), supplier: r.supplier ?? '', invoice_no: r.invoice_no ?? '',
      note: r.note ?? '', files: r.files, add: [], market_price: false, report: { id: r.id, who: driver(r.staff_id) || 'lái xe' } });
  }
  async function reject() {
    if (!f?.report) return;
    const why = window.prompt(`Bỏ phiếu đổ dầu của ${f.report.who} (không tạo phiếu). Lý do (lái xe sẽ thấy):`, '');
    if (why === null) return;
    setBusy(true);
    try { await rpc('reject_fuel_report', { p_id: f.report.id, p_reason: why }); toast('ok', 'Đã bỏ phiếu'); setF(null); await load(); }
    catch (e) { toast('error', errMsg(e)); }
    finally { setBusy(false); }
  }
  // Ảnh chia sẻ từ Zalo vào app (Chia sẻ → app): tạo phiếu từ ảnh khi đã tải xong danh sách xe
  useEffect(() => {
    if (!shareFiles?.length || !vehicles.length || !canAdd) return;
    onShareDone?.();
    void fromPhotos(shareFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareFiles, vehicles.length, canAdd]);

  async function del(r: FuelEntry) {
    const { error } = await supabase.from('fuel_entries').delete().eq('id', r.id);
    if (error) return toast('error', errMsg(error));
    toast('ok', `Đã xóa phiếu ${r.code}`);
    await load();
  }

  // Theo xe trong tháng: lít, tiền, km chạy (giữa các lần đổ có km), L/100km so với định mức
  const byVeh = vehicles.map((v) => {
    const L = led.list.filter((r) => r.vehicle_id === v.id && r.kind !== 'nhap' && inMonth(r));
    const lit = L.reduce((a, r) => a + r.liters, 0), amount = L.reduce((a, r) => a + (led.map.get(r.id)?.amount ?? 0), 0);
    const withKm = L.filter((r) => (led.map.get(r.id)?.km ?? 0) > 0);
    const km = withKm.reduce((a, r) => a + (led.map.get(r.id)?.km ?? 0), 0), litKm = withKm.reduce((a, r) => a + r.liters, 0);
    const g = gps.get(v.id) ?? 0;   // không có km đồng hồ thì dùng km GPS của tháng (như app cũ)
    return { v, n: L.length, lit, amount, km: km || g, src: km ? 'đồng hồ' : g ? 'GPS' : '', per100: km ? (litKm / km) * 100 : g && lit ? (lit / g) * 100 : 0 };
  }).filter((x) => x.n > 0 || (!self && x.v.is_active && !veh));

  // Sổ nhập xuất nhiên liệu (như app cũ): in A4 ngang có chữ ký, tải Excel (CSV)
  const bookCols = ['Số phiếu', 'Ngày', 'Giờ', 'Loại', 'Xe / Nhà cung cấp', 'Lái xe', 'Cây xăng', 'Km đồng hồ', 'Số lít', 'Đơn giá', 'Thành tiền', 'Km chạy', 'L/100km', 'Tồn bồn sau'];
  const bookRows = () => led.list.filter((r) => inMonth(r) && (!veh || r.vehicle_id === veh) && (!kind || r.kind === kind)).map((r) => {
    const m = led.map.get(r.id);
    return [r.code, r.entry_date.split('-').reverse().join('/'), r.entry_time ?? '', FUEL_KIND[r.kind].short, r.kind === 'nhap' ? r.supplier ?? '' : plate(r.vehicle_id), driver(r.driver_id),
      r.kind === 'ngoai' ? r.supplier ?? '' : '', r.odo_km ?? '', r.liters, Math.round(m?.price ?? 0), m?.amount ?? 0, m?.km || '', m?.per100 ? Math.round(m.per100 * 10) / 10 : '', r.kind === 'ngoai' ? '' : Math.round((m?.tank ?? 0) * 100) / 100];
  });
  const monthTxt = month ? `tháng ${month.slice(5)}/${month.slice(0, 4)}` : 'mọi tháng';
  function bookCsv() {
    const q = (v: unknown) => { const x = String(v ?? ''); return /[",\n;]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    const R = bookRows(), tot = (i: number) => R.reduce((a, r) => a + (Number(r[i]) || 0), 0);
    const body = [`SỔ NHẬP XUẤT NHIÊN LIỆU ${monthTxt.toUpperCase()}`, bookCols.map(q).join(','), ...R.map((r) => r.map(q).join(',')),
      ['Cộng', '', '', '', '', '', '', '', Math.round(tot(8) * 100) / 100, '', tot(10), '', '', ''].map(q).join(',')].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff', body], { type: 'text/csv;charset=utf-8' }));
    a.download = `So nhien lieu ${month || 'tat ca'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function printBook() {
    const c = await company(), R = bookRows(), keep = bookCols.map((_, i) => i).filter((i) => i !== 2 && i !== 6);
    const B = 'border:1px solid #000;padding:3px 4px;font-size:10.5px';
    const fmt = (v: string | number, i: number) => (typeof v === 'number' ? (i === 8 || i === 13 ? num(v, 2) : i === 12 ? num(v, 1) : num(v)) : v);
    const tot = (i: number) => R.reduce((a, r) => a + (Number(r[i]) || 0), 0);
    setBook(`<div style="font-size:12px">${head(c)}<h2 style="text-align:center;margin:8px 0 2px;font-size:16px">SỔ NHẬP XUẤT NHIÊN LIỆU</h2>
      <div style="text-align:center;margin-bottom:6px">${monthTxt.charAt(0).toUpperCase() + monthTxt.slice(1)} · Tồn bồn hiện tại: ${num(led.tank, 2)} lít</div>
      <table style="width:100%;border-collapse:collapse"><tr>${keep.map((i) => `<th style="${B};background:#e2e8f0">${bookCols[i]}</th>`).join('')}</tr>
      ${R.map((r) => `<tr>${keep.map((i) => `<td style="${B};${i >= 7 ? 'text-align:right' : ''}">${fmt(r[i] as string | number, i)}</td>`).join('')}</tr>`).join('')}
      <tr style="font-weight:bold">${keep.map((i, k) => `<td style="${B};text-align:right">${k === 0 ? 'Cộng' : i === 8 ? num(tot(8), 2) : i === 10 ? num(tot(10)) : ''}</td>`).join('')}</tr></table>
      <table style="width:100%;border-collapse:collapse;margin-top:10px"><tr>${['NGƯỜI LẬP', 'THỦ KHO', 'KẾ TOÁN', 'GIÁM ĐỐC'].map((t) => signCol(t, '(Ký, họ tên)', '', '', null, 25)).join('')}</tr></table></div>`);
  }

  return (
    <>
      <section className="card">
        <div className="item-head">
          <h2>Nhiên liệu</h2>
          {canAdd && <div className="actions">
            <button className="btn primary" onClick={() => open(null, 'bon')}>+ Cấp dầu từ bồn</button>
            <button className="btn" onClick={() => open(null, 'ngoai')}>+ Đổ ngoài</button>
            <button className="btn" onClick={() => open(null, 'nhap')}>+ Nhập bồn</button>
            <label className="btn">Tạo phiếu từ ảnh<input type="file" accept="image/*" multiple hidden aria-label="Tạo phiếu đổ dầu từ ảnh" disabled={!!ai}
              onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; void fromPhotos(fs); }} /></label>
          </div>}
        {ai && <p className="small muted">{ai}</p>}
        </div>
        {!self && <><div className="fuel-tank">
          <div className={`fuel-bar${low ? ' low' : ''}`} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Tồn bồn"><i style={{ width: `${pct}%` }} /></div>
          <div><b>{set.tank_name}</b>: tồn <b className={low ? 'danger-text' : ''}>{num(led.tank, 2)} lít</b> / {num(set.capacity_l)} lít ({Math.round(pct)}%)
            · giá bình quân <b>{money(led.avg)}</b>/lít · {set.fuel_type}
            {low && <span className="badge locked">Dưới mức cảnh báo {num(set.alert_l)} lít, cần nhập thêm</span>}</div>
        </div>
        <MarketCard mk={mk} fuelType={set.fuel_type} avg={led.avg} saved={(() => { const mp = mkPrice(mk, set.fuel_type); return mp ? led.list.filter((r) => r.kind === 'bon' && inMonth(r)).reduce((t, r) => t + (mp - (led.map.get(r.id)?.price ?? 0)) * r.liters, 0) : 0; })()}
          bonLit={led.list.filter((r) => r.kind === 'bon' && inMonth(r)).reduce((t, r) => t + r.liters, 0)}
          onEdit={canEdit ? () => { setMkEdit(Object.fromEntries(MK.map((k) => [k, mk?.gia[k] ? String(mk.gia[k]) : '']))); setMkAt(new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 16)); } : undefined} /></>}
        {reports.length > 0 && (
          <div className="fuel-wait" role="region" aria-label="Phiếu đổ dầu lái xe gửi chờ duyệt">
            <b>⛽ {reports.length} phiếu đổ dầu lái xe gửi qua app đang chờ duyệt</b>
            {reports.map((r) => (
              <div key={r.id} className="fuel-wait-row">
                <div className="grow"><b>{plate(r.vehicle_id)}</b> · {num(r.liters, 3)} lít · {money(r.amount ?? r.liters * r.unit_price)}
                  <div className="small muted">{driver(r.staff_id)} gửi {fmtDate(r.entry_date)} {r.entry_time?.slice(0, 5) ?? ''}{r.supplier ? ` · ${r.supplier}` : ''}{r.odo_km ? ` · ${num(r.odo_km)} km` : ''}</div>
                  <FilesViewButton files={r.files} label={`Xem ${r.files.length} ảnh`} /></div>
                {canAdd && <button type="button" className="btn small primary" onClick={() => review(r)}>Xem, duyệt</button>}
              </div>
            ))}
          </div>
        )}
        <div className="seg" role="tablist" aria-label="Xem">
          {([['phieu', 'Phiếu'], ['xe', 'Theo xe'], ['cai', 'Thiết lập']] as const).filter(([k]) => !self || k !== 'cai').map(([k, l]) =>
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab !== 'cai' && <div className="inline-form">
          <MonthPicker value={month} onChange={setMonth} allowEmpty />
          <label>Xe<select value={veh} onChange={(e) => setVeh(e.target.value)}><option value="">Tất cả xe</option>{vehicles.filter((v) => !self || rows.some((r) => r.vehicle_id === v.id)).map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
          {tab === 'phieu' && <label>Loại<select value={kind} onChange={(e) => setKind(e.target.value as FuelKind | '')}><option value="">Tất cả</option>
            {(Object.keys(FUEL_KIND) as FuelKind[]).map((k) => <option key={k} value={k}>{FUEL_KIND[k].short}</option>)}</select></label>}
          {month && <button className="btn small link" onClick={() => setMonth('')}>Xem mọi tháng</button>}
          {tab === 'phieu' && !self && <><button className="btn small" onClick={() => void printBook()}>In sổ</button>
            <button className="btn small" onClick={() => bookCsv()}>Tải Excel (CSV)</button></>}
        </div>}
      </section>

      {tab === 'phieu' && (
        <section className="card">
          {self ? <p className="small muted">{shown.length} phiếu · {num(out.reduce((a, r) => a + r.liters, 0), 2)} lít</p>
            : <p className="small muted">{shown.length} phiếu · cấp cho xe {num(out.reduce((a, r) => a + r.liters, 0), 2)} lít · {money(out.reduce((a, r) => a + (led.map.get(r.id)?.amount ?? 0), 0))}
            {' · '}nhập bồn {num(shown.filter((r) => r.kind === 'nhap').reduce((a, r) => a + r.liters, 0), 2)} lít</p>}
          {shown.length === 0 && <p className="muted">Chưa có phiếu.</p>}
          <div className="table-wrap">
            <table className="plist">
              <thead><tr><th>Số phiếu</th><th>Ngày</th><th>Xe · lái xe</th><th>Km</th><th>Lít</th><th>Đơn giá</th><th>Thành tiền</th><th>Tiêu hao</th><th>Tồn bồn</th><th /></tr></thead>
              <tbody>
                {shown.map((r) => {
                  const m = led.map.get(r.id);
                  const lv = normLevel(m?.per100 ?? 0, vehicles.find((v) => v.id === r.vehicle_id)?.fuel_norm ?? null);
                  return (
                    <tr key={r.id}>
                      <td><b>{r.code}</b><div className="small muted">{FUEL_KIND[r.kind].short}</div></td>
                      <td>{fmtDate(r.entry_date)}<div className="small muted">{r.entry_time}</div></td>
                      <td>{r.kind === 'nhap' ? <span className="small">{r.supplier}</span> : <><b>{plate(r.vehicle_id)}</b><div className="small muted">{driver(r.driver_id)}{r.kind === 'ngoai' && r.supplier ? ` · ${r.supplier}` : ''}</div></>}
                        {r.note && <div className="small muted">{r.note}</div>}
                        <FilesViewButton files={r.files} label={`Xem ${r.files.length} chứng từ`} /></td>
                      <td>{r.odo_km ? num(r.odo_km) : ''}{m?.km ? <div className="small muted">+{num(m.km)} km</div> : null}</td>
                      <td className={r.kind === 'nhap' ? 'ok-text' : ''}><b>{r.kind === 'nhap' ? '+' : ''}{num(r.liters, 2)}</b></td>
                      <td>{self ? (r.unit_price != null ? num(r.unit_price) : '') : <>{m ? num(Math.round(m.price)) : ''}{r.kind === 'bon' && r.unit_price == null && <div className="small muted">bình quân</div>}{r.market_price && <div className="small muted">niêm yết</div>}</>}</td>
                      <td>{self ? (r.unit_price != null ? num(Math.round(r.unit_price * r.liters)) : '') : m ? num(m.amount) : ''}</td>
                      <td>{m?.per100 ? <span className={`badge${lv === 'bad' ? ' locked' : lv === 'warn' ? ' warn-badge' : ''}`}>{num(m.per100, 1)} L/100km</span> : ''}</td>
                      <td className="small">{!self && r.kind !== 'ngoai' && m ? num(m.tank, 2) : ''}</td>
                      <td className="hs-act">{!self && <button className="btn small" aria-label={`In phiếu ${r.code}`} onClick={() => void printSlips([r.id])}>In</button>}
                        {canEdit && <button className="btn small" onClick={() => open(r)}>Sửa</button>}
                        {canDel && <button className="btn small link danger-text" onClick={() => void del(r)}>Xóa</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'xe' && (
        <section className="card">
          <div className="table-wrap">
            <table className="plist">
              <thead><tr><th>Xe</th><th>Số lần</th><th>Lít</th><th>Tiền</th><th>Km chạy</th><th>Tiêu hao</th><th>Định mức</th></tr></thead>
              <tbody>
                {byVeh.map((x) => {
                  const lv = normLevel(x.per100, x.v.fuel_norm);
                  return (
                    <tr key={x.v.id}>
                      <td><b>{x.v.plate}</b></td><td>{x.n}</td><td>{num(x.lit, 2)}</td><td>{num(x.amount)}</td><td>{x.km ? <>{num(x.km)} <span className="small muted">({x.src})</span></> : ''}</td>
                      <td>{x.per100 ? <span className={`badge${lv === 'bad' ? ' locked' : lv === 'warn' ? ' warn-badge' : ''}`}>{num(x.per100, 1)} L/100km</span> : ''}</td>
                      <td>{x.v.fuel_norm ? `${num(x.v.fuel_norm, 1)} L/100km` : <span className="muted small">chưa đặt</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr><th>Cộng</th><th>{byVeh.reduce((a, x) => a + x.n, 0)}</th><th>{num(byVeh.reduce((a, x) => a + x.lit, 0), 2)}</th><th>{num(byVeh.reduce((a, x) => a + x.amount, 0))}</th><th>{num(byVeh.reduce((a, x) => a + x.km, 0))}</th><th /><th /></tr></tfoot>
            </table>
          </div>
        </section>
      )}

      {tab === 'cai' && <FuelSetup key={`${JSON.stringify(set)}${vehicles.length}`} set={set} vehicles={vehicles} canEdit={canEdit} onSaved={load} />}

      {f && (
        <Modal title={f.report ? `Duyệt phiếu đổ dầu · ${f.report.who}` : f.id ? `Sửa phiếu · ${FUEL_KIND[f.kind].label}` : FUEL_KIND[f.kind].label} onClose={() => setF(null)}>
          <div className="form">
            {f.report && <p className="small muted">Lái xe <b>{f.report.who}</b> gửi qua app. Kiểm tra số lít, số tiền, biển số với ảnh, sửa nếu cần rồi bấm Duyệt.</p>}
            <div className="grid2">
              <label>Ngày<input type="date" value={f.entry_date} onChange={(e) => setF({ ...f, entry_date: e.target.value })} /></label>
              <label>Giờ<input type="time" value={f.entry_time} onChange={(e) => setF({ ...f, entry_time: e.target.value })} /></label>
              {f.kind !== 'nhap' && <>
                <label>Xe<select value={f.vehicle_id} onChange={(e) => setF({ ...f, vehicle_id: e.target.value })}>
                  <option value="">Chọn xe</option>{vehicles.filter((v) => v.is_active || v.id === f.vehicle_id).map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
                <label>Lái xe<select value={f.driver_id} onChange={(e) => setF({ ...f, driver_id: e.target.value })}>
                  <option value="">—</option>{drivers.filter((d) => (d.is_active && d.position === 'lai_xe') || d.id === f.driver_id).map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</select></label>
                <label>Km đồng hồ (Odo)<input type="number" min={0} inputMode="numeric" value={f.odo_km} onChange={(e) => setF({ ...f, odo_km: e.target.value })} /></label>
              </>}
              <label>Số lít<input type="number" min={0} step="0.01" inputMode="decimal" value={f.liters} onChange={(e) => setF({ ...f, liters: e.target.value })} /></label>
              <label>Đơn giá (đ/lít){f.kind === 'bon' && <span className="small muted"> · để trống = giá bình quân {num(Math.round(led.avg))}</span>}
                <input type="number" min={0} step={10} inputMode="numeric" value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /></label>
              {f.kind !== 'bon' && <label>{f.kind === 'nhap' ? 'Nhà cung cấp' : 'Cây xăng'}<input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></label>}
              {f.kind !== 'bon' && <label>Số hóa đơn<input value={f.invoice_no} onChange={(e) => setF({ ...f, invoice_no: e.target.value })} /></label>}
              <label>Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            </div>
            <FuelInfo f={f} rows={rows} set={set} mk={mk} plate={plate} norm={vehicles.find((v) => v.id === f.vehicle_id)?.fuel_norm ?? null} />
            <label>Ảnh hóa đơn / trụ bơm / phiếu
              <input type="file" multiple accept="image/*,application/pdf" onChange={(e) => setF({ ...f, add: [...f.add, ...Array.from(e.target.files ?? [])] })} />
            </label>
            <FilePreviews files={f.files} blobs={f.add} />
            {(f.files.length > 0 || f.add.length > 0) && <p className="small muted">{f.files.length} tệp đã lưu{f.add.length ? ` · ${f.add.length} tệp sẽ tải lên` : ''}</p>}
            <div className="actions">
              <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : f.report ? 'Duyệt, tạo phiếu' : 'Lưu phiếu'}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => void save(true)}>{f.report ? 'Duyệt & in phiếu 80mm' : 'Lưu & in phiếu 80mm'}</button>
              {f.report && <button type="button" className="btn danger-text" disabled={busy} onClick={() => void reject()}>Bỏ phiếu này</button>}
              <button type="button" className="btn link" onClick={() => setF(null)}>Thôi</button>
            </div>
          </div>
        </Modal>
      )}
      {slips && <FuelSlip list={slips} onClose={() => setSlips(null)} />}
      {book && <PaperView title={`Sổ nhập xuất nhiên liệu ${monthTxt}`} pages={[{ html: book, land: true }]} onClose={() => setBook(null)} />}
      {mkEdit && (
        <Modal title="Nhập giá bán lẻ Petrolimex (vùng 1)" onClose={() => setMkEdit(null)}>
          <div className="form">
            <div className="grid2">
              {MK.map((k) => <label key={k}>{k}<input inputMode="numeric" aria-label={`Giá ${k}`} value={mkEdit[k] ?? ''} onChange={(e) => setMkEdit({ ...mkEdit, [k]: e.target.value.replace(/\D/g, '') })} /></label>)}
              <label>Hiệu lực từ<input type="datetime-local" value={mkAt} onChange={(e) => setMkAt(e.target.value)} /></label>
            </div>
            <div className="actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void (async () => {
              const gia = Object.fromEntries(Object.entries(mkEdit).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)]));
              if (!Object.keys(gia).length) return toast('error', 'Nhập ít nhất một giá');
              try { await rpc('save_fuel_market_manual', { p_prices: gia, p_effective_at: mkAt ? `${mkAt}:00+07:00` : null }); toast('ok', 'Đã cập nhật giá dầu'); setMkEdit(null); await load(); }
              catch (e) { toast('error', errMsg(e)); }
            })()}>Lưu giá</button></div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Giá bán lẻ Petrolimex vùng 1: từng mặt hàng (▲▼ so với kỳ trước), so giá bình quân bồn với giá niêm yết. */
function MarketCard({ mk, fuelType, avg, saved, bonLit, onEdit }: { mk: Market | null; fuelType: string; avg: number; saved: number; bonLit: number; onEdit?: () => void }) {
  if (!mk) return <div className="nl-mk empty-mk"><span>Chưa có giá thị trường. Giá Petrolimex tự cập nhật sau mỗi kỳ điều hành (chiều thứ Năm).</span>{onEdit && <button type="button" className="btn small" onClick={onEdit}>Nhập giá</button>}</div>;
  const mp = mkPrice(mk, fuelType), gap = mp && avg ? mp - avg : 0;
  return (
    <div className="nl-mk">
      <div className="nl-mk-h"><b>Giá bán lẻ {mk.source.replace(/\s*\(.*\)$/, '')} vùng 1</b>
        <small>Hiệu lực từ {mkWhen(mk.hieuLuc)} · {mk.tay ? 'nhập tay lúc' : 'kiểm tra lúc'} {mkWhen(mk.capNhat)} · đ/lít</small></div>
      <div className="nl-chips">
        {mkChanges(mk, fuelType).map((c) => (
          <div key={c.k} className={`nl-chip${c.my ? ' on' : ''}`} title={c.my ? 'Loại nhiên liệu của bồn công ty' : undefined}>
            <small>{c.k}</small><b>{num(c.p)}</b>{c.df ? <em className={c.df > 0 ? 'up' : 'dn'}>{c.df > 0 ? '▲' : '▼'} {num(Math.abs(c.df))}</em> : <em>—</em>}
          </div>
        ))}
      </div>
      {onEdit && <button type="button" className="btn small" onClick={onEdit}>Nhập giá</button>}
      {mp > 0 && avg > 0 && <div className={`nl-cmp ${gap >= 0 ? 'good' : 'bad'}`}>Giá bình quân bồn <b>{num(Math.round(avg))}</b> {gap >= 0 ? 'thấp hơn' : 'cao hơn'} giá niêm yết <b>{num(Math.abs(Math.round(gap)))} đ/lít</b>
        {bonLit > 0 && Math.round(saved) !== 0 && <><br />{saved >= 0 ? 'Tiết kiệm' : 'Chi thêm'} <b>{money(Math.abs(saved))}</b> cho {num(bonLit, 2)} lít cấp từ bồn tháng này so với đổ ngoài</>}</div>}
    </div>
  );
}

/** Thông tin khi lập phiếu (như app cũ): tồn bồn trước / sau, giá tính cho xe, lần đổ trước, tiêu hao, so với giá Petrolimex, thành tiền. */
function FuelInfo({ f, rows, set, mk, plate, norm }: { f: Form; rows: FuelEntry[]; set: FuelSettings; mk: Market | null; plate: (id: string | null) => string; norm: number | null }) {
  const me: FuelEntry = { id: f.id ?? '__moi', code: f.id ? rows.find((r) => r.id === f.id)?.code ?? '' : 'zz', kind: f.kind, entry_date: f.entry_date || today(), entry_time: f.entry_time || null,
    vehicle_id: f.vehicle_id || null, driver_id: null, odo_km: Number(f.odo_km) || null, liters: Number(f.liters) || 0, unit_price: f.unit_price === '' ? null : Number(f.unit_price), supplier: null, invoice_no: null, note: null, files: [] };
  const others = rows.filter((r) => r.id !== me.id);
  const L = fuelLedger([...others, me], set), x = L.map.get(me.id), before = fuelLedger([...others, { ...me, liters: 0 }], set).map.get(me.id);
  const lines: ReactNode[] = [];
  if (f.kind !== 'ngoai' && x) {
    lines.push(<>{set.tank_name}: tồn trước phiếu <b>{num(before?.tank ?? 0, 2)} lít</b> → sau phiếu <b>{num(x.tank, 2)} lít</b>{set.capacity_l ? ` (${Math.round((x.tank / set.capacity_l) * 100)}% sức chứa)` : ''}</>);
    if (f.kind === 'bon') lines.push(<>Giá tính cho xe: <b>{num(Math.round(x.price))} đ/lít</b> <span className="muted">· giá vốn bình quân bồn {num(Math.round(x.avg))} đ/lít</span></>);
  }
  if (f.kind !== 'nhap' && f.vehicle_id) {
    const last = others.filter((r) => r.kind !== 'nhap' && r.vehicle_id === f.vehicle_id && fuelSort(r, me) < 0).sort(fuelSort).slice(-1)[0];
    if (last) lines.push(<>Lần đổ trước của {plate(f.vehicle_id)}: {last.entry_date.split('-').reverse().join('/')}{last.odo_km ? ` · ${num(last.odo_km)} km` : ''} · {num(last.liters, 2)} lít</>);
    if (me.odo_km && last?.odo_km && me.odo_km <= last.odo_km) lines.push(<span className="badge locked">Km đồng hồ phải lớn hơn lần trước ({num(last.odo_km)} km)</span>);
    if (x?.km) lines.push(<>Đã chạy <b>{num(x.km)} km</b> từ lần đổ trước · tiêu hao <b>{num(x.per100, 1)} L/100km</b>{norm ? ` (định mức ${num(norm, 1)})` : ''}</>);
  }
  const mp = mkPrice(mk, set.fuel_type);
  if (mp && mk) {
    const g = f.kind === 'bon' ? x?.price ?? 0 : Number(f.unit_price) || 0, df = g ? g - mp : 0;
    lines.push(<>Giá Petrolimex vùng 1 ({mkKey(set.fuel_type)}): <b>{num(mp)} đ/lít</b> <span className="muted">· hiệu lực {mkWhen(mk.hieuLuc)}</span>
      {g && Math.abs(df) >= 1 ? <> · {f.kind === 'nhap' ? 'nhà cung cấp' : f.kind === 'bon' ? 'giá bồn' : 'cây xăng'} {df < 0 ? 'thấp hơn' : 'cao hơn'} <b className={df < 0 ? 'ok-text' : 'danger-text'}>{num(Math.abs(df))} đ/lít</b>{f.kind === 'nhap' ? ` (${num((Math.abs(df) / mp) * 100, 1)}%)` : ''}</> : null}</>);
  }
  const tt = Math.round((Number(f.liters) || 0) * (x?.price ?? 0));
  if (tt) lines.push(<b>Thành tiền: {money(tt)}</b>);
  return lines.length ? <div className="nl-info">{lines.map((l, i) => <div key={i}>{l}</div>)}</div> : null;
}

function FuelSetup({ set, vehicles, canEdit, onSaved }: { set: FuelSettings; vehicles: Veh[]; canEdit: boolean; onSaved: () => Promise<unknown> }) {
  const toast = useToast();
  const [s, setS] = useState({ ...set, opening_on: set.opening_on ?? '' });
  const [norm, setNorm] = useState<Record<string, string>>(Object.fromEntries(vehicles.map((v) => [v.id, v.fuel_norm?.toString() ?? ''])));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await supabase.from('fuel_settings').upsert({ tank_name: s.tank_name.trim() || DEFAULT_FUEL.tank_name, fuel_type: s.fuel_type.trim() || DEFAULT_FUEL.fuel_type,
        capacity_l: Number(s.capacity_l) || 0, opening_l: Number(s.opening_l) || 0, opening_price: Math.round(Number(s.opening_price) || 0),
        opening_on: s.opening_on || null, alert_l: Number(s.alert_l) || 0, issue_price_mode: s.issue_price_mode });
      if (r.error) throw r.error;
      for (const v of vehicles) {
        const n = norm[v.id] ? Number(norm[v.id]) : null;
        if (n !== v.fuel_norm) {
          const u = await supabase.from('vehicles').update({ fuel_norm: n }).eq('id', v.id);
          if (u.error) throw u.error;
        }
      }
      toast('ok', 'Đã lưu thiết lập nhiên liệu');
      await onSaved();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card form">
      <h3 className="section-title">Bồn dầu</h3>
      <div className="grid2">
        <label>Tên bồn<input value={s.tank_name} disabled={!canEdit} onChange={(e) => setS({ ...s, tank_name: e.target.value })} /></label>
        <label>Loại nhiên liệu<input value={s.fuel_type} disabled={!canEdit} onChange={(e) => setS({ ...s, fuel_type: e.target.value })} /></label>
        <label>Sức chứa (lít)<input type="number" min={0} value={s.capacity_l} disabled={!canEdit} onChange={(e) => setS({ ...s, capacity_l: Number(e.target.value) })} /></label>
        <label>Cảnh báo khi tồn dưới (lít)<input type="number" min={0} value={s.alert_l} disabled={!canEdit} onChange={(e) => setS({ ...s, alert_l: Number(e.target.value) })} /></label>
        <label>Tồn đầu kỳ (lít)<input type="number" step="0.01" value={s.opening_l} disabled={!canEdit} onChange={(e) => setS({ ...s, opening_l: Number(e.target.value) })} /></label>
        <label>Giá tồn đầu kỳ (đ/lít)<input type="number" min={0} value={s.opening_price} disabled={!canEdit} onChange={(e) => setS({ ...s, opening_price: Number(e.target.value) })} /></label>
        <label>Ngày tồn đầu kỳ<input type="date" value={s.opening_on} disabled={!canEdit} onChange={(e) => setS({ ...s, opening_on: e.target.value })} /></label>
        <label>Giá tính khi cấp dầu từ bồn cho xe<select value={s.issue_price_mode} disabled={!canEdit} onChange={(e) => setS({ ...s, issue_price_mode: e.target.value as 'tt' | 'bq' })}>
          <option value="tt">Giá niêm yết Petrolimex vùng 1 (tự cập nhật)</option><option value="bq">Giá bình quân bồn (giá vốn thực tế đã mua)</option></select>
          <span className="small muted">Chỉ áp dụng cho phiếu tạo mới. Phiếu cũ giữ nguyên giá đã ghi.</span></label>
      </div>
      <h3 className="section-title">Định mức tiêu hao từng xe (lít / 100 km)</h3>
      <div className="grid2">
        {vehicles.filter((v) => v.is_active || v.fuel_norm).map((v) => (
          <label key={v.id}>{v.plate}<input type="number" min={0} step="0.1" inputMode="decimal" value={norm[v.id] ?? ''} disabled={!canEdit}
            onChange={(e) => setNorm({ ...norm, [v.id]: e.target.value })} /></label>
        ))}
      </div>
      {canEdit && <div className="actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu thiết lập'}</button></div>}
    </section>
  );
}
