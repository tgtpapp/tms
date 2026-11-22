// Bán vé tại quầy: chọn chuyến → chọn chặng → bấm ghế (giữ ngay, chống bán trùng) → thông tin khách →
// thu tiền ngay hoặc đặt chỗ trả sau → in vé. Danh sách khách theo chuyến, tiền mặt đã thu hôm nay.
import { OrderIssue } from '../components/OrderIssue';
import { MiniCal } from '../components/MiniCal';
import { Modal } from '../components/Modal';
import { dirName } from '../lib/routes';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { fmtDate, today } from '../components/Documents';
import { TicketPrint, TicketSlip, type TicketPrintData } from '../components/TicketPrint';
import { companyFileUrl } from '../lib/documents';
import { TransferQR, type BankAccount } from '../components/TransferQR';
import type { Permissions } from '../lib/permissions';
import { cacheGet, cacheSet, enqueue, isNetworkError, localCode, queueAll, removeQueued, retryQueued, syncQueue, useOnline, useQueue,
  type OfflineSale } from '../lib/offline';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { zaloKick } from '../lib/zalo';
import { loadUi } from '../lib/theme';

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
  /** Lái xe báo về: đã gọi / nghe máy / thuê bao / khách báo hủy; vắng; đã trả khách */
  crew_call?: 'da_goi' | 'nghe_may' | 'thue_bao' | 'bao_huy' | null; no_show?: boolean; dropped?: boolean;
  /** Tiền khách đã cọc (vé đặt chỗ trả trước một phần) */
  deposit?: number;
}
/** Trạng thái lái xe báo về quầy (hiện trên sơ đồ ghế, danh sách khách) */
export function crewNote(t: Ticket): { cls: string; text: string } | null {
  if (t.no_show) return { cls: 'vang', text: 'LX: khách vắng' };
  if (t.crew_call === 'bao_huy') return { cls: 'bao_huy', text: 'LX: khách báo hủy' };
  if (t.dropped) return { cls: 'tra', text: 'LX: đã trả khách' };
  if (t.boarded) return null;
  if (t.crew_call === 'thue_bao') return { cls: 'thue_bao', text: 'LX: thuê bao / không nghe' };
  if (t.crew_call === 'nghe_may') return { cls: 'nghe_may', text: 'LX: đã gọi, khách sẽ ra' };
  if (t.crew_call === 'da_goi') return { cls: 'da_goi', text: 'LX: đã gọi' };
  return null;
}
interface Booking { id: string; code: string; customer_name: string | null; customer_phone: string | null; note: string | null }
interface Customer { phone: string; name: string | null; last_from_stop: string | null; last_to_stop: string | null; last_pickup_note: string | null; trips_count: number }

const TZ = 'Asia/Ho_Chi_Minh';
/** Tên mặc định khi không điền tên khách */
const KHACH_LE = 'Khách Lẻ';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const money = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
const active = (t: Ticket) => (t.status === 'giu' || t.status === 'dat' || t.status === 'da_tt')
  && !(t.hold_until && t.status !== 'da_tt' && Date.parse(t.hold_until) < Date.now());
