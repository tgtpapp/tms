// Giai đoạn 6.3 – Gửi hàng: nhận hàng (thu cước), gắn chuyến, đã đến, giao hàng (thu cước người nhận + thu hộ), trả thu hộ, hủy.
import { TripColorPicker } from '../components/TripColorPicker';
import { tripColorVars, useTripColorCfg } from '../lib/tripColor';
import { personSign, type Sign } from '../lib/signatures';
import { RouteCards, RouteViewToggle, useRouteView } from '../components/RouteCards';
import { dirName, type Dir } from '../lib/routes';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { MiniCal } from '../components/MiniCal';
import { ParcelPrint, ParcelSlip, type SlipData } from '../components/ParcelSlip';
import { companyFileUrl } from '../lib/documents';
import { fmtDate, today } from '../components/Documents';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { zaloKick } from '../lib/zalo';

type Status = 'nhan' | 'tren_xe' | 'den' | 'giao' | 'huy';
export interface Shipment {
  id: string; code: string; trip_id: string | null; service_date: string; from_stop_id: string; to_stop_id: string;
  sender_name: string | null; sender_phone: string; receiver_name: string | null; receiver_phone: string; description: string;
  packages: number; weight_kg: number | null; fee: number; fee_payer: 'nguoi_gui' | 'nguoi_nhan'; fee_paid_at: string | null;
  cod_amount: number; cod_collected_at: string | null; cod_paid_out_at: string | null; status: Status; note: string | null;
  delivered_to: string | null;
}
export const SHIP_COLS = 'id, code, trip_id, service_date, from_stop_id, to_stop_id, sender_name, sender_phone, receiver_name, receiver_phone, description, packages, weight_kg, fee, fee_payer, fee_paid_at, cod_amount, cod_collected_at, cod_paid_out_at, status, note, delivered_to';
export const STATUS: Record<Status, [string, string]> = {
  nhan: ['Đã nhận', 'idle'], tren_xe: ['Đã lên xe', 'warn-badge'], den: ['Đã đến', 'warn-badge'], giao: ['Đã giao', ''], huy: ['Đã hủy', 'locked'],
};
const TZ = 'Asia/Ho_Chi_Minh';
const upper = (x: string) => x.toLocaleUpperCase('vi-VN');
const norm = (x: string) => x.trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi-VN');
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
export const money = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
/** Số tiền còn phải thu khi giao */
export const dueOnDelivery = (s: Shipment) => (s.fee_paid_at ? 0 : s.fee) + (s.cod_collected_at ? 0 : s.cod_amount);

interface Trip { id: string; depart_at: string; route_id: string; direction: Dir; vehicle_id?: string | null }
interface Stop { id: string; name: string }
interface Route { id: string; name: string; name_ve: string | null }
interface RouteStop { route_id: string; seq: number; stop_id: string }
type Co = SlipData['company'];
const EMPTY = { trip_id: '', from: '', to: '', sender_name: '', sender_phone: '', receiver_name: '', receiver_phone: '', description: '',
  packages: '1', weight: '', value: '', fee: '', payer: 'nguoi_gui' as 'nguoi_gui' | 'nguoi_nhan', cod: '', method: 'tien_mat', note: '' };
const ROUTE_KEY = 'gui_hang.tuyen';

