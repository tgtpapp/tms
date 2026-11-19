// Bán vé tại quầy: chọn chuyến → chọn chặng → bấm ghế (giữ ngay, chống bán trùng) → thông tin khách →
// thu tiền ngay hoặc đặt chỗ trả sau → in vé. Danh sách khách theo chuyến, tiền mặt đã thu hôm nay.
import { MiniCal } from '../components/MiniCal';
import { Modal } from '../components/Modal';
import { SeatIcon } from '../components/SeatIcon';
import { dirName } from '../lib/routes';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { fmtDate, today } from '../components/Documents';
import { TicketPrint, type TicketPrintData } from '../components/TicketPrint';
import { companyFileUrl } from '../lib/documents';
import { TransferQR, type BankAccount } from '../components/TransferQR';
import type { Permissions } from '../lib/permissions';
import { cacheGet, cacheSet, enqueue, isNetworkError, localCode, queueAll, removeQueued, retryQueued, syncQueue, useOnline, useQueue,
  type OfflineSale } from '../lib/offline';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { zaloKick } from '../lib/zalo';

type Dir = 'di' | 've';
type SeatStatus = 'giu' | 'dat' | 'da_tt' | 'cho_xep' | 'het_han' | 'huy';
interface Trip {
  id: string; route_id: string; direction: Dir; depart_at: string; arrive_at: string; status: 'mo' | 'huy';
  vehicle_id: string | null; vehicle_type_id: string | null; service_date: string;
  departed_at?: string | null; edit_unlocked_at?: string | null; manifest_printed_at?: string | null;
}
interface Route { id: string; name: string; name_ve: string | null }
interface RouteStop { route_id: string; seq: number; stop_id: string }
interface Stop { id: string; name: string }
interface VType { id: string; name: string; decks: number; layout_rows: number; layout_cols: number }
interface Seat { vehicle_type_id: string; label: string; deck: number; row_no: number; col_no: number; kind: 'ghe' | 'giuong' | 'tai_xe' | 'cua'; is_priority: boolean; is_sellable: boolean }
export interface Ticket {
  id: string; booking_id: string; trip_id: string; seat_label: string; from_stop_id: string; to_stop_id: string;
  from_idx: number; to_idx: number; price: number; status: SeatStatus; hold_until: string | null; keep_reason: string | null;
  passenger_name: string | null; passenger_phone: string | null; pickup_note: string | null; dropoff_note: string | null;
  boarded: boolean; created_by: string | null; paid_by: string | null; pay_method: 'tien_mat' | 'chuyen_khoan' | null;
  tc_don?: boolean; tc_tra?: boolean; printed_at?: string | null; print_count?: number;
}
interface Booking { id: string; code: string; customer_name: string | null; customer_phone: string | null; note: string | null }
interface Customer { phone: string; name: string | null; last_from_stop: string | null; last_to_stop: string | null; last_pickup_note: string | null; trips_count: number }

const TZ = 'Asia/Ho_Chi_Minh';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const money = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
const active = (t: Ticket) => (t.status === 'giu' || t.status === 'dat' || t.status === 'da_tt')
  && !(t.hold_until && t.status !== 'da_tt' && Date.parse(t.hold_until) < Date.now());
