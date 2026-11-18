import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { fmtDate, today } from '../components/Documents';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

type Dir = 'di' | 've';
interface Route { id: string; code: string; name: string; is_active: boolean }
interface RouteStop { route_id: string; seq: number; stop_id: string; minutes_from_start: number }
interface Stop { id: string; name: string }
interface Schedule {
  id: string; route_id: string; direction: Dir; depart_time: string; days_of_week: number[]; valid_from: string;
  valid_to: string | null; is_active: boolean; note: string | null;
}
interface Trip {
  id: string; route_id: string; direction: Dir; schedule_id: string | null; service_date: string; depart_at: string; arrive_at: string;
  status: 'mo' | 'huy'; vehicle_id: string | null; cancel_reason: string | null; assign_note: string | null; note: string | null;
}
interface Crew { trip_id: string; role: 'lai_xe_1' | 'lai_xe_2' | 'phu_xe'; staff_id: string; active: boolean }
interface Vehicle { id: string; plate: string; vehicle_type_id: string; is_active: boolean }
interface Staff { id: string; full_name: string; position: 'lai_xe' | 'phu_xe' | 'nhan_vien'; is_active: boolean }
interface License { staff_id: string; vehicle_type_id: string; ok: boolean; reason: string | null }

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

export function TripsScreen({ perms }: { perms: Permissions }) {
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

  const load = useCallback(async () => {
    const [r, rs, st, sc, tr, v, sf, lm] = await Promise.all([
      supabase.from('routes').select('id, code, name, is_active').order('code'),
      supabase.from('route_stops').select('route_id, seq, stop_id, minutes_from_start').order('seq'),
      supabase.from('stops').select('id, name'),
      supabase.from('schedules').select('id, route_id, direction, depart_time, days_of_week, valid_from, valid_to, is_active, note').order('depart_time'),
      supabase.from('trips').select('id, route_id, direction, schedule_id, service_date, depart_at, arrive_at, status, vehicle_id, cancel_reason, assign_note, note')
        .eq('service_date', day).order('depart_at'),
      supabase.from('vehicles').select('id, plate, vehicle_type_id, is_active').order('plate'),
      supabase.from('staff_members').select('id, full_name, position, is_active').order('full_name'),
      supabase.rpc('license_matrix'),
    ]);
    const err = r.error ?? rs.error ?? st.error ?? sc.error ?? tr.error ?? v.error ?? sf.error ?? lm.error;
    if (err) return toast('error', err.message);
    const tripList = (tr.data ?? []) as Trip[];
    const c = tripList.length
      ? await supabase.from('trip_crew').select('trip_id, role, staff_id, active').in('trip_id', tripList.map((t) => t.id))
      : { data: [], error: null };
    if (c.error) return toast('error', c.error.message);
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

  const ctx = { routes, schedules, trips, crew, vehicles, staff, licenses, canEdit, ends, reload: load };
  return (
    <>
      <TripDay {...ctx} day={day} setDay={setDay} />
      <Schedules {...ctx} />
    </>
  );
}

interface Ctx {
  routes: Route[]; schedules: Schedule[]; trips: Trip[]; crew: Crew[]; vehicles: Vehicle[]; staff: Staff[]; licenses: License[];
  canEdit: boolean; ends: (routeId: string, dir: Dir) => string; reload: () => Promise<void>;
}

/* ------------------------------------------------------------------ Nốt */

function Schedules(props: Ctx) {
  const { routes, schedules, canEdit, ends, reload } = props;
  const toast = useToast();
  const [f, setF] = useState({ route_id: '', direction: 'di' as Dir, time: '', days: [1, 2, 3, 4, 5, 6, 7] as number[], from: today(), to: '', note: '' });
  const [showOld, setShowOld] = useState(false);
  const [stopping, setStopping] = useState<{ id: string; from: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const routeName = (id: string) => routes.find((r) => r.id === id)?.name ?? '?';

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!f.route_id || !f.time) return toast('error', 'Chọn tuyến và giờ xuất bến');
    setBusy(true);
    try {
      const r = await rpc<{ created_trips: number }>('save_schedule', {
        p_id: null, p_route_id: f.route_id, p_direction: f.direction, p_depart_time: f.time, p_days: f.days,
        p_valid_from: f.from || null, p_valid_to: f.to || null, p_note: f.note || null,
      });
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
                <div className="muted small">{daysText(s.days_of_week)} · từ {fmtDate(s.valid_from)}{s.valid_to ? ` đến ${fmtDate(s.valid_to)}` : ''}{s.note ? ` · ${s.note}` : ''}</div>
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
  const { routes, trips, crew, vehicles, staff, canEdit, ends, reload, day, setDay } = props;
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
                  {t.assign_note && <div className="muted small">Lý do xếp khi có cảnh báo: {t.assign_note}</div>}
                </div>
                {canEdit && open !== t.id && (
                  <div className="actions">
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