/** Thông tin chuyến in trên phiếu: biển số, lái xe 1 + SĐT */
async function tripInfo(tripId: string | null): Promise<{ plate: string; driver: string; phone: string }> {
  const none = { plate: '', driver: '', phone: '' };
  if (!tripId) return none;
  const t = (await supabase.from('trips').select('vehicle_id').eq('id', tripId).maybeSingle()).data as { vehicle_id: string | null } | null;
  const [v, c] = await Promise.all([
    t?.vehicle_id ? supabase.from('vehicles').select('plate').eq('id', t.vehicle_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from('trip_crew').select('role, staff_id').eq('trip_id', tripId).eq('active', true),
  ]);
  const crew = ((c.data ?? []) as { role: string; staff_id: string }[]).sort((x, y) => x.role.localeCompare(y.role));
  const lx = crew.find((x) => x.role.startsWith('lai_xe'));
  const st = lx ? (await supabase.from('staff_members').select('full_name, phone').eq('id', lx.staff_id).maybeSingle()).data as { full_name: string; phone: string | null } | null : null;
  return { plate: (v.data as { plate?: string } | null)?.plate ?? '', driver: st?.full_name ?? '', phone: st?.phone ?? '' };
}

export function ParcelsScreen({ ctx }: { ctx: AccountContext }) {
  const toast = useToast();
  const [day, setDay] = useState(today());
  const [list, setList] = useState<Shipment[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [rstops, setRstops] = useState<RouteStop[]>([]);
  const [f, setF] = useState(EMPTY);
  const tcCfg = useTripColorCfg();   // màu thẻ giờ chạy (Giao diện của tôi)
  const [req, setReq] = useState(() => crypto.randomUUID());
  const [finding, setFinding] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rf, setRf] = useState(() => { try { return localStorage.getItem(ROUTE_KEY) ?? ''; } catch { return ''; } });
  useEffect(() => { try { localStorage.setItem(ROUTE_KEY, rf); } catch { /* bỏ qua */ } }, [rf]);
  const [calOpen, setCalOpen] = useState(true);
  const [co, setCo] = useState<Co>({ name: ctx.tenant_name ?? '', address: '', phone: '', tax: '', logo: null });
  const [ti, setTi] = useState({ plate: '', driver: '', phone: '' });
  // chữ ký của người đang lập phiếu (hồ sơ nhân viên, chưa có thì tài khoản) – tải sẵn để bản in có ngay
  const [mySign, setMySign] = useState<Sign | null>(null);
  useEffect(() => { void personSign(ctx.tenant_id, { userId: ctx.user_id }).then(setMySign); }, [ctx.tenant_id, ctx.user_id]);
  const [printing, setPrinting] = useState<SlipData[] | null>(null);
  const [pvOpen, setPvOpen] = useState(true);
  const formRef = useRef<HTMLFormElement>(null);
  const [plates, setPlates] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [s, t, st, r, rs, v] = await Promise.all([
      supabase.from('shipments').select(SHIP_COLS).eq('service_date', day).order('created_at', { ascending: false }),
      supabase.from('trips').select('id, depart_at, route_id, direction, vehicle_id').eq('service_date', day).eq('status', 'mo').order('depart_at'),
      supabase.from('stops').select('id, name').eq('is_active', true).order('name'),
      supabase.from('routes').select('id, name, name_ve, is_active'),
      supabase.from('route_stops').select('route_id, seq, stop_id').order('seq'),
      supabase.from('vehicles').select('id, plate'),
    ]);
    const err = s.error ?? t.error ?? st.error ?? r.error ?? rs.error;
    if (err) return toast('error', err.message);
    setList((s.data ?? []) as Shipment[]);
    setTrips((t.data ?? []) as Trip[]);
    setStops((st.data ?? []) as Stop[]);
    setRoutes((r.data ?? []) as Route[]);
    setRstops((rs.data ?? []) as RouteStop[]);
    setPlates(Object.fromEntries(((v.data ?? []) as { id: string; plate: string }[]).map((x) => [x.id, x.plate])));
  }, [day, toast]);
  useEffect(() => { void load(); }, [load]);
  // Phiếu vừa tìm được: cuộn tới và tô sáng
  useEffect(() => {
    if (!focus || !list.some((x) => x.id === focus)) return;
    const t = setTimeout(() => document.querySelector(`[data-ship="${focus}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
    return () => clearTimeout(t);
  }, [focus, list]);
  useEffect(() => {
    void (async () => {
      const [t, logo] = await Promise.all([
        supabase.from('tenants').select('name, address, phone, tax_code').maybeSingle(),
        ctx.tenant_id ? companyFileUrl(ctx.tenant_id, 'logo.png').catch(() => null) : Promise.resolve(null),
      ]);
      const x = t.data as { name?: string; address?: string | null; phone?: string | null; tax_code?: string | null } | null;
      setCo({ name: x?.name || ctx.tenant_name || '', address: x?.address ?? '', phone: x?.phone ?? '', tax: x?.tax_code ?? '', logo });
    })();
  }, [ctx.tenant_id, ctx.tenant_name]);
  useEffect(() => { let on = true; void tripInfo(f.trip_id || null).then((x) => { if (on) setTi(x); }).catch(() => undefined); return () => { on = false; }; }, [f.trip_id]);

  const stopName = (id: string) => stops.find((s) => s.id === id)?.name ?? '?';
  const routeName = (t: Trip) => dirName(routes.find((r) => r.id === t.route_id), t.direction);
  const tripName = (id: string | null) => {
    const t = trips.find((x) => x.id === id);
    return t ? `${hhmm(t.depart_at)} ${routeName(t)}` : '';
  };
  /** Điểm dừng theo chiều chạy (như Bán vé) */
  const ordered = useCallback((routeId: string, dir: Dir) => {
    const l = rstops.filter((x) => x.route_id === routeId).sort((a, b) => a.seq - b.seq).map((x) => x.stop_id);
    return dir === 'di' ? l : [...l].reverse();
  }, [rstops]);
  // Tuyến: theo từng cặp, chiều đi rồi chiều về (như Bán vé)
  const routeOpts = useMemo(() => {
    // Mọi tuyến đang chạy (cả 2 chiều), kể cả ngày chưa có chuyến; cộng thêm tuyến có chuyến trong ngày
    const keys = [...new Set([...routes.filter((r) => (r as { is_active?: boolean }).is_active !== false).flatMap((r) => [`${r.id}|di`, `${r.id}|ve`]),
      ...trips.map((t) => `${t.route_id}|${t.direction}`)])];
    return keys.map((k) => { const [rid, d] = k.split('|'); const r = routes.find((x) => x.id === rid); return { key: k, label: dirName(r, d as Dir), pair: r?.name ?? '', d }; })
      .sort((x, y) => x.pair.localeCompare(y.pair, 'vi') || (x.d === 'di' ? 0 : 1) - (y.d === 'di' ? 0 : 1));
  }, [trips, routes]);
  // Luôn đang ở 1 tuyến (không có "Tất cả tuyến" để tránh đặt nhầm tuyến)
  const rfOk = routeOpts.some((o) => o.key === rf) ? rf : (routeOpts[0]?.key ?? '');
  const [rview, setRview] = useRouteView();
  const shown = rfOk ? trips.filter((t) => `${t.route_id}|${t.direction}` === rfOk) : trips;
  const cur = trips.find((t) => t.id === f.trip_id) ?? null;
  // Điểm gửi / nhận: theo tuyến của chuyến đang chọn (hoặc tuyến đang lọc), xếp theo thứ tự chạy; chưa chọn tuyến thì tất cả
  const [rk, rd] = cur ? [cur.route_id, cur.direction] : rfOk ? (rfOk.split('|') as [string, Dir]) : ['', 'di' as Dir];
  const stopOpts = useMemo(() => {
    if (!rk) return stops;
    const ids = ordered(rk, rd);
    return ids.length ? ids.map((id) => stops.find((s) => s.id === id)).filter((x): x is Stop => !!x) : stops;
  }, [rk, rd, ordered, stops]);
  /** Chọn chuyến: điểm gửi / nhận mặc định đầu, cuối tuyến (giữ nếu đã chọn đúng tuyến) */
  const pickTrip = (t: Trip | null) => {
    if (!t) return setF((x) => ({ ...x, trip_id: '' }));
    const ids = ordered(t.route_id, t.direction);
    const nm = (id: string | undefined) => (id ? upper(stopName(id)) : '');
    const names = ids.map((id) => norm(stopName(id)));
    setF((x) => ({ ...x, trip_id: t.id, from: names.includes(norm(x.from)) ? x.from : nm(ids[0]) || x.from, to: names.includes(norm(x.to)) ? x.to : nm(ids[ids.length - 1]) || x.to }));
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  const pickRoute = (key: string) => {
    setRf(key);
    const l = trips.filter((t) => !key || `${t.route_id}|${t.direction}` === key);
    const next = l.find((t) => new Date(t.depart_at).getTime() >= Date.now()) ?? l[l.length - 1];
    if (key && next) pickTrip(next); else setF((x) => ({ ...x, trip_id: '' }));
  };
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const s of list) if (s.trip_id && s.status !== 'huy') c[s.trip_id] = (c[s.trip_id] ?? 0) + 1; return c; }, [list]);

  /** Dữ liệu phiếu từ form (xem trước) hoặc phiếu đã lưu */
  const slipOf = (x: { code: string | null; trip_id: string | null; from: string; to: string; sender_name: string; sender_phone: string; receiver_name: string; receiver_phone: string;
    description: string; packages: number; weight: number | null; value: number | null; fee: number; payer: 'nguoi_gui' | 'nguoi_nhan'; cod: number; note: string; at: string },
  info = ti): SlipData => {
    const t = trips.find((y) => y.id === x.trip_id) ?? null;
    return { code: x.code, company: co, departAt: t?.depart_at ?? null, route: t ? routeName(t) : '', plate: info.plate, driver: info.driver, driverPhone: info.phone,
      from: x.from, to: x.to, senderName: x.sender_name, senderPhone: x.sender_phone, receiverName: x.receiver_name, receiverPhone: x.receiver_phone,
      description: x.description, packages: x.packages, weight: x.weight, value: x.value, fee: x.fee, payer: x.payer, cod: x.cod, note: x.note, staff: ctx.full_name ?? '', staffSign: mySign, at: x.at };
  };
  const draft = slipOf({ code: null, trip_id: f.trip_id || null, from: f.from, to: f.to, sender_name: f.sender_name, sender_phone: f.sender_phone, receiver_name: f.receiver_name,
    receiver_phone: f.receiver_phone, description: f.description, packages: Number(f.packages) || 1, weight: f.weight ? Number(f.weight) : null, value: f.value ? Number(f.value) : null,
    fee: Number(f.fee) || 0, payer: f.payer, cod: Number(f.cod) || 0, note: f.note, at: new Date().toISOString() });
  async function printSaved(s: Shipment) {
    const info = await tripInfo(s.trip_id).catch(() => ({ plate: '', driver: '', phone: '' }));
    setPrinting([slipOf({ code: s.code, trip_id: s.trip_id, from: upper(stopName(s.from_stop_id)), to: upper(stopName(s.to_stop_id)), sender_name: s.sender_name ?? '', sender_phone: s.sender_phone,
      receiver_name: s.receiver_name ?? '', receiver_phone: s.receiver_phone, description: s.description, packages: s.packages, weight: s.weight_kg, value: null,
      fee: s.fee, payer: s.fee_payer, cod: s.cod_amount, note: s.note ?? '', at: new Date().toISOString() }, info)]);
  }

  async function create(e: FormEvent | null, print: boolean) {
    e?.preventDefault();
    if (!formRef.current?.reportValidity()) return;
    if (norm(f.from) === norm(f.to)) return toast('error', 'Nơi gửi và nơi nhận phải khác nhau');
    setBusy(true);
    try {
      // Nơi gửi / nhận chưa có thì thêm mới (chữ in hoa)
      const idOf = async (name: string) => stops.find((x) => norm(x.name) === norm(name))?.id ?? await rpc<string>('parcel_stop', { p_name: upper(name) });
      const [fromId, toId] = [await idOf(f.from), await idOf(f.to)];
      const r = await rpc<{ code: string; repeated: boolean }>('create_shipment', {
        p: {
          trip_id: f.trip_id || null, service_date: day, from_stop_id: fromId, to_stop_id: toId, sender_name: f.sender_name, sender_phone: f.sender_phone,
          receiver_name: f.receiver_name, receiver_phone: f.receiver_phone, description: f.description, packages: Number(f.packages) || 1,
          weight_kg: f.weight || null, declared_value: f.value || null, fee: Number(f.fee) || 0, fee_payer: f.payer, cod_amount: Number(f.cod) || 0, note: f.note,
        },
        p_method: f.payer === 'nguoi_gui' ? f.method : null, p_request_id: req,
      });
      toast('ok', `Đã nhận hàng, phiếu ${r.code}${f.payer === 'nguoi_gui' && Number(f.fee) ? ` · thu cước ${money(Number(f.fee))}` : ''}`);
      if (print) setPrinting([{ ...draft, code: r.code }]);
      setF({ ...EMPTY, trip_id: f.trip_id, from: f.from, to: f.to });
      setReq(crypto.randomUUID());
      await load();
    } catch (err) {
      toast('error', errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  const nowMs = Date.now();
  const card = (t: Trip) => (
    <button key={t.id} type="button" style={tripColorVars(tcCfg, t.route_id, t.direction, hhmm(t.depart_at))} className={['vx-trip tc', t.id === f.trip_id && 'on', new Date(t.depart_at).getTime() < nowMs && 'past'].filter(Boolean).join(' ')}
            aria-label={`Chuyến ${hhmm(t.depart_at)} ${routeName(t)}`} onClick={() => pickTrip(t.id === f.trip_id ? null : t)}>
      <span className="tc-l"><b className="vx-time">{hhmm(t.depart_at)}</b></span>
      <span className="tc-r">
        {!rfOk && <span className="vx-rname">{routeName(t)}</span>}
        <span className="vx-meta"><span><i className={t.vehicle_id ? 'dot ok' : 'dot'} />{t.vehicle_id ? (plates[t.vehicle_id] ?? '').split('-').pop() : '—'}</span><span>{counts[t.id] ? `${counts[t.id]} phiếu` : ''}</span></span>
      </span>
    </button>
  );
  const up = shown.filter((t) => new Date(t.depart_at).getTime() >= nowMs), past = shown.filter((t) => new Date(t.depart_at).getTime() < nowMs);

  return (
    <>
      {printing && <ParcelPrint slips={printing} onClose={() => setPrinting(null)} />}
      <label className="dv-sbar"><i className="fi fi-rr-search" aria-hidden="true" />
        <input type="search" autoComplete="off" value={finding} onChange={(e) => setFinding(e.target.value)} aria-label="Tìm hàng"
               placeholder="Tìm hàng theo số điện thoại người gửi / nhận, tên, mã phiếu…" />
        {finding && <button type="button" className="dv-sx" aria-label="Xóa tìm kiếm" onClick={() => setFinding('')}>✕</button>}
      </label>
      {rview === 'the' && !finding.trim() && <RouteCards opts={routeOpts} trips={trips} counts={counts} unit="phiếu" value={rfOk} onPick={pickRoute} />}
      {finding.trim() && (
        <ParcelSearch q={finding} stopName={stopName}
                      onPick={(x) => { setFinding(''); setDay(x.service_date); setFocus(x.id); }} />
      )}
      <div className="vx" hidden={!!finding.trim()}>
        <aside className="vx-left">
          <RouteViewToggle view={rview} onChange={setRview} />
          <TripColorPicker />
          {rview === 'o' && <select className="vx-route" aria-label="Tuyến" value={rfOk} onChange={(e) => pickRoute(e.target.value)}>
              {routeOpts.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>}
          <div className="vx-cal">
            {calOpen ? <MiniCal day={day} onPick={(d) => { setDay(d); setF((x) => ({ ...x, trip_id: '' })); }} /> : <p className="vx-calday">{fmtDate(day)}</p>}
            <button type="button" className="vx-fold" aria-label={calOpen ? 'Thu gọn lịch' : 'Mở lịch'} onClick={() => setCalOpen(!calOpen)}>{calOpen ? '︿' : '﹀'}</button>
          </div>
          {shown.length === 0 && <p className="muted small">{rfOk ? 'Tuyến này chưa có chuyến trong ngày.' : 'Không có chuyến đang mở trong ngày.'}</p>}
          <div className="vx-trips">{up.map(card)}</div>
          {past.length > 0 && <><h4 className="past-head">Đã qua giờ khởi hành</h4><div className="vx-trips">{past.map(card)}</div></>}
        </aside>
        <div className="vx-right">
          <form ref={formRef} className="card form" onSubmit={(e) => void create(e, false)}>
            <h2>Nhận hàng gửi</h2>
            <div className="gh-cur">
              <span>{cur ? <>Chuyến <b>{hhmm(cur.depart_at)}</b> {routeName(cur)} · {fmtDate(day)}{ti.plate ? ` · Xe ${ti.plate}` : ''}{ti.driver ? ` · LX ${ti.driver}` : ''}</>
                : <span className="muted">Chưa chọn chuyến (bấm giờ chạy bên trái, hoặc gắn chuyến sau)</span>}</span>
              {cur && <button type="button" className="btn small link" onClick={() => pickTrip(null)}>Bỏ chọn chuyến</button>}
            </div>
            <div className="gh-wrap">
              <div className="grid2">
                <label>Gửi tại
                  <input list="gh-diem" className="upper" value={f.from} onChange={(e) => setF({ ...f, from: upper(e.target.value) })} placeholder="CHỌN HOẶC GÕ NƠI GỬI" required />
                </label>
                <label>Nhận tại
                  <input list="gh-diem" className="upper" value={f.to} onChange={(e) => setF({ ...f, to: upper(e.target.value) })} placeholder="CHỌN HOẶC GÕ NƠI NHẬN" required />
                </label>
                <datalist id="gh-diem">{[...new Set([...stopOpts, ...stops].map((s) => upper(s.name)))].map((n) => <option key={n} value={n} />)}</datalist>
                <label>SĐT người gửi<input inputMode="tel" value={f.sender_phone} onChange={(e) => setF({ ...f, sender_phone: e.target.value })} required /></label>
                <label>Tên người gửi<input value={f.sender_name} onChange={(e) => setF({ ...f, sender_name: e.target.value })} /></label>
                <label>SĐT người nhận<input inputMode="tel" value={f.receiver_phone} onChange={(e) => setF({ ...f, receiver_phone: e.target.value })} required /></label>
                <label>Tên người nhận<input value={f.receiver_name} onChange={(e) => setF({ ...f, receiver_name: e.target.value })} /></label>
                <label>Hàng gì<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="vd 1 thùng trái cây" required /></label>
                <label>Số kiện<input type="number" min={1} inputMode="numeric" value={f.packages} onChange={(e) => setF({ ...f, packages: e.target.value })} /></label>
                <label>Cân nặng (kg)<input type="number" min={0} step="0.1" inputMode="decimal" value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} /></label>
                <label>Giá trị khai báo (đồng)<input type="number" min={0} inputMode="numeric" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></label>
                <label>Cước (đồng)<input type="number" min={0} step={1000} inputMode="numeric" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} required /></label>
                <label>Người trả cước
                  <select value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value as 'nguoi_gui' | 'nguoi_nhan' })}>
                    <option value="nguoi_gui">Người gửi (thu ngay)</option>
                    <option value="nguoi_nhan">Người nhận (thu khi giao)</option>
                  </select>
                </label>
                {f.payer === 'nguoi_gui' && (
                  <label>Thu cước bằng
                    <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
                      <option value="tien_mat">Tiền mặt</option>
                      <option value="chuyen_khoan">Chuyển khoản</option>
                    </select>
                  </label>
                )}
                <label>Thu hộ (COD, đồng)<input type="number" min={0} step={1000} inputMode="numeric" value={f.cod} onChange={(e) => setF({ ...f, cod: e.target.value })} placeholder="0 nếu không thu hộ" /></label>
                <label>Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
              </div>
              <aside className="gh-pv no-print" aria-label="Xem trước phiếu K80">
                <div className="gh-pvh">Xem trước phiếu K80<button type="button" className="btn small link" onClick={() => setPvOpen(!pvOpen)}>{pvOpen ? 'Thu gọn' : 'Mở'}</button></div>
                {pvOpen && <div className="gh-pvb"><ParcelSlip d={draft} /></div>}
              </aside>
            </div>
            <div className="actions">
              <button className="btn primary" disabled={busy}>Nhận hàng</button>
              <button type="button" className="btn" disabled={busy} onClick={() => void create(null, true)}>Nhận hàng + in K80</button>
            </div>
          </form>

          <section className="card">
            <h2>Phiếu gửi hàng ngày {fmtDate(day)} ({list.length})</h2>
            {list.length === 0 && <p className="muted">Chưa có phiếu.</p>}
            <ul className="list">
              {list.map((s) => <ParcelRow key={s.id} hl={focus === s.id} s={s} stopName={stopName} tripName={tripName} trips={trips} reload={load} manage onPrint={() => void printSaved(s)} />)}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}

/** Tìm phiếu gửi hàng theo số điện thoại người gửi / nhận, tên hoặc mã phiếu (như Tìm vé) */
function ParcelSearch({ q, stopName, onPick }: { q: string; stopName: (id: string) => string; onPick: (x: Shipment) => void }) {
  const toast = useToast();
  const [sortBy, setSortBy] = useState<'dat' | 'chay'>('dat');
  const [lim, setLim] = useState(100);
  const [hits, setHits] = useState<(Shipment & { created_at: string })[] | null>(null);
  const raw = q.trim();
  const dg = raw.replace(/\D/g, '').replace(/^84/, '0');
  const isNum = /^[\d\s+.\-()]+$/.test(raw);
  const short = isNum ? dg.length < 3 : raw.length < 2;

  useEffect(() => { setLim(100); }, [raw]);
  useEffect(() => {
    if (short) { setHits(null); return; }
    let on = true;
    const t = setTimeout(() => void (async () => {
      let qb = supabase.from('shipments').select(`${SHIP_COLS}, created_at`);
      if (raw && isNum) qb = qb.or(`sender_phone.ilike.%${dg}%,receiver_phone.ilike.%${dg}%`);
      else if (raw) {
        const nm = raw.replace(/[%,()]/g, ' ');
        qb = qb.or(`sender_name.ilike.%${nm}%,receiver_name.ilike.%${nm}%,code.eq.${raw.toUpperCase().replace(/[\s,()]/g, '')}`);
      }
      qb = sortBy === 'dat' ? qb.order('created_at', { ascending: false }) : qb.order('service_date', { ascending: false }).order('created_at', { ascending: false });
      const { data, error } = await qb.limit(lim + 1);
      if (!on) return;
      if (error) { toast('error', error.message); return; }
      setHits((data ?? []) as unknown as (Shipment & { created_at: string })[]);
    })(), 250);
    return () => { on = false; clearTimeout(t); };
  }, [raw, dg, isNum, short, sortBy, lim, toast]);

  const shown = (hits ?? []).slice(0, lim);
  const when = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false });
  return (
    <section className="card qs-inline">
      <div className="qsort">
        <button type="button" className={sortBy === 'dat' ? 'on' : ''} onClick={() => setSortBy('dat')}>Theo giờ nhận</button>
        <button type="button" className={sortBy === 'chay' ? 'on' : ''} onClick={() => setSortBy('chay')}>Theo ngày gửi</button>
      </div>
      <p className="muted small qs-sum">
        {short ? 'Nhập ít nhất 3 số điện thoại hoặc 2 chữ của tên.'
          : hits === null ? 'Đang tìm…'
          : shown.length ? <>Tìm thấy <b>{shown.length}{hits.length > lim ? '+' : ''}</b> phiếu · tổng cước {money(shown.filter((x) => x.status !== 'huy').reduce((a, x) => a + x.fee, 0))} (không tính phiếu hủy)</>
          : 'Không có'}
      </p>
      <div className="qs-list">
        {shown.map((x) => (
          <button type="button" key={x.id} className={`qh${x.status === 'huy' ? ' x' : ''}`} onClick={() => onPick(x)}>
            <div className="qh-t"><b>{fmtDate(x.service_date)} · Mã {x.code}</b><span>{stopName(x.from_stop_id)} → {stopName(x.to_stop_id)}</span></div>
            <div className="qh-m">Gửi: <b>{x.sender_name || '—'}</b> · {x.sender_phone} → Nhận: <b>{x.receiver_name || '—'}</b> · {x.receiver_phone}</div>
            <div className="qh-m muted">Nhận lúc: {when(x.created_at)} · {x.description}</div>
            <div className="qh-m">Cước {money(x.fee)}{x.cod_amount ? ` · Thu hộ ${money(x.cod_amount)}` : ''} <em className={`qh-b${x.status === 'huy' ? ' r' : x.status === 'giao' ? ' g' : ''}`}>{STATUS[x.status][0]}</em></div>
          </button>
        ))}
        {hits && hits.length > lim && <button type="button" className="btn small" onClick={() => setLim(lim + 100)}>Xem thêm</button>}
      </div>
    </section>
  );
}

/** Một phiếu: dùng ở màn Gửi hàng và màn lái xe (manage = false: chỉ báo đến, giao hàng) */
export function ParcelRow({ s, stopName, tripName, trips, reload, manage, onPrint, hl }: {
  s: Shipment; stopName: (id: string) => string; tripName: (id: string | null) => string; trips: Trip[] | null;
  reload: () => Promise<void>; manage: boolean; onPrint?: () => void;
  hl?: boolean;
}) {
  const toast = useToast();
  const [act, setAct] = useState<'' | 'xe' | 'giao' | 'huy'>('');
  const [v, setV] = useState({ trip: s.trip_id ?? '', receiver: s.receiver_name ?? '', method: 'tien_mat', reason: '' });
  const due = dueOnDelivery(s);
  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast('ok', ok);
      setAct('');
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }
  const [lb, cls] = STATUS[s.status];
  return (
    <li className={hl ? 'item qs-hl' : 'item'} data-ship={s.id}>
      <div className="item-head">
        <div>
          <b>{s.code}</b> <span className={`badge ${cls}`}>{lb}</span>
          {onPrint && <button type="button" className="btn small link" aria-label={`In phiếu ${s.code}`} onClick={onPrint}>🖨 In K80</button>}
          <div className="small">{s.description} · {s.packages} kiện{s.weight_kg ? ` · ${s.weight_kg} kg` : ''} · {stopName(s.from_stop_id)} → {stopName(s.to_stop_id)}</div>
          <div className="small">Nhận: {s.receiver_name ?? ''} <a href={`tel:${s.receiver_phone}`}>{s.receiver_phone}</a> · Gửi: {s.sender_name ?? ''} <a href={`tel:${s.sender_phone}`}>{s.sender_phone}</a></div>
          <div className="small muted">
            Cước {money(s.fee)} ({s.fee_paid_at ? 'đã thu' : 'người nhận trả'}){s.cod_amount ? ` · Thu hộ ${money(s.cod_amount)}${s.cod_paid_out_at ? ' (đã trả người gửi)' : s.cod_collected_at ? ' (đã thu, chưa trả người gửi)' : ''}` : ''}
            {s.trip_id ? ` · Chuyến ${tripName(s.trip_id)}` : ''}{s.delivered_to ? ` · Giao cho ${s.delivered_to}` : ''}
          </div>
        </div>
        {s.status !== 'giao' && s.status !== 'huy' && (
          <div className="actions">
            {manage && s.status === 'nhan' && <button className="btn small" onClick={() => setAct('xe')}>Lên xe</button>}
            {(s.status === 'nhan' || s.status === 'tren_xe') && (
              <button className="btn small" onClick={() => void run(() => rpc('set_shipment_status', { p_id: s.id, p_status: 'den', p_trip_id: null, p_reason: null }).then(zaloKick), `Phiếu ${s.code} đã đến`)}>Đã đến</button>
            )}
            <button className="btn small primary" onClick={() => setAct('giao')}>Giao hàng{due ? ` · thu ${money(due)}` : ''}</button>
            {manage && <button className="btn small link" onClick={() => setAct('huy')}>Hủy</button>}
          </div>
        )}
        {manage && s.status === 'giao' && s.cod_amount > 0 && !s.cod_paid_out_at && (
          <button className="btn small primary" onClick={() => void run(() => rpc('pay_out_cod', { p_id: s.id, p_method: 'tien_mat' }), `Đã trả thu hộ ${money(s.cod_amount)} cho người gửi`)}>
            Trả thu hộ {money(s.cod_amount)}
          </button>
        )}
      </div>
      {act === 'xe' && trips && (
        <div className="inline-form">
          <label>Chuyến<select value={v.trip} onChange={(e) => setV({ ...v, trip: e.target.value })}>
            <option value="">Chọn chuyến</option>
            {trips.map((t) => <option key={t.id} value={t.id}>{tripName(t.id)}</option>)}
          </select></label>
          <button className="btn small primary" disabled={!v.trip} onClick={() => void run(() => rpc('set_shipment_status', { p_id: s.id, p_status: 'tren_xe', p_trip_id: v.trip, p_reason: null }), `Phiếu ${s.code} đã lên xe`)}>Xác nhận</button>
          <button className="btn small link" onClick={() => setAct('')}>Thôi</button>
        </div>
      )}
      {act === 'giao' && (
        <div className="inline-form">
          <label>Người nhận hàng<input value={v.receiver} onChange={(e) => setV({ ...v, receiver: e.target.value })} /></label>
          {due > 0 && (
            <label>Thu {money(due)} bằng<select value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })}>
              <option value="tien_mat">Tiền mặt</option>
              <option value="chuyen_khoan">Chuyển khoản</option>
            </select></label>
          )}
          <button className="btn small primary" onClick={() => void run(() => rpc('deliver_shipment', { p_id: s.id, p_receiver: v.receiver, p_method: v.method }),
            `Đã giao phiếu ${s.code}${due ? ` · thu ${money(due)}` : ''}`)}>Xác nhận giao</button>
          <button className="btn small link" onClick={() => setAct('')}>Thôi</button>
        </div>
      )}
      {act === 'huy' && (
        <div className="inline-form">
          <label>Lý do hủy<input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></label>
          <button className="btn small danger" disabled={!v.reason.trim()} onClick={() => void run(() => rpc('set_shipment_status', { p_id: s.id, p_status: 'huy', p_trip_id: null, p_reason: v.reason }),
            `Đã hủy phiếu ${s.code}${s.fee_paid_at ? `, hoàn cước ${money(s.fee)}` : ''}`)}>Xác nhận hủy</button>
          <button className="btn small link" onClick={() => setAct('')}>Thôi</button>
        </div>
      )}
    </li>
  );
}