const TICKET_COLS = 'id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx, price, status, hold_until, keep_reason, passenger_name, passenger_phone, pickup_note, dropoff_note, boarded, created_by, paid_by, pay_method, tc_don, tc_tra, printed_at, print_count';
/** Đã thu tiền (kể cả vé chờ xếp ghế). */
const paid = (t: Ticket) => t.status === 'da_tt' || t.status === 'cho_xep';
interface Fare { from_stop_id: string; to_stop_id: string; price: number }
interface BaseData { trips: Trip[]; routes: Route[]; rstops: RouteStop[]; stops: Stop[]; types: VType[]; seats: Seat[]; plates: Record<string, string>; counts: Record<string, number> }
/** Vé đã bán trên máy, chưa gửi: hiện trên sơ đồ như vé đã thu tiền. */
const queuedTickets = (q: OfflineSale[], tripId: string, stopIds: string[]): Ticket[] => q.filter((x) => x.trip_id === tripId).flatMap((x) => x.seats.map((seat) => ({
  id: `q:${x.key}:${seat}`, booking_id: `q:${x.key}`, trip_id: x.trip_id, seat_label: seat, from_stop_id: x.from_stop, to_stop_id: x.to_stop,
  from_idx: stopIds.indexOf(x.from_stop), to_idx: stopIds.indexOf(x.to_stop), price: x.price, status: 'da_tt' as const, hold_until: null, keep_reason: null,
  passenger_name: x.name, passenger_phone: x.phone, pickup_note: null, dropoff_note: null, boarded: false, created_by: x.user_id, paid_by: x.user_id,
  pay_method: x.method,
})));
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
  const [rf, setRf] = useState(() => { try { return localStorage.getItem('ban_ve.tuyen') ?? ''; } catch { return ''; } });
  useEffect(() => { try { localStorage.setItem('ban_ve.tuyen', rf); } catch { /* bỏ qua */ } }, [rf]);
  const [footer, setFooter] = useState<string | null>(null);
  const [bank, setBank] = useState<BankAccount | null>(null);
  const [changeFee, setChangeFee] = useState(0);
  const [version, setVersion] = useState(0);
  const [logo, setLogo] = useState<string | null>(null);
  const online = useOnline();
  const queue = useQueue();
  const mine = queue.filter((x) => x.tenant_id === ctx.tenant_id && x.user_id === ctx.user_id);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
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

  const apply = useCallback((d: BaseData) => {
    setTrips(d.trips); setRoutes(d.routes); setRstops(d.rstops); setStops(d.stops);
    setTypes(d.types); setSeats(d.seats); setPlates(d.plates); setCounts(d.counts);
  }, []);

  const loadBase = useCallback(async () => {
    const cacheKey = `ban_ve:${ctx.tenant_id}:${day}`;
    const [t, r, rs, st, vt, se, v] = await Promise.all([
      supabase.from('trips').select('id, route_id, direction, depart_at, arrive_at, status, vehicle_id, vehicle_type_id, service_date, departed_at, edit_unlocked_at, manifest_printed_at')
        .eq('service_date', day).eq('status', 'mo').order('depart_at'),
      supabase.from('routes').select('id, name, name_ve'),
      supabase.from('route_stops').select('route_id, seq, stop_id').order('seq'),
      supabase.from('stops').select('id, name'),
      supabase.from('vehicle_types').select('id, name, decks, layout_rows, layout_cols'),
      supabase.from('vehicle_type_seats').select('vehicle_type_id, label, deck, row_no, col_no, kind, is_priority, is_sellable'),
      supabase.from('vehicles').select('id, plate'),
    ]);
    const err = t.error ?? r.error ?? rs.error ?? st.error ?? vt.error ?? se.error ?? v.error;
    if (err) {
      // Mất mạng: dùng bản sao đã lưu trên máy
      const c = isNetworkError(err.message) ? cacheGet<BaseData>(cacheKey) : null;
      if (c) {
        apply(c.value);
        setCachedAt(c.at);
        return;
      }
      return toast('error', isNetworkError(err.message) ? 'Mất mạng và máy chưa lưu dữ liệu ngày này' : err.message);
    }
    const list = (t.data ?? []) as Trip[];
    const m: Record<string, number> = {};
    if (list.length) {
      const c = await supabase.from('seat_inventory').select('trip_id, status, hold_until').in('trip_id', list.map((x) => x.id))
        .in('status', ['giu', 'dat', 'da_tt']);
      for (const x of (c.data ?? []) as Ticket[]) if (active(x)) m[x.trip_id] = (m[x.trip_id] ?? 0) + 1;
    }
    const d: BaseData = {
      trips: list, routes: (r.data ?? []) as Route[], rstops: (rs.data ?? []) as RouteStop[], stops: (st.data ?? []) as Stop[],
      types: (vt.data ?? []) as VType[], seats: (se.data ?? []) as Seat[],
      plates: Object.fromEntries(((v.data ?? []) as { id: string; plate: string }[]).map((x) => [x.id, x.plate])), counts: m,
    };
    apply(d);
    setCachedAt(null);
    cacheSet(cacheKey, d);
  }, [day, toast, apply, ctx.tenant_id]);

  // Có mạng lại: tự gửi vé đã bán trên máy
  const sync = useCallback(async () => {
    if (!ctx.tenant_id || !ctx.user_id || !navigator.onLine) return;
    if (!queueAll().some((x) => x.tenant_id === ctx.tenant_id && x.user_id === ctx.user_id && !x.error)) return;
    const r = await syncQueue(ctx.tenant_id, ctx.user_id);
    if (r.sent) { toast('ok', `Đã gửi ${r.sent} đơn vé bán khi mất mạng`); zaloKick(); }
    if (r.conflicts.length) toast('error', `Trùng ghế, cần xếp ghế khác: ${r.conflicts.join('; ')}`);
    if (r.errors) toast('error', `${r.errors} đơn vé gửi lỗi, xem mục "Vé chờ gửi"`);
    if (r.sent || r.errors) {
      setVersion((x) => x + 1);
      await loadBase();
    }
  }, [ctx.tenant_id, ctx.user_id, toast, loadBase]);

  const wasOffline = useRef(false);
  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      void loadBase();
    }
    void sync();
    const t = setInterval(() => void sync(), 30000);
    return () => clearInterval(t);
  }, [online, sync, loadBase]);

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
  const routeOpts = useMemo(() => {
    const keys = [...new Set(trips.map((t) => `${t.route_id}|${t.direction}`))];
    return keys.map((k) => { const [rid, d] = k.split('|'); return { key: k, label: dirName(routes.find((r) => r.id === rid), d as Dir) }; })
      .sort((x, y) => x.label.localeCompare(y.label, 'vi'));
  }, [trips, routes]);
  const rfOk = routeOpts.some((o) => o.key === rf) ? rf : '';
  const shownTrips = rfOk ? trips.filter((t) => `${t.route_id}|${t.direction}` === rfOk) : trips;

  return (
    <>
      {(!online || cachedAt) && (
        <p className="offline-bar">Mất mạng: đang bán trên máy (dữ liệu lúc {cachedAt ? new Date(cachedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'vừa rồi'}).
          Vé bán sẽ tự gửi lên khi có mạng.</p>
      )}
      {mine.length > 0 && <QueuePanel list={mine} online={online} onSync={() => void sync()} />}
      {online && <CashToday userId={ctx.user_id} version={version} />}
      <div className="sell-layout">
      <aside className="sell-left">
      <section className="card">
        <label>Tuyến
          <select value={rfOk} onChange={(e) => { setRf(e.target.value); setTripId(null); }}>
            <option value="">Tất cả tuyến</option>
            {routeOpts.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        <MiniCal day={day} onPick={(d) => { setDay(d); setTripId(null); }} />
        <div className="inline-form day-nav">
          <button className="btn small" aria-label="Ngày trước" onClick={() => { setDay(addDays(day, -1)); setTripId(null); }}>‹</button>
          <label>Ngày đi<input type="date" value={day} onChange={(e) => { if (e.target.value) { setDay(e.target.value); setTripId(null); } }} /></label>
          <button className="btn small" aria-label="Ngày sau" onClick={() => { setDay(addDays(day, 1)); setTripId(null); }}>›</button>
        </div>
      </section>
      <section className="card">
        <h2>Chuyến ngày {fmtDate(day)} ({shownTrips.length})</h2>
        {shownTrips.length === 0 && <p className="muted">Không có chuyến đang mở trong ngày.</p>}
        {(() => {
          const card = (t: Trip) => {
            const total = sellable(t.vehicle_type_id);
            const sold = counts[t.id] ?? 0;
            const name = dirName(routes.find((r) => r.id === t.route_id), t.direction);
            const past = new Date(t.depart_at).getTime() < Date.now();
            return (
              <button key={t.id} className={['trip-card', t.id === tripId && 'on', past && 'past', t.manifest_printed_at && 'phoi'].filter(Boolean).join(' ')}
                      aria-label={`Chuyến ${hhmm(t.depart_at)} ${name}`} onClick={() => setTripId(t.id)}>
                <span className="tc-top"><b>{hhmm(t.depart_at)}</b>{!rfOk && <span className="tc-route">{name}</span>}</span>
                <span className="tc-meta">
                  <span><i className={t.vehicle_id ? 'dot ok' : 'dot'} />{t.vehicle_id ? plates[t.vehicle_id] : 'Chưa xếp xe'}</span>
                  <span>{t.vehicle_type_id ? `${sold}|${total}` : '—'}</span>
                </span>
                {(t.departed_at || t.manifest_printed_at) && <span className="tc-badges">{t.departed_at && <span className="tc-badge">Đã xuất bến</span>}{t.manifest_printed_at && <span className="tc-badge phoi">Đã in phơi</span>}</span>}
                <span className="tc-bar"><span style={{ width: `${total ? Math.min(100, Math.round((sold / total) * 100)) : 0}%` }} /></span>
              </button>
            );
          };
          const nowMs = Date.now();
          const upcoming = shownTrips.filter((t) => new Date(t.depart_at).getTime() >= nowMs);
          const past = shownTrips.filter((t) => new Date(t.depart_at).getTime() < nowMs);
          return (
            <>
              <div className="trip-cards">{upcoming.map(card)}</div>
              {past.length > 0 && <h3 className="past-head">Đã qua giờ khởi hành</h3>}
              <div className="trip-cards">{past.map(card)}</div>
            </>
          );
        })()}
      </section>
      </aside>
      <div className="sell-right">
      {!trip && <section className="card"><p className="muted">Chọn chuyến bên trái để bán vé.</p></section>}
      {trip && (
        <TripSell key={trip.id} trip={trip} ctx={ctx} canSell={canSell} canOverride={perms.has('settings.manage')} changeFee={changeFee} routeName={dirName(routes.find((r) => r.id === trip.route_id), trip.direction)}
                  stopIds={orderedStops(trip.route_id, trip.direction)} stopName={stopName} type={types.find((x) => x.id === trip.vehicle_type_id) ?? null}
                  seats={seats.filter((s) => s.vehicle_type_id === trip.vehicle_type_id)} plate={trip.vehicle_id ? plates[trip.vehicle_id] : null}
                  otherTrips={trips.filter((x) => x.route_id === trip.route_id && x.direction === trip.direction)}
                  footer={footer} logo={logo} bank={bank} online={online && !cachedAt} queue={mine} onChanged={async () => { setVersion((v) => v + 1); await loadBase(); }}
                  sold={counts[trip.id] ?? 0} total={sellable(trip.vehicle_type_id)} day={day} />
      )}
      </div>
      </div>
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
  online: boolean; queue: OfflineSale[]; sold: number; total: number; day: string;
}

function TripSell(props: TripSellProps) {
  const { trip, ctx, canSell, stopIds, stopName, type, seats, onChanged, online, queue } = props;
  const toast = useToast();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [from, setFrom] = useState(stopIds[0] ?? '');
  const [to, setTo] = useState(stopIds[stopIds.length - 1] ?? '');
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [printing, setPrinting] = useState<TicketPrintData | null>(null);
  const [view, setView] = useState<'so_do' | 'khach'>('so_do');
  const [fares, setFares] = useState<Fare[]>([]);
  const [offSel, setOffSel] = useState<string[]>([]);   // ghế chọn khi mất mạng
  const [paper, setPaper] = useState(false);
  const [ckOpen, setCkOpen] = useState(false);
  const locked = !!trip.departed_at && !trip.edit_unlocked_at;
  const fromIdx = stopIds.indexOf(from);
  const toIdx = stopIds.indexOf(to);

  const cacheKey = `ban_ve:${ctx.tenant_id}:chuyen:${trip.id}`;
  const load = useCallback(async () => {
    await rpc('refresh_trip_seats', { p_trip_id: trip.id }).catch(() => undefined);
    const t = await supabase.from('seat_inventory').select(TICKET_COLS).eq('trip_id', trip.id).in('status', ['giu', 'dat', 'da_tt', 'cho_xep']);
    if (t.error) {
      const c = isNetworkError(t.error.message) ? cacheGet<{ tickets: Ticket[]; bookings: Booking[]; fares: Fare[] }>(cacheKey) : null;
      if (c) {
        setTickets(c.value.tickets);
        setBookings(c.value.bookings);
        setFares(c.value.fares);
      } else if (!isNetworkError(t.error.message)) toast('error', t.error.message);
      return;
    }
    const list = (t.data ?? []) as Ticket[];
    setTickets(list);
    const ids = [...new Set(list.map((x) => x.booking_id))];
    const b = ids.length ? await supabase.from('bookings').select('id, code, customer_name, customer_phone, note').in('id', ids) : null;
    const bl = (b?.data ?? []) as Booking[];
    setBookings(bl);
    const f = await rpc<Fare[]>('trip_fares', { p_trip_id: trip.id }).catch(() => null);
    if (f) setFares(f);
    cacheSet(cacheKey, { tickets: list, bookings: bl, fares: f ?? [] });
  }, [trip.id, toast, cacheKey]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);   // cập nhật ghế các quầy khác bán
    return () => clearInterval(t);
  }, [load]);

  const all = useMemo(() => [...tickets.filter((t) => !t.id.startsWith('q:')), ...queuedTickets(queue, trip.id, stopIds)], [tickets, queue, trip.id, stopIds]);
  const waiting = tickets.filter((t) => t.status === 'cho_xep');
  const fareOf = (a: string, b: string) => fares.find((x) => x.from_stop_id === a && x.to_stop_id === b)?.price ?? null;
  const myHolds = tickets.filter((t) => t.status === 'giu' && t.booking_id === bookingId && active(t));
  const onSeat = (label: string) => all.filter((t) => t.seat_label === label && active(t));
  const overlapping = (label: string) => onSeat(label).find((t) => t.from_idx < toIdx && fromIdx < t.to_idx);

  async function clickSeat(label: string) {
    if (!canSell) return;
    const hit = overlapping(label);
    if (!online) {
      // Mất mạng: chọn ghế trên máy (chưa giữ được trên hệ thống)
      if (offSel.includes(label)) return setOffSel(offSel.filter((x) => x !== label));
      if (hit) return toast('error', hit.id.startsWith('q:') ? `Ghế ${label}: vé chờ gửi` : `Ghế ${label} đã bán (theo dữ liệu lúc mất mạng)`);
      if (fromIdx < 0 || toIdx <= fromIdx) return toast('error', 'Chọn điểm đón trước điểm trả');
      return setOffSel([...offSel, label]);
    }
    if (hit?.id.startsWith('q:')) return toast('error', `Ghế ${label}: vé bán khi mất mạng, đang chờ gửi`);
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
    if (locked) return toast('error', 'Chuyến đã xuất bến: không bán thêm. Cần quản trị mở khóa');
    if (fromIdx < 0 || toIdx <= fromIdx) return toast('error', 'Chọn điểm đón trước điểm trả');
    try {
      const r = await rpc<{ booking_id: string }>('hold_seat', {
        p_trip_id: trip.id, p_seat: label, p_from_stop: from, p_to_stop: to, p_booking_id: bookingId, p_request_id: crypto.randomUUID(),
      });
      setBookingId(r.booking_id);
      setCkOpen(true);
    } catch (e) {
      toast('error', errMsg(e));
    }
    await load();
  }

  const bookingOf = (id: string) => bookings.find((b) => b.id === id);
  /** In vé + ghi nhận đã in để quầy khác biết */
  const printList = (list: Ticket[], code: string) => {
    setPrinting(ticketData(list, code));
    const ids = list.map((x) => x.id).filter((id) => !id.startsWith('q:'));
    if (ids.length) void rpc('mark_tickets_printed', { p_ids: ids }).then(() => load()).catch(() => undefined);
  };
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
        <div className="trip-head">
          <div>
            <h2>{hhmm(trip.depart_at)} · {fmtDate(props.day)} · {props.routeName}</h2>
            <div className="small muted">
              {stopIds.map((id) => stopName(id)).join(' → ')}
            </div>
            <div className="small">{type.name}{props.plate ? ` · ${props.plate}` : ' · chưa xếp xe'} · <b>{props.sold}</b>/{props.total} vé đã bán
              {trip.manifest_printed_at && <span className="badge phoi-badge">Đã in phơi {hhmm(trip.manifest_printed_at)}</span>}</div>
          </div>
          {trip.departed_at && (
            <div className="lock-box">
              <span className="stamp">ĐÃ XUẤT BẾN<small>Thực hiện: {hhmm(trip.departed_at)} {new Date(trip.departed_at).toLocaleDateString('vi-VN', { timeZone: TZ })}</small></span>
              {locked ? <span className="small muted">Khóa sửa vé</span> : <span className="small state-sap_het">Đang mở khóa sửa</span>}
              {props.canOverride && (
                <button className="btn small" onClick={() => void rpc('set_trip_edit_lock', { p_trip_id: trip.id, p_unlock: locked })
                  .then(async () => { toast('ok', locked ? 'Đã mở khóa sửa chuyến' : 'Đã khóa lại chuyến'); await onChanged(); })
                  .catch((e) => toast('error', errMsg(e)))}>{locked ? 'Mở khóa sửa' : 'Khóa lại'}</button>
              )}
            </div>
          )}
          <div className="chips">
            <button className={view === 'so_do' ? 'btn small primary' : 'btn small'} onClick={() => setView('so_do')}>Sơ đồ ghế</button>
            <button className={view === 'khach' ? 'btn small primary' : 'btn small'} onClick={() => setView('khach')}>Danh sách khách</button>
            {canSell && <button className={paper ? 'btn small primary' : 'btn small'} onClick={() => setPaper(!paper)}>Nhập vé giấy</button>}
          </div>
        </div>
        {view === 'so_do' ? (
          <>
            <div className="inline-form">
              <label>Đón tại
                <select value={from} onChange={(e) => setFrom(e.target.value)} disabled={myHolds.length + offSel.length > 0}>
                  {stopIds.slice(0, -1).map((id) => <option key={id} value={id}>{stopName(id)}</option>)}
                </select>
              </label>
              <label>Trả tại
                <select value={to} onChange={(e) => setTo(e.target.value)} disabled={myHolds.length + offSel.length > 0}>
                  {stopIds.slice(1).map((id) => <option key={id} value={id}>{stopName(id)}</option>)}
                </select>
              </label>
            </div>
            <SeatMap type={type} seats={seats} statusOf={(label) => {
              if (offSel.includes(label)) return { cls: 'mine' };
              const hit = overlapping(label);
              if (!hit) return { cls: 'free' };
              if (hit.id.startsWith('q:')) return { cls: 'cho_gui', t: hit };
              const mine = hit.status === 'giu' && hit.booking_id === bookingId;
              return { cls: mine ? 'mine' : hit.status === 'giu' ? 'held' : hit.boarded ? 'boarded' : hit.status, t: hit };
            }} onClick={(l) => void clickSeat(l)} />
            <p className="muted small legend">
              <span className="seat-dot free" /> trống <span className="seat-dot mine" /> đang chọn <span className="seat-dot held" /> quầy khác giữ
              <span className="seat-dot dat" /> đặt chưa trả <span className="seat-dot da_tt" /> đã thanh toán <span className="seat-dot boarded" /> đã lên xe
              {queue.some((x) => x.trip_id === trip.id) && <><span className="seat-dot cho_gui" /> chờ gửi</>}
            </p>
          </>
        ) : (
          <PassengerList tickets={all.filter((t) => t.status !== 'giu')} stopName={stopName} bookingOf={bookingOf}
                         onOpen={(t) => setSelected(t)} reload={load}
                         onPrinted={() => void rpc('mark_manifest_printed', { p_trip_id: trip.id }).then(() => onChanged()).catch((e) => toast('error', errMsg(e)))} />
        )}
      </section>
      {waiting.length > 0 && (
        <section className="card waiting">
          <h2>Vé chờ xếp ghế ({waiting.length})</h2>
          <p className="muted small">Vé bán khi mất mạng hoặc vé giấy bị trùng ghế. Khách đã trả tiền: bấm vào vé để chuyển sang ghế trống, hoặc hủy / hoàn.</p>
          <div className="chips">
            {waiting.map((t) => (
              <button key={t.id} className="btn small" onClick={() => setSelected(t)}>
                Ghế {t.seat_label} · {t.passenger_name ?? t.passenger_phone ?? 'khách'} · {bookingOf(t.booking_id)?.code}
              </button>
            ))}
          </div>
        </section>
      )}
      {paper && ctx.tenant_id && ctx.user_id && (
        <PaperForm tenantId={ctx.tenant_id} userId={ctx.user_id} trip={trip} tripLabel={`${hhmm(trip.depart_at)} ${props.routeName}`} stopIds={stopIds}
                   stopName={stopName} seats={seats.filter((x) => x.is_sellable).map((x) => x.label)} fareOf={fareOf} bank={props.bank !== null}
                   online={online} onDone={async () => { await load(); await onChanged(); }} />
      )}
      {offSel.length > 0 && ctx.tenant_id && ctx.user_id && (
        <OfflineCheckout tenantId={ctx.tenant_id} userId={ctx.user_id} trip={trip} tripLabel={`${hhmm(trip.depart_at)} ${props.routeName}`}
                         seats={offSel} from={from} to={to} stopName={stopName} price={fareOf(from, to)} bank={props.bank !== null}
                         onCancel={() => setOffSel([])}
                         onDone={(code, list) => { setOffSel([]); if (list.length) setPrinting(ticketData(list, code)); }} />
      )}
      {myHolds.length > 0 && bookingId && !ckOpen && (
        <div className="pick-bar">
          <span><b>{myHolds.length}</b> vé đã chọn · ghế {myHolds.map((h) => h.seat_label).join(', ')}</span>
          <button className="btn small primary" onClick={() => setCkOpen(true)}>Tiếp tục</button>
        </div>
      )}
      {myHolds.length > 0 && bookingId && ckOpen && (
        <Modal wide title={`${hhmm(trip.depart_at)} · ${fmtDate(props.day)} · ${props.routeName}`} onClose={() => setCkOpen(false)}>
        <Tabs tabs={['Thông tin chung']} />
        <Checkout trip={trip} holds={myHolds} bookingId={bookingId} stopName={stopName} from={from} to={to} bank={props.bank}
                  onDone={async (code, printed) => {
                    setBookingId(null);
                    await load();
                    await onChanged();
                    if (printed) printList(printed, code);
                  }} onCancelAll={async () => {
                    for (const h of myHolds) await rpc('unhold_seat', { p_ticket_id: h.id }).catch(() => undefined);
                    setBookingId(null);
                    await load();
                  }} onMore={() => setCkOpen(false)} />
        </Modal>
      )}
      {selected && !selected.id.startsWith('q:') && (
        <Modal wide title={`${hhmm(trip.depart_at)} · ${fmtDate(props.day)} · ${props.routeName}`} onClose={() => setSelected(null)}>
        <TicketTabs bookingId={selected.booking_id} stopName={stopName}>
        <TicketDetail ticket={selected} booking={bookingOf(selected.booking_id)} stopName={stopName} otherTrips={props.otherTrips} bank={props.bank}
                      canOverride={props.canOverride} changeFee={props.changeFee}
                      currentTrip={trip} onClose={() => setSelected(null)}
                      onPrint={(list, code) => printList(list, code)}
                      siblings={tickets.filter((t) => t.booking_id === selected.booking_id && t.status !== 'giu')}
                      reload={async () => { await load(); await onChanged(); }} />
        </TicketTabs>
        </Modal>
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
              if (s.kind === 'tai_xe' || s.kind === 'cua') return <div key={idx} className={`sseat ${s.kind}`} title={s.kind === 'tai_xe' ? 'Tài xế' : 'Cửa lên xuống'}><SeatIcon kind={s.kind} size={20} />{s.kind === 'tai_xe' ? 'Tài xế' : 'Cửa'}</div>;
              if (!s.is_sellable) return <div key={idx} className="sseat off">{s.label}</div>;
              const st = statusOf(s.label);
              const who = st.t && st.t.status !== 'giu' ? (st.t.passenger_name ?? st.t.passenger_phone ?? '') : '';
              return (
                <button key={idx} type="button" className={`sseat ${st.cls}${s.is_priority ? ' prio' : ''}`}
                        aria-label={`Ghế ${s.label}${st.cls === 'free' ? ' trống' : ''}`} onClick={() => onClick(s.label)}>
                  <b>{s.label}{st.t?.printed_at && <span className="printed" title={`Đã in vé ${st.t.print_count ?? 1} lần`} aria-label="Đã in vé"><PrinterIcon /></span>}</b>
                  {st.t && st.t.status !== 'giu' ? (
                    <>
                      {st.t.passenger_name && <span className="sp-name">{st.t.passenger_name}</span>}
                      {st.t.passenger_phone && <span className="sp-phone">{st.t.passenger_phone}</span>}
                      {st.t.pickup_note && <span className="sp-note">Đón: {st.t.pickup_note}</span>}
                      {!st.t.passenger_name && !st.t.passenger_phone && who && <span>{who.slice(0, 14)}</span>}
                    </>
                  ) : who && <span>{who.slice(0, 14)}</span>}
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
  onDone: (code: string, printList: Ticket[] | null) => Promise<void>; onCancelAll: () => Promise<void>; onMore: () => void;
}) {
  const { holds, bookingId, stopName, onDone, onCancelAll, bank, onMore } = props;
  const toast = useToast();
  const [f, setF] = useState({ phone: '', name: '', pickup: '', dropoff: '', note: '', mode: 'thu_tien' as 'thu_tien' | 'dat_cho' | 'chuyen_khoan', keep: false, reason: '', tcDon: false, tcTra: false });
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
      if (f.tcDon || f.tcTra) {
        for (const h of holds) await rpc('set_ticket_transfer', { p_ticket_id: h.id, p_don: f.tcDon, p_tra: f.tcTra });
      }
      const { data } = await supabase.from('seat_inventory').select(TICKET_COLS).eq('booking_id', bookingId).in('status', ['dat', 'da_tt']);
      const list = (data ?? []) as Ticket[];
      if (f.mode === 'chuyen_khoan') {
        // Hiện QR, chờ nhân viên xác nhận tiền đã về
        setTransfer({ code: r.code, total: list.reduce((a, t) => a + t.price, 0), holdUntil: list[0]?.hold_until ?? null });
        return;
      }
      toast('ok', f.mode === 'thu_tien' ? `Đã bán vé ${r.code} · thu ${money(total)}` : `Đã đặt chỗ ${r.code}`);
      zaloKick();
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
      zaloKick();
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
      <section className="form checkout">
        <h2>Chuyển khoản vé {transfer.code}</h2>
        <TransferQR bank={bank} amount={transfer.total} code={transfer.code} holdUntil={transfer.holdUntil} busy={busy}
                    onConfirm={() => void received()} onLater={() => { toast('ok', `Vé ${transfer.code} đang chờ chuyển khoản`); void onDone(transfer.code, null); }} />
      </section>
    );
  }

  return (
    <section className="form checkout">
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
      <div className="chips">
        <label className="check"><input type="checkbox" checked={f.tcDon} onChange={(e) => setF({ ...f, tcDon: e.target.checked })} /> Đón tận nơi (trung chuyển, địa chỉ ở ghi chú điểm đón)</label>
        <label className="check"><input type="checkbox" checked={f.tcTra} onChange={(e) => setF({ ...f, tcTra: e.target.checked })} /> Trả tận nơi (địa chỉ ở ghi chú điểm trả)</label>
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
        <button className="btn" disabled={busy} onClick={onMore}>+ Chọn thêm ghế</button>
        <button className="btn link" disabled={busy} onClick={() => void onCancelAll()}>Bỏ chọn ghế</button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ Danh sách khách (phơi khách) */

function PassengerList(props: { tickets: Ticket[]; stopName: (id: string | null) => string; bookingOf: (id: string) => Booking | undefined;
                                onOpen: (t: Ticket) => void; reload: () => Promise<void>; onPrinted: () => void }) {
  const { tickets, stopName, bookingOf, onOpen, reload, onPrinted } = props;
  const toast = useToast();
  const list = useMemo(() => [...tickets].sort((a, b) => a.seat_label.localeCompare(b.seat_label, 'vi', { numeric: true }) || a.from_idx - b.from_idx), [tickets]);
  const sum = (f: (t: Ticket) => boolean) => list.filter(f).reduce((a, t) => a + t.price, 0);
  return (
    <>
      <p className="small">{list.length} khách · đã lên xe {list.filter((t) => t.boarded).length} · đã thu {money(sum(paid))} ·
        chưa thu {money(sum((t) => t.status === 'dat'))}</p>
      <button className="btn small no-print" onClick={() => { window.print(); onPrinted(); }}>In phơi</button>
      <table className="plist print-area">
        <thead><tr><th>Ghế</th><th>Khách</th><th>Đón → trả</th><th>Tiền</th><th>Lên xe</th></tr></thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id} className={t.boarded ? 'boarded' : ''}>
              <td><button className="btn small link" onClick={() => onOpen(t)}>{t.seat_label}</button></td>
              <td>{t.passenger_name ?? ''}<br /><a href={t.passenger_phone ? `tel:${t.passenger_phone}` : undefined}>{t.passenger_phone ?? ''}</a>
                <span className="muted small"> {bookingOf(t.booking_id)?.code}</span></td>
              <td>{stopName(t.from_stop_id)} → {stopName(t.to_stop_id)}{t.pickup_note ? <><br /><i className="small">{t.pickup_note}</i></> : null}</td>
              <td>{t.id.startsWith('q:') ? <b className="state-sap_het">Chờ gửi</b> : t.status === 'cho_xep' ? <b className="state-het_han">Chờ xếp ghế</b>
                : paid(t) ? (t.pay_method === 'chuyen_khoan' ? 'Đã thu (CK)' : 'Đã thu')
                : <b className="state-sap_het">{t.pay_method === 'chuyen_khoan' ? 'Chờ CK' : 'Chưa thu'}</b>}<br />{money(t.price)}</td>
              <td><input type="checkbox" aria-label={`Ghế ${t.seat_label} đã lên xe`} checked={t.boarded} disabled={t.id.startsWith('q:')} onChange={async (e) => {
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
    <section className="form ticket-detail">
      <div className="item-head">
        <h2>Vé {booking?.code} · ghế {t.seat_label}</h2>
        <button className="btn small link" onClick={onClose}>Đóng</button>
      </div>
      <p className="small">{stopName(t.from_stop_id)} → {stopName(t.to_stop_id)} · {money(t.price)} ·{' '}
        {t.status === 'cho_xep' ? 'Đã thu tiền · CHỜ XẾP GHẾ (trùng ghế khi mất mạng): chọn "Chuyển ghế / chuyến"'
          : t.status === 'da_tt' ? `Đã thanh toán${t.pay_method === 'chuyen_khoan' ? ' (chuyển khoản)' : ''}`
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
        {t.status !== 'cho_xep' && (['don', 'tra'] as const).map((k) => {
          const on = k === 'don' ? !!t.tc_don : !!t.tc_tra;
          return (
            <label key={k} className="check small">
              <input type="checkbox" checked={on} onChange={(e) => void run(() => rpc('set_ticket_transfer', {
                p_ticket_id: t.id, p_don: k === 'don' ? e.target.checked : !!t.tc_don, p_tra: k === 'tra' ? e.target.checked : !!t.tc_tra,
              }), e.target.checked ? `Đã đánh dấu ${k === 'don' ? 'đón' : 'trả'} tận nơi` : 'Đã bỏ trung chuyển')} />
              {k === 'don' ? 'Đón tận nơi' : 'Trả tận nơi'}
            </label>
          );
        })}
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
  const active = siblings.filter((x) => x.status === 'dat' || paid(x));
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
  const anyPaid = quote.some((q) => q.status !== 'dat');

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
              <td>{q.status !== 'dat' ? money(q.price) : 'chưa thu'}</td>
              <td>{q.status !== 'dat' ? `${q.fee_pct}% · ${money(q.fee)}` : '—'}</td>
              <td>{q.status !== 'dat' ? money(q.refund) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {quote[0] && <p className="muted small">Còn {quote[0].hours_left} giờ đến giờ chạy. Mốc phí sửa ở Cấu hình → Hủy / đổi vé.</p>}
      <label>Lý do hủy<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {anyPaid && (
        <label>Hoàn tiền bằng
          <select value={method} onChange={(e) => setMethod(e.target.value as 'tien_mat' | 'chuyen_khoan')}>
            <option value="tien_mat">Tiền mặt (tôi chi ra)</option>
            {bank && <option value="chuyen_khoan">Chuyển khoản cho khách</option>}
          </select>
        </label>
      )}
      {anyPaid && canOverride && !override && <button type="button" className="btn small link" onClick={() => setOverride({ fee: '0', reason: '' })}>Sửa phí hủy (quản trị)</button>}
      {override && (
        <div className="inline-form">
          <label>Phí hủy mỗi vé (đồng)<input type="number" min={0} inputMode="numeric" value={override.fee} onChange={(e) => setOverride({ ...override, fee: e.target.value })} /></label>
          <label>Lý do sửa phí<input value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} /></label>
        </div>
      )}
      <p className="small">{anyPaid && !override ? `Phí ${money(sum('fee'))} · hoàn khách ${money(sum('refund'))}` : ''}</p>
      <div className="actions">
        <button type="button" className="btn small danger" disabled={busy || !reason.trim() || !pick.length} onClick={() => void go()}>Xác nhận hủy</button>
        <button type="button" className="btn small link" onClick={onClose}>Thôi</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Mất mạng: hàng đợi, bán trên máy, nhập vé giấy */

function QueuePanel({ list, online, onSync }: { list: OfflineSale[]; online: boolean; onSync: () => void }) {
  const [drop, setDrop] = useState<string | null>(null);
  const failed = list.filter((x) => x.error);
  return (
    <section className="card queue">
      <div className="item-head">
        <h2>Vé chờ gửi ({list.length})</h2>
        {online && <button className="btn small" onClick={onSync}>Gửi ngay</button>}
      </div>
      <p className="muted small">Vé đã thu tiền, lưu trên máy này. Không xóa dữ liệu trình duyệt khi còn vé chờ gửi.</p>
      <ul className="queue-list">
        {list.map((x) => (
          <li key={x.key}>
            {x.paper_no ? `Vé giấy ${x.paper_no}` : `Vé ${x.local_code}`} · {x.trip_label} · ghế {x.seats.join(', ')} · {money(x.price * x.seats.length)}
            {x.error && (
              <>
                <br /><span className="error-text small">{x.error}</span>{' '}
                <button className="btn small link" onClick={() => { retryQueued(x.key); onSync(); }}>Gửi lại</button>
                {drop === x.key
                  ? <button className="btn small danger" onClick={() => removeQueued(x.key)}>Chắc chắn bỏ</button>
                  : <button className="btn small link" onClick={() => setDrop(x.key)}>Bỏ vé này</button>}
              </>
            )}
          </li>
        ))}
      </ul>
      {failed.length > 0 && <p className="small">Vé lỗi: kiểm tra lại (vd số vé giấy đã nhập), sửa thì bỏ vé lỗi và nhập lại.</p>}
    </section>
  );
}

function OfflineCheckout(props: {
  tenantId: string; userId: string; trip: Trip; tripLabel: string; seats: string[]; from: string; to: string;
  stopName: (id: string | null) => string; price: number | null; bank: boolean;
  onCancel: () => void; onDone: (code: string, list: Ticket[]) => void;
}) {
  const { seats, from, to, stopName, trip } = props;
  const toast = useToast();
  const [f, setF] = useState({ phone: '', name: '', price: props.price === null ? '' : String(props.price), method: 'tien_mat' as 'tien_mat' | 'chuyen_khoan' });
  const price = Number(f.price);

  function sell(print: boolean) {
    if (!Number.isInteger(price) || price < 0 || f.price === '') return toast('error', 'Nhập giá vé');
    const phone = f.phone.replace(/\D/g, '');
    if (phone && !/^0\d{9}$/.test(phone)) return toast('error', 'Số điện thoại phải gồm 10 số, bắt đầu bằng 0');
    const sale: OfflineSale = {
      key: crypto.randomUUID(), tenant_id: props.tenantId, user_id: props.userId, local_code: localCode(), paper_no: null,
      trip_id: trip.id, trip_label: props.tripLabel, seats, from_stop: from, to_stop: to, price,
      phone: phone || null, name: f.name.trim() || null, method: f.method, sold_at: new Date().toISOString(),
    };
    try {
      enqueue(sale);
    } catch {
      return toast('error', 'Máy không lưu được vé (bộ nhớ trình duyệt đầy). Bán vé giấy.');
    }
    toast('ok', `Đã bán vé ${sale.local_code} (chờ gửi) · thu ${money(price * seats.length)}`);
    props.onDone(sale.local_code, print ? queuedTickets([sale], trip.id, [from, to]) : []);
  }

  return (
    <section className="form checkout">
      <h2>Bán khi mất mạng · {seats.length} ghế</h2>
      <p className="small">Ghế {seats.join(', ')} · {stopName(from)} → {stopName(to)}. Vé lưu trên máy, có mạng sẽ tự gửi.
        Nếu quầy khác đã bán trùng ghế, vé vẫn giữ và vào mục "Vé chờ xếp ghế".</p>
      <div className="grid2">
        <label>Giá mỗi ghế (đồng)<input type="number" inputMode="numeric" min={0} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
        <label>Số điện thoại khách<input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        <label>Tên khách<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Thu bằng
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as 'tien_mat' | 'chuyen_khoan' })}>
            <option value="tien_mat">Tiền mặt</option>
            {props.bank && <option value="chuyen_khoan">Chuyển khoản (đã thấy tiền về)</option>}
          </select>
        </label>
      </div>
      <div className="actions">
        <button className="btn primary" onClick={() => sell(true)}>Thu tiền + in vé</button>
        <button className="btn" onClick={() => sell(false)}>Thu tiền, không in</button>
        <button className="btn link" onClick={props.onCancel}>Bỏ chọn ghế</button>
      </div>
    </section>
  );
}

function PaperForm(props: {
  tenantId: string; userId: string; trip: Trip; tripLabel: string; stopIds: string[]; stopName: (id: string | null) => string; seats: string[];
  fareOf: (a: string, b: string) => number | null; bank: boolean; online: boolean; onDone: () => Promise<void>;
}) {
  const { stopIds, stopName, fareOf } = props;
  const toast = useToast();
  const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const blank = () => ({ no: '', seat: '', from: stopIds[0] ?? '', to: stopIds[stopIds.length - 1] ?? '', price: '', name: '', phone: '',
                         method: 'tien_mat' as 'tien_mat' | 'chuyen_khoan', at: nowLocal() });
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const fare = fareOf(f.from, f.to);

  async function save(e: FormEvent) {
    e.preventDefault();
    const no = f.no.trim().toUpperCase();
    if (!/^[A-Z0-9/.-]{1,20}$/.test(no)) return toast('error', 'Số vé giấy: 1–20 ký tự chữ, số');
    if (!f.seat) return toast('error', 'Chọn ghế');
    if (stopIds.indexOf(f.to) <= stopIds.indexOf(f.from)) return toast('error', 'Điểm đón phải trước điểm trả');
    const price = Number(f.price === '' ? fare : f.price);
    if (!Number.isInteger(price) || price < 0) return toast('error', 'Nhập giá ghi trên vé');
    const phone = f.phone.replace(/\D/g, '');
    if (phone && !/^0\d{9}$/.test(phone)) return toast('error', 'Số điện thoại phải gồm 10 số, bắt đầu bằng 0');
    if (queueAll().some((x) => x.tenant_id === props.tenantId && x.paper_no === no)) return toast('error', `Vé giấy số ${no} đã có trong vé chờ gửi`);
    const at = new Date(f.at);
    if (Number.isNaN(at.getTime())) return toast('error', 'Nhập giờ bán');
    const key = crypto.randomUUID();
    enqueue({
      key, tenant_id: props.tenantId, user_id: props.userId, local_code: no, paper_no: no, trip_id: props.trip.id, trip_label: props.tripLabel,
      seats: [f.seat], from_stop: f.from, to_stop: f.to, price, phone: phone || null, name: f.name.trim() || null, method: f.method,
      sold_at: at.toISOString(),
    });
    if (!props.online) {
      toast('ok', `Đã lưu vé giấy ${no}, có mạng sẽ tự gửi`);
      setF({ ...blank(), from: f.from, to: f.to });
      return;
    }
    setBusy(true);
    try {
      const r = await syncQueue(props.tenantId, props.userId);
      const left = queueAll().find((x) => x.key === key);
      if (left?.error) {
        removeQueued(key);   // lỗi nhập liệu (vd trùng số vé giấy): sửa rồi lưu lại
        return toast('error', left.error);
      }
      if (left) {
        toast('ok', `Đã lưu vé giấy ${no}, đang gửi`);
        setF({ ...blank(), from: f.from, to: f.to });
        return;
      }
      toast(r.conflicts.length ? 'error' : 'ok', r.conflicts.length ? `Đã nhập vé giấy ${no} nhưng trùng ghế: ${r.conflicts.join('; ')} – xem "Vé chờ xếp ghế"`
        : `Đã nhập vé giấy ${no}`);
      setF({ ...blank(), from: f.from, to: f.to });
      await props.onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form paper" onSubmit={(e) => void save(e)}>
      <h2>Nhập vé giấy · {props.tripLabel}</h2>
      <p className="muted small">Vé viết tay khi mất mạng. Mỗi số vé giấy chỉ nhập được một lần. Trùng ghế với vé đã bán thì vé vẫn được lưu, chờ xếp ghế.</p>
      <div className="grid2">
        <label>Số vé giấy<input value={f.no} onChange={(e) => setF({ ...f, no: e.target.value.toUpperCase() })} placeholder="vd 0012345" required /></label>
        <label>Ghế
          <select aria-label="Ghế vé giấy" value={f.seat} onChange={(e) => setF({ ...f, seat: e.target.value })} required>
            <option value="">Chọn ghế</option>
            {props.seats.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label>Đón tại
          <select value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })}>
            {stopIds.slice(0, -1).map((id) => <option key={id} value={id}>{stopName(id)}</option>)}
          </select>
        </label>
        <label>Trả tại
          <select value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}>
            {stopIds.slice(1).map((id) => <option key={id} value={id}>{stopName(id)}</option>)}
          </select>
        </label>
        <label>Giá ghi trên vé (đồng)
          <input type="number" inputMode="numeric" min={0} value={f.price} placeholder={fare === null ? '' : String(fare)}
                 onChange={(e) => setF({ ...f, price: e.target.value })} />
        </label>
        <label>Giờ bán<input type="datetime-local" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} required /></label>
        <label>Tên khách<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Số điện thoại khách<input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        <label>Đã thu bằng
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as 'tien_mat' | 'chuyen_khoan' })}>
            <option value="tien_mat">Tiền mặt</option>
            {props.bank && <option value="chuyen_khoan">Chuyển khoản</option>}
          </select>
        </label>
      </div>
      <button className="btn primary" disabled={busy}>Lưu vé giấy</button>
    </form>
  );
}

