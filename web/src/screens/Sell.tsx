// Bán vé tại quầy: chọn chuyến → chọn chặng → bấm ghế (giữ ngay, chống bán trùng) → thông tin khách →
// thu tiền ngay hoặc đặt chỗ trả sau → in vé. Danh sách khách theo chuyến, tiền mặt đã thu hôm nay.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtDate, today } from '../components/Documents';
import { TicketPrint, type TicketPrintData } from '../components/TicketPrint';
import { companyFileUrl } from '../lib/documents';
import { TransferQR, type BankAccount } from '../components/TransferQR';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';

type Dir = 'di' | 've';
type SeatStatus = 'giu' | 'dat' | 'da_tt' | 'het_han' | 'huy';
interface Trip {
  id: string; route_id: string; direction: Dir; depart_at: string; arrive_at: string; status: 'mo' | 'huy';
  vehicle_id: string | null; vehicle_type_id: string | null; service_date: string;
}
interface Route { id: string; name: string }
interface RouteStop { route_id: string; seq: number; stop_id: string }
interface Stop { id: string; name: string }
interface VType { id: string; name: string; decks: number; layout_rows: number; layout_cols: number }
interface Seat { vehicle_type_id: string; label: string; deck: number; row_no: number; col_no: number; kind: 'ghe' | 'giuong'; is_priority: boolean; is_sellable: boolean }
export interface Ticket {
  id: string; booking_id: string; trip_id: string; seat_label: string; from_stop_id: string; to_stop_id: string;
  from_idx: number; to_idx: number; price: number; status: SeatStatus; hold_until: string | null; keep_reason: string | null;
  passenger_name: string | null; passenger_phone: string | null; pickup_note: string | null; dropoff_note: string | null;
  boarded: boolean; created_by: string | null; paid_by: string | null; pay_method: 'tien_mat' | 'chuyen_khoan' | null;
}
interface Booking { id: string; code: string; customer_name: string | null; customer_phone: string | null; note: string | null }
interface Customer { phone: string; name: string | null; last_from_stop: string | null; last_to_stop: string | null; last_pickup_note: string | null; trips_count: number }

const TZ = 'Asia/Ho_Chi_Minh';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const money = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
const active = (t: Ticket) => (t.status === 'giu' || t.status === 'dat' || t.status === 'da_tt')
  && !(t.hold_until && t.status !== 'da_tt' && Date.parse(t.hold_until) < Date.now());
const TICKET_COLS = 'id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx, price, status, hold_until, keep_reason, passenger_name, passenger_phone, pickup_note, dropoff_note, boarded, created_by, paid_by, pay_method';
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

