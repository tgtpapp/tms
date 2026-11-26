// App lái xe (như app cũ): chuyến của tôi; mỗi chuyến có Đón khách theo điểm đón · Sơ đồ ghế có tên khách · Trả & hàng; gọi khách ghi trạng thái báo về quầy; thu tiền mặt / chuyển khoản; xuất bến / đến bến.
import { MiniCal } from '../components/MiniCal';
import { dirName } from '../lib/routes';
import { NotifyBanner, NotifyBell } from '../components/NotifyBell';
import { MonthPicker } from '../components/MonthPicker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { meter } from '../lib/egress';
import { fmtDate, today } from '../components/Documents';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { MyTransfers } from './Transfers';
import { ParcelRow, SHIP_COLS, type Shipment } from './Parcels';
import { MyCharters } from './Charters';
import { FuelReportCard } from '../components/FuelReport';
import { Modal } from '../components/Modal';
import { ScanScreen } from './Scan';
import { DOC_COLS, docState, type Doc } from '../components/Documents';
import { RECORD_OF } from '../lib/recordPapers';
import { FilesViewButton } from '../components/FilePreview';
import { DOC_TYPES } from '../lib/docTypes';

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
/** Chuyến còn phải chạy: chưa hủy, chưa đến bến, đang chạy hoặc chưa tới giờ xuất bến,
 *  và chưa có chuyến sau nó tới giờ / đã xuất bến (tới giờ chuyến sau thì chuyến trước coi như đã kết thúc). */
