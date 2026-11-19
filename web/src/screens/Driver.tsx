// Giai đoạn 6.1 – App lái xe: chuyến của tôi, danh sách khách theo điểm đón, lên xe, thu tiền trên xe, xuất bến / đến bến.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtDate, today } from '../components/Documents';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { MyTransfers } from './Transfers';
import { ParcelRow, SHIP_COLS, type Shipment } from './Parcels';
import { MyCharters } from './Charters';

interface MyTrip {
  trip_id: string; service_date: string; depart_at: string; arrive_at: string; route_id: string; direction: 'di' | 've'; status: 'mo' | 'huy';
  plate: string | null; my_role: 'lai_xe_1' | 'lai_xe_2' | 'phu_xe'; departed_at: string | null; arrived_at: string | null; order_no: string | null;
}
interface Ticket {
  id: string; booking_id: string; seat_label: string; from_stop_id: string; to_stop_id: string; from_idx: number; price: number;
  status: 'dat' | 'da_tt'; passenger_name: string | null; passenger_phone: string | null; pickup_note: string | null; dropoff_note: string | null; boarded: boolean;
}
interface RouteStop { route_id: string; seq: number; stop_id: string }

const TZ = 'Asia/Ho_Chi_Minh';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const money = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
const ROLE = { lai_xe_1: 'Lái xe 1', lai_xe_2: 'Lái xe 2', phu_xe: 'Phụ xe' } as const;
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

export function DriverScreen() {
  const toast = useToast();
  const [day, setDay] = useState(today());
  const [trips, setTrips] = useState<MyTrip[]>([]);
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [rstops, setRstops] = useState<RouteStop[]>([]);
  const [stops, setStops] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, r, rs, st] = await Promise.all([
        rpc<MyTrip[]>('my_trips', { p_from: day, p_to: day }),
        supabase.from('routes').select('id, name'),
        supabase.from('route_stops').select('route_id, seq, stop_id').order('seq'),
        supabase.from('stops').select('id, name'),
      ]);
      setTrips(t);
      setRoutes(Object.fromEntries(((r.data ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name])));
      setRstops((rs.data ?? []) as RouteStop[]);
      setStops(Object.fromEntries(((st.data ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name])));
      if (t.length === 1) setOpen((o) => o ?? t[0].trip_id);
    } catch (e) {
      toast('error', errMsg(e));
    }
  }, [day, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const ends = (routeId: string, dir: 'di' | 've') => {
    const l = rstops.filter((x) => x.route_id === routeId).sort((a, b) => a.seq - b.seq);
    if (l.length < 2) return routes[routeId] ?? '';
    const [a, b] = [stops[l[0].stop_id], stops[l[l.length - 1].stop_id]];
    return dir === 'di' ? `${a} → ${b}` : `${b} → ${a}`;
  };

  return (
    <>
      <section className="card">
        <h2>Chuyến của tôi · {fmtDate(day)}</h2>
        <div className="inline-form">
          <button className="btn small" aria-label="Ngày trước" onClick={() => { setDay(addDays(day, -1)); setOpen(null); }}>‹</button>
          <label>Ngày<input type="date" value={day} onChange={(e) => { if (e.target.value) { setDay(e.target.value); setOpen(null); } }} /></label>
          <button className="btn small" aria-label="Ngày sau" onClick={() => { setDay(addDays(day, 1)); setOpen(null); }}>›</button>
        </div>
        {trips.length === 0 && <p className="muted">Không có chuyến xe nào được xếp cho bạn trong ngày.</p>}
        <div className="drv-trips">
          {trips.map((t) => (
            <button key={t.trip_id} className={open === t.trip_id ? 'trip-chip on' : 'trip-chip'} onClick={() => setOpen(open === t.trip_id ? null : t.trip_id)}
                    aria-label={`Chuyến ${hhmm(t.depart_at)} ${ends(t.route_id, t.direction)}`}>
              <b>{hhmm(t.depart_at)}</b> {ends(t.route_id, t.direction)}
              <span className="small">{t.plate ?? 'chưa có xe'} · {ROLE[t.my_role]}{t.order_no ? ` · Lệnh ${t.order_no}` : ''}</span>
              <span className={`badge ${t.status === 'huy' ? 'locked' : t.arrived_at ? '' : t.departed_at ? 'warn-badge' : 'idle'}`}>
                {t.status === 'huy' ? 'Đã hủy' : t.arrived_at ? `Đã đến bến ${hhmm(t.arrived_at)}` : t.departed_at ? `Đã xuất bến ${hhmm(t.departed_at)}` : 'Chưa xuất bến'}
              </span>
            </button>
          ))}
        </div>
      </section>
      <MyTransfers day={day} />
      <MyCharters />
      {open && trips.find((t) => t.trip_id === open) && (
        <TripRun trip={trips.find((t) => t.trip_id === open)!} stopName={(id) => stops[id] ?? '?'} reload={load} />
      )}
    </>
  );
}