/* ------------------------------------------------------------------ Thẻ trong cửa sổ vé */

function Tabs({ tabs, cur, onPick }: { tabs: string[]; cur?: number; onPick?: (i: number) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t, i) => (
        <button key={t} type="button" role="tab" aria-selected={(cur ?? 0) === i} className={(cur ?? 0) === i ? 'tab on' : 'tab'}
                onClick={() => onPick?.(i)}>{t}</button>
      ))}
    </div>
  );
}

function TicketTabs({ bookingId, stopName, children }: { bookingId: string; stopName: (id: string | null) => string; children: ReactNode }) {
  const [tab, setTab] = useState(0);
  return (
    <>
      <Tabs tabs={['Thông tin chung', 'Lịch sử']} cur={tab} onPick={setTab} />
      {tab === 0 ? children : <TicketHistory bookingId={bookingId} stopName={stopName} />}
    </>
  );
}

interface HistEvent { at: string; actor: string | null; entity: string; action: string; old?: Record<string, unknown> | null; new?: Record<string, unknown> | null;
  amount?: number; method?: string | null; note?: string | null }
const ST: Record<string, string> = { giu: 'Đang giữ', dat: 'Đặt chỗ', da_tt: 'Đã thanh toán', huy: 'Đã hủy', het_han: 'Hết hạn giữ', cho_xep: 'Chờ xếp ghế' };
const FIELDS: Record<string, string> = {
  status: 'Trạng thái', seat_label: 'Ghế', passenger_name: 'Tên khách', passenger_phone: 'SĐT', pickup_note: 'Đón', dropoff_note: 'Trả',
  price: 'Giá vé', boarded: 'Lên xe', tc_don: 'Đón tận nơi', tc_tra: 'Trả tận nơi', customer_name: 'Tên khách', customer_phone: 'SĐT', note: 'Ghi chú',
  keep_reason: 'Lý do giữ', trip_id: 'Chuyến',
};
const KIND_TIEN: Record<string, string> = { ban_ve: 'Thu tiền vé', dao: 'Bút toán đảo', hoan: 'Hoàn tiền', phi_huy: 'Phí hủy', phi_doi: 'Phí đổi vé' };