const isUpcoming = (t: MyTrip, all: MyTrip[], now: number) =>
  t.status !== 'huy' && !t.arrived_at && (!!t.departed_at || new Date(t.depart_at).getTime() >= now)
  && !all.some((x) => x.status !== 'huy' && x.depart_at > t.depart_at && (!!x.departed_at || new Date(x.depart_at).getTime() <= now));
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
  // chuyến người dùng tự bấm mở ('' = đã đóng); chưa bấm thì tự mở chuyến chuẩn bị chạy
  const [picked, setOpen] = useState<string | null>(null);
  const [nbOpen, setNbOpen] = useState(0);
  // lệnh đã scan lưu vào hệ thống theo chuyến (cả các lượt cùng lệnh)
  const [scanned, setScanned] = useState<Set<string>>(new Set());
  const [scanTrip, setScanTrip] = useState<MyTrip | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, r, st] = await Promise.all([
        rpc<MyTrip[]>('my_trips', { p_from: day, p_to: day }),
        supabase.from('routes').select('id, name, name_ve'),
        supabase.from('stops').select('id, name'),
      ]);
      setTrips(t);
      const sc = t.length ? await supabase.from('order_scans').select('trip_id').in('trip_id', t.map((x) => x.trip_id)) : { data: [] };
      setScanned(new Set(((sc.data ?? []) as { trip_id: string }[]).map((x) => x.trip_id)));
      setRoutes(Object.fromEntries(((r.data ?? []) as { id: string; name: string; name_ve: string | null }[]).map((x) => [x.id, x])));
      setStops(Object.fromEntries(((st.data ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name])));
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


  // Thứ tự: chuyến chuẩn bị chạy (xanh) + chi tiết chuyến lên đầu → các chuyến tiếp theo (vàng nhạt) → chuyến đã kết thúc / qua giờ (xám).
  // Mỗi phút xếp lại; 3 phút tải lại trạng thái (quay lại app thì tải ngay): chuyến chạy xong thì chuyến tiếp theo được đẩy lên.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let n = 0;
    const t = setInterval(() => { setNow(Date.now()); n += 1; if (n % 3 === 0 && !document.hidden && day === today()) void load(); }, 60_000);
    const vis = () => { if (!document.hidden && day === today()) void load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [day, load]);
  // Lịch như app cũ: chấm dưới các ngày có chuyến của tôi trong tháng đang xem
  const [marks, setMarks] = useState<Map<string, number>>(new Map());
  const loadMarks = useCallback((ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    void rpc<MyTrip[]>('my_trips', { p_from: `${ym}-01`, p_to: `${ym}-${String(last).padStart(2, '0')}` }).then((t) => {
      const c = new Map<string, number>();
      for (const x of t) if (x.status !== 'huy') c.set(x.service_date, (c.get(x.service_date) ?? 0) + 1);
      setMarks(c);
    }).catch(() => undefined);
  }, []);
  const sorted = [...trips].sort((a, b) => Number(isUpcoming(b, trips, now)) - Number(isUpcoming(a, trips, now)) || a.depart_at.localeCompare(b.depart_at));
  const first = sorted.find((t) => isUpcoming(t, trips, now));
  const open = picked === '' ? null : picked ?? first?.trip_id ?? (trips.length === 1 ? trips[0]!.trip_id : null);
  const cur = open ? trips.find((t) => t.trip_id === open) : undefined;
  const cut = cur ? sorted.indexOf(cur) + 1 : first ? 1 : 0;   // chi tiết chuyến nằm ngay dưới thẻ chuyến đang mở
  const chip = (t: MyTrip) => (
    <button key={t.trip_id} className={['trip-chip', open === t.trip_id && 'on', !isUpcoming(t, trips, now) ? 'past' : t === first ? 'next' : 'later'].filter(Boolean).join(' ')}
            onClick={() => setOpen(open === t.trip_id ? '' : t.trip_id)} aria-label={`Chuyến ${hhmm(t.depart_at)} ${dirName(routes[t.route_id], t.direction)}`}>
      <b>{hhmm(t.depart_at)}</b> {dirName(routes[t.route_id], t.direction)}
      <span className="small">{t.plate ?? 'chưa có xe'} · {ROLE[t.my_role]}{t.order_no ? ` · Lệnh ${t.order_no}` : ''}</span>
      <span className={`badge ${t.status === 'huy' ? 'locked' : t.arrived_at ? '' : t.departed_at ? 'warn-badge' : 'idle'}`}>
        {t.status === 'huy' ? 'Đã hủy' : t.arrived_at ? `Đã đến bến ${hhmm(t.arrived_at)}` : t.departed_at ? `Đã xuất bến ${hhmm(t.departed_at)}` : 'Chưa xuất bến'}
      </span>
    </button>
  );
  // đang chạy chuyến (đã xuất bến, chưa đến bến): không bắt thao tác điện thoại
  const running = day === today() && trips.some((t) => t.departed_at && !t.arrived_at && t.status !== 'huy');
  if (scanTrip) {
    return (
      <>
        <button type="button" className="btn small" onClick={() => setScanTrip(null)}>‹ Quay lại Chuyến của tôi</button>
        <ScanScreen canSave={false} canAI canLenh forTrip={{ id: scanTrip.trip_id, label: `${hhmm(scanTrip.depart_at)} ${fmtDate(scanTrip.service_date)} · ${dirName(routes[scanTrip.route_id], scanTrip.direction)}` }}
          onDone={() => { setScanTrip(null); void load(); }} />
      </>
    );
  }
  return (
    <>
      <section className="card">
        <div className="item-head"><h2>Chuyến của tôi · {fmtDate(day)}</h2><NotifyBell inline openKey={nbOpen} /></div>
        <NotifyBanner running={running} onOpen={() => setNbOpen((k) => k + 1)} />
        <MiniCal day={day} marks={marks} onMonth={loadMarks} onPick={(d) => { setDay(d); setOpen(null); }} />
        {trips.length === 0 && <p className="muted">Không có chuyến xe nào được xếp cho bạn trong ngày.</p>}
        <div className="drv-trips">{sorted.slice(0, cut).map(chip)}</div>
      </section>
      {cur && <TripRun trip={cur} stopName={(id) => stops[id] ?? '?'} reload={load} scanned={scanned.has(cur.trip_id)} onScan={() => setScanTrip(cur)} />}
      {sorted.length > cut && <section className="card"><div className="drv-trips">{sorted.slice(cut).map(chip)}</div></section>}
      {staffId && <MyPapers staffId={staffId} plates={plates} />}
      {tenantId && staffId && <FuelReportCard tenantId={tenantId} staffId={staffId} plates={plates} shareFiles={shareFiles} onShareDone={onShareDone} />}
      <MyTransfers day={day} />
      <MyCharters />
      <MyMonthTrips routes={routes} onPick={(d, id) => { setDay(d); setOpen(id); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
    </>
  );
}

interface PaperRec { staff_id: string; kind: string; occurred_on: string; doc_no: string | null; data: Record<string, unknown> | null; files: string[] }
const ymd = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '');

/** Mỗi loại giấy lấy bản mới nhất: bản "đang dùng" trước; giấy khám SK / tập huấn so thêm bản cũ khác và dòng lý lịch,
 *  bản nào cấp sau (hoặc hạn xa hơn) thì hiện bản đó, kèm ảnh của chính bản đó. */
