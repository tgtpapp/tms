// Cấp lệnh vận chuyển 4 lượt (2 đi + 2 về) trên 1 tờ: lấy tự động theo lịch xếp xe, chỉnh tay (chọn chuyến khác, sửa giờ / ngày),
// rồi in đúng mẫu lệnh của nhà xe kèm chữ ký (Giám đốc + dấu, lái xe 1, lái xe 2, cán bộ điều hành cấp lệnh) theo quy tắc in chữ ký.
// Dùng chung ở Bán vé và Điều hành.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Modal } from './Modal';
import { fmtDate } from './Documents';
import { TransportOrderPrint, type OrderPrintData } from './TransportOrder';
import { signatureUrl } from '../lib/documents';
import { dirName, reverseItinerary, type Dir } from '../lib/routes';
import { loadSigns, showName } from '../lib/signatures';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

const TZ = 'Asia/Ho_Chi_Minh';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const TITLES = ['Lượt đi 1', 'Lượt về 1', 'Lượt đi 2', 'Lượt về 2'];

interface Leg { seq: number; trip_id: string | null; time: string; date: string }
interface Cand { id: string; route_id: string; direction: Dir; depart_at: string; service_date: string }
interface PrintRow {
  order_no: string; issued_at: string; valid_from: string; valid_to: string; issued_by: string | null; sign: boolean; seal: boolean;
  issuer: { staff_id: string; name: string } | null; issuer_name: string | null; company: string | null; signer_title: string | null; signer_name: string | null;
  plate: string | null; seats: number | null; direction: Dir;
  route: { name: string; name_ve: string | null; distance_km: number | null; registered_code: string | null; itinerary: string | null; itinerary_ve: string | null };
  stop_a: string | null; stop_b: string | null;
  crew: { role: string; staff_id: string; user_id: string | null; name: string; hang: string | null }[];
  legs: { seq: number; time: string | null; date: string | null }[];
}

/** Dựng dữ liệu in của 1 lệnh đã cấp (dữ liệu lấy qua hàm in lệnh: người bán vé không cần quyền xem hồ sơ nhân viên) */
export async function loadOrderPrint(orderId: string, tenantId: string, me: { id: string | null; name: string }): Promise<OrderPrintData> {
  const p = await rpc<PrintRow>('transport_order_print', { p_order_id: orderId });
  const c = (r: string) => p.crew.find((x) => x.role === r);
  const nv = (r: string) => (c(r) ? `nv_${c(r)!.staff_id}` : null);
  const keys = ['giam_doc', p.issued_by, p.issuer && `nv_${p.issuer.staff_id}`, c('lai_xe_1')?.user_id, c('lai_xe_2')?.user_id, nv('lai_xe_1'), nv('lai_xe_2')];
  const [sg, seal, qr] = await Promise.all([
    loadSigns(tenantId, keys),
    p.seal ? signatureUrl(tenantId, 'con_dau') : Promise.resolve(null),
    QRCode.toDataURL(`LVC ${p.order_no} | ${p.plate ?? ''} | ${p.route.name} | ${fmtDate(p.valid_from)}`, { margin: 0, width: 240 }),
  ]);
  // chữ ký hồ sơ nhân viên trước, chưa có thì chữ ký theo tài khoản
  const pick = (a: string | null | undefined, b: string | null | undefined) => { const x = a ? sg.get(a) : undefined; return x?.img ? x : (b ? sg.get(b) : undefined); };
  const gd = p.sign ? sg.get('giam_doc') : undefined;
  const s1 = pick(nv('lai_xe_1'), c('lai_xe_1')?.user_id), s2 = pick(nv('lai_xe_2'), c('lai_xe_2')?.user_id), dh = pick(p.issuer && `nv_${p.issuer.staff_id}`, p.issued_by);
  const [a, b] = [p.stop_a ?? '', p.stop_b ?? ''], [from, to] = p.direction === 'di' ? [a, b] : [b, a];
  const who = (r: string) => (c(r) ? { name: c(r)!.name, hang: c(r)!.hang } : null);
  return {
    orderNo: p.order_no, issueDate: new Date(p.issued_at).toLocaleDateString('sv-SE', { timeZone: TZ }), validFrom: p.valid_from, validTo: p.valid_to,
    company: p.company ?? '', signerTitle: p.signer_title || 'Giám đốc', signerName: p.signer_name ?? '',
    signerImg: gd?.img ?? null, sealImg: seal, signerShowName: showName(gd),
    dispatcherName: p.issuer?.name ?? p.issuer_name ?? (p.issued_by && p.issued_by === me.id ? me.name : null), dispatcherImg: dh?.img ?? null, dispatcherShowName: showName(dh),
    driver1Sign: s1?.img ?? null, driver1ShowName: showName(s1), driver2Sign: s2?.img ?? null, driver2ShowName: showName(s2),
    driver1: who('lai_xe_1'), driver2: who('lai_xe_2'), assistant: c('phu_xe')?.name ?? null,
    plate: p.plate ?? '', seats: p.seats, routeName: dirName(p.route, p.direction), distanceKm: p.route.distance_km, registeredCode: p.route.registered_code,
    itinerary: (p.direction === 've' ? p.route.itinerary_ve || reverseItinerary(p.route.itinerary ?? '') : p.route.itinerary) || null,
    fromStop: from, toStop: to,
    legs: [1, 2, 3, 4].map((i) => { const l = p.legs.find((x) => x.seq === i); return { time: l?.time ?? null, date: l?.date ?? null }; }),
    qr,
  };
}

