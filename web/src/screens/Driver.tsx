// App lái xe (như app cũ): chuyến của tôi; mỗi chuyến có Đón khách theo điểm đón · Sơ đồ ghế có tên khách · Trả & hàng; gọi khách ghi trạng thái báo về quầy; thu tiền mặt / chuyển khoản; xuất bến / đến bến.
import { dirName } from '../lib/routes';
import { NotifyBanner, NotifyBell } from '../components/NotifyBell';
import { MonthPicker } from '../components/MonthPicker';
import { useCallback, useEffect, useState } from 'react';
import { fmtDate, today } from '../components/Documents';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { MyTransfers } from './Transfers';
import { ParcelRow, SHIP_COLS, type Shipment } from './Parcels';
import { MyCharters } from './Charters';
import { FuelReportCard } from '../components/FuelReport';
import { Modal } from '../components/Modal';

interface MyTrip {
  trip_id: string; service_date: string; depart_at: string; arrive_at: string; route_id: string; direction: 'di' | 've'; status: 'mo' | 'huy';
  plate: string | null; my_role: 'lai_xe_1' | 'lai_xe_2' | 'phu_xe'; departed_at: string | null; arrived_at: string | null; order_no: string | null;
  departed_auto?: boolean; arrived_auto?: boolean;
}
type Call = 'da_goi' | 'nghe_may' | 'thue_bao' | 'bao_huy';
interface Ticket {
  id: string; booking_id: string; seat_label: string; from_stop_id: string; to_stop_id: string; from_idx: number; price: number;
  status: 'dat' | 'da_tt'; passenger_name: string | null; passenger_phone: string | null; pickup_note: string | null; dropoff_note: string | null; boarded: boolean;
  crew_call: Call | null; no_show: boolean; dropped: boolean; pay_method: 'tien_mat' | 'chuyen_khoan' | null;
}
interface Layout { name: string; decks: number; rows: number; cols: number; seats: { label: string; deck: number; row: number; col: number; kind: string; sellable: boolean }[] }
const CALL: Record<Call, string> = { da_goi: 'Đã gọi', nghe_may: 'Nghe máy · sẽ ra đón', thue_bao: 'Thuê bao / không nghe', bao_huy: 'Khách báo hủy' };
const TICKET_COLS = 'id, booking_id, seat_label, from_stop_id, to_stop_id, from_idx, price, status, passenger_name, passenger_phone, pickup_note, dropoff_note, boarded, crew_call, no_show, dropped, pay_method';
const mapUrl = (q: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

const TZ = 'Asia/Ho_Chi_Minh';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const money = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
const ROLE = { lai_xe_1: 'Lái xe 1', lai_xe_2: 'Lái xe 2', phu_xe: 'Phụ xe' } as const;
/** Chuyến còn phải chạy: chưa hủy, chưa đến bến, và đang chạy hoặc chưa tới giờ xuất bến */
const isUpcoming = (t: MyTrip, now: number) => t.status !== 'huy' && !t.arrived_at && (!!t.departed_at || new Date(t.depart_at).getTime() >= now);
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

export function DriverScreen({ tenantId, staffId, shareFiles, onShareDone }: { tenantId?: string | null; staffId?: string | null; shareFiles?: File[] | null; onShareDone?: () => void } = {}) {
  const toast = useToast();
  const [day, setDay] = useState(today());
  const [trips, setTrips] = useState<MyTrip[]>([]);
  const [routes, setRoutes] = useState<Record<string, { name: string; name_ve: string | null }>>({});
  const [stops, setStops] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [nbOpen, setNbOpen] = useState(0);

  const load = useCallback(async () => {
    try {
      const [t, r, st] = await Promise.all([
        rpc<MyTrip[]>('my_trips', { p_from: day, p_to: day }),
        supabase.from('routes').select('id, name, name_ve'),
        supabase.from('stops').select('id, name'),
      ]);
      setTrips(t);
      setRoutes(Object.fromEntries(((r.data ?? []) as { id: string; name: string; name_ve: string | null }[]).map((x) => [x.id, x])));
      setStops(Object.fromEntries(((st.data ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name])));
      // mở sẵn chuyến sắp chạy / đang chạy gần nhất
      const now = Date.now(), next = t.filter((x) => isUpcoming(x, now)).sort((a, b) => a.depart_at.localeCompare(b.depart_at))[0] ?? (t.length === 1 ? t[0] : undefined);
      if (next) setOpen((o) => o ?? next.trip_id);
    } catch (e) {
      toast('error', errMsg(e));
    }
  }, [day, toast]);

  useEffect(() => {
    void load();
  }, [load]);
  // Biển số xe mình chạy 7 ngày qua → gợi ý khi báo đổ dầu (xe hôm nay lên đầu)
  const [plates, setPlates] = useState<string[]>([]);
  useEffect(() => {
    void rpc<MyTrip[]>('my_trips', { p_from: addDays(today(), -7), p_to: today() }).then((t) => {
      const L = [...t].sort((a, b) => b.depart_at.localeCompare(a.depart_at)).map((x) => x.plate).filter((x): x is string => !!x);
      setPlates([...new Set(L)]);
    }).catch(() => undefined);
  }, []);


  // chuyến sắp chạy / đang chạy lên đầu (theo giờ), chuyến đã qua giờ / đã đến bến / đã hủy xuống dưới; tự xếp lại mỗi phút
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const sorted = [...trips].sort((a, b) => Number(isUpcoming(b, now)) - Number(isUpcoming(a, now)) || a.depart_at.localeCompare(b.depart_at));
  const cur = open ? trips.find((t) => t.trip_id === open) : undefined;
  // đang chạy chuyến (đã xuất bến, chưa đến bến): không bắt thao tác điện thoại
  const running = day === today() && trips.some((t) => t.departed_at && !t.arrived_at && t.status !== 'huy');
  return (
    <>
      <section className="card">
        <div className="item-head"><h2>Chuyến của tôi · {fmtDate(day)}</h2><NotifyBell inline openKey={nbOpen} /></div>
        <NotifyBanner running={running} onOpen={() => setNbOpen((k) => k + 1)} />
        <div className="inline-form">
          <button className="btn small" aria-label="Ngày trước" onClick={() => { setDay(addDays(day, -1)); setOpen(null); }}>‹</button>
          <label>Ngày<input type="date" value={day} onChange={(e) => { if (e.target.value) { setDay(e.target.value); setOpen(null); } }} /></label>
          <button className="btn small" aria-label="Ngày sau" onClick={() => { setDay(addDays(day, 1)); setOpen(null); }}>›</button>
        </div>
        {trips.length === 0 && <p className="muted">Không có chuyến xe nào được xếp cho bạn trong ngày.</p>}
        <div className="drv-trips">
          {sorted.map((t) => (
            <button key={t.trip_id} className={[open === t.trip_id ? 'trip-chip on' : 'trip-chip', isUpcoming(t, now) ? 'next' : 'past'].filter(Boolean).join(' ')} onClick={() => setOpen(open === t.trip_id ? null : t.trip_id)}
                    aria-label={`Chuyến ${hhmm(t.depart_at)} ${dirName(routes[t.route_id], t.direction)}`}>
              <b>{hhmm(t.depart_at)}</b> {dirName(routes[t.route_id], t.direction)}
              <span className="small">{t.plate ?? 'chưa có xe'} · {ROLE[t.my_role]}{t.order_no ? ` · Lệnh ${t.order_no}` : ''}</span>
              <span className={`badge ${t.status === 'huy' ? 'locked' : t.arrived_at ? '' : t.departed_at ? 'warn-badge' : 'idle'}`}>
                {t.status === 'huy' ? 'Đã hủy' : t.arrived_at ? `Đã đến bến ${hhmm(t.arrived_at)}${t.arrived_auto ? ' (tự ghi)' : ''}` : t.departed_at ? `Đã xuất bến ${hhmm(t.departed_at)}${t.departed_auto ? ' (tự ghi)' : ''}` : 'Chưa xuất bến'}
              </span>
            </button>
          ))}
        </div>
      </section>
      {cur && <TripRun trip={cur} stopName={(id) => stops[id] ?? '?'} reload={load} />}
      {tenantId && staffId && <FuelReportCard tenantId={tenantId} staffId={staffId} plates={plates} shareFiles={shareFiles} onShareDone={onShareDone} />}
      <MyTransfers day={day} />
      <MyCharters />
      <MyMonthTrips routes={routes} onPick={(d, id) => { setDay(d); setOpen(id); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
    </>
  );
}

/** Tất cả chuyến của tôi trong tháng (như app cũ "Thông tin của tôi"): ngày, giờ, tuyến, xe, số khách, trạng thái; bấm 1 dòng để mở chuyến */
function MyMonthTrips({ routes, onPick }: { routes: Record<string, { name: string; name_ve: string | null }>; onPick: (day: string, tripId: string) => void }) {
  const [ym, setYm] = useState(today().slice(0, 7));
  const [list, setList] = useState<MyTrip[]>([]);
  const [pax, setPax] = useState<Record<string, number>>({});
  const [show, setShow] = useState(false);
  useEffect(() => {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    let on = true;
    void (async () => {
      const t = await rpc<MyTrip[]>('my_trips', { p_from: `${ym}-01`, p_to: `${ym}-${String(last).padStart(2, '0')}` }).catch(() => [] as MyTrip[]);
      if (!on) return;
      setList(t);
      const ids = t.map((x) => x.trip_id), c: Record<string, number> = {};
      for (let i = 0; i < ids.length; i += 100) {
        const r = await supabase.from('seat_inventory').select('trip_id').in('trip_id', ids.slice(i, i + 100)).in('status', ['dat', 'da_tt']);
        for (const x of (r.data ?? []) as { trip_id: string }[]) c[x.trip_id] = (c[x.trip_id] ?? 0) + 1;
      }
      if (on) setPax(c);
    })();
    return () => { on = false; };
  }, [ym]);
  const td = today(), done = list.filter((t) => t.status !== 'huy');
  return (
    <section className="card">
      <div className="item-head">
        <h2>Tất cả chuyến của tôi · tháng {ym.slice(5)}/{ym.slice(0, 4)}</h2>
        <MonthPicker value={ym} onChange={setYm} />
      </div>
      <div className="item-head">
        <p className="small muted">{done.length} chuyến · {done.filter((t) => t.service_date < td).length} đã chạy · {done.filter((t) => t.service_date >= td).length} hôm nay và sắp chạy</p>
        {list.length > 0 && <button type="button" className="btn small" aria-expanded={show} onClick={() => setShow(!show)}>{show ? 'Ẩn chi tiết chuyến' : 'Hiện chi tiết chuyến'}</button>}
      </div>
      {list.length === 0 ? <p className="muted">Tháng này chưa có chuyến nào được xếp cho bạn.</p> : !show ? null : (
        <div className="table-wrap">
          <table className="plist">
            <thead><tr><th>Ngày</th><th>Giờ</th><th>Tuyến</th><th>Xe</th><th style={{ textAlign: "right" }}>Khách</th><th /></tr></thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.trip_id} className={t.service_date === td ? 'me-today' : ''} style={{ cursor: 'pointer' }} onClick={() => onPick(t.service_date, t.trip_id)}>
                  <td>{fmtDate(t.service_date)}</td><td><b>{hhmm(t.depart_at)}</b></td><td>{dirName(routes[t.route_id], t.direction)}</td>
                  <td>{t.plate ?? '—'}</td><td style={{ textAlign: "right" }}>{pax[t.trip_id] ?? 0}</td>
                  <td>{t.status === 'huy' ? <span className="badge locked">Đã hủy</span> : t.service_date === td ? <span className="badge warn-badge">Hôm nay</span>
                    : t.service_date > td ? <span className="badge idle">Sắp chạy</span> : <span className="badge">Đã chạy</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Một chuyến (như app cũ): Đón khách theo điểm đón · Sơ đồ ghế có tên khách · Trả khách & hàng. Gọi khách ghi trạng thái báo về quầy bán vé. */
function TripRun({ trip, stopName, reload }: { trip: MyTrip; stopName: (id: string) => string; reload: () => Promise<void> }) {
  const toast = useToast();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [parcels, setParcels] = useState<Shipment[]>([]);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [tab, setTab] = useState<'don' | 'ghe' | 'tra'>('don');
  const [ask, setAsk] = useState<string | null>(null);        // vé đang chọn kết quả cuộc gọi
  const [pay, setPay] = useState<Ticket | null>(null);
  const [hl, setHl] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [ps, t] = await Promise.all([
      supabase.from('shipments').select(SHIP_COLS).eq('trip_id', trip.trip_id).neq('status', 'huy').order('created_at'),
      supabase.from('seat_inventory').select(TICKET_COLS).eq('trip_id', trip.trip_id).in('status', ['dat', 'da_tt']),
    ]);
    setParcels((ps.data ?? []) as Shipment[]);
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
    const t = setInterval(() => void load(), 20000);   // vé bán thêm / quầy đổi ở nơi khác
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => { void rpc<Layout | null>('my_trip_layout', { p_trip_id: trip.trip_id }).then(setLayout).catch(() => setLayout(null)); }, [trip.trip_id]);
  useEffect(() => { if (!hl) return; const t = window.setTimeout(() => setHl(null), 4000); return () => window.clearTimeout(t); }, [hl]);

  const cap = layout?.seats.filter((x) => x.sellable && (x.kind === 'ghe' || x.kind === 'giuong')).length ?? 0;
  const live = tickets.filter((t) => !t.no_show);
  const due = tickets.filter((t) => t.status === 'dat' && !t.no_show).reduce((a, t) => a + t.price, 0);
  const paid = tickets.filter((t) => t.status === 'da_tt').reduce((a, t) => a + t.price, 0);
  const boarded = tickets.filter((t) => t.boarded).length;

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
  /** Ghi trạng thái khách (đổi ngay trên màn hình, lỗi thì tải lại) */
  async function act(list: Ticket[], action: string, patch: Partial<Ticket>) {
    setTickets((cur) => cur.map((x) => (list.some((y) => y.id === x.id) ? { ...x, ...patch } : x)));
    try { for (const t of list) await rpc('crew_mark', { p_ticket_id: t.id, p_action: action }); }
    catch (e) { toast('error', errMsg(e)); }
    await load();
  }
  /** Lên xe: cả đoàn cùng đơn, cùng điểm đón (như app cũ) */
  function board(t: Ticket) {
    const on = !t.boarded;
    const g = on ? tickets.filter((x) => x.booking_id === t.booking_id && x.from_stop_id === t.from_stop_id && !x.boarded && !x.no_show) : [t];
    if (g.length > 1) toast('ok', `Đã đánh dấu lên xe cả đoàn ${g.length} khách (ghế ${g.map((x) => x.seat_label).join(', ')})`);
    void act(g, on ? 'len' : 'bo_len', on ? { boarded: true, no_show: false } : { boarded: false, dropped: false });
  }
  async function collect(t: Ticket, method: 'tien_mat' | 'chuyen_khoan') {
    setPay(null);
    try {
      const n = await rpc<number>('crew_collect', { p_ticket_id: t.id, p_method: method });
      toast('ok', n ? `Đã thu ${money(n)} ghế ${t.seat_label}${method === 'chuyen_khoan' ? ' (chuyển khoản)' : ''}` : 'Vé này đã thu rồi');
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }
  const call = (t: Ticket) => { setAsk(t.id); if (!t.crew_call) void act([t], 'goi', { crew_call: 'da_goi' }); };
  const result = (t: Ticket, c: Call | null) => { setAsk(null); void act([t], c ?? 'bo_goi', { crew_call: c }); };

  const groups = (key: 'from' | 'to') => {
    const m = new Map<string, Ticket[]>();
    for (const t of [...tickets].sort((a, b) => a.from_idx - b.from_idx)) { const k = key === 'from' ? t.from_stop_id : t.to_stop_id; m.set(k, [...(m.get(k) ?? []), t]); }
    return [...m.entries()].map(([k, L]) => [k, L.sort((a, b) => Number(key === 'from' ? a.boarded || a.no_show : a.dropped || a.no_show) - Number(key === 'from' ? b.boarded || b.no_show : b.dropped || b.no_show)
      || a.seat_label.localeCompare(b.seat_label, 'vi', { numeric: true }))] as const);
  };
  const toTab = (t: Ticket) => { setTab('don'); setHl(t.id); setTimeout(() => document.getElementById(`pax-${t.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60); };

  const row = (t: Ticket, mode: 'don' | 'tra') => {
    const done = mode === 'don' ? t.boarded || t.no_show : t.dropped || t.no_show;
    return (
      <div key={t.id} id={`pax-${t.id}`} className={`dt-p${done ? ' on' : ''}${t.no_show ? ' vang' : ''}${hl === t.id ? ' hl' : ''}`}>
        <div className="dt-pt">
          <span className="dt-seat">{t.seat_label}</span>
          <div className="grow">
            <b>{t.passenger_name || 'Khách'}</b>
            {t.no_show && <span className="dt-tag vang">Vắng</span>}
            {t.dropped && <span className="dt-tag">Đã trả</span>}
            {t.crew_call && <button type="button" className={`dt-tag call ${t.crew_call}`} onClick={() => setAsk(ask === t.id ? null : t.id)} aria-label={`Kết quả gọi ghế ${t.seat_label}: ${CALL[t.crew_call]}`}>{CALL[t.crew_call]}</button>}
            {mode === 'don' && t.pickup_note && <div className="dt-gc">Đón: {t.pickup_note}</div>}
            <div className="dt-pm">{mode === 'don' ? `→ ${stopName(t.to_stop_id)}${t.dropoff_note ? ` · Trả: ${t.dropoff_note}` : ''}` : `Trả: ${t.dropoff_note || stopName(t.to_stop_id)}`}{codes[t.booking_id] ? ` · ${codes[t.booking_id]}` : ''}</div>
          </div>
          <div className="dt-money">{t.status === 'da_tt' ? <span className="ok-text">Đã thu{t.pay_method === 'chuyen_khoan' ? ' CK' : ''}</span> : <><b>{money(t.price)}</b><small>cần thu</small></>}</div>
        </div>
        {ask === t.id && (
          <div className="dt-ask" role="group" aria-label={`Kết quả gọi ghế ${t.seat_label}`}>
            {(['nghe_may', 'thue_bao', 'bao_huy'] as const).map((c) => (
              <button key={c} type="button" className={`btn small${t.crew_call === c ? ' primary' : ''}`} onClick={() => result(t, c)}>{CALL[c]}</button>))}
            {t.crew_call && <button type="button" className="btn small link" onClick={() => result(t, null)}>Xóa</button>}
          </div>
        )}
        <div className="dt-acts">
          {t.passenger_phone ? <a className="btn dt-b" href={`tel:${t.passenger_phone}`} onClick={() => call(t)} aria-label={`Gọi ghế ${t.seat_label}`}>📞 Gọi</a> : <span />}
          {mode === 'don' ? <>
            <button type="button" className={`btn dt-b${t.boarded ? ' done' : ''}`} disabled={t.no_show} onClick={() => board(t)} aria-label={`Ghế ${t.seat_label} lên xe`}>✓ {t.boarded ? 'Đã lên' : 'Lên xe'}</button>
            <button type="button" className={`btn dt-b${t.no_show ? ' warn' : ''}`} disabled={t.boarded} onClick={() => void act([t], t.no_show ? 'bo_vang' : 'vang', { no_show: !t.no_show })} aria-label={`Ghế ${t.seat_label} vắng`}>✕ {t.no_show ? 'Đã vắng' : 'Vắng'}</button>
          </> : (
            <button type="button" className={`btn dt-b${t.dropped ? ' done' : ''}`} disabled={t.no_show} onClick={() => void act([t], t.dropped ? 'bo_tra' : 'tra', { dropped: !t.dropped, boarded: true })} aria-label={`Trả khách ghế ${t.seat_label}`}>✓ {t.dropped ? 'Đã trả' : 'Trả khách'}</button>
          )}
          <button type="button" className={`btn dt-b${t.status === 'da_tt' ? ' done' : ' pay'}`} disabled={t.no_show || t.status === 'da_tt'} onClick={() => setPay(t)} aria-label={`Thu tiền ghế ${t.seat_label}`}>💵 {t.status === 'da_tt' ? 'Đã thu' : 'Thu'}</button>
        </div>
      </div>
    );
  };

  const stopHead = (k: string, L: Ticket[], mode: 'don' | 'tra') => {
    const left = L.filter((t) => !t.no_show && !(mode === 'don' ? t.boarded : t.dropped)).length;
    return <div className="dt-sh"><a href={mapUrl(stopName(k))} target="_blank" rel="noopener noreferrer" title="Chỉ đường">📍 {stopName(k)}</a><span>{left ? `${left} chờ` : '✓ đủ'}/{L.length}</span></div>;
  };

  return (
    <section className="card dt">
      <div className="item-head">
        <div>
          <h2>{hhmm(trip.depart_at)} · {trip.plate ?? 'chưa có xe'}</h2>
          <div className="small muted">{trip.order_no ? `Lệnh ${trip.order_no}` : 'Chưa có lệnh vận chuyển'}{layout ? ` · ${layout.name}` : ''}</div>
        </div>
        {trip.status === 'mo' && (
          <div className="actions">
            {!trip.departed_at && <button className="btn primary" disabled={busy} onClick={() => void mark('xuat_ben')}>Xuất bến</button>}
            {trip.departed_at && !trip.arrived_at && <button className="btn primary" disabled={busy} onClick={() => void mark('den_ben')}>Đến bến</button>}
          </div>
        )}
      </div>
      {!trip.order_no && trip.status === 'mo' && <p className="warn small">Chuyến chưa có lệnh vận chuyển. Báo điều hành cấp lệnh trước khi xuất bến.</p>}
      <div className="dt-kpi">
        <div><b>{live.length}{cap ? <small>/{cap}</small> : null}</b><span>Khách</span></div>
        <div><b>{boarded}</b><span>Đã lên</span></div>
        <div><b className={due ? 'danger-text' : ''}>{money(due)}</b><span>Còn phải thu</span></div>
      </div>
      {trip.arrived_at && (
        <div className="dt-sum"><b>Tổng kết chuyến</b> · đã lên {boarded}/{tickets.length} · đã thu {money(paid)}
          {tickets.some((t) => t.no_show) && <div className="warn small">{tickets.filter((t) => t.no_show).length} khách vắng</div>}
          {tickets.length - boarded - tickets.filter((t) => t.no_show).length > 0 && <div className="warn small">{tickets.length - boarded - tickets.filter((t) => t.no_show).length} khách chưa đánh dấu lên xe hoặc vắng</div>}
          {due > 0 && <div className="warn small">Còn {money(due)} chưa thu</div>}</div>
      )}
      <div className="dt-tabs" role="tablist" aria-label="Xem">
        {([['don', 'Đón khách'], ['ghe', 'Sơ đồ ghế'], ['tra', 'Trả & hàng']] as const).map(([k, n]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{n}</button>))}
      </div>

      {tab === 'don' && (tickets.length ? groups('from').map(([k, L]) => <div key={k} className="dt-stop">{stopHead(k, L, 'don')}{L.map((t) => row(t, 'don'))}</div>)
        : <p className="muted">Chưa có khách đặt vé.</p>)}

      {tab === 'ghe' && (layout ? (
        <>
          {Array.from({ length: layout.decks }, (_, i) => i + 1).map((d) => (
            <div key={d}>
              {layout.decks > 1 && <div className="small muted">Tầng {d === 1 ? 'dưới' : 'trên'}</div>}
              <div className="dt-grid" style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` }}>
                {Array.from({ length: layout.rows * layout.cols }, (_, idx) => {
                  const r = Math.floor(idx / layout.cols) + 1, c = (idx % layout.cols) + 1;
                  const st = layout.seats.find((x) => x.deck === d && x.row === r && x.col === c);
                  if (!st) return <div key={idx} />;
                  if (st.kind === 'tai_xe' || st.kind === 'cua') return <div key={idx} className="dt-g lbl">{st.kind === 'tai_xe' ? 'Tài xế' : 'Cửa'}</div>;
                  const ts = tickets.filter((x) => x.seat_label === st.label), t = ts[0];
                  if (!t) return <div key={idx} className="dt-g" aria-label={`Ghế ${st.label} trống`}><b>{st.label}</b></div>;
                  const cls = t.no_show ? 'vang' : t.crew_call === 'bao_huy' ? 'huy' : t.boarded ? 'len' : t.status === 'da_tt' ? 'pd' : 'bk';
                  return (
                    <button key={idx} type="button" className={`dt-g ${cls}`} onClick={() => toTab(t)} aria-label={`Ghế ${st.label} ${t.passenger_name ?? 'khách'}`}>
                      <b>{st.label}{ts.length > 1 ? ` ·${ts.length}` : ''}</b>
                      <span className="dt-gn">{t.passenger_name || t.passenger_phone || 'Khách'}</span>
                      <small>{t.pickup_note || stopName(t.from_stop_id)}</small>
                      {t.status === 'dat' && !t.no_show && <small className="dt-gm">{money(t.price)}</small>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="dt-leg"><span><i className="bk" />Chưa thu</span><span><i className="pd" />Đã thu</span><span><i className="len" />Đã lên xe</span>
            <span><i className="vang" />Vắng</span><span><i className="huy" />Báo hủy</span><span><i />Trống</span></div>
        </>
      ) : <p className="muted">Xe chưa có sơ đồ ghế.</p>)}

      {tab === 'tra' && (
        <>
          {tickets.length > 0 && groups('to').map(([k, L]) => <div key={k} className="dt-stop">{stopHead(k, L, 'tra')}{L.map((t) => row(t, 'tra'))}</div>)}
          <h3 className="section-title">Hàng gửi ({parcels.length})</h3>
          {parcels.length ? <ul className="list">{parcels.map((p) => <ParcelRow key={p.id} s={p} stopName={stopName} tripName={() => ''} trips={null} reload={load} manage={false} />)}</ul>
            : <p className="muted small">Không có hàng gửi.</p>}
        </>
      )}

      <div className="dt-foot"><div><small>Đã thu</small><b>{money(paid)}</b></div><div><small>Còn phải thu</small><b className={due ? 'danger-text' : ''}>{money(due)}</b></div></div>

      {pay && (
        <Modal title={`Thu tiền ghế ${pay.seat_label}${pay.passenger_name ? ` · ${pay.passenger_name}` : ''}`} onClose={() => setPay(null)}>
          <div className="dt-paybox">
            <div className="dt-amount">{money(pay.price)}</div>
            <div className="dt-pay2">
              <button type="button" className="btn primary dt-b" onClick={() => void collect(pay, 'tien_mat')}>💵 Tiền mặt</button>
              <button type="button" className="btn primary dt-b" onClick={() => void collect(pay, 'chuyen_khoan')}>🏦 Chuyển khoản</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