const TICKET_COLS = 'id, booking_id, trip_id, seat_label, from_stop_id, to_stop_id, from_idx, to_idx, price, status, hold_until, keep_reason, passenger_name, passenger_phone, pickup_note, dropoff_note, boarded, created_by, paid_by, pay_method, tc_don, tc_tra, printed_at, print_count, crew_call, no_show, dropped, deposit';
/** Đã thu tiền (kể cả vé chờ xếp ghế). */
const paid = (t: Ticket) => t.status === 'da_tt' || t.status === 'cho_xep';
interface Fare { from_stop_id: string; to_stop_id: string; price: number; listed?: boolean }
interface BaseData { trips: Trip[]; routes: Route[]; rstops: RouteStop[]; stops: Stop[]; types: VType[]; seats: Seat[]; plates: Record<string, string>; counts: Record<string, number> }
/** Vé đã bán trên máy, chưa gửi: hiện trên sơ đồ như vé đã thu tiền. */
const queuedTickets = (q: OfflineSale[], tripId: string, stopIds: string[]): Ticket[] => q.filter((x) => x.trip_id === tripId).flatMap((x) => x.seats.map((seat) => ({
  id: `q:${x.key}:${seat}`, booking_id: `q:${x.key}`, trip_id: x.trip_id, seat_label: seat, from_stop_id: x.from_stop, to_stop_id: x.to_stop,
  from_idx: stopIds.indexOf(x.from_stop), to_idx: stopIds.indexOf(x.to_stop), price: x.price, status: 'da_tt' as const, hold_until: null, keep_reason: null,
  passenger_name: x.name, passenger_phone: x.phone, pickup_note: null, dropoff_note: null, boarded: false, created_by: x.user_id, paid_by: x.user_id,
  pay_method: x.method,
})));


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
      supabase.from('routes').select('id, name, name_ve, is_active'),
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
    // Mọi tuyến đang chạy (cả 2 chiều), kể cả ngày chưa có chuyến; cộng thêm tuyến có chuyến trong ngày
    const keys = [...new Set([...routes.filter((r) => (r as { is_active?: boolean }).is_active !== false).flatMap((r) => [`${r.id}|di`, `${r.id}|ve`]),
      ...trips.map((t) => `${t.route_id}|${t.direction}`)])];
    // Theo từng cặp tuyến: chiều đi rồi chiều về (Biên Hòa - Vũng Tàu, Vũng Tàu - Biên Hòa, Hố Nai - Vũng Tàu, Vũng Tàu - Hố Nai…)
    return keys.map((k) => { const [rid, d] = k.split('|'); const r = routes.find((x) => x.id === rid); return { key: k, label: dirName(r, d as Dir), pair: r?.name ?? '', d }; })
      .sort((x, y) => x.pair.localeCompare(y.pair, 'vi') || (x.d === 'di' ? 0 : 1) - (y.d === 'di' ? 0 : 1));
  }, [trips, routes]);
  const rfOk = routeOpts.some((o) => o.key === rf) ? rf : '';
  const shownTrips = rfOk ? trips.filter((t) => `${t.route_id}|${t.direction}` === rfOk) : trips;

  const canTrip = perms.has('trip.manage');
  const rightRef = useRef<HTMLDivElement>(null);
  /** Bấm chuyến là nhảy ngay tới sơ đồ ghế (điện thoại: cột phải nằm dưới) */
  const pickTrip = (id: string) => {
    setTripId(id);
    setTimeout(() => rightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  /** Chọn tuyến: tự mở chuyến sắp chạy gần nhất của tuyến đó */
  const pickRoute = (key: string) => {
    setRf(key);
    const l = trips.filter((t) => !key || `${t.route_id}|${t.direction}` === key);
    const next = l.find((t) => new Date(t.depart_at).getTime() >= Date.now()) ?? l[l.length - 1];
    if (key && next) pickTrip(next.id); else setTripId(null);
  };
  const [calOpen, setCalOpen] = useState(true);
  const [extra, setExtra] = useState<{ key: string; time: string; note: string } | null>(null);
  const [finding, setFinding] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [dead, setDead] = useState<Hit | null>(null);
  async function addExtra() {
    if (!extra) return;
    const [rid, d] = extra.key.split('|');
    if (!rid || !extra.time) return toast('error', 'Chọn tuyến và giờ chạy');
    try {
      await rpc('add_extra_trip', { p_route_id: rid, p_direction: d, p_date: day, p_time: extra.time, p_note: extra.note || null });
      toast('ok', `Đã thêm chuyến tăng cường ${extra.time}`);
      setExtra(null);
      await loadBase();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }
  const tail = (p: string) => p.split('-').pop() ?? p;   // 60F-004.41 → 004.41 như Vexere
  const card = (t: Trip) => {
    const total = sellable(t.vehicle_type_id);
    const sold = counts[t.id] ?? 0;
    const name = dirName(routes.find((r) => r.id === t.route_id), t.direction);
    const past = new Date(t.depart_at).getTime() < Date.now();
    return (
      <button key={t.id} className={['vx-trip', t.id === tripId && 'on', past && 'past', t.manifest_printed_at && 'phoi', t.departed_at && 'xb'].filter(Boolean).join(' ')}
              aria-label={`Chuyến ${hhmm(t.depart_at)} ${name}`} title={[name, t.departed_at && 'Đã xuất bến', t.manifest_printed_at && 'Đã in phơi'].filter(Boolean).join(' · ')}
              onClick={() => pickTrip(t.id)}>
        <b className="vx-time">{hhmm(t.depart_at)}</b>
        {!rfOk && <span className="vx-rname">{name}</span>}
        <span className="vx-meta"><span><i className={t.vehicle_id ? 'dot ok' : 'dot'} />{t.vehicle_id ? tail(plates[t.vehicle_id] ?? '') : '—'}</span><span>{t.vehicle_type_id ? `${sold}|${total}` : ''}</span></span>
        <span className="vx-bar"><span style={{ width: `${total ? Math.min(100, Math.round((sold / total) * 100)) : 0}%` }} /></span>
      </button>
    );
  };
  const nowMs = Date.now();
  const upcoming = shownTrips.filter((t) => new Date(t.depart_at).getTime() >= nowMs);
  const pastTrips = shownTrips.filter((t) => new Date(t.depart_at).getTime() < nowMs);

  return (
    <>
      {(!online || cachedAt) && (
        <p className="offline-bar">Mất mạng: đang bán trên máy (dữ liệu lúc {cachedAt ? new Date(cachedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'vừa rồi'}).
          Vé bán sẽ tự gửi lên khi có mạng.</p>
      )}
      {mine.length > 0 && <QueuePanel list={mine} online={online} onSync={() => void sync()} />}
      <button type="button" className="dv-sbar" onClick={() => setFinding(true)}><i className="fi fi-rr-search" aria-hidden="true" /><span>Tìm vé theo số điện thoại, tên khách, mã vé…</span></button>
      {finding && (
        <TicketSearch routes={routes} stopName={stopName} onClose={() => setFinding(false)}
                      onPick={(x) => {
                        setFinding(false);
                        if (x.status === 'huy' || x.status === 'het_han') { setDead(x); return; }
                        setDay(x.service_date); setRf(`${x.route_id}|${x.direction}`); setTripId(x.trip_id); setFocus(x.id);
                      }} />
      )}
      {dead && <CancelledTicket t={dead} admin={perms.has('sell.cancelled')} stopName={stopName} routeName={dirName(routes.find((r) => r.id === dead.route_id), dead.direction)}
                                onClose={() => setDead(null)} />}
      <div className="vx">
        <aside className="vx-left">
          <select className="vx-route" aria-label="Tuyến" value={rfOk} onChange={(e) => pickRoute(e.target.value)}>
            <option value="">Tất cả tuyến</option>
            {routeOpts.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          <div className="vx-cal">
            {calOpen ? <MiniCal day={day} onPick={(d) => { setDay(d); setTripId(null); }} /> : <p className="vx-calday">{fmtDate(day)}</p>}
            <button type="button" className="vx-fold" aria-label={calOpen ? 'Thu gọn lịch' : 'Mở lịch'} onClick={() => setCalOpen(!calOpen)}>{calOpen ? '︿' : '﹀'}</button>
          </div>
          {canTrip && <div className="vx-extra"><button type="button" className="btn small" onClick={() => setExtra({ key: rfOk || routeOpts[0]?.key || '', time: '', note: '' })}>+ Tăng cường chuyến</button></div>}
          {shownTrips.length === 0 && <p className="muted small">{rfOk ? 'Tuyến này chưa có chuyến trong ngày.' : 'Không có chuyến đang mở trong ngày.'}{canTrip ? ' Bấm + Tăng cường chuyến để thêm.' : ''}</p>}
          <div className="vx-trips">{upcoming.map(card)}</div>
          {pastTrips.length > 0 && <><h4 className="past-head">Đã qua giờ khởi hành</h4><div className="vx-trips">{pastTrips.map(card)}</div></>}
        </aside>
        <div className="vx-right" ref={rightRef}>
          {!trip && <section className="card"><p className="muted">Chọn chuyến bên trái để bán vé.</p>{online && <CashToday userId={ctx.user_id} version={version} />}</section>}
          {trip && (
            <TripSell key={trip.id} trip={trip} ctx={ctx} canSell={canSell} canOrder={perms.has('order.add') || perms.has('trip.edit')} canOverride={perms.has('settings.manage')} changeFee={changeFee} routeName={dirName(routes.find((r) => r.id === trip.route_id), trip.direction)}
                      stopIds={orderedStops(trip.route_id, trip.direction)} stopName={stopName} type={types.find((x) => x.id === trip.vehicle_type_id) ?? null}
                      seats={seats.filter((s) => s.vehicle_type_id === trip.vehicle_type_id)} plate={trip.vehicle_id ? plates[trip.vehicle_id] : null}
                      otherTrips={trips.filter((x) => x.route_id === trip.route_id && x.direction === trip.direction)}
                      footer={footer} logo={logo} bank={bank} online={online && !cachedAt} queue={mine} onChanged={async () => { setVersion((v) => v + 1); await loadBase(); }}
                      sold={counts[trip.id] ?? 0} total={sellable(trip.vehicle_type_id)} day={day}
                      cash={online ? <CashToday userId={ctx.user_id} version={version} /> : null} focus={focus} onFocused={() => setFocus(null)} />
          )}
        </div>
      </div>
      {extra && (
        <Modal title="Tăng cường chuyến" onClose={() => setExtra(null)}>
          <div className="form">
            <label>Tuyến<select value={extra.key} onChange={(e) => setExtra({ ...extra, key: e.target.value })}>
              {routes.flatMap((r) => (['di', 've'] as Dir[]).map((d) => <option key={`${r.id}|${d}`} value={`${r.id}|${d}`}>{dirName(r, d)}</option>))}</select></label>
            <label>Ngày<input value={fmtDate(day)} disabled /></label>
            <label>Giờ chạy<input type="time" value={extra.time} onChange={(e) => setExtra({ ...extra, time: e.target.value })} /></label>
            <label>Ghi chú<input value={extra.note} onChange={(e) => setExtra({ ...extra, note: e.target.value })} /></label>
            <div className="actions"><button className="btn primary" onClick={() => void addExtra()}>Thêm chuyến</button><button className="btn link" onClick={() => setExtra(null)}>Thôi</button></div>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ Tìm vé theo số điện thoại (như app cũ) */

interface Hit {
  id: string; trip_id: string; seat_label: string; status: SeatStatus; price: number; passenger_name: string | null; passenger_phone: string | null;
  from_stop_id: string; to_stop_id: string; created_at: string; service_date: string; route_id: string; direction: Dir; depart_at: string; code: string | null;
  cancel_reason: string | null; pickup_note: string | null; dropoff_note: string | null;
}

function TicketSearch({ routes, stopName, onClose, onPick }: { routes: Route[]; stopName: (id: string | null) => string; onClose: () => void; onPick: (x: Hit) => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState<'dat' | 'chay'>('dat');
  const [lim, setLim] = useState(100);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const raw = q.trim();
  const dg = raw.replace(/\D/g, '').replace(/^84/, '0');
  const isNum = /^[\d\s+.\-()]+$/.test(raw);
  const short = !!raw && (isNum ? dg.length < 3 : raw.length < 2);

  useEffect(() => {
    if (short) { setHits(null); return; }
    let on = true;
    const t = setTimeout(() => void (async () => {
      const cols = 'id, trip_id, seat_label, status, price, passenger_name, passenger_phone, from_stop_id, to_stop_id, created_at, cancel_reason, pickup_note, dropoff_note, trips!inner(service_date, route_id, direction, depart_at), bookings(code)';
      let qb = supabase.from('seat_inventory').select(cols).neq('status', 'giu');
      const code = raw.toUpperCase().replace(/\s/g, '');
      if (raw && isNum) qb = qb.ilike('passenger_phone', `%${dg}%`);
      else if (raw) {
        const b = await supabase.from('bookings').select('id').eq('code', code).limit(20);
        const ids = ((b.data ?? []) as { id: string }[]).map((x) => x.id);
        const nm = raw.replace(/[%,()]/g, ' ');
        qb = qb.or([`passenger_name.ilike.%${nm}%`, ...(ids.length ? [`booking_id.in.(${ids.join(',')})`] : [])].join(','));
      }
      qb = sortBy === 'dat' ? qb.order('created_at', { ascending: false }) : qb.order('trips(depart_at)', { ascending: false });
      const { data, error } = await qb.limit(lim + 1);
      if (!on) return;
      if (error) { toast('error', error.message); return; }
      type Row = Omit<Hit, 'service_date' | 'route_id' | 'direction' | 'depart_at' | 'code'> & { trips: { service_date: string; route_id: string; direction: Dir; depart_at: string }; bookings: { code: string } | null };
      const l = ((data ?? []) as unknown as Row[]).map(({ trips, bookings, ...x }) => ({ ...x, ...trips, code: bookings?.code ?? null }));
      if (sortBy === 'chay') l.sort((a, b) => b.depart_at.localeCompare(a.depart_at));
      setHits(l);
    })(), 250);
    return () => { on = false; clearTimeout(t); };
  }, [raw, dg, isNum, short, sortBy, lim, toast]);

  const shown = (hits ?? []).slice(0, lim);
  const act = shown.filter((x) => x.status !== 'huy' && x.status !== 'het_han');
  const rName = (x: Hit) => dirName(routes.find((r) => r.id === x.route_id), x.direction);
  const when = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false });
  return (
    <Modal title="Tìm vé theo số điện thoại" onClose={onClose}>
      <input className="qs-in" type="search" inputMode="tel" autoFocus autoComplete="off" value={q} onChange={(e) => { setQ(e.target.value); setLim(100); }}
             placeholder="Số điện thoại, tên khách hoặc mã vé (để trống = tất cả vé)" />
      <div className="qsort">
        <button type="button" className={sortBy === 'dat' ? 'on' : ''} onClick={() => setSortBy('dat')}>Theo giờ đặt</button>
        <button type="button" className={sortBy === 'chay' ? 'on' : ''} onClick={() => setSortBy('chay')}>Theo giờ chạy</button>
      </div>
      <p className="muted small qs-sum">
        {short ? 'Nhập ít nhất 3 số điện thoại hoặc 2 chữ của tên (hoặc để trống để xem tất cả).'
          : hits === null ? 'Đang tìm…'
          : shown.length ? <>Tìm thấy <b>{shown.length}{hits.length > lim ? '+' : ''}</b> vé · {new Set(shown.map((x) => x.trip_id)).size} chuyến · tổng {money(act.reduce((a, x) => a + x.price, 0))} (không tính vé hủy)</>
          : 'Không tìm thấy vé nào.'}
      </p>
      <div className="qs-list">
        {shown.map((x) => (
          <button type="button" key={x.id} className={`qh${x.status === 'huy' || x.status === 'het_han' ? ' x' : ''}`} onClick={() => onPick(x)}>
            <div className="qh-t"><b>{fmtDate(x.service_date)} · {hhmm(x.depart_at)}</b><span>{rName(x)}</span></div>
            <div className="qh-m">{x.code ? <>Mã <b>{x.code}</b> · </> : null}Ghế <b>{x.seat_label}</b> · {x.passenger_name || KHACH_LE} · {x.passenger_phone ?? ''}</div>
            <div className="qh-m muted">Đặt lúc: {when(x.created_at)}</div>
            <div className="qh-m">{stopName(x.from_stop_id)} → {stopName(x.to_stop_id)} · {money(x.price)}{' '}
              {x.status === 'huy' || x.status === 'het_han' ? <em className="qh-b r">Đã hủy</em> : x.status === 'da_tt' ? <em className="qh-b g">Đã thu</em> : <em className="qh-b">Chưa thu</em>}</div>
          </button>
        ))}
        {hits && hits.length > lim && <button type="button" className="btn small" onClick={() => setLim(lim + 100)}>Xem thêm</button>}
      </div>
    </Modal>
  );
}

/** Vé đã hủy (mở từ Tìm vé): quản trị sửa thông tin khách hoặc xóa hẳn; người khác chỉ xem */
function CancelledTicket({ t, admin, stopName, routeName, onClose }: { t: Hit; admin: boolean; stopName: (id: string | null) => string; routeName: string; onClose: () => void }) {
  const toast = useToast();
  const [info, setInfo] = useState({ name: t.passenger_name ?? '', phone: t.passenger_phone ?? '', pickup: t.pickup_note ?? '', dropoff: t.dropoff_note ?? '' });
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); toast('ok', ok); onClose(); } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={`${hhmm(t.depart_at)} · ${fmtDate(t.service_date)} · ${routeName}`} onClose={onClose}>
      <section className="form">
        <h2>Vé {t.code ?? ''} · ghế {t.seat_label} · <span className="state-het_han">Đã hủy</span></h2>
        <p className="small">{stopName(t.from_stop_id)} → {stopName(t.to_stop_id)} · {money(t.price)}{t.cancel_reason ? ` · Lý do hủy: ${t.cancel_reason}` : ''}</p>
        <div className="grid2">
          <label>Tên khách<input value={info.name} disabled={!admin} onChange={(e) => setInfo({ ...info, name: e.target.value })} /></label>
          <label>SĐT<input inputMode="tel" value={info.phone} disabled={!admin} onChange={(e) => setInfo({ ...info, phone: e.target.value })} /></label>
          <label>Ghi chú điểm đón<input value={info.pickup} disabled={!admin} onChange={(e) => setInfo({ ...info, pickup: e.target.value.toUpperCase() })} /></label>
          <label>Ghi chú điểm trả<input value={info.dropoff} disabled={!admin} onChange={(e) => setInfo({ ...info, dropoff: e.target.value.toUpperCase() })} /></label>
        </div>
        {admin && (
          <div className="actions">
            <button type="button" className="btn small" disabled={busy} onClick={() => void run(() => rpc('update_ticket_info', {
              p_ticket_id: t.id, p_name: info.name.trim() || KHACH_LE, p_phone: info.phone, p_pickup_note: info.pickup, p_dropoff_note: info.dropoff }), 'Đã sửa thông tin khách')}>Lưu thông tin</button>
            {ask
              ? <span className="inline-form"><span className="small">Xóa hẳn vé đã hủy này?</span>
                  <button type="button" className="btn small danger" disabled={busy} onClick={() => void run(() => rpc('delete_cancelled_ticket', { p_ticket_id: t.id }), 'Đã xóa vé đã hủy')}>Xóa hẳn</button>
                  <button type="button" className="btn small link" onClick={() => setAsk(false)}>Thôi</button></span>
              : <button type="button" className="btn small danger" onClick={() => setAsk(true)}>Xóa vé</button>}
          </div>
        )}
      </section>
    </Modal>
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
  trip: Trip; ctx: AccountContext; canSell: boolean; canOrder: boolean; canOverride: boolean; changeFee: number; routeName: string; stopIds: string[]; stopName: (id: string | null) => string;
  type: VType | null; seats: Seat[]; plate: string | null; otherTrips: Trip[]; footer: string | null; logo: string | null; bank: BankAccount | null; onChanged: () => Promise<void>;
  online: boolean; queue: OfflineSale[]; sold: number; total: number; day: string; cash: ReactNode;
  focus: string | null; onFocused: () => void;
}

function TripSell(props: TripSellProps) {
  const { trip, ctx, canSell, stopIds, stopName, type, seats, onChanged, online, queue } = props;
  const toast = useToast();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [from, setFrom] = useState(stopIds[0] ?? '');
  const [to, setTo] = useState(stopIds[stopIds.length - 1] ?? '');
  const [bookingId, setBookingIdState] = useState<string | null>(null);
  const bookingRef = useRef<string | null>(null);
  const setBookingId = (b: string | null) => { bookingRef.current = b; setBookingIdState(b); };
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [printing, setPrinting] = useState<TicketPrintData | null>(null);
  const [view, setView] = useState<'so_do' | 'khach' | 'don_tra' | 'tc' | 'tk'>('so_do');
  const [fold, setFold] = useState(false);
  const [showStops, setShowStops] = useState(false);
  const [phoi, setPhoi] = useState(false);
  const [order, setOrder] = useState(false);
  const [crew, setCrew] = useState<{ role: string; name: string; phone: string | null; staff_id: string }[]>([]);
  const [crewVer, setCrewVer] = useState(0);
  const [quick, setQuick] = useState(false);
  const [fares, setFares] = useState<Fare[]>([]);
  const [offSel, setOffSel] = useState<string[]>([]);   // ghế chọn khi mất mạng
  const [paper, setPaper] = useState(false);
  const [ckOpen, setCkOpen] = useState(false);
  const locked = !!trip.departed_at && !trip.edit_unlocked_at;
  const fromIdx = stopIds.indexOf(from);
  const toIdx = stopIds.indexOf(to);

  // Hoạt cảnh đón khách (Giao diện của tôi): khách vừa được báo đã lên xe / lái xe vừa ghi kết quả gọi khách trên chuyến đang xem
  const seen = useRef<Map<string, { b: boolean; c: string | null }> | null>(null);
  useEffect(() => { seen.current = null; }, [trip.id]);
  useEffect(() => {
    const prev = seen.current;
    seen.current = new Map(tickets.map((x) => [x.id, { b: x.boarded, c: x.crew_call ?? null }]));
    if (!prev || !loadUi().anim) return;
    const nm = (x: Ticket) => `Ghế ${x.seat_label}${x.passenger_name ? ` · ${x.passenger_name}` : ''}`;
    const up = tickets.filter((x) => x.boarded && prev.has(x.id) && !prev.get(x.id)!.b);
    const hm = new Date(trip.depart_at).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false });
    if (up.length) { void import('../lib/hoatCanh').then((h) => h.playScene({ cap: `${hm} · ${up.length > 1 ? `${up.length} khách` : nm(up[0]!)} đã lên xe` })); return; }
    const cg = tickets.find((x) => x.crew_call && x.crew_call !== 'bao_huy' && prev.has(x.id) && prev.get(x.id)!.c !== x.crew_call);
    if (cg) {
      const kq = cg.crew_call === 'thue_bao' ? 'tb' : 'ok';
      void import('../lib/hoatCanh').then((h) => h.playScene({ mode: 'call', kq, cap: `${hm} · ${nm(cg)} · ${crewNote(cg)?.text ?? 'LX đã gọi'}` }));
    }
  }, [tickets, trip.depart_at]);

  const cacheKey = `ban_ve:${ctx.tenant_id}:chuyen:${trip.id}`;
  // Mở vé vừa tìm được (Tìm vé theo số điện thoại)
  useEffect(() => {
    if (!props.focus) return;
    const t = tickets.find((x) => x.id === props.focus);
    if (t) { setSelected(t); props.onFocused(); }
  }, [tickets, props]);
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
    // Ghế tôi đang giữ nhưng nằm ở đơn khác (tải lại trang, đổi chuyến rồi quay lại…): gom về 1 đơn để bán tiếp / bỏ chọn được
    const mineHeld = list.filter((x) => x.status === 'giu' && x.created_by === ctx.user_id);
    const cur = bookingRef.current;
    if (mineHeld.length && (!cur || mineHeld.some((x) => x.booking_id !== cur))) {
      const b2 = await rpc<string | null>('merge_my_holds', { p_trip_id: trip.id }).catch(() => null);
      if (b2) {
        bookingRef.current = b2;
        setBookingIdState(b2);
        if (mineHeld.some((x) => x.booking_id !== b2)) {
          const again = await supabase.from('seat_inventory').select(TICKET_COLS).eq('trip_id', trip.id).in('status', ['giu', 'dat', 'da_tt', 'cho_xep']);
          if (!again.error) setTickets((again.data ?? []) as Ticket[]);
        }
      }
    }
  }, [trip.id, toast, cacheKey, ctx.user_id]);

  useEffect(() => {
    void (async () => {
      const c = await supabase.from('trip_crew').select('role, staff_id').eq('trip_id', trip.id).eq('active', true);
      const rows = (c.data ?? []) as { role: string; staff_id: string }[];
      if (!rows.length) return setCrew([]);
      const st = await supabase.from('staff_members').select('id, full_name, phone').in('id', rows.map((x) => x.staff_id));
      const sm = (st.data ?? []) as { id: string; full_name: string; phone: string | null }[];
      setCrew(rows.map((x) => ({ role: x.role, staff_id: x.staff_id, name: sm.find((y) => y.id === x.staff_id)?.full_name ?? '', phone: sm.find((y) => y.id === x.staff_id)?.phone ?? null })));
    })();
  }, [trip.id, crewVer]);
  // In phơi dạng sơ đồ ghế, vừa 1 trang A4; in xong ghi nhận đã in phơi
  useEffect(() => {
    if (!phoi || view !== 'so_do') return;
    const t = setTimeout(() => { window.print(); setPhoi(false); void rpc('mark_manifest_printed', { p_trip_id: trip.id }).then(() => onChanged()).catch((e) => toast('error', errMsg(e))); }, 300);
    return () => clearTimeout(t);
  }, [phoi, view, trip.id, onChanged, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);   // cập nhật ghế các quầy khác bán
    return () => clearInterval(t);
  }, [load]);

  /** Tiền cọc của cả đơn (cọc tính theo đơn, không theo từng ghế) */
  const bookingDep = (bid: string) => tickets.reduce((a, x) => a + (x.booking_id === bid && x.status === 'dat' ? x.deposit ?? 0 : 0), 0);
  const bookingDue = (bid: string) => tickets.reduce((a, x) => a + (x.booking_id === bid && x.status === 'dat' ? x.price : 0), 0) - bookingDep(bid);
  const all = useMemo(() => [...tickets.filter((t) => !t.id.startsWith('q:')), ...queuedTickets(queue, trip.id, stopIds)], [tickets, queue, trip.id, stopIds]);
  const waiting = tickets.filter((t) => t.status === 'cho_xep');
  const fareOf = (a: string, b: string) => fares.find((x) => x.from_stop_id === a && x.to_stop_id === b)?.price ?? null;
  // Chặng hiện trong ô chọn: toàn tuyến + chặng có trong Bảng giá vé, theo chiều chạy của chuyến (toàn tuyến đứng đầu)
  const segs = fares.filter((x) => x.listed !== false && stopIds.indexOf(x.from_stop_id) < stopIds.indexOf(x.to_stop_id))
    .sort((x, y) => stopIds.indexOf(x.from_stop_id) - stopIds.indexOf(y.from_stop_id) || stopIds.indexOf(y.to_stop_id) - stopIds.indexOf(x.to_stop_id));
  const me = ctx.user_id;
  const isMine = (t: Ticket) => t.status === 'giu' && t.created_by === me;
  const myHolds = tickets.filter((t) => isMine(t) && t.booking_id === bookingId && active(t));
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
      if (isMine(hit)) {
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
    deposit: (() => {
      const dat = list.filter((t) => t.status === 'dat'), paidDep = dat.reduce((a, t) => a + (t.deposit ?? 0), 0);
      return paidDep > 0 ? { paid: paidDep, due: dat.reduce((a, t) => a + t.price, 0) - paidDep, n: dat.length } : null;
    })(),
  });

  if (!type) {
    return <section className="card"><p className="muted">Chuyến chưa có sơ đồ ghế. Vào mục Điều hành chọn loại xe cho nốt hoặc chuyến.</p></section>;
  }

  return (
    <>
      {printing && <TicketPrint data={printing} onClose={() => setPrinting(null)} />}
      {quick && <QuickAssign tripId={trip.id} vehicleId={trip.vehicle_id ?? null} crew={crew} onClose={() => setQuick(false)}
                             onSaved={async () => { setQuick(false); setCrewVer((v) => v + 1); await onChanged(); }} />}
      {order && <OrderIssue tripId={trip.id} tenantId={ctx.tenant_id ?? ''} me={{ id: ctx.user_id, name: ctx.full_name ?? '' }} onClose={() => setOrder(false)} />}
      <div className="vx-tool">
        <button className="btn small" onClick={() => { setView('so_do'); setPhoi(true); }}><PrinterIcon /> In Phơi</button>
        {props.canOrder && <button className="btn small" onClick={() => setOrder(true)}>🧾 Cấp lệnh</button>}
        {canSell && <button className={paper ? 'btn small primary' : 'btn small'} onClick={() => setPaper(!paper)}>Nhập vé giấy</button>}
        {trip.departed_at && props.canOverride && (
          <button className="btn small" onClick={() => void rpc('set_trip_edit_lock', { p_trip_id: trip.id, p_unlock: locked })
            .then(async () => { toast('ok', locked ? 'Đã mở khóa sửa chuyến' : 'Đã khóa lại chuyến'); await onChanged(); })
            .catch((e) => toast('error', errMsg(e)))}>{locked ? 'Mở khóa sửa' : 'Khóa lại'}</button>
        )}
        <span className="vx-tool-r">{props.cash}<button className="btn small" aria-label="Tải lại" title="Tải lại" onClick={() => void load()}>⟳</button></span>
      </div>
      <section className="card vx-head">
        <div className="vx-h1">
          <span><b>{hhmm(trip.depart_at)}</b> • <b>{fmtDate(props.day)}</b> • <b>{props.routeName}</b> •{' '}
            <button type="button" className="btn small link" onClick={() => setShowStops(!showStops)}>Lộ trình {showStops ? '‹' : '›'}</button></span>
          <button type="button" className="btn small link" aria-label={fold ? 'Mở thông tin chuyến' : 'Thu gọn thông tin chuyến'} onClick={() => setFold(!fold)}>{fold ? '﹀' : '︿'}</button>
        </div>
        {showStops && <div className="small muted">{stopIds.map((id) => stopName(id)).join(' → ')}</div>}
        {!fold && (() => {
          const sold = all.filter((t) => t.status === 'dat' || t.status === 'da_tt');
          const sum = (l: Ticket[]) => l.reduce((a, t) => a + t.price, 0);
          const d1 = crew.find((c) => c.role === 'lai_xe_1'), d2 = crew.find((c) => c.role === 'lai_xe_2'), px = crew.find((c) => c.role === 'phu_xe');
          return (
            <div className="vx-h2">
              <div>
                <div className="vx-line"><span>🪑 {type.name}</span><span><i className={props.plate ? 'dot ok' : 'dot'} /> <b>{props.plate ?? 'Chưa xếp xe'}</b></span>
                  {props.canOrder && <button type="button" className="btn small" aria-label="Sửa xe và lái xe" onClick={() => setQuick(true)}>✎ Sửa</button>}</div>
                <div className="vx-line"><span>👤 <b>{d1 ? d1.name.toUpperCase() : 'Chưa xếp lái xe'}</b> {d1?.phone && <a href={`tel:${d1.phone}`}>{d1.phone}</a>}</span>
                  {d2 && <span>Lái xe 2: {d2.name}</span>}{px && <span>Phụ xe: {px.name}</span>}</div>
                <div className="vx-line"><span><b className="vx-big">{props.sold}</b> /{props.total} vé đã bán</span></div>
                <div className="vx-line small"><span>Lên xe <b>{sold.filter((t) => t.boarded).length}/{sold.length}</b></span>
                  <span>TC đón <b>{sold.filter((t) => t.tc_don).length}</b></span><span>TC trả <b>{sold.filter((t) => t.tc_tra).length}</b></span></div>
              </div>
              <div>
                <div className="vx-line small"><span>Tổng tiền <b>{money(sum(sold))}</b></span><span>Đã thu <b>{money(sum(sold.filter((t) => t.status === 'da_tt')) + sold.reduce((a, t) => a + (t.status === 'dat' ? t.deposit ?? 0 : 0), 0))}</b></span></div>
                <div className="vx-line small"><span>Thanh toán <b>{sold.filter((t) => t.status === 'da_tt').length}</b></span></div>
                <div className="vx-line small"><span>Đặt chỗ <b>{sold.filter((t) => t.status === 'dat').length}</b></span>
                  {trip.manifest_printed_at && <span className="badge phoi-badge">Đã in phơi {hhmm(trip.manifest_printed_at)}</span>}</div>
              </div>
              {trip.departed_at && (
                <div className="lock-box">
                  <span className="stamp">ĐÃ XUẤT BẾN<small>Thực hiện: {hhmm(trip.departed_at)} {new Date(trip.departed_at).toLocaleDateString('vi-VN', { timeZone: TZ })}</small></span>
                  {locked ? <span className="small muted">Khóa sửa vé</span> : <span className="small state-sap_het">Đang mở khóa sửa</span>}
                </div>
              )}
            </div>
          );
        })()}
      </section>
      <section className="card vx-body">
        {(() => {
          const sold = all.filter((t) => t.status !== 'giu');
          const pick = sold.filter((t) => t.pickup_note).length, drop = sold.filter((t) => t.dropoff_note).length;
          const tabs: [typeof view, string][] = [['so_do', 'Sơ đồ ghế'], ['khach', `Hành khách (${sold.length})`], ['don_tra', `Đón / Trả (${pick} | ${drop})`],
            ['tc', `Trung chuyển (${sold.filter((t) => t.tc_don).length} | ${sold.filter((t) => t.tc_tra).length})`], ['tk', 'Thống kê']];
          return (
            <div className="vx-tabs" role="tablist">
              {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}
              {view === 'so_do' && (
                <span className="vx-leg">
                  {fares.length > 0 && (
                    <SegSelect segs={segs} from={from} to={to} stopName={stopName} fareOf={fareOf} disabled={myHolds.length + offSel.length > 0}
                               onPick={(a, b) => { setFrom(a); setTo(b); }} />
                  )}
                  <select aria-label="Đón tại" value={from} onChange={(e) => setFrom(e.target.value)} disabled={myHolds.length + offSel.length > 0}>
                    {stopIds.slice(0, -1).map((id) => <option key={id} value={id}>{stopName(id)}</option>)}
                  </select>→
                  <select aria-label="Trả tại" value={to} onChange={(e) => setTo(e.target.value)} disabled={myHolds.length + offSel.length > 0}>
                    {stopIds.slice(1).map((id) => <option key={id} value={id}>{stopName(id)}</option>)}
                  </select>
                </span>
              )}
            </div>
          );
        })()}
        {phoi && (
          <PhoiPrint company={ctx.tenant_name ?? ''} route={props.routeName} time={hhmm(trip.depart_at)} day={fmtDate(props.day)} plate={props.plate} type={type}
                     seats={seats} crew={crew} me={ctx.full_name ?? ''} stopName={stopName}
                     tickets={all.filter((t) => t.status === 'dat' || t.status === 'da_tt')} />
        )}
        {view === 'so_do' && (
          <>
            <SeatMap type={type} seats={seats} stopName={stopName} bookingOf={bookingOf} depOf={(bid) => { const p = bookingDep(bid); return p > 0 ? { paid: p, due: bookingDue(bid) } : null; }} statusOf={(label) => {
              if (offSel.includes(label)) return { cls: 'mine' };
              const hit = overlapping(label);
              if (!hit) return { cls: 'free' };
              if (hit.id.startsWith('q:')) return { cls: 'cho_gui', t: hit };
              const mine = isMine(hit);
              return { cls: mine ? 'mine' : hit.status === 'giu' ? 'held' : hit.boarded ? 'boarded' : hit.status === 'dat' && bookingDep(hit.booking_id) > 0 ? 'coc' : hit.status, t: hit };
            }} onClick={(l) => void clickSeat(l)} />
            <p className="muted small legend">
              <span className="seat-dot free" /> trống <span className="seat-dot mine" /> đang chọn <span className="seat-dot held" /> quầy khác giữ
              <span className="seat-dot dat" /> đặt chưa trả <span className="seat-dot coc" /> đã cọc <span className="seat-dot da_tt" /> đã thanh toán <span className="seat-dot boarded" /> đã lên xe
              {queue.some((x) => x.trip_id === trip.id) && <><span className="seat-dot cho_gui" /> chờ gửi</>}
            </p>
          </>
        )}
        {view === 'khach' && (
          <PassengerList tickets={all.filter((t) => t.status !== 'giu')} stopName={stopName} bookingOf={bookingOf}
                         onOpen={(t) => setSelected(t)} reload={load}
                         onPrinted={() => void rpc('mark_manifest_printed', { p_trip_id: trip.id }).then(() => onChanged()).catch((e) => toast('error', errMsg(e)))} />
        )}
        {view === 'don_tra' && <PickDrop tickets={all.filter((t) => t.status !== 'giu')} onOpen={(t) => setSelected(t)} />}
        {view === 'tc' && <PickDrop tickets={all.filter((t) => t.status !== 'giu' && (t.tc_don || t.tc_tra))} onOpen={(t) => setSelected(t)} tc />}
        {view === 'tk' && <TripStats tickets={all.filter((t) => t.status !== 'giu')} stopName={stopName} />}
      </section>
      {waiting.length > 0 && (
        <section className="card waiting">
          <h2>Vé chờ xếp ghế ({waiting.length})</h2>
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
          <span><b>{myHolds.length}</b> vé đã chọn · ghế {myHolds.map((h) => h.seat_label).join(', ')} <span className="small">(bấm thêm ghế để chọn tiếp, bấm lại ghế để bỏ)</span></span>
          <span className="actions">
            <button className="btn small" onClick={() => void (async () => { for (const h of myHolds) await rpc('unhold_seat', { p_ticket_id: h.id }).catch(() => undefined); setBookingId(null); await load(); })()}>Bỏ chọn</button>
            <button className="btn small primary" onClick={() => setCkOpen(true)}>Tiếp tục</button>
          </span>
        </div>
      )}
      {myHolds.length > 0 && bookingId && ckOpen && (
        <Modal wide title={`${hhmm(trip.depart_at)} · ${fmtDate(props.day)} · ${props.routeName}`} onClose={() => setCkOpen(false)}>
        <Tabs tabs={['Thông tin chung']} />
        <Checkout trip={trip} holds={myHolds} bookingId={bookingId} stopName={stopName} from={from} to={to} bank={props.bank} ticketBase={ticketData}
                  segs={segs} fareOf={fareOf} onSegment={async (a, b) => { setFrom(a); setTo(b); await load(); }}
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

const ST_LABEL: Record<string, string> = { dat: 'Đặt chỗ', coc: 'Đã cọc', da_tt: 'Đã thanh toán', boarded: 'Đã lên xe', held: 'Quầy khác giữ', mine: 'Đang chọn', cho_gui: 'Chờ gửi', cho_xep: 'Chờ xếp ghế' };
const shortStop = (n: string) => n.replace(/^(bến xe|bx|văn phòng|vp)\s+/i, '');

/** Sơ đồ ghế kiểu Vexere: mỗi ghế là 1 thẻ lớn ghi chặng, tiền, tên, SĐT, ghi chú đón; ô tài xế / cửa ghi chữ lớn. */
function SeatMap(props: { type: VType; seats: Seat[]; stopName: (id: string | null) => string; bookingOf: (id: string) => Booking | undefined;
                          depOf: (bookingId: string) => { paid: number; due: number } | null;
                          statusOf: (label: string) => { cls: string; t?: Ticket }; onClick: (label: string) => void }) {
  const { type, seats, statusOf, onClick, stopName, bookingOf, depOf } = props;
  return (
    <div className="decks">
      {Array.from({ length: type.decks }, (_, i) => i + 1).map((d) => (
        <div key={d} className="deck">
          {type.decks > 1 && <div className="muted small">Tầng {d === 1 ? 'dưới' : 'trên'}</div>}
          <div className="vx-seats" style={{ gridTemplateColumns: `repeat(${type.layout_cols}, minmax(0, 1fr))` }}>
            {Array.from({ length: type.layout_rows * type.layout_cols }, (_, idx) => {
              const r = Math.floor(idx / type.layout_cols) + 1;
              const c = (idx % type.layout_cols) + 1;
              const s = seats.find((x) => x.deck === d && x.row_no === r && x.col_no === c);
              if (!s) return <div key={idx} />;
              if (s.kind === 'tai_xe' || s.kind === 'cua') return <div key={idx} className="vxs-fix">{s.kind === 'tai_xe' ? 'TÀI XẾ' : 'CỬA'}</div>;
              if (!s.is_sellable) return <div key={idx} className="vxs off"><b>{s.label}</b></div>;
              const st = statusOf(s.label);
              const t = st.t && st.t.status !== 'giu' ? st.t : null;
              return (
                <button key={idx} type="button" className={`vxs ${st.cls}${s.is_priority ? ' prio' : ''}`}
                        aria-label={`Ghế ${s.label}${st.cls === 'free' ? ' trống' : ''}`} onClick={() => onClick(s.label)}>
                  <span className="vxs-h"><b>{s.label}</b>
                    {t?.printed_at && <span className="printed" title={`Đã in vé ${t.print_count ?? 1} lần`} aria-label="Đã in vé"><PrinterIcon /></span>}
                    {t?.pickup_note && <span className="vxs-tag">{t.pickup_note}</span>}</span>
                  {t ? (
                    <>
                      <span className="vxs-r"><span>{shortStop(stopName(t.from_stop_id))} - {shortStop(stopName(t.to_stop_id))}</span><b>{money(t.price)}</b></span>
                      <span className="vxs-r"><span>{t.passenger_name ?? ''}</span><b>{t.passenger_phone ?? ''}</b></span>
                      {t.dropoff_note && <span className="vxs-n">Trả: {t.dropoff_note}</span>}
                      {st.cls === 'coc' && (() => { const d = depOf(t.booking_id); return d && <span className="vxs-r vxs-coc"><span>Cọc {money(d.paid)}</span><b>Còn {money(d.due)}</b></span>; })()}
                      {(() => { const c = crewNote(t); return c && <span className={`vxs-crew ${c.cls}`}>{c.text}</span>; })()}
                      <span className="vxs-r vxs-s"><span>{bookingOf(t.booking_id)?.code ?? ''}</span><span>{ST_LABEL[st.cls] ?? ''}</span></span>
                    </>
                  ) : st.cls !== 'free' && <span className="vxs-s">{ST_LABEL[st.cls] ?? ''}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Phơi in dạng sơ đồ ghế, tự co giãn cho vừa đúng 1 trang A4 dọc (xe 2 tầng: 2 tầng cạnh nhau). */
function PhoiPrint(p: { company: string; route: string; time: string; day: string; plate: string | null; type: VType; seats: Seat[];
                        crew: { role: string; name: string; phone: string | null }[]; me: string; stopName: (id: string | null) => string; tickets: Ticket[] }) {
  const { type, seats, tickets } = p;
  const rows = type.layout_rows, cols = type.layout_cols;
  const fs = rows <= 5 ? 13 : rows <= 7 ? 11.5 : rows <= 9 ? 10 : 8.5;   // chữ nhỏ dần khi nhiều hàng ghế
  const paid = tickets.filter((t) => t.status === 'da_tt'), unpaid = tickets.filter((t) => t.status === 'dat');
  const sum = (l: Ticket[]) => l.reduce((a, t) => a + t.price, 0);
  const d1 = p.crew.find((c) => c.role === 'lai_xe_1'), d2 = p.crew.find((c) => c.role === 'lai_xe_2'), px = p.crew.find((c) => c.role === 'phu_xe');
  return (
    <div className="print-area phoi-a4" style={{ fontSize: fs }}>
      <div className="phoi-head">
        <div><b>{p.company.toUpperCase()}</b><div>PHƠI XE · SƠ ĐỒ GHẾ</div></div>
        <div className="phoi-title"><b>{p.route}</b><div>Giờ chạy <b>{p.time}</b> · ngày <b>{p.day}</b></div></div>
        <div className="phoi-r">Xe <b>{p.plate ?? '……………'}</b> · {type.name}<div>Lái xe: <b>{d1?.name ?? '……………'}</b>{d2 ? ` · ${d2.name}` : ''}{px ? ` · Phụ xe: ${px.name}` : ''}</div></div>
      </div>
      <div className="phoi-decks">
        {Array.from({ length: type.decks }, (_, i) => i + 1).map((d) => (
          <div key={d} className="phoi-deck">
            {type.decks > 1 && <div className="phoi-dl">Tầng {d === 1 ? 'dưới' : 'trên'}</div>}
            <div className="phoi-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
              {Array.from({ length: rows * cols }, (_, idx) => {
                const r = Math.floor(idx / cols) + 1, c = (idx % cols) + 1;
                const s = seats.find((x) => x.deck === d && x.row_no === r && x.col_no === c);
                if (!s) return <div key={idx} />;
                if (s.kind === 'tai_xe' || s.kind === 'cua') return <div key={idx} className="phoi-fix">{s.kind === 'tai_xe' ? 'TÀI XẾ' : 'CỬA'}</div>;
                const ts = tickets.filter((t) => t.seat_label === s.label);
                return (
                  <div key={idx} className={`phoi-seat${ts.length ? ' on' : ''}`}>
                    <b className="phoi-no">{s.label}</b>
                    {ts.map((t) => (
                      <div key={t.id} className="phoi-t">
                        <div className="phoi-row"><b>{t.passenger_name ?? ''}</b><span>{t.passenger_phone ?? ''}</span></div>
                        <div className="phoi-row"><span>{shortStop(p.stopName(t.from_stop_id))} - {shortStop(p.stopName(t.to_stop_id))}</span>
                          <b>{t.price.toLocaleString('vi-VN')}{t.status === 'da_tt' ? ' ✓' : ''}</b></div>
                        {t.pickup_note && <div>Đón: {t.pickup_note}</div>}
                        {t.dropoff_note && <div>Trả: {t.dropoff_note}</div>}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="phoi-foot">
        <div>Tổng <b>{tickets.length}</b> vé · Đã thu <b>{sum(paid).toLocaleString('vi-VN')} đ</b> ({paid.length} vé ✓) · Chưa thu <b>{sum(unpaid).toLocaleString('vi-VN')} đ</b> ({unpaid.length} vé)</div>
        <div className="phoi-sign"><div><b>Người lập phơi</b><div className="phoi-sb" />{p.me}</div><div><b>Lái xe</b><div className="phoi-sb" />{d1?.name ?? ''}</div></div>
      </div>
    </div>
  );
}

/** Đón / trả (hoặc trung chuyển): gom khách theo ghi chú điểm đón và điểm trả. */
function PickDrop({ tickets, onOpen, tc }: { tickets: Ticket[]; onOpen: (t: Ticket) => void; tc?: boolean }) {
  const col = (title: string, list: Ticket[], note: (t: Ticket) => string | null) => {
    const groups = new Map<string, Ticket[]>();
    for (const t of list) { const k = note(t) || '(không ghi)'; groups.set(k, [...(groups.get(k) ?? []), t]); }
    return (
      <div>
        <h3>{title} ({list.length})</h3>
        {[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'vi')).map(([k, l]) => (
          <div key={k} className="pd-group"><b>{k}</b>
            <ul className="list small">{l.map((t) => <li key={t.id}><button className="btn small link" onClick={() => onOpen(t)}>Ghế {t.seat_label}</button> {t.passenger_name ?? ''} {t.passenger_phone && <a href={`tel:${t.passenger_phone}`}>{t.passenger_phone}</a>}</li>)}</ul>
          </div>
        ))}
        {list.length === 0 && <p className="muted small">Không có.</p>}
      </div>
    );
  };
  return (
    <div className="pd-cols">
      {col(tc ? 'Trung chuyển đón' : 'Đón', tc ? tickets.filter((t) => t.tc_don) : tickets.filter((t) => t.pickup_note), (t) => t.pickup_note)}
      {col(tc ? 'Trung chuyển trả' : 'Trả', tc ? tickets.filter((t) => t.tc_tra) : tickets.filter((t) => t.dropoff_note), (t) => t.dropoff_note)}
    </div>
  );
}

/** Thống kê chuyến: theo chặng và theo trạng thái. */
function TripStats({ tickets, stopName }: { tickets: Ticket[]; stopName: (id: string | null) => string }) {
  const by = new Map<string, { n: number; sum: number }>();
  for (const t of tickets) { const k = `${stopName(t.from_stop_id)} → ${stopName(t.to_stop_id)}`; const o = by.get(k) ?? { n: 0, sum: 0 }; by.set(k, { n: o.n + 1, sum: o.sum + t.price }); }
  const st = (f: (t: Ticket) => boolean) => { const l = tickets.filter(f); return `${l.length} vé · ${money(l.reduce((a, t) => a + t.price, 0))}`; };
  return (
    <>
      <table className="plist">
        <thead><tr><th>Chặng</th><th>Số vé</th><th>Tiền</th></tr></thead>
        <tbody>{[...by.entries()].map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.n}</td><td>{money(v.sum)}</td></tr>)}</tbody>
      </table>
      <p className="small">Đã thanh toán: {st((t) => t.status === 'da_tt')} · Đặt chỗ chưa trả: {st((t) => t.status === 'dat')} · Đã lên xe: {st((t) => t.boarded)}</p>
    </>
  );
}

/* ------------------------------------------------------------------ Xác nhận đơn */

/** Ô chọn chặng: mặc định toàn tuyến; chọn chặng khác (trong Bảng giá vé) thì đón / trả và giá theo chặng đó */
function SegSelect(props: { segs: Fare[]; from: string; to: string; stopName: (id: string | null) => string; fareOf: (a: string, b: string) => number | null;
  disabled: boolean; onPick: (from: string, to: string) => void }) {
  const { segs, from, to, stopName, fareOf } = props;
  const cur = segs.some((x) => x.from_stop_id === from && x.to_stop_id === to) ? `${from}|${to}` : '';
  const p = fareOf(from, to);
  return (
    <select aria-label="Chặng" value={cur} disabled={props.disabled}
            onChange={(e) => { const [a, b] = e.target.value.split('|'); if (a && b) props.onPick(a, b); }}>
      {!cur && <option value="">{stopName(from)} → {stopName(to)}{p !== null ? ` · ${money(p)}` : ''}</option>}
      {segs.map((x) => <option key={`${x.from_stop_id}|${x.to_stop_id}`} value={`${x.from_stop_id}|${x.to_stop_id}`}>{stopName(x.from_stop_id)} → {stopName(x.to_stop_id)} · {money(x.price)}</option>)}
    </select>
  );
}

function Checkout(props: {
  trip: Trip; holds: Ticket[]; bookingId: string; stopName: (id: string | null) => string; from: string; to: string;
  bank: BankAccount | null; ticketBase: (list: Ticket[], code: string) => TicketPrintData;
  segs: Fare[]; fareOf: (a: string, b: string) => number | null; onSegment: (from: string, to: string) => Promise<void>;
  onDone: (code: string, printList: Ticket[] | null) => Promise<void>; onCancelAll: () => Promise<void>; onMore: () => void;
}) {
  const { holds, bookingId, stopName, onDone, onCancelAll, bank, onMore } = props;
  const toast = useToast();
  const [f, setF] = useState({ phone: '', name: '', pickup: '', dropoff: '', note: '', mode: 'thu_tien' as 'thu_tien' | 'dat_cho' | 'chuyen_khoan' | 'coc', keep: false, reason: '', tcDon: false, tcTra: false,
    coc: '', cocMethod: 'tien_mat' as 'tien_mat' | 'chuyen_khoan' });
  const [transfer, setTransfer] = useState<{ code: string; total: number; holdUntil: string | null } | null>(null);
  const [known, setKnown] = useState<Customer | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0);
  const total = holds.reduce((a, t) => a + t.price, 0);
  const [pvOpen, setPvOpen] = useState(true);
  // Xem trước vé K80 ngay khi nhập (như phiếu gửi hàng)
  const draft = props.ticketBase(holds.map((h) => ({
    ...h, passenger_name: f.name.trim() || KHACH_LE, passenger_phone: f.phone || null, pickup_note: f.pickup || null, dropoff_note: f.dropoff || null,
    status: (f.mode === 'thu_tien' ? 'da_tt' : 'dat') as SeatStatus, deposit: f.mode === 'coc' && h.id === holds[0]?.id ? Number(f.coc || 0) : 0,
  })), '(cấp khi lưu)');
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
    if (c) setF((cur) => ({ ...cur, name: cur.name || (c.name && c.name !== KHACH_LE ? c.name : ''), pickup: cur.pickup || (c.last_pickup_note ?? '').toUpperCase() }));
  }

  async function confirm(print: boolean) {
    setBusy(true);
    try {
      const coc = Number(f.coc || 0);
      if (f.mode === 'coc' && !(coc > 0 && coc < total)) { toast('error', `Tiền cọc phải lớn hơn 0 và nhỏ hơn ${money(total)}`); return; }
      const r = await rpc<{ code: string }>('confirm_booking', {
        p_booking_id: bookingId, p_phone: f.phone || null, p_name: f.name.trim() || KHACH_LE, p_mode: f.mode === 'coc' ? 'dat_cho' : f.mode, p_keep: f.mode === 'dat_cho' && f.keep,
        p_keep_reason: f.reason || null, p_pickup_note: f.pickup || null, p_dropoff_note: f.dropoff || null, p_note: f.note || null, p_passengers: null,
      });
      if (f.mode === 'coc') await rpc('deposit_booking', { p_booking_id: bookingId, p_amount: coc, p_method: f.cocMethod });
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
      toast('ok', f.mode === 'thu_tien' ? `Đã bán vé ${r.code} · thu ${money(total)}` : f.mode === 'coc' ? `Đã nhận cọc ${money(coc)} vé ${r.code} · còn ${money(total - coc)}` : `Đã đặt chỗ ${r.code}`);
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
      <div className="gh-wrap">
      <div className="form">
      <p className="small seg-line">Ghế {holds.map((h) => h.seat_label).join(', ')} ·{' '}
        <SegSelect segs={props.segs} from={props.from} to={props.to} stopName={stopName} fareOf={props.fareOf} disabled={busy}
                   onPick={(a, b) => void (async () => {
                     setBusy(true);
                     try {
                       await rpc('set_hold_segment', { p_booking_id: bookingId, p_from_stop: a, p_to_stop: b });
                       await props.onSegment(a, b);
                     } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
                   })()} />
      </p>
      <div className="grid2">
        <label>Số điện thoại khách
          <input inputMode="tel" value={f.phone} onChange={(e) => { setF({ ...f, phone: e.target.value }); void lookup(e.target.value); }} />
          {known && <span className="small state-con_han">Khách cũ · đã đi {known.trips_count} lần{known.last_from_stop ? ` · lần trước ${stopName(known.last_from_stop)} → ${stopName(known.last_to_stop)}` : ''}</span>}
        </label>
        <label>Tên khách<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={KHACH_LE} /></label>
        <label>Ghi chú điểm đón<input value={f.pickup} onChange={(e) => setF({ ...f, pickup: e.target.value.toUpperCase() })} placeholder="VD: ĐÓN TRƯỚC CÂY XĂNG" /></label>
        <label>Ghi chú điểm trả<input value={f.dropoff} onChange={(e) => setF({ ...f, dropoff: e.target.value.toUpperCase() })} /></label>
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
        <button type="button" role="radio" aria-checked={f.mode === 'coc'} className={f.mode === 'coc' ? 'btn small primary' : 'btn small'}
                onClick={() => setF({ ...f, mode: 'coc' })}>Khách cọc trước</button>
        <button type="button" role="radio" aria-checked={f.mode === 'dat_cho'} className={f.mode === 'dat_cho' ? 'btn small primary' : 'btn small'}
                onClick={() => setF({ ...f, mode: 'dat_cho' })}>Đặt chỗ trả sau</button>
      </div>
      {f.mode === 'coc' && (
        <div className="inline-form">
          <label>Tiền cọc (đồng)<input type="number" min={0} step={1000} inputMode="numeric" value={f.coc} onChange={(e) => setF({ ...f, coc: e.target.value })} /></label>
          <label>Nhận cọc bằng
            <select value={f.cocMethod} onChange={(e) => setF({ ...f, cocMethod: e.target.value as 'tien_mat' | 'chuyen_khoan' })}>
              <option value="tien_mat">Tiền mặt</option>
              <option value="chuyen_khoan">Chuyển khoản</option>
            </select>
          </label>
          {Number(f.coc) > 0 && <span className="small">Còn phải thu {money(Math.max(0, total - Number(f.coc)))}</span>}
        </div>
      )}
      {f.mode === 'dat_cho' && (
        <div className="inline-form">
          <label className="check"><input type="checkbox" checked={f.keep} onChange={(e) => setF({ ...f, keep: e.target.checked })} /> Giữ đến giờ chạy (không tự nhả)</label>
          {f.keep && <label>Lý do<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="vd: khách quen" /></label>}
        </div>
      )}
      </div>
      <aside className="gh-pv no-print" aria-label="Xem trước vé K80">
        <div className="gh-pvh">Xem trước vé K80<button type="button" className="btn small link" onClick={() => setPvOpen(!pvOpen)}>{pvOpen ? 'Thu gọn' : 'Mở'}</button></div>
        {pvOpen && <div className="gh-pvb"><TicketSlip data={draft} i={0} qr={null} /></div>}
      </aside>
      </div>
      <div className="actions">
        {f.mode === 'chuyen_khoan' ? (
          <button className="btn primary" disabled={busy} onClick={() => void confirm(true)}>Tạo QR chuyển khoản</button>
        ) : (
          <>
            <button className="btn primary" disabled={busy} onClick={() => void confirm(true)}>{f.mode === 'thu_tien' ? 'Thu tiền + in vé' : f.mode === 'coc' ? 'Nhận cọc + in vé' : 'Đặt chỗ + in phiếu'}</button>
            <button className="btn" disabled={busy} onClick={() => void confirm(false)}>{f.mode === 'thu_tien' ? 'Thu tiền, không in' : f.mode === 'coc' ? 'Nhận cọc, không in' : 'Đặt chỗ, không in'}</button>
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
                <span className="muted small"> {bookingOf(t.booking_id)?.code}</span>
                {(() => { const c = crewNote(t); return c && <><br /><span className={`vxs-crew ${c.cls}`}>{c.text}</span></>; })()}</td>
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
  const depAll = unpaid.reduce((a, x) => a + (x.deposit ?? 0), 0);
  const [note, setNote] = useState(booking?.note ?? '');

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
          : depAll > 0 ? `Đơn ${unpaid.length} ghế đã cọc ${money(depAll)}, còn ${money(unpaid.reduce((a, x) => a + x.price, 0) - depAll)}` : `${t.pay_method === 'chuyen_khoan' ? 'Chờ chuyển khoản' : 'Đặt chỗ chưa trả'}${t.hold_until ? `, giữ đến ${hhmm(t.hold_until)}` : ', giữ đến giờ chạy'}`}
        {t.keep_reason ? ` (${t.keep_reason})` : ''}</p>
      {unpaid.length > 0 && qr && bank && (
        <TransferQR bank={bank} amount={unpaid.reduce((a, x) => a + x.price - (x.deposit ?? 0), 0)} code={booking?.code ?? ''} holdUntil={t.hold_until} busy={false}
                    onConfirm={() => void run(() => rpc('pay_booking', { p_booking_id: t.booking_id, p_ticket_ids: null, p_method: 'chuyen_khoan' }),
                      `Đã nhận chuyển khoản ${money(unpaid.reduce((a, x) => a + x.price - (x.deposit ?? 0), 0))}`)} onLater={() => setQr(false)} />
      )}
      {unpaid.length > 0 && !qr && (
        <div className="actions">
          <button className="btn primary" onClick={() => void run(() => rpc('pay_booking', { p_booking_id: t.booking_id, p_ticket_ids: null, p_method: 'tien_mat' }),
            `Đã thu ${money(unpaid.reduce((a, x) => a + x.price - (x.deposit ?? 0), 0))}`)}>Thu tiền mặt {money(unpaid.reduce((a, x) => a + x.price - (x.deposit ?? 0), 0))}</button>
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
        <label>Ghi chú điểm đón<input value={info.pickup} onChange={(e) => setInfo({ ...info, pickup: e.target.value.toUpperCase() })} /></label>
        <label>Ghi chú điểm trả<input value={info.dropoff} onChange={(e) => setInfo({ ...info, dropoff: e.target.value.toUpperCase() })} /></label>
        <label>Ghi chú đơn<input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <div className="actions">
        <button className="btn small" onClick={() => void run(async () => {
          await rpc('update_ticket_info', { p_ticket_id: t.id, p_name: info.name.trim() || KHACH_LE, p_phone: info.phone, p_pickup_note: info.pickup, p_dropoff_note: info.dropoff });
          if (note.trim() !== (booking?.note ?? '').trim()) await rpc('set_booking_note', { p_booking_id: t.booking_id, p_note: note });
        }, 'Đã sửa thông tin khách')}>Lưu thông tin</button>
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
  // vé đã cọc: hoàn theo phí hủy / không hoàn / tự nhập (mặc định theo Cấu hình, chọn lại được)
  const [dep, setDep] = useState<{ mode: 'hoan_theo_phi' | 'khong_hoan' | 'tu_nhap'; amount: string }>({ mode: 'hoan_theo_phi', amount: '' });
  useEffect(() => {
    void supabase.from('tenant_settings').select('value').eq('key', 've.huy_coc').maybeSingle()
      .then(({ data }) => { const v = (data as { value: unknown } | null)?.value; if (v === 'khong_hoan' || v === 'tu_nhap' || v === 'hoan_theo_phi') setDep((d) => ({ ...d, mode: v })); });
  }, []);
  const depOf = (id: string) => siblings.find((x) => x.id === id)?.deposit ?? 0;
  const deposits = pick.reduce((a, id) => a + depOf(id), 0);

  useEffect(() => {
    if (!pick.length) return setQuote([]);
    void rpc<Quote[]>('cancel_quote', { p_ticket_ids: pick }).then(setQuote).catch((e) => toast('error', errMsg(e)));
  }, [pick, toast]);

  const sum = (k: 'fee' | 'refund') => quote.reduce((a, q) => a + q[k], 0);
  const anyPaid = quote.some((q) => q.status !== 'dat') || deposits > 0;

  async function go() {
    setBusy(true);
    try {
      const r = await rpc<{ tickets: number; fee: number; refund: number }>('cancel_tickets', {
        p_ticket_ids: pick, p_reason: reason, p_refund_method: method,
        p_fee_override: override ? Number(override.fee || 0) : null, p_override_reason: override?.reason ?? null,
        p_deposit_mode: deposits > 0 ? dep.mode : null, p_deposit_refund: deposits > 0 && dep.mode === 'tu_nhap' ? Number(dep.amount || 0) : null,
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
              <td>{q.status !== 'dat' ? money(q.price) : depOf(q.ticket_id) > 0 ? `cọc ${money(depOf(q.ticket_id))}` : 'chưa thu'}</td>
              <td>{q.status !== 'dat' ? `${q.fee_pct}% · ${money(q.fee)}` : '—'}</td>
              <td>{q.status !== 'dat' ? money(q.refund) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {quote[0] && <p className="muted small">Còn {quote[0].hours_left} giờ đến giờ chạy. Mốc phí sửa ở Cấu hình → Hủy / đổi vé.</p>}
      {deposits > 0 && (
        <div className="inline-form">
          <label>Tiền cọc {money(deposits)}
            <select value={dep.mode} onChange={(e) => setDep({ ...dep, mode: e.target.value as typeof dep.mode })}>
              <option value="hoan_theo_phi">Hoàn cọc sau khi trừ phí hủy</option>
              <option value="khong_hoan">Không hoàn cọc</option>
              <option value="tu_nhap">Nhập số tiền hoàn</option>
            </select>
          </label>
          {dep.mode === 'tu_nhap' && <label>Hoàn cọc (đồng)<input type="number" min={0} max={deposits} step={1000} inputMode="numeric" value={dep.amount} onChange={(e) => setDep({ ...dep, amount: e.target.value })} /></label>}
        </div>
      )}
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
        <button type="button" className="btn small danger" disabled={busy || !pick.length} onClick={() => void go()}>Xác nhận hủy</button>
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
      phone: phone || null, name: f.name.trim() || KHACH_LE, method: f.method, sold_at: new Date().toISOString(),
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
        <label>Tên khách<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={KHACH_LE} /></label>
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
      seats: [f.seat], from_stop: f.from, to_stop: f.to, price, phone: phone || null, name: f.name.trim() || KHACH_LE, method: f.method,
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
        <label>Tên khách<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={KHACH_LE} /></label>
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
  keep_reason: 'Lý do giữ', trip_id: 'Chuyến', deposit: 'Tiền cọc',
};
const KIND_TIEN: Record<string, string> = { ban_ve: 'Thu tiền vé', dao: 'Bút toán đảo', hoan: 'Hoàn tiền', phi_huy: 'Phí hủy', phi_doi: 'Phí đổi vé' };

/** Tên chuyến (giờ chạy ngày) để hiện trong lịch sử thay cho mã chuyến */
const tripLabel = new Map<string, string>();
function show(k: string, v: unknown, stopName: (id: string | null) => string): string {
  if (v === null || v === undefined || v === '') return '(trống)';
  if (k === 'status') return ST[String(v)] ?? String(v);
  if (k === 'price' || k === 'deposit') return money(Number(v));
  if (k === 'trip_id') return tripLabel.get(String(v)) ?? 'chuyến khác';
  if (typeof v === 'boolean') return v ? 'có' : 'không';
  if (k.endsWith('_stop_id')) return stopName(String(v));
  return String(v);
}

function TicketHistory({ bookingId, stopName }: { bookingId: string; stopName: (id: string | null) => string }) {
  const [list, setList] = useState<HistEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const l = await rpc<HistEvent[]>('ticket_history', { p_booking_id: bookingId });
        const ids = [...new Set(l.flatMap((e) => [e.old?.trip_id, e.new?.trip_id]).filter((x): x is string => typeof x === 'string' && !tripLabel.has(x)))];
        if (ids.length) {
          const { data } = await supabase.from('trips').select('id, depart_at').in('id', ids);
          for (const t of (data ?? []) as { id: string; depart_at: string }[]) {
            tripLabel.set(t.id, new Date(t.depart_at).toLocaleString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false }));
          }
        }
        setList(l);
      } catch (e) { setErr(errMsg(e)); }
    })();
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
  }).filter((x): x is { at: string; actor: string | null; text: string } => x !== null)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));   // mới nhất lên trên
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

/** Sửa nhanh xe + lái xe 1 của chuyến ngay ở màn Bán vé (cùng hàm xếp xe của Điều hành: có cảnh báo thì ghi lý do rồi vẫn xếp) */
function QuickAssign({ tripId, vehicleId, crew, onClose, onSaved }: {
  tripId: string; vehicleId: string | null; crew: { role: string; staff_id: string }[]; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const cur = (r: string) => crew.find((c) => c.role === r)?.staff_id ?? '';
  const [f, setF] = useState({ vehicle: vehicleId ?? '', d1: cur('lai_xe_1') });
  const [lists, setLists] = useState<{ vehicles: { id: string; plate: string; seats: number | null }[]; drivers: { id: string; name: string }[] } | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { void rpc<NonNullable<typeof lists>>('assign_pick_lists').then(setLists).catch((e) => setErr(errMsg(e))); }, []);
  async function save(withReason: boolean) {
    setBusy(true); setErr('');
    try {
      const r = await rpc<{ saved: boolean; warnings: string[] }>('assign_trip', {
        p_trip_id: tripId, p_vehicle_id: f.vehicle || null, p_driver1: f.d1 || null, p_driver2: cur('lai_xe_2') || null, p_assistant: cur('phu_xe') || null,
        p_reason: withReason ? reason.trim() || 'Đã xem cảnh báo, vẫn xếp' : null,
      });
      if (!r.saved) { setWarnings(r.warnings); return; }
      await onSaved();
    } catch (e) {
      const m = errMsg(e);
      setErr(/trips_vehicle_no_overlap|trip_crew_no_overlap/.test(m) ? 'Xe hoặc lái xe đang chạy chuyến khác cùng giờ' : m);
    } finally { setBusy(false); }
  }
  return (
    <Modal title="Sửa xe và lái xe" onClose={onClose}>
      {!lists ? <p className="muted">{err || 'Đang tải…'}</p> : (
        <div className="form">
          <label>Xe
            <select value={f.vehicle} onChange={(e) => { setF({ ...f, vehicle: e.target.value }); setWarnings(null); }}>
              <option value="">Chưa xếp</option>
              {lists.vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate}{v.seats ? ` · ${v.seats} chỗ` : ''}</option>)}
            </select>
          </label>
          <label>Lái xe
            <select value={f.d1} onChange={(e) => { setF({ ...f, d1: e.target.value }); setWarnings(null); }}>
              <option value="">Chưa xếp</option>
              {lists.drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          {warnings && (
            <div className="warn small">
              <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              <label>Lý do vẫn xếp<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            </div>
          )}
          {err && <p className="error-text" role="alert">{err}</p>}
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void save(!!warnings)}>{warnings ? 'Vẫn xếp' : 'Lưu'}</button>
            <button type="button" className="btn link" onClick={onClose}>Thôi</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