/** Nút "Cấp lệnh": xem / chỉnh 4 lượt rồi cấp + in */
export function OrderIssue({ tripId, tenantId, me, onClose, onDone }: { tripId: string; tenantId: string; me: { id: string | null; name: string }; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const [legs, setLegs] = useState<Leg[] | null>(null);
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [cands, setCands] = useState<Cand[]>([]);
  const [routes, setRoutes] = useState<{ id: string; name: string; name_ve: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState<OrderPrintData | null>(null);
  const [sign, setSign] = useState(true);
  const [seal, setSeal] = useState(true);
  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const [d, t] = await Promise.all([
          rpc<{ order_no: string | null; sign: boolean; seal: boolean; legs: { seq: number; trip_id: string | null; time: string | null; date: string | null }[] }>('transport_order_draft', { p_trip_id: tripId }),
          supabase.from('trips').select('vehicle_id, service_date').eq('id', tripId).single(),
        ]);
        const tr = t.data as { vehicle_id: string | null; service_date: string };
        const [c, r] = await Promise.all([
          tr.vehicle_id ? supabase.from('trips').select('id, route_id, direction, depart_at, service_date').eq('vehicle_id', tr.vehicle_id).eq('status', 'mo')
            .gte('service_date', addDays(tr.service_date, -1)).lte('service_date', addDays(tr.service_date, 1)).order('depart_at') : Promise.resolve({ data: [] }),
          supabase.from('routes').select('id, name, name_ve'),
        ]);
        if (!on) return;
        setCands((c.data ?? []) as Cand[]);
        setRoutes((r.data ?? []) as { id: string; name: string; name_ve: string | null }[]);
        setOrderNo(d.order_no);
        setSign(d.sign !== false); setSeal(d.seal !== false);
        setLegs([1, 2, 3, 4].map((i) => { const l = d.legs.find((x) => x.seq === i); return { seq: i, trip_id: l?.trip_id ?? null, time: l?.time ?? '', date: l?.date ?? '' }; }));
      } catch (e) { toast('error', errMsg(e)); onClose(); }
    })();
    return () => { on = false; };
  }, [tripId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const label = (c: Cand) => `${hhmm(c.depart_at)} ${fmtDate(c.service_date)} · ${dirName(routes.find((r) => r.id === c.route_id), c.direction)}`;
  const set = (i: number, p: Partial<Leg>) => setLegs((L) => L && L.map((x, k) => (k === i ? { ...x, ...p } : x)));
  async function issue() {
    if (!legs) return;
    if (!legs[0]?.trip_id) return toast('error', 'Lượt đi 1 phải chọn chuyến');
    setBusy(true);
    try {
      const o = await rpc<{ id: string }>('save_transport_order', { p_trip_id: tripId, p_legs: legs.map((l) => ({ seq: l.seq, trip_id: l.trip_id, time: l.time || null, date: l.date || null })) });
      await rpc('set_order_print', { p_order_id: o.id, p_sign: sign, p_seal: seal });
      setPrinting(await loadOrderPrint(o.id, tenantId, me));
      onDone?.();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  if (printing) return <TransportOrderPrint data={printing} onClose={onClose} />;
  return (
    <Modal title={orderNo ? `Lệnh vận chuyển ${orderNo}` : 'Cấp lệnh vận chuyển'} onClose={onClose}>
      {!legs ? <p className="muted">Đang lấy lịch xếp xe…</p> : (
        <div className="form">
          <p className="small muted">{orderNo ? 'Lệnh đã cấp: sửa lượt rồi bấm Lưu & in lại (giữ số lệnh).' : 'Các lượt lấy theo lịch xếp xe của xe này; chọn chuyến khác hoặc sửa giờ / ngày nếu cần.'}</p>
          {legs.map((l, i) => (
            <fieldset key={l.seq} className="ord-leg">
              <legend>{TITLES[i]}</legend>
              <label>Chuyến<select aria-label={`Chuyến ${TITLES[i]}`} value={l.trip_id ?? ''} onChange={(e) => {
                const c = cands.find((x) => x.id === e.target.value);
                set(i, c ? { trip_id: c.id, time: hhmm(c.depart_at), date: c.service_date } : { trip_id: null });
              }}>
                <option value="">{i === 0 ? 'Chọn chuyến' : '— Không có / ghi tay —'}</option>
                {cands.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}
              </select></label>
              <div className="grid2">
                <label>Giờ xuất bến<input type="time" aria-label={`Giờ ${TITLES[i]}`} value={l.time} onChange={(e) => set(i, { time: e.target.value })} /></label>
                <label>Ngày<input type="date" aria-label={`Ngày ${TITLES[i]}`} value={l.date} onChange={(e) => set(i, { date: e.target.value })} /></label>
              </div>
            </fieldset>
          ))}
          <div className="ord-opt">
            <label className="check"><input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} /> In chữ ký Giám đốc</label>
            <label className="check"><input type="checkbox" checked={seal} onChange={(e) => setSeal(e.target.checked)} /> In con dấu</label>
          </div>
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void issue()}>{busy ? 'Đang cấp…' : orderNo ? 'Lưu & in lại' : 'Cấp lệnh & in'}</button>
            <button type="button" className="btn link" onClick={onClose}>Thôi</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