function newestPapers(docs: Doc[], recs: PaperRec[]): Doc[] {
  const out: Doc[] = [];
  for (const type of [...new Set(docs.map((d) => d.doc_type).concat(Object.keys(RECORD_OF)))]) {
    const same = docs.filter((d) => d.doc_type === type);
    const key = (d: { issued: string; exp: string }) => `${d.issued}|${d.exp}`;
    let best: Doc | undefined = same.find((d) => d.is_current);
    if (RECORD_OF[type]) {
      const cands = [
        ...same.map((d) => ({ doc: d, issued: ymd(d.issued_on) || ymd(d.valid_from), exp: ymd(d.expires_on) })),
        ...recs.filter((r) => r.kind === RECORD_OF[type]).map((r) => ({
          doc: { ...(best ?? same[0] ?? ({ id: `ll:${type}:${r.occurred_on}`, staff_id: r.staff_id, vehicle_id: null, doc_type: type, issuer: null, valid_from: null, data: {}, note: null, is_current: true, created_at: '' } as unknown as Doc)),
            doc_no: r.doc_no, issued_on: r.occurred_on, expires_on: ymd(r.data?.het_han) || null, files: r.files } as Doc,
          issued: ymd(r.occurred_on), exp: ymd(r.data?.het_han) })),
      ];
      const top = cands.sort((a, b) => key(b).localeCompare(key(a)))[0];
      if (top && (!best || key(top) > key({ issued: ymd(best.issued_on) || ymd(best.valid_from), exp: ymd(best.expires_on) }))) best = top.doc;
    }
    if (best) out.push(best);
  }
  return out;
}

