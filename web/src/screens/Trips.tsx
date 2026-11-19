import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { fmtDate, today } from '../components/Documents';
import { TransportOrderPrint, type OrderPrintData } from '../components/TransportOrder';
import { signatureUrl } from '../lib/documents';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';

type Dir = 'di' | 've';
interface Route { id: string; code: string; name: string; registered_code: string | null; distance_km: number | null; itinerary: string | null; is_active: boolean }
interface RouteStop { route_id: string; seq: number; stop_id: string; minutes_from_start: number }
interface Stop { id: string; name: string }
interface Schedule {
  id: string; route_id: string; direction: Dir; depart_time: string; days_of_week: number[]; valid_from: string;
  valid_to: string | null; is_active: boolean; note: string | null; vehicle_type_id: string | null;
}
interface Trip {
  id: string; route_id: string; direction: Dir; schedule_id: string | null; service_date: string; depart_at: string; arrive_at: string;
  status: 'mo' | 'huy'; vehicle_id: string | null; cancel_reason: string | null; assign_note: string | null; note: string | null;
  vehicle_type_id: string | null;
}
interface Crew { trip_id: string; role: 'lai_xe_1' | 'lai_xe_2' | 'phu_xe'; staff_id: string; active: boolean }
interface Vehicle { id: string; plate: string; vehicle_type_id: string; is_active: boolean }
interface Staff { id: string; full_name: string; position: 'lai_xe' | 'phu_xe' | 'nhan_vien'; is_active: boolean }
interface License { staff_id: string; vehicle_type_id: string; license_class: string | null; ok: boolean; reason: string | null }
interface VType { id: string; name: string; reg_seats: number; reg_berths: number; is_active: boolean }
interface Order { trip_id: string; order_no: string; valid_from: string; valid_to: string; issued_at: string }

const DAYS = [[1, 'T2'], [2, 'T3'], [3, 'T4'], [4, 'T5'], [5, 'T6'], [6, 'T7'], [7, 'CN']] as const;
const TZ = 'Asia/Ho_Chi_Minh';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
function daysText(days: number[]): string {
  if (days.length === 7) return 'Hằng ngày';
  return DAYS.filter(([n]) => days.includes(n)).map(([, t]) => t).join(', ');
}