function TripRun({ trip, stopName, reload }: { trip: MyTrip; stopName: (id: string) => string; reload: () => Promise<void> }) {
  const toast = useToast();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [parcels, setParcels] = useState<Shipment[]>([]);

  const load = useCallback(async () => {
    const ps = await supabase.from('shipments').select(SHIP_COLS).eq('trip_id', trip.trip_id).neq('status', 'huy').order('created_at');
    setParcels((ps.data ?? []) as Shipment[]);
    const t = await supabase.from('seat_inventory')
      .select('id, booking_id, seat_label, from_stop_id, to_stop_id, from_idx, price, status, passenger_name, passenger_phone, pickup_note, dropoff_note, boarded')
      .eq('trip_id', trip.trip_id).in('status', ['dat', 'da_tt']);
    if (t.error) return toast('error', t.error.message);
    const list = (t.data ?? []) as Ticket[];
    setTickets(list);
    const ids = [...new Set(list.map((x) => x.booking_id))];
    if (ids.length) {
      const b = await supabase.from('bookings').select('id, code').in('id', ids);
      setCodes(Object.fromEntries(((b.data ?? []) as { id: string; code: string }[]).map((x) => [x.id, x.code])));
    }
  }, [trip.trip_id, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 20000);   // vé bán thêm ở quầy
    return () => clearInterval(t);
  }, [load]);

  const sorted = useMemo(() => [...tickets].sort((a, b) => a.from_idx - b.from_idx
    || a.seat_label.localeCompare(b.seat_label, 'vi', { numeric: true })), [tickets]);
  const unpaid = tickets.filter((t) => t.status === 'dat');

  async function mark(ev: 'xuat_ben' | 'den_ben') {
    setBusy(true);
    try {
      const at = await rpc<string>('trip_mark', { p_trip_id: trip.trip_id, p_event: ev });
      toast('ok', `${ev === 'xuat_ben' ? 'Đã báo xuất bến' : 'Đã báo đến bến'} lúc ${hhmm(at)}`);
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  async function board(t: Ticket, v: boolean) {
    try {
      await rpc('set_boarded', { p_ticket_id: t.id, p_boarded: v });
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }
  async function collect(t: Ticket) {
    try {
      const n = await rpc<number>('crew_collect', { p_ticket_id: t.id });
      toast('ok', n ? `Đã thu ${money(n)} ghế ${t.seat_label}` : 'Vé này đã thu rồi');
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }

  let lastStop = '';
  return (
    <section className="card">
      <div className="item-head">
        <h2>{hhmm(trip.depart_at)} · {trip.plate ?? 'chưa có xe'}</h2>
        {trip.status === 'mo' && (
          <div className="actions">
            {!trip.departed_at && <button className="btn primary" disabled={busy} onClick={() => void mark('xuat_ben')}>Xuất bến</button>}
            {trip.departed_at && !trip.arrived_at && <button className="btn primary" disabled={busy} onClick={() => void mark('den_ben')}>Đến bến</button>}
          </div>
        )}
      </div>
      {!trip.order_no && trip.status === 'mo' && <p className="warn small">Chuyến chưa có lệnh vận chuyển. Báo điều hành cấp lệnh trước khi xuất bến.</p>}
      <p className="drv-sum">
        <b>{tickets.length}</b> khách · đã lên <b>{tickets.filter((t) => t.boarded).length}</b>
        {unpaid.length > 0 && <> · chưa thu <b className="state-sap_het">{money(unpaid.reduce((a, t) => a + t.price, 0))}</b> ({unpaid.length} vé)</>}
      </p>
      {sorted.length === 0 && <p className="muted">Chưa có khách.</p>}
      <ul className="drv-list">
        {sorted.map((t) => {
          const head = stopName(t.from_stop_id) !== lastStop ? (lastStop = stopName(t.from_stop_id)) : null;
          return (
            <li key={t.id}>
              {head && <div className="drv-stop">Đón tại {head}</div>}
              <div className={t.boarded ? 'drv-pax boarded' : 'drv-pax'}>
                <label className="check drv-board">
                  <input type="checkbox" aria-label={`Ghế ${t.seat_label} đã lên xe`} checked={t.boarded} onChange={(e) => void board(t, e.target.checked)} />
                  <b>{t.seat_label}</b>
                </label>
                <div className="drv-info">
                  <div>{t.passenger_name ?? 'Khách'} {t.passenger_phone && <a href={`tel:${t.passenger_phone}`} className="drv-call">{t.passenger_phone}</a>}</div>
                  <div className="muted small">→ {stopName(t.to_stop_id)}{t.pickup_note ? ` · Đón: ${t.pickup_note}` : ''}{t.dropoff_note ? ` · Trả: ${t.dropoff_note}` : ''} · {codes[t.booking_id]}</div>
                </div>
                <div className="drv-pay">
                  {t.status === 'da_tt' ? <span className="badge">Đã thu</span> : (
                    <button className="btn small primary" aria-label={`Thu tiền ghế ${t.seat_label}`} onClick={() => void collect(t)}>Thu {money(t.price)}</button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {parcels.length > 0 && (
        <>
          <h3 className="section-title">Hàng trên xe ({parcels.length})</h3>
          <ul className="list">
            {parcels.map((p) => <ParcelRow key={p.id} s={p} stopName={stopName} tripName={() => ''} trips={null} reload={load} manage={false} />)}
          </ul>
        </>
      )}
    </section>
  );
}