function show(k: string, v: unknown, stopName: (id: string | null) => string): string {
  if (v === null || v === undefined || v === '') return '(trống)';
  if (k === 'status') return ST[String(v)] ?? String(v);
  if (k === 'price') return money(Number(v));
  if (typeof v === 'boolean') return v ? 'có' : 'không';
  if (k.endsWith('_stop_id')) return stopName(String(v));
  return String(v);
}

function TicketHistory({ bookingId, stopName }: { bookingId: string; stopName: (id: string | null) => string }) {
  const [list, setList] = useState<HistEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    rpc<HistEvent[]>('ticket_history', { p_booking_id: bookingId }).then(setList).catch((e) => setErr(errMsg(e)));
  }, [bookingId]);
  if (err) return <p className="state-het_han">{err}</p>;
  if (!list) return <p className="muted">Đang tải lịch sử…</p>;
  if (list.length === 0) return <p className="muted">Chưa có lịch sử.</p>;
  const rows = list.map((e) => {
    let text = '';
    if (e.entity === 'tien') {
      const amt = Number(e.amount ?? 0);
      const how = (e.method ?? '').includes('ngan_hang') ? 'chuyển khoản' : 'tiền mặt';
      text = `${KIND_TIEN[e.action] ?? e.action}: ${amt >= 0 ? 'thu' : 'chi'} ${money(Math.abs(amt))} (${how})${e.note ? ` · ${e.note}` : ''}`;
    } else if (e.action === 'insert') {
      text = e.entity === 'bookings' ? `Tạo đơn vé ${String(e.new?.code ?? '')}` : `Thêm ghế ${String(e.new?.seat_label ?? '')}`;
    } else if (e.action === 'delete') {
      text = `Xóa ${e.entity === 'bookings' ? 'đơn vé' : `ghế ${String(e.old?.seat_label ?? '')}`}`;
    } else {
      const o = e.old ?? {}, n = e.new ?? {};
      const diff = Object.keys(FIELDS).filter((k) => JSON.stringify(o[k] ?? null) !== JSON.stringify(n[k] ?? null))
        .map((k) => `${FIELDS[k]}: ${show(k, o[k], stopName)} → ${show(k, n[k], stopName)}`);
      if (diff.length === 0) return null;
      text = `${e.entity === 'seat_inventory' ? `Ghế ${String(n.seat_label ?? o.seat_label ?? '')}` : 'Đơn vé'} · ${diff.join('; ')}`;
    }
    return { at: e.at, actor: e.actor, text };
  }).filter((x): x is { at: string; actor: string | null; text: string } => x !== null);
  return (
    <ol className="hist">
      {rows.map((r, i) => (
        <li key={i}>
          <span className="muted small">{new Date(r.at).toLocaleString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false })}
            {r.actor ? ` · ${r.actor}` : ''}</span>
          <div>{r.text}</div>
        </li>
      ))}
    </ol>
  );
}

function PrinterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M6 14h12v7H6z" />
    </svg>
  );
}