export function SellScreen({ ctx, perms }: { ctx: AccountContext; perms: Permissions }) {
  const toast = useToast();
  const canSell = perms.has('ticket.sell');
  const [day, setDay] = useState(today());
  const [trips, setTrips] = useState<Trip[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [rstops, setRstops] = useState<RouteStop[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [types, setTypes] = useState<VType[]>([]);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [plates, setPlates] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [tripId, setTripId] = useState<string | null>(null);
  const [footer, setFooter] = useState<string | null>(null);
  const [bank, setBank] = useState<BankAccount | null>(null);
  const [changeFee, setChangeFee] = useState(0);
  const [version, setVersion] = useState(0);
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    if (ctx.tenant_id) void companyFileUrl(ctx.tenant_id, 'logo.png').then(setLogo);
  }, [ctx.tenant_id]);
  useEffect(() => {
    void supabase.from('tenant_settings').select('key, value').in('key', ['ve.ghi_chu', 'tt.ngan_hang_bin', 'tt.so_tai_khoan', 'tt.ten_tai_khoan', 'doi_ve.phi_dong'])
      .then(({ data }) => {
        const v = (k: string) => ((data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value as string | undefined;
        setFooter(v('ve.ghi_chu') || null);
        setChangeFee(Number(v('doi_ve.phi_dong') ?? 0) || 0);
        const bin = v('tt.ngan_hang_bin');
        const acc = v('tt.so_tai_khoan');
        setBank(bin && acc ? { bin, account: acc, name: v('tt.ten_tai_khoan') ?? '' } : null);
      });
  }, []);

  const loadBase = useCallback(async () => {
    const [t, r, rs, st, vt, se, v] = await Promise.all([
      supabase.from('trips').select('id, route_id, direction, depart_at, arrive_at, status, vehicle_id, vehicle_type_id, service_date')
        .eq('service_date', day).eq('status', 'mo').order('depart_at'),
      supabase.from('routes').select('id, name'),
      supabase.from('route_stops').select('route_id, seq, stop_id').order('seq'),
      supabase.from('stops').select('id, name'),
      supabase.from('vehicle_types').select('id, name, decks, layout_rows, layout_cols'),
      supabase.from('vehicle_type_seats').select('vehicle_type_id, label, deck, row_no, col_no, kind, is_priority, is_sellable'),
      supabase.from('vehicles').select('id, plate'),
    ]);
    const err = t.error ?? r.error ?? rs.error ?? st.error ?? vt.error ?? se.error ?? v.error;
    if (err) return toast('error', err.message);
    const list = (t.data ?? []) as Trip[];
    setTrips(list);
    setRoutes((r.data ?? []) as Route[]);
    setRstops((rs.data ?? []) as RouteStop[]);
    setStops((st.data ?? []) as Stop[]);
    setTypes((vt.data ?? []) as VType[]);
    setSeats((se.data ?? []) as Seat[]);
    setPlates(Object.fromEntries(((v.data ?? []) as { id: string; plate: string }[]).map((x) => [x.id, x.plate])));
    if (list.length) {
      const c = await supabase.from('seat_inventory').select('trip_id, status, hold_until').in('trip_id', list.map((x) => x.id))
        .in('status', ['giu', 'dat', 'da_tt']);
      const m: Record<string, number> = {};
      for (const x of (c.data ?? []) as Ticket[]) if (active(x)) m[x.trip_id] = (m[x.trip_id] ?? 0) + 1;
      setCounts(m);
    } else setCounts({});
  }, [day, toast]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  /** Điểm dừng theo chiều chạy */
  const orderedStops = useCallback((routeId: string, dir: Dir) => {
    const list = rstops.filter((x) => x.route_id === routeId).sort((a, b) => a.seq - b.seq).map((x) => x.stop_id);
    return dir === 'di' ? list : [...list].reverse();
  }, [rstops]);
  const stopName = useCallback((id: string | null) => stops.find((s) => s.id === id)?.name ?? '?', [stops]);

  const trip = trips.find((t) => t.id === tripId) ?? null;
  const sellable = (typeId: string | null) => seats.filter((s) => s.vehicle_type_id === typeId && s.is_sellable).length;

  return (
    <>
      <CashToday userId={ctx.user_id} version={version} />
      <section className="card">
        <h2>Bán vé ngày {fmtDate(day)}</h2>
        <div className="inline-form">
          <button className="btn small" aria-label="Ngày trước" onClick={() => { setDay(addDays(day, -1)); setTripId(null); }}>‹</button>
          <label>Ngày đi<input type="date" value={day} onChange={(e) => { if (e.target.value) { setDay(e.target.value); setTripId(null); } }} /></label>
          <button className="btn small" aria-label="Ngày sau" onClick={() => { setDay(addDays(day, 1)); setTripId(null); }}>›</button>
        </div>
        {trips.length === 0 && <p className="muted">Không có chuyến đang mở trong ngày.</p>}
        <div className="trip-chips">
          {trips.map((t) => {
            const stopsOf = orderedStops(t.route_id, t.direction);
            const total = sellable(t.vehicle_type_id);
            return (
              <button key={t.id} className={t.id === tripId ? 'trip-chip on' : 'trip-chip'} aria-label={`Chuyến ${hhmm(t.depart_at)} ${routes.find((r) => r.id === t.route_id)?.name ?? ''}`}
                      onClick={() => setTripId(t.id)}>
                <b>{hhmm(t.depart_at)}</b> {routes.find((r) => r.id === t.route_id)?.name}
                <span className="small">{stopName(stopsOf[0])} → {stopName(stopsOf[stopsOf.length - 1])}</span>
                <span className="small">{t.vehicle_type_id ? `${counts[t.id] ?? 0}/${total} chỗ đã bán` : 'Chưa có sơ đồ ghế'}{t.vehicle_id ? ` · ${plates[t.vehicle_id]}` : ''}</span>
              </button>
            );
          })}
        </div>
      </section>
      {trip && (
        <TripSell key={trip.id} trip={trip} ctx={ctx} canSell={canSell} canOverride={perms.has('settings.manage')} changeFee={changeFee} routeName={routes.find((r) => r.id === trip.route_id)?.name ?? ''}
                  stopIds={orderedStops(trip.route_id, trip.direction)} stopName={stopName} type={types.find((x) => x.id === trip.vehicle_type_id) ?? null}
                  seats={seats.filter((s) => s.vehicle_type_id === trip.vehicle_type_id)} plate={trip.vehicle_id ? plates[trip.vehicle_id] : null}
                  otherTrips={trips.filter((x) => x.route_id === trip.route_id && x.direction === trip.direction)}
                  footer={footer} logo={logo} bank={bank} onChanged={async () => { setVersion((v) => v + 1); await loadBase(); }} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ Tiền mặt hôm nay của tôi */

function CashToday({ userId, version }: { userId: string | null; version: number }) {
  const [sum, setSum] = useState<{ cash: number; bank: number } | null>(null);
  const load = useCallback(async () => {
    if (!userId) return;
    const start = new Date(`${today()}T00:00:00+07:00`).toISOString();
    const { data } = await supabase.from('ledger_lines').select('account, debit, credit, ledger_transactions!inner(created_at)')
      .in('account', ['tien_mat', 'ngan_hang']).eq('holder_id', userId).gte('ledger_transactions.created_at', start);
    const rows = (data ?? []) as { account: string; debit: number; credit: number }[];
    const total = (acc: string) => rows.filter((x) => x.account === acc).reduce((a, x) => a + Number(x.debit) - Number(x.credit), 0);
    setSum({ cash: total('tien_mat'), bank: total('ngan_hang') });
  }, [userId]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load, version]);
  if (sum === null) return null;
  return <p className="cash-today">Tôi thu hôm nay: tiền mặt <b>{money(sum.cash)}</b> · chuyển khoản đã xác nhận <b>{money(sum.bank)}</b></p>;
}

/* ------------------------------------------------------------------ Bán vé 1 chuyến */

interface TripSellProps {
  trip: Trip; ctx: AccountContext; canSell: boolean; canOverride: boolean; changeFee: number; routeName: string; stopIds: string[]; stopName: (id: string | null) => string;
  type: VType | null; seats: Seat[]; plate: string | null; otherTrips: Trip[]; footer: string | null; logo: string | null; bank: BankAccount | null; onChanged: () => Promise<void>;
}

function TripSell(props: TripSellProps) {
  const { trip, ctx, canSell, stopIds, stopName, type, seats, onChanged } = props;
  const toast = useToast();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [from, setFrom] = useState(stopIds[0] ?? '');
  const [to, setTo] = useState(stopIds[stopIds.length - 1] ?? '');
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [printing, setPrinting] = useState<TicketPrintData | null>(null);
  const [view, setView] = useState<'so_do' | 'khach'>('so_do');
  const fromIdx = stopIds.indexOf(from);
  const toIdx = stopIds.indexOf(to);

  const load = useCallback(async () => {
    await rpc('refresh_trip_seats', { p_trip_id: trip.id }).catch(() => undefined);
    const t = await supabase.from('seat_inventory').select(TICKET_COLS).eq('trip_id', trip.id).in('status', ['giu', 'dat', 'da_tt']);
    if (t.error) return toast('error', t.error.message);
    const list = (t.data ?? []) as Ticket[];
    setTickets(list);
    const ids = [...new Set(list.map((x) => x.booking_id))];
    if (ids.length) {
      const b = await supabase.from('bookings').select('id, code, customer_name, customer_phone, note').in('id', ids);
      setBookings((b.data ?? []) as Booking[]);
    }
  }, [trip.id, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);   // cập nhật ghế các quầy khác bán
    return () => clearInterval(t);
  }, [load]);

  const myHolds = tickets.filter((t) => t.status === 'giu' && t.booking_id === bookingId && active(t));
  const onSeat = (label: string) => tickets.filter((t) => t.seat_label === label && active(t));
  const overlapping = (label: string) => onSeat(label).find((t) => t.from_idx < toIdx && fromIdx < t.to_idx);

  async function clickSeat(label: string) {
    if (!canSell) return;
    const hit = overlapping(label);
    if (hit) {
      if (hit.status === 'giu' && hit.booking_id === bookingId) {
        try {
          await rpc('unhold_seat', { p_ticket_id: hit.id });
        } catch (e) {
          toast('error', errMsg(e));
        }
        return void load();
      }
      if (hit.status === 'giu') return toast('error', `Ghế ${label} đang được quầy khác giữ`);
      return setSelected(hit);
    }
    if (fromIdx < 0 || toIdx <= fromIdx) return toast('error', 'Chọn điểm đón trước điểm trả');
    try {
      const r = await rpc<{ booking_id: string }>('hold_seat', {
        p_trip_id: trip.id, p_seat: label, p_from_stop: from, p_to_stop: to, p_booking_id: bookingId, p_request_id: crypto.randomUUID(),
      });
      setBookingId(r.booking_id);
    } catch (e) {
      toast('error', errMsg(e));
    }
    await load();
  }

  const bookingOf = (id: string) => bookings.find((b) => b.id === id);
  const ticketData = (list: Ticket[], code: string): TicketPrintData => ({
    code, tenant: ctx.tenant_name ?? '', routeName: props.routeName, departAt: trip.depart_at, plate: props.plate, seller: ctx.full_name ?? '',
    footer: props.footer, logo: props.logo,
    tickets: list.map((t) => ({
      seat: t.seat_label, from: stopName(t.from_stop_id), to: stopName(t.to_stop_id), price: t.price,
      name: t.passenger_name, phone: t.passenger_phone, pickup: t.pickup_note, dropoff: t.dropoff_note,
      paid: t.status === 'da_tt', holdUntil: t.status === 'dat' ? t.hold_until : null,
    })),
  });

  if (!type) {
    return <section className="card"><p className="muted">Chuyến chưa có sơ đồ ghế. Vào mục Điều hành chọn loại xe cho nốt hoặc chuyến.</p></section>;
  }

  return (
    <>
      {printing && <TicketPrint data={printing} onClose={() => setPrinting(null)} />}
      <section className="card">
        <div className="item-head">
          <h2>{hhmm(trip.depart_at)} · {props.routeName}{props.plate ? ` · ${props.plate}` : ''}</h2>
          <div className="chips">
            <button className={view === 'so_do' ? 'btn small primary' : 'btn small'} onClick={() => setView('so_do')}>Sơ đồ ghế</button>
            <button className={view === 'khach' ? 'btn small primary' : 'btn small'} onClick={() => setView('khach')}>Danh sách khách</button>
          </div>
        </div>
        {view === 'so_do' ? (
          <>
            <div className="inline-form">
              <label>Đón tại
                <select value={from} onChange={(e) => setFrom(e.target.value)} disabled={myHolds.length > 0}>
                  {stopIds.slice(0, -1).map((id) => <option key={id} value={id}>{stopName(id)}</option>)}
                </select>
              </label>
              <label>Trả tại
                <select value={to} onChange={(e) => setTo(e.target.value)} disabled={myHolds.length > 0}>
                  {stopIds.slice(1).map((id) => <option key={id} value={id}>{stopName(id)}</option>)}
                </select>
              </label>
            </div>
            <SeatMap type={type} seats={seats} statusOf={(label) => {
              const hit = overlapping(label);
              if (!hit) return { cls: 'free' };
              const mine = hit.status === 'giu' && hit.booking_id === bookingId;
              return { cls: mine ? 'mine' : hit.status === 'giu' ? 'held' : hit.boarded ? 'boarded' : hit.status, t: hit };
            }} onClick={(l) => void clickSeat(l)} />
            <p className="muted small legend">
              <span className="seat-dot free" /> trống <span className="seat-dot mine" /> đang chọn <span className="seat-dot held" /> quầy khác giữ
              <span className="seat-dot dat" /> đặt chưa trả <span className="seat-dot da_tt" /> đã thanh toán <span className="seat-dot boarded" /> đã lên xe
            </p>
          </>
        ) : (
          <PassengerList tickets={tickets.filter((t) => t.status !== 'giu')} stopName={stopName} bookingOf={bookingOf}
                         onOpen={(t) => setSelected(t)} reload={load} />
        )}
      </section>
      {myHolds.length > 0 && bookingId && (
        <Checkout trip={trip} holds={myHolds} bookingId={bookingId} stopName={stopName} from={from} to={to} bank={props.bank}
                  onDone={async (code, printList) => {
                    setBookingId(null);
                    await load();
                    await onChanged();
                    if (printList) setPrinting(ticketData(printList, code));
                  }} onCancelAll={async () => {
                    for (const h of myHolds) await rpc('unhold_seat', { p_ticket_id: h.id }).catch(() => undefined);
                    setBookingId(null);
                    await load();
                  }} />
      )}
      {selected && (
        <TicketDetail ticket={selected} booking={bookingOf(selected.booking_id)} stopName={stopName} otherTrips={props.otherTrips} bank={props.bank}
                      canOverride={props.canOverride} changeFee={props.changeFee}
                      currentTrip={trip} onClose={() => setSelected(null)}
                      onPrint={(list, code) => setPrinting(ticketData(list, code))}
                      siblings={tickets.filter((t) => t.booking_id === selected.booking_id && t.status !== 'giu')}
                      reload={async () => { await load(); await onChanged(); }} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ Sơ đồ ghế */

function SeatMap(props: { type: VType; seats: Seat[]; statusOf: (label: string) => { cls: string; t?: Ticket }; onClick: (label: string) => void }) {
  const { type, seats, statusOf, onClick } = props;
  return (
    <div className="decks">
      {Array.from({ length: type.decks }, (_, i) => i + 1).map((d) => (
        <div key={d} className="deck">
          {type.decks > 1 && <div className="muted small">Tầng {d === 1 ? 'dưới' : 'trên'}</div>}
          <div className="seat-grid sell" style={{ gridTemplateColumns: `repeat(${type.layout_cols}, minmax(52px, 72px))` }}>
            {Array.from({ length: type.layout_rows * type.layout_cols }, (_, idx) => {
              const r = Math.floor(idx / type.layout_cols) + 1;
              const c = (idx % type.layout_cols) + 1;
              const s = seats.find((x) => x.deck === d && x.row_no === r && x.col_no === c);
              if (!s) return <div key={idx} />;
              if (!s.is_sellable) return <div key={idx} className="sseat off">{s.label}</div>;
              const st = statusOf(s.label);
              const who = st.t && st.t.status !== 'giu' ? (st.t.passenger_name ?? st.t.passenger_phone ?? '') : '';
              return (
                <button key={idx} type="button" className={`sseat ${st.cls}${s.is_priority ? ' prio' : ''}`}
                        aria-label={`Ghế ${s.label}${st.cls === 'free' ? ' trống' : ''}`} onClick={() => onClick(s.label)}>
                  <b>{s.label}</b>
                  {who && <span>{who.slice(0, 10)}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Xác nhận đơn */

function Checkout(props: {
  trip: Trip; holds: Ticket[]; bookingId: string; stopName: (id: string | null) => string; from: string; to: string;
  bank: BankAccount | null;
  onDone: (code: string, printList: Ticket[] | null) => Promise<void>; onCancelAll: () => Promise<void>;
}) {
  const { holds, bookingId, stopName, onDone, onCancelAll, bank } = props;
  const toast = useToast();
  const [f, setF] = useState({ phone: '', name: '', pickup: '', dropoff: '', note: '', mode: 'thu_tien' as 'thu_tien' | 'dat_cho' | 'chuyen_khoan', keep: false, reason: '' });
  const [transfer, setTransfer] = useState<{ code: string; total: number; holdUntil: string | null } | null>(null);
  const [known, setKnown] = useState<Customer | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0);
  const total = holds.reduce((a, t) => a + t.price, 0);
  const until = Math.min(...holds.map((t) => Date.parse(t.hold_until ?? '') || Infinity));

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.round((until - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until]);

  async function lookup(phone: string) {
    const p = phone.replace(/\D/g, '');
    if (!/^0\d{9}$/.test(p)) return setKnown(null);
    const { data } = await supabase.from('customers').select('phone, name, last_from_stop, last_to_stop, last_pickup_note, trips_count').eq('phone', p).maybeSingle();
    const c = data as Customer | null;
    setKnown(c);
    if (c) setF((cur) => ({ ...cur, name: cur.name || c.name || '', pickup: cur.pickup || c.last_pickup_note || '' }));
  }

  async function confirm(print: boolean) {
    setBusy(true);
    try {
      const r = await rpc<{ code: string }>('confirm_booking', {
        p_booking_id: bookingId, p_phone: f.phone || null, p_name: f.name || null, p_mode: f.mode, p_keep: f.mode === 'dat_cho' && f.keep,
        p_keep_reason: f.reason || null, p_pickup_note: f.pickup || null, p_dropoff_note: f.dropoff || null, p_note: f.note || null, p_passengers: null,
      });
      const { data } = await supabase.from('seat_inventory').select(TICKET_COLS).eq('booking_id', bookingId).in('status', ['dat', 'da_tt']);
      const list = (data ?? []) as Ticket[];
      if (f.mode === 'chuyen_khoan') {
        // Hiện QR, chờ nhân viên xác nhận tiền đã về
        setTransfer({ code: r.code, total: list.reduce((a, t) => a + t.price, 0), holdUntil: list[0]?.hold_until ?? null });
        return;
      }
      toast('ok', f.mode === 'thu_tien' ? `Đã bán vé ${r.code} · thu ${money(total)}` : `Đã đặt chỗ ${r.code}`);
      await onDone(r.code, print ? list : null);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function received() {
    if (!transfer) return;
    setBusy(true);
    try {
      await rpc('pay_booking', { p_booking_id: bookingId, p_ticket_ids: null, p_method: 'chuyen_khoan' });
      toast('ok', `Đã nhận chuyển khoản vé ${transfer.code} · ${money(transfer.total)}`);
      const { data } = await supabase.from('seat_inventory').select(TICKET_COLS).eq('booking_id', bookingId).eq('status', 'da_tt');
      await onDone(transfer.code, (data ?? []) as Ticket[]);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  if (transfer && bank) {
    return (
      <section className="card form checkout">
        <h2>Chuyển khoản vé {transfer.code}</h2>
        <TransferQR bank={bank} amount={transfer.total} code={transfer.code} holdUntil={transfer.holdUntil} busy={busy}
                    onConfirm={() => void received()} onLater={() => { toast('ok', `Vé ${transfer.code} đang chờ chuyển khoản`); void onDone(transfer.code, null); }} />
      </section>
    );
  }

  return (
    <section className="card form checkout">
      <div className="item-head">
        <h2>Đơn vé · {holds.length} ghế · {money(total)}</h2>
        <span className={left < 60 ? 'state-het_han' : 'muted'}>Giữ ghế còn {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
      </div>
      <p className="small">Ghế {holds.map((h) => h.seat_label).join(', ')} · {stopName(props.from)} → {stopName(props.to)}</p>
      <div className="grid2">
        <label>Số điện thoại khách
          <input inputMode="tel" value={f.phone} onChange={(e) => { setF({ ...f, phone: e.target.value }); void lookup(e.target.value); }} />
          {known && <span className="small state-con_han">Khách cũ · đã đi {known.trips_count} lần{known.last_from_stop ? ` · lần trước ${stopName(known.last_from_stop)} → ${stopName(known.last_to_stop)}` : ''}</span>}
        </label>
        <label>Tên khách<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Ghi chú điểm đón<input value={f.pickup} onChange={(e) => setF({ ...f, pickup: e.target.value })} placeholder="vd: đón trước cây xăng" /></label>
        <label>Ghi chú điểm trả<input value={f.dropoff} onChange={(e) => setF({ ...f, dropoff: e.target.value })} /></label>
        <label>Ghi chú đơn<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
      </div>
      <div className="chips" role="radiogroup" aria-label="Cách thanh toán">
        <button type="button" role="radio" aria-checked={f.mode === 'thu_tien'} className={f.mode === 'thu_tien' ? 'btn small primary' : 'btn small'}
                onClick={() => setF({ ...f, mode: 'thu_tien' })}>Thu tiền mặt ngay</button>
        {bank && (
          <button type="button" role="radio" aria-checked={f.mode === 'chuyen_khoan'} className={f.mode === 'chuyen_khoan' ? 'btn small primary' : 'btn small'}
                  onClick={() => setF({ ...f, mode: 'chuyen_khoan' })}>Chuyển khoản (QR)</button>
        )}
        <button type="button" role="radio" aria-checked={f.mode === 'dat_cho'} className={f.mode === 'dat_cho' ? 'btn small primary' : 'btn small'}
                onClick={() => setF({ ...f, mode: 'dat_cho' })}>Đặt chỗ trả sau</button>
      </div>
      {f.mode === 'dat_cho' && (
        <div className="inline-form">
          <label className="check"><input type="checkbox" checked={f.keep} onChange={(e) => setF({ ...f, keep: e.target.checked })} /> Giữ đến giờ chạy (không tự nhả)</label>
          {f.keep && <label>Lý do<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="vd: khách quen" /></label>}
        </div>
      )}
      <div className="actions">
        {f.mode === 'chuyen_khoan' ? (
          <button className="btn primary" disabled={busy} onClick={() => void confirm(true)}>Tạo QR chuyển khoản</button>
        ) : (
          <>
            <button className="btn primary" disabled={busy} onClick={() => void confirm(true)}>{f.mode === 'thu_tien' ? 'Thu tiền + in vé' : 'Đặt chỗ + in phiếu'}</button>
            <button className="btn" disabled={busy} onClick={() => void confirm(false)}>{f.mode === 'thu_tien' ? 'Thu tiền, không in' : 'Đặt chỗ, không in'}</button>
          </>
        )}
        <button className="btn link" disabled={busy} onClick={() => void onCancelAll()}>Bỏ chọn ghế</button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ Danh sách khách (phơi khách) */

function PassengerList(props: { tickets: Ticket[]; stopName: (id: string | null) => string; bookingOf: (id: string) => Booking | undefined;
                                onOpen: (t: Ticket) => void; reload: () => Promise<void> }) {
  const { tickets, stopName, bookingOf, onOpen, reload } = props;
  const toast = useToast();
  const list = useMemo(() => [...tickets].sort((a, b) => a.seat_label.localeCompare(b.seat_label, 'vi', { numeric: true }) || a.from_idx - b.from_idx), [tickets]);
  const sum = (f: (t: Ticket) => boolean) => list.filter(f).reduce((a, t) => a + t.price, 0);
  return (
    <>
      <p className="small">{list.length} khách · đã lên xe {list.filter((t) => t.boarded).length} · đã thu {money(sum((t) => t.status === 'da_tt'))} ·
        chưa thu {money(sum((t) => t.status === 'dat'))}</p>
      <button className="btn small no-print" onClick={() => window.print()}>In danh sách</button>
      <table className="plist print-area">
        <thead><tr><th>Ghế</th><th>Khách</th><th>Đón → trả</th><th>Tiền</th><th>Lên xe</th></tr></thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id} className={t.boarded ? 'boarded' : ''}>
              <td><button className="btn small link" onClick={() => onOpen(t)}>{t.seat_label}</button></td>
              <td>{t.passenger_name ?? ''}<br /><a href={t.passenger_phone ? `tel:${t.passenger_phone}` : undefined}>{t.passenger_phone ?? ''}</a>
                <span className="muted small"> {bookingOf(t.booking_id)?.code}</span></td>
              <td>{stopName(t.from_stop_id)} → {stopName(t.to_stop_id)}{t.pickup_note ? <><br /><i className="small">{t.pickup_note}</i></> : null}</td>
              <td>{t.status === 'da_tt' ? (t.pay_method === 'chuyen_khoan' ? 'Đã thu (CK)' : 'Đã thu')
                : <b className="state-sap_het">{t.pay_method === 'chuyen_khoan' ? 'Chờ CK' : 'Chưa thu'}</b>}<br />{money(t.price)}</td>
              <td><input type="checkbox" aria-label={`Ghế ${t.seat_label} đã lên xe`} checked={t.boarded} onChange={async (e) => {
                try {
                  await rpc('set_boarded', { p_ticket_id: t.id, p_boarded: e.target.checked });
                  await reload();
                } catch (err) {
                  toast('error', errMsg(err));
                }
              }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/* ------------------------------------------------------------------ Chi tiết vé: thu tiền, gia hạn, chuyển ghế, sửa, in */

function TicketDetail(props: {
  ticket: Ticket; booking: Booking | undefined; siblings: Ticket[]; stopName: (id: string | null) => string; otherTrips: Trip[];
  bank: BankAccount | null; canOverride: boolean; changeFee: number;
  currentTrip: Trip; onClose: () => void; onPrint: (list: Ticket[], code: string) => void; reload: () => Promise<void>;
}) {
  const { ticket: t, booking, siblings, stopName, otherTrips, currentTrip, onClose, onPrint, reload, bank, canOverride, changeFee } = props;
  const [cancel, setCancel] = useState(false);
  const [feeMethod, setFeeMethod] = useState<'tien_mat' | 'chuyen_khoan'>('tien_mat');
  const [qr, setQr] = useState(false);
  const toast = useToast();
  const [info, setInfo] = useState({ name: t.passenger_name ?? '', phone: t.passenger_phone ?? '', pickup: t.pickup_note ?? '', dropoff: t.dropoff_note ?? '' });
  const [move, setMove] = useState<{ trip: string; seat: string } | null>(null);
  const [ext, setExt] = useState<{ keep: boolean; reason: string } | null>(null);
  const unpaid = siblings.filter((x) => x.status === 'dat');

  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast('ok', ok);
      await reload();
      onClose();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }

  return (
    <section className="card form ticket-detail">
      <div className="item-head">
        <h2>Vé {booking?.code} · ghế {t.seat_label}</h2>
        <button className="btn small link" onClick={onClose}>Đóng</button>
      </div>
      <p className="small">{stopName(t.from_stop_id)} → {stopName(t.to_stop_id)} · {money(t.price)} ·{' '}
        {t.status === 'da_tt' ? `Đã thanh toán${t.pay_method === 'chuyen_khoan' ? ' (chuyển khoản)' : ''}`
          : `${t.pay_method === 'chuyen_khoan' ? 'Chờ chuyển khoản' : 'Đặt chỗ chưa trả'}${t.hold_until ? `, giữ đến ${hhmm(t.hold_until)}` : ', giữ đến giờ chạy'}`}
        {t.keep_reason ? ` (${t.keep_reason})` : ''}</p>
      {unpaid.length > 0 && qr && bank && (
        <TransferQR bank={bank} amount={unpaid.reduce((a, x) => a + x.price, 0)} code={booking?.code ?? ''} holdUntil={t.hold_until} busy={false}
                    onConfirm={() => void run(() => rpc('pay_booking', { p_booking_id: t.booking_id, p_ticket_ids: null, p_method: 'chuyen_khoan' }),
                      `Đã nhận chuyển khoản ${money(unpaid.reduce((a, x) => a + x.price, 0))}`)} onLater={() => setQr(false)} />
      )}
      {unpaid.length > 0 && !qr && (
        <div className="actions">
          <button className="btn primary" onClick={() => void run(() => rpc('pay_booking', { p_booking_id: t.booking_id, p_ticket_ids: null, p_method: 'tien_mat' }),
            `Đã thu ${money(unpaid.reduce((a, x) => a + x.price, 0))}`)}>Thu tiền mặt {money(unpaid.reduce((a, x) => a + x.price, 0))}</button>
          {bank && <button className="btn" onClick={() => setQr(true)}>Chuyển khoản (QR)</button>}
          {!ext && <button className="btn small" onClick={() => setExt({ keep: false, reason: '' })}>Gia hạn giữ chỗ</button>}
        </div>
      )}
      {ext && (
        <div className="inline-form">
          <label className="check"><input type="checkbox" checked={ext.keep} onChange={(e) => setExt({ ...ext, keep: e.target.checked })} /> Giữ đến giờ chạy</label>
          <label>Lý do<input value={ext.reason} onChange={(e) => setExt({ ...ext, reason: e.target.value })} /></label>
          <button className="btn small primary" onClick={() => void run(() => rpc('extend_booking', { p_booking_id: t.booking_id, p_keep: ext.keep, p_minutes: 30, p_reason: ext.reason }),
            ext.keep ? 'Đã giữ chỗ đến giờ chạy' : 'Đã gia hạn thêm 30 phút')}>{ext.keep ? 'Giữ đến giờ chạy' : 'Gia hạn 30 phút'}</button>
        </div>
      )}
      <div className="grid2">
        <label>Tên khách<input value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} /></label>
        <label>SĐT<input inputMode="tel" value={info.phone} onChange={(e) => setInfo({ ...info, phone: e.target.value })} /></label>
        <label>Ghi chú điểm đón<input value={info.pickup} onChange={(e) => setInfo({ ...info, pickup: e.target.value })} /></label>
        <label>Ghi chú điểm trả<input value={info.dropoff} onChange={(e) => setInfo({ ...info, dropoff: e.target.value })} /></label>
      </div>
      <div className="actions">
        <button className="btn small" onClick={() => void run(() => rpc('update_ticket_info', { p_ticket_id: t.id, p_name: info.name, p_phone: info.phone,
          p_pickup_note: info.pickup, p_dropoff_note: info.dropoff }), 'Đã sửa thông tin khách')}>Lưu thông tin</button>
        <button className="btn small" onClick={() => onPrint(siblings, booking?.code ?? '')}>In vé</button>
        {!move && <button className="btn small" onClick={() => setMove({ trip: currentTrip.id, seat: '' })}>Chuyển ghế / chuyến</button>}
        {!cancel && <button className="btn small danger" onClick={() => setCancel(true)}>Hủy vé</button>}
      </div>
      {cancel && <CancelPanel siblings={siblings} current={t} canOverride={canOverride} bank={bank !== null}
                              onDone={async (msg) => { toast('ok', msg); await reload(); onClose(); }} onClose={() => setCancel(false)} />}
      {move && (
        <div className="inline-form">
          <label>Chuyến
            <select value={move.trip} onChange={(e) => setMove({ ...move, trip: e.target.value })}>
              {otherTrips.map((x) => <option key={x.id} value={x.id}>{hhmm(x.depart_at)}</option>)}
            </select>
          </label>
          <label>Ghế mới<input value={move.seat} onChange={(e) => setMove({ ...move, seat: e.target.value.toUpperCase() })} placeholder="vd A05" /></label>
          {move.trip !== currentTrip.id && t.status === 'da_tt' && changeFee > 0 && (
            <label>Thu phí đổi {money(changeFee)}
              <select value={feeMethod} onChange={(e) => setFeeMethod(e.target.value as 'tien_mat' | 'chuyen_khoan')}>
                <option value="tien_mat">Tiền mặt</option>
                <option value="chuyen_khoan">Chuyển khoản</option>
              </select>
            </label>
          )}
          <button className="btn small primary" disabled={!move.seat} onClick={() => void run(async () => {
            const fee = await rpc<number>('change_ticket', { p_ticket_id: t.id, p_trip_id: move.trip, p_seat: move.seat, p_fee_method: feeMethod });
            if (fee > 0) toast('ok', `Đã thu phí đổi ${money(fee)}`);
          }, `Đã chuyển sang ghế ${move.seat}`)}>Chuyển</button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ Hủy vé + hoàn tiền */

interface Quote { ticket_id: string; seat_label: string; status: string; price: number; hours_left: number; fee_pct: number; fee: number; refund: number }

function CancelPanel(props: { siblings: Ticket[]; current: Ticket; canOverride: boolean; bank: boolean;
                              onDone: (msg: string) => Promise<void>; onClose: () => void }) {
  const { siblings, current, canOverride, bank, onDone, onClose } = props;
  const toast = useToast();
  const active = siblings.filter((x) => x.status === 'dat' || x.status === 'da_tt');
  const [pick, setPick] = useState<string[]>([current.id]);
  const [quote, setQuote] = useState<Quote[]>([]);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'tien_mat' | 'chuyen_khoan'>('tien_mat');
  const [override, setOverride] = useState<{ fee: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pick.length) return setQuote([]);
    void rpc<Quote[]>('cancel_quote', { p_ticket_ids: pick }).then(setQuote).catch((e) => toast('error', errMsg(e)));
  }, [pick, toast]);

  const sum = (k: 'fee' | 'refund') => quote.reduce((a, q) => a + q[k], 0);
  const paid = quote.some((q) => q.status === 'da_tt');

  async function go() {
    setBusy(true);
    try {
      const r = await rpc<{ tickets: number; fee: number; refund: number }>('cancel_tickets', {
        p_ticket_ids: pick, p_reason: reason, p_refund_method: method,
        p_fee_override: override ? Number(override.fee || 0) : null, p_override_reason: override?.reason ?? null,
      });
      await onDone(`Đã hủy ${r.tickets} vé${r.refund ? ` · hoàn ${money(r.refund)}${method === 'chuyen_khoan' ? ' (chuyển khoản)' : ''}` : ''}${r.fee ? ` · phí ${money(r.fee)}` : ''}`);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sub form cancel-panel">
      <b>Hủy vé</b>
      {active.length > 1 && (
        <div className="chips">
          {active.map((x) => (
            <label key={x.id} className="check">
              <input type="checkbox" checked={pick.includes(x.id)}
                     onChange={(e) => setPick(e.target.checked ? [...pick, x.id] : pick.filter((p) => p !== x.id))} /> Ghế {x.seat_label}
            </label>
          ))}
        </div>
      )}
      <table className="plist">
        <thead><tr><th>Ghế</th><th>Giá</th><th>Phí hủy</th><th>Hoàn</th></tr></thead>
        <tbody>
          {quote.map((q) => (
            <tr key={q.ticket_id}>
              <td>{q.seat_label}</td>
              <td>{q.status === 'da_tt' ? money(q.price) : 'chưa thu'}</td>
              <td>{q.status === 'da_tt' ? `${q.fee_pct}% · ${money(q.fee)}` : '—'}</td>
              <td>{q.status === 'da_tt' ? money(q.refund) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {quote[0] && <p className="muted small">Còn {quote[0].hours_left} giờ đến giờ chạy. Mốc phí sửa ở Cấu hình → Hủy / đổi vé.</p>}
      <label>Lý do hủy<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {paid && (
        <label>Hoàn tiền bằng
          <select value={method} onChange={(e) => setMethod(e.target.value as 'tien_mat' | 'chuyen_khoan')}>
            <option value="tien_mat">Tiền mặt (tôi chi ra)</option>
            {bank && <option value="chuyen_khoan">Chuyển khoản cho khách</option>}
          </select>
        </label>
      )}
      {paid && canOverride && !override && <button type="button" className="btn small link" onClick={() => setOverride({ fee: '0', reason: '' })}>Sửa phí hủy (quản trị)</button>}
      {override && (
        <div className="inline-form">
          <label>Phí hủy mỗi vé (đồng)<input type="number" min={0} inputMode="numeric" value={override.fee} onChange={(e) => setOverride({ ...override, fee: e.target.value })} /></label>
          <label>Lý do sửa phí<input value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} /></label>
        </div>
      )}
      <p className="small">{paid && !override ? `Phí ${money(sum('fee'))} · hoàn khách ${money(sum('refund'))}` : ''}</p>
      <div className="actions">
        <button type="button" className="btn small danger" disabled={busy || !reason.trim() || !pick.length} onClick={() => void go()}>Xác nhận hủy</button>
        <button type="button" className="btn small link" onClick={onClose}>Thôi</button>
      </div>
    </div>
  );
}