/** Giấy tờ để xuất trình khi cơ quan chức năng kiểm tra (như app cũ): giấy tờ cá nhân + giấy tờ xe mình chạy, bấm Xem để mở ảnh */
function MyPapers({ staffId, plates }: { staffId: string; plates: string[] }) {
  const [mine, setMine] = useState<Doc[]>([]);
  const [cars, setCars] = useState<{ id: string; plate: string }[]>([]);
  const [carDocs, setCarDocs] = useState<Doc[]>([]);
  useEffect(() => {
    // Lấy cả bản cũ + lý lịch (Theo dõi sức khỏe / Đào tạo) để hiện giấy MỚI NHẤT như trang quản lý,
    // không chỉ bản đánh dấu "đang dùng" (giấy khám SK mới thường nằm ở lý lịch / bản thêm sau)
    void (async () => {
      const [d, r] = await Promise.all([
        supabase.from('documents').select(DOC_COLS).eq('staff_id', staffId),
        supabase.from('staff_records').select('staff_id, kind, occurred_on, doc_no, data, files').eq('staff_id', staffId).in('kind', Object.values(RECORD_OF)),
      ]);
      setMine(newestPapers((d.data ?? []) as Doc[], (r.data ?? []) as PaperRec[]));
    })();
  }, [staffId]);
  const key = plates.join('|');
  useEffect(() => {
    if (!key) { setCars([]); setCarDocs([]); return; }
    void (async () => {
      const v = await supabase.from('vehicles').select('id, plate').in('plate', key.split('|'));
      const l = ((v.data ?? []) as { id: string; plate: string }[]).sort((a, b) => key.split('|').indexOf(a.plate) - key.split('|').indexOf(b.plate));
      setCars(l);
      if (!l.length) { setCarDocs([]); return; }
      const d = await supabase.from('documents').select(DOC_COLS).in('vehicle_id', l.map((x) => x.id)).eq('is_current', true);
      setCarDocs((d.data ?? []) as Doc[]);
    })();
  }, [key]);
  const row = (code: string, doc: Doc | undefined) => {
    const def = DOC_TYPES.find((x) => x.code === code)!;
    const st = docState(def, doc, 30, def.required);
    const hang = doc?.data?.hang ? ` · Hạng ${String(doc.data.hang)}` : '';
    return (
      <li key={code} className="item paper-row">
        <div>
          <b>{def.name}</b>
          <div className={`small state-${st.state}`}>{doc?.doc_no ? `Số ${doc.doc_no}${hang} · ` : ''}{st.text}</div>
        </div>
        {doc && doc.files.length > 0 ? <FilesViewButton files={doc.files} label="Xem" /> : <span className="muted small">Chưa có ảnh</span>}
      </li>
    );
  };
  const personal = ['cccd', 'gplx', 'tap_huan', 'kham_suc_khoe', 'hop_dong_ld'].filter((c) => ['cccd', 'gplx'].includes(c) || mine.some((d) => d.doc_type === c));
  const carTypes = DOC_TYPES.filter((d) => d.owner === 'xe');
  return (
    <>
      <section className="card">
        <h2>Giấy tờ của tôi</h2>
        <p className="muted small">Xuất trình khi cơ quan chức năng kiểm tra · bấm Xem để mở ảnh giấy tờ</p>
        <ul className="list">{personal.map((c) => row(c, mine.find((d) => d.doc_type === c)))}</ul>
      </section>
      {cars.length > 0 && (
        <section className="card">
          <h2>Giấy tờ xe tôi chạy</h2>
          {cars.map((v) => (
            <div key={v.id} className="sub">
              <b>Xe {v.plate}</b>{v.plate === plates[0] ? <span className="badge">Gần nhất</span> : null}
              <ul className="list">{carTypes.filter((t) => t.required || carDocs.some((d) => d.vehicle_id === v.id && d.doc_type === t.code))
                .map((t) => row(t.code, carDocs.find((d) => d.vehicle_id === v.id && d.doc_type === t.code)))}</ul>
            </div>
          ))}
        </section>
      )}
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
function TripRun({ trip, stopName, reload, scanned, onScan }: { trip: MyTrip; stopName: (id: string) => string; reload: () => Promise<void>; scanned: boolean; onScan: () => void }) {
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

  // Dấu thay đổi (số vé/hàng + lần sửa mới nhất): chỉ khi đổi mới tải lại cả chuyến – tiết kiệm băng thông
  const sigRef = useRef<string | null>(null);
  const tripSig = useCallback(async (): Promise<string | null> => {
    const [a, b] = await Promise.all([
      supabase.from('seat_inventory').select('updated_at', { count: 'exact' }).eq('trip_id', trip.trip_id).in('status', ['dat', 'da_tt'])
        .order('updated_at', { ascending: false }).limit(1),
      supabase.from('shipments').select('updated_at', { count: 'exact' }).eq('trip_id', trip.trip_id).neq('status', 'huy')
        .order('updated_at', { ascending: false }).limit(1),
    ]);
    meter('Lái xe: kiểm tra chuyến có đổi', [a.data, b.data]);
    if (a.error || b.error) return null;
    const ta = (a.data ?? []) as { updated_at: string }[];
    const tb = (b.data ?? []) as { updated_at: string }[];
    return `${a.count ?? 0}|${ta[0]?.updated_at ?? ''}|${b.count ?? 0}|${tb[0]?.updated_at ?? ''}`;
  }, [trip.trip_id]);
  const load = useCallback(async () => {
    sigRef.current = null;
    const [ps, t] = await Promise.all([
      supabase.from('shipments').select(SHIP_COLS).eq('trip_id', trip.trip_id).neq('status', 'huy').order('created_at'),
      supabase.from('seat_inventory').select(TICKET_COLS).eq('trip_id', trip.trip_id).in('status', ['dat', 'da_tt']),
    ]);
    meter('Lái xe: tải cả chuyến', [...(ps.data ?? []), ...(t.data ?? [])]);
    setParcels((ps.data ?? []) as Shipment[]);
    if (t.error) return toast('error', t.error.message);
    const list = (t.data ?? []) as Ticket[];
    setTickets(list);
    const ids = [...new Set(list.map((x) => x.booking_id))];
    if (ids.length) {
      const b = await supabase.from('bookings').select('id, code').in('id', ids);
      setCodes(Object.fromEntries(((b.data ?? []) as { id: string; code: string }[]).map((x) => [x.id, x.code])));
    }
    if (!ps.error) sigRef.current = await tripSig().catch(() => null);
  }, [trip.trip_id, toast, tripSig]);
  const check = useCallback(async () => {
    if (document.hidden || !navigator.onLine) return;
    const s = await tripSig().catch(() => null);
    if (s === null || s !== sigRef.current) await load();
  }, [tripSig, load]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void check(), 20000);   // vé bán thêm / quầy đổi ở nơi khác (tab ẩn thì nghỉ)
    const vis = () => { if (!document.hidden) void check(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [load, check]);
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
            <button className={scanned ? 'btn small scan-ok' : 'btn small'} onClick={onScan}>{scanned ? '✅ Đã scan lệnh' : '📷 Scan lệnh'}</button>
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