export function TripsScreen({ ctx: account, perms }: { ctx: AccountContext; perms: Permissions }) {
  const toast = useToast();
  const canEdit = perms.has('trip.manage');
  const [day, setDay] = useState(today());
  const [routes, setRoutes] = useState<Route[]>([]);
  const [rstops, setRstops] = useState<RouteStop[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [crew, setCrew] = useState<Crew[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [vtypes, setVtypes] = useState<VType[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [printing, setPrinting] = useState<OrderPrintData | null>(null);

  const load = useCallback(async () => {
    const [r, rs, st, sc, tr, v, sf, lm, vt] = await Promise.all([
      supabase.from('routes').select('id, code, name, registered_code, distance_km, itinerary, is_active').order('code'),
      supabase.from('route_stops').select('route_id, seq, stop_id, minutes_from_start').order('seq'),
      supabase.from('stops').select('id, name'),
      supabase.from('schedules').select('id, route_id, direction, depart_time, days_of_week, valid_from, valid_to, is_active, note, vehicle_type_id').order('depart_time'),
      supabase.from('trips').select('id, route_id, direction, schedule_id, service_date, depart_at, arrive_at, status, vehicle_id, cancel_reason, assign_note, note, vehicle_type_id')
        .eq('service_date', day).order('depart_at'),
      supabase.from('vehicles').select('id, plate, vehicle_type_id, is_active').order('plate'),
      supabase.from('staff_members').select('id, full_name, position, is_active').order('full_name'),
      supabase.rpc('license_matrix'),
      supabase.from('vehicle_types').select('id, name, reg_seats, reg_berths, is_active').order('name'),
    ]);
    const err = r.error ?? rs.error ?? st.error ?? sc.error ?? tr.error ?? v.error ?? sf.error ?? lm.error ?? vt.error;
    if (err) return toast('error', err.message);
    const tripList = (tr.data ?? []) as Trip[];
    const ids = tripList.map((t) => t.id);
    const [c, o] = ids.length
      ? await Promise.all([
        supabase.from('trip_crew').select('trip_id, role, staff_id, active').in('trip_id', ids),
        supabase.from('transport_orders').select('trip_id, order_no, valid_from, valid_to, issued_at').in('trip_id', ids),
      ])
      : [{ data: [], error: null }, { data: [], error: null }];
    if (c.error || o.error) return toast('error', (c.error ?? o.error)!.message);
    setOrders((o.data ?? []) as Order[]);
    setVtypes((vt.data ?? []) as VType[]);
    setRoutes((r.data ?? []) as Route[]);
    setRstops((rs.data ?? []) as RouteStop[]);
    setStops((st.data ?? []) as Stop[]);
    setSchedules((sc.data ?? []) as Schedule[]);
    setTrips(tripList);
    setCrew((c.data ?? []) as Crew[]);
    setVehicles((v.data ?? []) as Vehicle[]);
    setStaff((sf.data ?? []) as Staff[]);
    setLicenses((lm.data ?? []) as License[]);
  }, [day, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  /** "BX Hố Nai → BX Vũng Tàu" theo chiều */
  const ends = useCallback((routeId: string, dir: Dir) => {
    const list = rstops.filter((x) => x.route_id === routeId).sort((a, b) => a.seq - b.seq);
    if (list.length < 2) return '';
    const name = (id: string) => stops.find((s) => s.id === id)?.name ?? '?';
    const [a, b] = [name(list[0].stop_id), name(list[list.length - 1].stop_id)];
    return dir === 'di' ? `${a} → ${b}` : `${b} → ${a}`;
  }, [rstops, stops]);

  /** Cấp lệnh (giữ số nếu đã cấp) rồi mở bản in đúng mẫu */
  const printOrder = useCallback(async (t: Trip) => {
    try {
      const order = await rpc<Order>('issue_transport_order', { p_trip_id: t.id });
      const tid = account.tenant_id ?? '';
      const [tn, ss, ret] = await Promise.all([
        supabase.from('tenants').select('name, legal_name').maybeSingle(),
        supabase.from('tenant_settings').select('key, value').in('key', ['cong_ty.giam_doc', 'cong_ty.chuc_danh_ky', 'in.chu_ky_giam_doc', 'in.con_dau']),
        supabase.from('trips').select('depart_at, service_date').eq('vehicle_id', t.vehicle_id ?? '').eq('status', 'mo')
          .neq('direction', t.direction).gte('depart_at', t.arrive_at).lte('service_date', order.valid_to).order('depart_at').limit(1),
      ]);
      const raw = (k: string) => ((ss.data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value;
      const setting = (k: string) => raw(k) as string | undefined;
      const route = routes.find((x) => x.id === t.route_id);
      const veh = vehicles.find((x) => x.id === t.vehicle_id);
      const vt = vtypes.find((x) => x.id === veh?.vehicle_type_id);
      const mine = crew.filter((c) => c.trip_id === t.id && c.active);
      const who = (role: Crew['role']) => {
        const id = mine.find((c) => c.role === role)?.staff_id;
        if (!id) return null;
        return { name: staff.find((s) => s.id === id)?.full_name ?? '', hang: licenses.find((l) => l.staff_id === id)?.license_class ?? null };
      };
      const [a, b] = ends(t.route_id, t.direction).split(' → ');
      const r0 = (ret.data ?? [])[0] as { depart_at: string; service_date: string } | undefined;
      const [signerImg, sealImg, dispatcherImg, qr] = await Promise.all([
        raw('in.chu_ky_giam_doc') === false ? Promise.resolve(null) : signatureUrl(tid, 'giam_doc'),
        raw('in.con_dau') === false ? Promise.resolve(null) : signatureUrl(tid, 'con_dau'),
        account.user_id ? signatureUrl(tid, account.user_id) : Promise.resolve(null),
        QRCode.toDataURL(`LVC ${order.order_no} | ${veh?.plate ?? ''} | ${route?.name ?? ''} | ${hhmm(t.depart_at)} ${fmtDate(t.service_date)}`,
                         { margin: 0, width: 240 }),
      ]);
      const tnRow = (tn.data ?? {}) as { name?: string; legal_name?: string | null };
      setPrinting({
        orderNo: order.order_no, issueDate: new Date(order.issued_at).toLocaleDateString('sv-SE', { timeZone: TZ }),
        validFrom: order.valid_from, validTo: order.valid_to, company: tnRow.legal_name || tnRow.name || '',
        signerTitle: setting('cong_ty.chuc_danh_ky') || 'Giám đốc', signerName: setting('cong_ty.giam_doc') ?? '', signerImg, sealImg,
        driver1: who('lai_xe_1'), driver2: who('lai_xe_2'), assistant: who('phu_xe')?.name ?? null,
        plate: veh?.plate ?? '', seats: vt ? vt.reg_seats + vt.reg_berths : null,
        routeName: route?.name ?? '', distanceKm: route?.distance_km ?? null, registeredCode: route?.registered_code ?? null,
        itinerary: route?.itinerary ?? null, fromStop: a ?? '', toStop: b ?? '',
        departTime: hhmm(t.depart_at), departDate: t.service_date,
        ret: r0 ? { time: hhmm(r0.depart_at), date: r0.service_date } : null,
        dispatcherName: account.full_name, dispatcherImg, qr,
      });
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }, [account, routes, vehicles, vtypes, crew, staff, licenses, ends, load, toast]);

  const ctx = { routes, schedules, trips, crew, vehicles, staff, licenses, orders, vtypes, canEdit, ends, printOrder, reload: load };
  return (
    <>
      {printing && <TransportOrderPrint data={printing} onClose={() => setPrinting(null)} />}
      <TripDay {...ctx} day={day} setDay={setDay} />
      <Schedules {...ctx} />
    </>
  );
}

interface Ctx {
  routes: Route[]; schedules: Schedule[]; trips: Trip[]; crew: Crew[]; vehicles: Vehicle[]; staff: Staff[]; licenses: License[];
  orders: Order[]; vtypes: VType[]; canEdit: boolean; ends: (routeId: string, dir: Dir) => string; printOrder: (t: Trip) => Promise<void>;
  reload: () => Promise<void>;
}

/* ------------------------------------------------------------------ Nốt */

function Schedules(props: Ctx) {
  const { routes, schedules, vtypes, canEdit, ends, reload } = props;
  const toast = useToast();
  const [f, setF] = useState({ route_id: '', direction: 'di' as Dir, time: '', days: [1, 2, 3, 4, 5, 6, 7] as number[], from: today(), to: '', note: '', type: '' });
  const typeName = (id: string | null) => vtypes.find((v) => v.id === id)?.name;
  async function setType(id: string, type: string) {
    try {
      await rpc('set_schedule_vehicle_type', { p_schedule_id: id, p_vehicle_type_id: type || null });
      toast('ok', 'Đã đổi loại xe của nốt (áp cho các chuyến chưa có sơ đồ ghế)');
      await reload();
    } catch (err) {
      toast('error', errMsg(err));
    }
  }
  const [showOld, setShowOld] = useState(false);
  const [stopping, setStopping] = useState<{ id: string; from: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const routeName = (id: string) => routes.find((r) => r.id === id)?.name ?? '?';

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!f.route_id || !f.time) return toast('error', 'Chọn tuyến và giờ xuất bến');
    setBusy(true);
    try {
      const r = await rpc<{ id: string; created_trips: number }>('save_schedule', {
        p_id: null, p_route_id: f.route_id, p_direction: f.direction, p_depart_time: f.time, p_days: f.days,
        p_valid_from: f.from || null, p_valid_to: f.to || null, p_note: f.note || null,
      });
      if (f.type) await rpc('set_schedule_vehicle_type', { p_schedule_id: r.id, p_vehicle_type_id: f.type });
      toast('ok', `Đã thêm nốt ${f.time}, tạo ${r.created_trips} chuyến`);
      setF({ ...f, time: '', note: '' });
      await reload();
    } catch (err) {
      toast('error', errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!stopping) return;
    try {
      const n = await rpc<number>('stop_schedule', { p_id: stopping.id, p_from: stopping.from, p_reason: stopping.reason || null });
      toast('ok', `Đã ngừng nốt, hủy ${n} chuyến từ ${fmtDate(stopping.from)}`);
      setStopping(null);
      await reload();
    } catch (err) {
      toast('error', errMsg(err));
    }
  }

  const active = schedules.filter((s) => s.is_active && (!s.valid_to || s.valid_to >= today()));
  const old = schedules.filter((s) => !active.includes(s));

  return (
    <section className="card">
      <h2>Lịch chạy cố định – nốt ({active.length})</h2>
      {canEdit && (
        <form className="form sub" onSubmit={add}>
          <h3>Thêm nốt</h3>
          <div className="grid2">
            <label>Tuyến
              <select aria-label="Tuyến của nốt" value={f.route_id} onChange={(e) => setF({ ...f, route_id: e.target.value })} required>
                <option value="">Chọn tuyến</option>
                {routes.filter((r) => r.is_active).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.code})</option>)}
              </select>
            </label>
            <label>Chiều
              <select aria-label="Chiều của nốt" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value as Dir })}>
                <option value="di">Chiều đi{f.route_id && ends(f.route_id, 'di') ? `: ${ends(f.route_id, 'di')}` : ''}</option>
                <option value="ve">Chiều về{f.route_id && ends(f.route_id, 've') ? `: ${ends(f.route_id, 've')}` : ''}</option>
              </select>
            </label>
            <label>Giờ xuất bến<input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} required /></label>
            <label>Chạy từ ngày<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
            <label>Đến ngày (để trống nếu chạy lâu dài)<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
            <label>Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            <label>Loại xe (sơ đồ ghế để bán vé)
              <select aria-label="Loại xe của nốt" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                <option value="">Chưa chọn</option>
                {vtypes.filter((v) => v.is_active).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
          </div>
          <div className="chips" role="group" aria-label="Ngày chạy trong tuần">
            {DAYS.map(([n, t]) => (
              <button key={n} type="button" aria-pressed={f.days.includes(n)} className={f.days.includes(n) ? 'btn small primary' : 'btn small'}
                      onClick={() => setF({ ...f, days: f.days.includes(n) ? f.days.filter((x) => x !== n) : [...f.days, n] })}>{t}</button>
            ))}
          </div>
          <button className="btn primary" disabled={busy}>Thêm nốt</button>
        </form>
      )}
      {active.length === 0 && <p className="muted">Chưa có nốt.</p>}
      <ul className="list">
        {active.map((s) => (
          <li key={s.id} className="item">
            <div className="item-head">
              <div>
                <b>{s.depart_time.slice(0, 5)}</b> · {routeName(s.route_id)} <span className="muted small">· {ends(s.route_id, s.direction) || (s.direction === 'di' ? 'Chiều đi' : 'Chiều về')}</span>
                <div className="muted small">{daysText(s.days_of_week)} · từ {fmtDate(s.valid_from)}{s.valid_to ? ` đến ${fmtDate(s.valid_to)}` : ''}{s.note ? ` · ${s.note}` : ''}
                  {' · '}{typeName(s.vehicle_type_id) ?? 'chưa chọn loại xe'}</div>
                {canEdit && (
                  <select aria-label={`Loại xe nốt ${s.depart_time.slice(0, 5)}`} className="small-select" value={s.vehicle_type_id ?? ''} onChange={(e) => void setType(s.id, e.target.value)}>
                    <option value="">Loại xe…</option>
                    {vtypes.filter((v) => v.is_active).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                )}
              </div>
              {canEdit && stopping?.id !== s.id && (
                <button className="btn small" onClick={() => setStopping({ id: s.id, from: addDays(today(), 1), reason: '' })}>Ngừng nốt</button>
              )}
            </div>
            {stopping?.id === s.id && (
              <div className="inline-form">
                <label>Ngừng từ ngày<input type="date" min={today()} value={stopping.from} onChange={(e) => setStopping({ ...stopping, from: e.target.value })} /></label>
                <label>Lý do<input value={stopping.reason} onChange={(e) => setStopping({ ...stopping, reason: e.target.value })} /></label>
                <button className="btn small primary" onClick={() => void stop()}>Xác nhận ngừng</button>
                <button className="btn small link" onClick={() => setStopping(null)}>Thôi</button>
                <p className="muted small">Các chuyến của nốt từ ngày này sẽ chuyển sang "Đã hủy" (vẫn giữ lại).</p>
              </div>
            )}
          </li>
        ))}
      </ul>
      {old.length > 0 && <button className="btn small link" onClick={() => setShowOld(!showOld)}>{showOld ? 'Ẩn nốt đã ngừng' : `Hiện nốt đã ngừng (${old.length})`}</button>}
      {showOld && (
        <ul className="list small">
          {old.map((s) => <li key={s.id} className="muted">{s.depart_time.slice(0, 5)} · {routeName(s.route_id)} · {s.direction === 'di' ? 'chiều đi' : 'chiều về'} · ngừng sau {fmtDate(s.valid_to)}</li>)}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ Chuyến theo ngày */

function TripDay(props: Ctx & { day: string; setDay: (d: string) => void }) {
  const { routes, trips, crew, vehicles, staff, orders, vtypes, canEdit, ends, printOrder, reload, day, setDay } = props;
  async function setTripType(id: string, type: string) {
    if (!type) return;
    try {
      await rpc('set_trip_vehicle_type', { p_trip_id: id, p_vehicle_type_id: type });
      toast('ok', 'Đã chọn sơ đồ ghế cho chuyến');
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [extra, setExtra] = useState<{ route_id: string; direction: Dir; time: string; note: string } | null>(null);
  const routeName = (id: string) => routes.find((r) => r.id === id)?.name ?? '?';
  const person = (id: string) => staff.find((s) => s.id === id)?.full_name ?? '?';

  async function generate() {
    try {
      const n = await rpc<number>('generate_trips', {});
      toast('ok', n ? `Đã tạo thêm ${n} chuyến` : 'Không có chuyến mới cần tạo');
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }

  async function addExtra() {
    if (!extra?.route_id || !extra.time) return toast('error', 'Chọn tuyến và giờ');
    try {
      await rpc('add_extra_trip', { p_route_id: extra.route_id, p_direction: extra.direction, p_date: day, p_time: extra.time, p_note: extra.note || null });
      toast('ok', `Đã thêm chuyến tăng cường ${extra.time}`);
      setExtra(null);
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }

  const open_ = trips.filter((t) => t.status === 'mo');
  const ready = open_.filter((t) => t.vehicle_id && crew.some((c) => c.trip_id === t.id && c.role === 'lai_xe_1' && c.active)).length;

  return (
    <section className="card">
      <div className="item-head">
        <h2>Chuyến ngày {fmtDate(day)}</h2>
        {canEdit && <button className="btn small" onClick={() => void generate()}>Tạo chuyến</button>}
      </div>
      <div className="inline-form">
        <button className="btn small" aria-label="Ngày trước" onClick={() => setDay(addDays(day, -1))}>‹</button>
        <label>Ngày chạy<input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
        <button className="btn small" aria-label="Ngày sau" onClick={() => setDay(addDays(day, 1))}>›</button>
        {day !== today() && <button className="btn small link" onClick={() => setDay(today())}>Hôm nay</button>}
      </div>
      <p className="muted small">{open_.length} chuyến · {ready} đủ xe + lái · {open_.length - ready} chưa xếp · {trips.length - open_.length} đã hủy</p>

      {canEdit && !extra && day >= today() && (
        <button className="btn small" onClick={() => setExtra({ route_id: routes.find((r) => r.is_active)?.id ?? '', direction: 'di', time: '', note: '' })}>
          + Chuyến tăng cường
        </button>
      )}
      {extra && (
        <div className="inline-form sub">
          <label>Tuyến
            <select value={extra.route_id} onChange={(e) => setExtra({ ...extra, route_id: e.target.value })}>
              {routes.filter((r) => r.is_active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label>Chiều
            <select value={extra.direction} onChange={(e) => setExtra({ ...extra, direction: e.target.value as Dir })}>
              <option value="di">Chiều đi</option>
              <option value="ve">Chiều về</option>
            </select>
          </label>
          <label>Giờ<input type="time" value={extra.time} onChange={(e) => setExtra({ ...extra, time: e.target.value })} /></label>
          <label>Ghi chú<input value={extra.note} onChange={(e) => setExtra({ ...extra, note: e.target.value })} placeholder="vd: Tết" /></label>
          <button className="btn small primary" onClick={() => void addExtra()}>Thêm chuyến</button>
          <button className="btn small link" onClick={() => setExtra(null)}>Thôi</button>
        </div>
      )}

      {trips.length === 0 && <p className="muted">Không có chuyến trong ngày.</p>}
      <ul className="list">
        {trips.map((t) => {
          const mine = crew.filter((c) => c.trip_id === t.id && (c.active || t.status === 'huy'));
          const veh = vehicles.find((v) => v.id === t.vehicle_id);
          const d1 = mine.find((c) => c.role === 'lai_xe_1');
          const ok = t.status === 'mo' && !!veh && !!d1;
          const label = `${hhmm(t.depart_at)} ${routeName(t.route_id)}`;
          return (
            <li key={t.id} className="item">
              <div className="item-head">
                <div>
                  <b>{hhmm(t.depart_at)}–{hhmm(t.arrive_at)}</b> · {routeName(t.route_id)}
                  <span className="muted small"> · {ends(t.route_id, t.direction) || (t.direction === 'di' ? 'chiều đi' : 'chiều về')}{t.schedule_id ? '' : ' · tăng cường'}</span>
                  {t.status === 'huy' ? <span className="badge locked">Đã hủy: {t.cancel_reason}</span>
                    : ok ? <span className="badge">Đủ xe + lái</span> : <span className="badge warn-badge">Chưa xếp xe / lái</span>}
                  <div className="small">
                    {veh ? `Xe ${veh.plate}` : 'Chưa có xe'}
                    {mine.filter((c) => c.role !== 'phu_xe').length > 0 && ` · Lái: ${mine.filter((c) => c.role !== 'phu_xe').map((c) => person(c.staff_id)).join(', ')}`}
                    {mine.find((c) => c.role === 'phu_xe') && ` · Phụ xe: ${person(mine.find((c) => c.role === 'phu_xe')!.staff_id)}`}
                  </div>
                  {t.status === 'mo' && !t.vehicle_type_id && (
                    <div className="small state-sap_het">Chưa có sơ đồ ghế (chưa bán vé được)
                      {canEdit && (
                        <select aria-label={`Sơ đồ ghế ${label}`} className="small-select" value="" onChange={(e) => void setTripType(t.id, e.target.value)}>
                          <option value="">Chọn loại xe…</option>
                          {vtypes.filter((v) => v.is_active).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      )}
                    </div>
                  )}
                  {t.assign_note && <div className="muted small">Lý do xếp khi có cảnh báo: {t.assign_note}</div>}
                  {orders.find((o) => o.trip_id === t.id) && <div className="muted small">Lệnh số {orders.find((o) => o.trip_id === t.id)!.order_no}</div>}
                </div>
                {canEdit && open !== t.id && (
                  <div className="actions">
                    {(ok || orders.some((o) => o.trip_id === t.id)) && (
                      <button className="btn small" aria-label={`In lệnh ${label}`} onClick={() => void printOrder(t)}>In lệnh</button>
                    )}
                    {t.status === 'mo' && <button className="btn small" aria-label={`Xếp xe ${label}`} onClick={() => setOpen(t.id)}>Xếp xe</button>}
                    {t.status === 'huy' && day >= today() && <Reopen tripId={t.id} reload={reload} />}
                  </div>
                )}
              </div>
              {open === t.id && <Assign {...props} trip={t} onClose={() => setOpen(null)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Reopen({ tripId, reload }: { tripId: string; reload: () => Promise<void> }) {
  const toast = useToast();
  return (
    <button className="btn small" onClick={async () => {
      try {
        await rpc('reopen_trip', { p_trip_id: tripId });
        toast('ok', 'Đã mở lại chuyến, hãy xếp lại xe và lái xe');
        await reload();
      } catch (e) {
        toast('error', errMsg(e));
      }
    }}>Mở lại</button>
  );
}

function Assign(props: Ctx & { trip: Trip; onClose: () => void }) {
  const { trip, crew, vehicles, staff, licenses, reload, onClose } = props;
  const toast = useToast();
  const cur = (role: Crew['role']) => crew.find((c) => c.trip_id === trip.id && c.role === role && c.active)?.staff_id ?? '';
  const [f, setF] = useState({ vehicle: trip.vehicle_id ?? '', d1: cur('lai_xe_1'), d2: cur('lai_xe_2'), px: cur('phu_xe') });
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [reason, setReason] = useState('');
  const [cancel, setCancel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const vType = vehicles.find((v) => v.id === f.vehicle)?.vehicle_type_id;
  const drivers = staff.filter((s) => s.is_active && s.position === 'lai_xe');
  const helpers = staff.filter((s) => s.is_active);
  const hint = useMemo(() => (id: string) => {
    if (!vType) return '';
    const l = licenses.find((x) => x.staff_id === id && x.vehicle_type_id === vType);
    return l && !l.ok ? ` ✗ ${l.reason ?? ''}` : '';
  }, [licenses, vType]);

  async function save(withReason: boolean) {
    setBusy(true);
    try {
      const r = await rpc<{ saved: boolean; warnings: string[] }>('assign_trip', {
        p_trip_id: trip.id, p_vehicle_id: f.vehicle || null, p_driver1: f.d1 || null, p_driver2: f.d2 || null,
        p_assistant: f.px || null, p_reason: withReason ? reason : null,
      });
      if (!r.saved) {
        setWarnings(r.warnings);
        return;
      }
      toast('ok', 'Đã xếp xe cho chuyến');
      onClose();
      await reload();
    } catch (e) {
      const msg = errMsg(e);
      toast('error', /trips_vehicle_no_overlap|trip_crew_no_overlap/.test(msg) ? 'Xe hoặc lái xe vừa được xếp chuyến khác, tải lại để xem' : msg);
    } finally {
      setBusy(false);
    }
  }

  async function doCancel() {
    try {
      await rpc('cancel_trip', { p_trip_id: trip.id, p_reason: cancel ?? '' });
      toast('ok', 'Đã hủy chuyến');
      onClose();
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }

  return (
    <div className="sub form">
      <div className="grid2">
        <label>Xe
          <select value={f.vehicle} onChange={(e) => { setF({ ...f, vehicle: e.target.value }); setWarnings(null); }}>
            <option value="">Chưa xếp</option>
            {vehicles.filter((v) => v.is_active || v.id === f.vehicle).map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}
          </select>
        </label>
        <label>Lái xe 1
          <select value={f.d1} onChange={(e) => { setF({ ...f, d1: e.target.value }); setWarnings(null); }}>
            <option value="">Chưa xếp</option>
            {drivers.map((s) => <option key={s.id} value={s.id}>{s.full_name}{hint(s.id)}</option>)}
          </select>
        </label>
        <label>Lái xe 2
          <select value={f.d2} onChange={(e) => { setF({ ...f, d2: e.target.value }); setWarnings(null); }}>
            <option value="">Không có</option>
            {drivers.filter((s) => s.id !== f.d1).map((s) => <option key={s.id} value={s.id}>{s.full_name}{hint(s.id)}</option>)}
          </select>
        </label>
        <label>Phụ xe
          <select value={f.px} onChange={(e) => { setF({ ...f, px: e.target.value }); setWarnings(null); }}>
            <option value="">Không có</option>
            {helpers.filter((s) => s.id !== f.d1 && s.id !== f.d2).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
          </select>
        </label>
      </div>
      {warnings && (
        <div className="warn small">
          <b>Cần lưu ý trước khi xếp:</b>
          <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          <label>Lý do vẫn xếp<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="vd: dừng nghỉ 20 phút ở Long Thành" /></label>
        </div>
      )}
      <div className="actions">
        {!warnings && <button type="button" className="btn small primary" disabled={busy} onClick={() => void save(false)}>Lưu xếp xe</button>}
        {warnings && <button type="button" className="btn small primary" disabled={busy || !reason.trim()} onClick={() => void save(true)}>Vẫn lưu</button>}
        <button type="button" className="btn small link" onClick={onClose}>Đóng</button>
        {cancel === null && <button type="button" className="btn small" onClick={() => setCancel('')}>Hủy chuyến</button>}
      </div>
      {cancel !== null && (
        <div className="inline-form">
          <label>Lý do hủy chuyến<input value={cancel} onChange={(e) => setCancel(e.target.value)} /></label>
          <button type="button" className="btn small primary" disabled={!cancel.trim()} onClick={() => void doCancel()}>Xác nhận hủy</button>
          <button type="button" className="btn small link" onClick={() => setCancel(null)}>Thôi</button>
        </div>
      )}
    </div>
  );
}
