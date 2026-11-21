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
interface Order { id: string; trip_id: string; order_no: string; valid_from: string; valid_to: string; issued_at: string; issued_by: string | null }

/** Dựng dữ liệu in của 1 lệnh (đã cấp) */
export async function loadOrderPrint(orderId: string, tenantId: string, me: { id: string | null; name: string }): Promise<OrderPrintData> {
  const o = (await supabase.from('transport_orders').select('id, trip_id, order_no, valid_from, valid_to, issued_at, issued_by').eq('id', orderId).single()).data as Order | null;
  if (!o) throw new Error('Không tìm thấy lệnh');
  const [lg, tr] = await Promise.all([
    supabase.from('transport_order_legs').select('seq, depart_time, depart_date').eq('order_id', o.id).order('seq'),
    supabase.from('trips').select('id, route_id, direction, vehicle_id, service_date').eq('id', o.trip_id).single(),
  ]);
  const t = tr.data as { id: string; route_id: string; direction: Dir; vehicle_id: string | null; service_date: string };
  const [rt, rs, vh, cr, tn, ss, lm] = await Promise.all([
    supabase.from('routes').select('name, name_ve, distance_km, registered_code, itinerary, itinerary_ve').eq('id', t.route_id).single(),
    supabase.from('route_stops').select('seq, stop_id').eq('route_id', t.route_id).order('seq'),
    supabase.from('vehicles').select('plate, vehicle_type_id').eq('id', t.vehicle_id ?? '').maybeSingle(),
    supabase.from('trip_crew').select('role, staff_id').eq('trip_id', t.id).eq('active', true),
    supabase.from('tenants').select('name, legal_name').maybeSingle(),
    supabase.from('tenant_settings').select('key, value').in('key', ['cong_ty.giam_doc', 'cong_ty.chuc_danh_ky', 'in.chu_ky_giam_doc', 'in.con_dau']),
    rpc<{ staff_id: string; vehicle_type_id: string; license_class: string | null }[]>('license_matrix', {}).catch(() => []),
  ]);
  const route = rt.data as { name: string; name_ve: string | null; distance_km: number | null; registered_code: string | null; itinerary: string | null; itinerary_ve: string | null } | null;
  const stopRows = (rs.data ?? []) as { seq: number; stop_id: string }[];
  const veh = vh.data as { plate: string; vehicle_type_id: string } | null;
  const crew = (cr.data ?? []) as { role: 'lai_xe_1' | 'lai_xe_2' | 'phu_xe'; staff_id: string }[];
  const ids = [...new Set([...crew.map((c) => c.staff_id)])];
  const [sm, vt, stp, issuer] = await Promise.all([
    ids.length ? supabase.from('staff_members').select('id, full_name, user_id').in('id', ids) : Promise.resolve({ data: [] }),
    veh ? supabase.from('vehicle_types').select('reg_seats, reg_berths').eq('id', veh.vehicle_type_id).maybeSingle() : Promise.resolve({ data: null }),
    stopRows.length ? supabase.from('stops').select('id, name').in('id', [stopRows[0]!.stop_id, stopRows[stopRows.length - 1]!.stop_id]) : Promise.resolve({ data: [] }),
    o.issued_by ? supabase.from('staff_members').select('id, full_name').eq('user_id', o.issued_by).limit(1) : Promise.resolve({ data: [] }),
  ]);
  const staff = (sm.data ?? []) as { id: string; full_name: string; user_id: string | null }[];
  const stops = (stp.data ?? []) as { id: string; name: string }[];
  const sName = (id: string | undefined) => stops.find((x) => x.id === id)?.name ?? '';
  const A = sName(stopRows[0]?.stop_id), B = sName(stopRows[stopRows.length - 1]?.stop_id);
  const [from, to] = t.direction === 'di' ? [A, B] : [B, A];
  const sid = (r: string) => crew.find((c) => c.role === r)?.staff_id ?? null;
  const st = (r: string) => staff.find((s) => s.id === sid(r));
  const who = (r: string) => { const s = st(r); return s ? { name: s.full_name, hang: ((lm as { staff_id: string; vehicle_type_id: string; license_class: string | null }[]).find((l) => l.staff_id === s.id && l.vehicle_type_id === veh?.vehicle_type_id)?.license_class) ?? null } : null; };
  const iss = ((issuer.data ?? []) as { id: string; full_name: string }[])[0];
  const raw = (k: string) => ((ss.data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value;
  const keys = ['giam_doc', o.issued_by, iss && `nv_${iss.id}`, st('lai_xe_1')?.user_id, st('lai_xe_2')?.user_id, sid('lai_xe_1') && `nv_${sid('lai_xe_1')}`, sid('lai_xe_2') && `nv_${sid('lai_xe_2')}`];
  const [sg, seal, qr] = await Promise.all([
    loadSigns(tenantId, keys),
    raw('in.con_dau') === false ? Promise.resolve(null) : signatureUrl(tenantId, 'con_dau'),
    QRCode.toDataURL(`LVC ${o.order_no} | ${veh?.plate ?? ''} | ${route?.name ?? ''} | ${fmtDate(o.valid_from)}`, { margin: 0, width: 240 }),
  ]);
  // chữ ký hồ sơ nhân viên trước, chưa có thì chữ ký theo tài khoản
  const pick = (a: string | null | undefined, b: string | null | undefined) => { const x = a ? sg.get(a) : undefined; return x?.img ? x : (b ? sg.get(b) : undefined); };
  const gd = raw('in.chu_ky_giam_doc') === false ? undefined : sg.get('giam_doc');
  const s1 = pick(sid('lai_xe_1') && `nv_${sid('lai_xe_1')}`, st('lai_xe_1')?.user_id), s2 = pick(sid('lai_xe_2') && `nv_${sid('lai_xe_2')}`, st('lai_xe_2')?.user_id);
  const dh = pick(iss && `nv_${iss.id}`, o.issued_by);
  const tnRow = (tn.data ?? {}) as { name?: string; legal_name?: string | null };
  const legRows = (lg.data ?? []) as { seq: number; depart_time: string | null; depart_date: string | null }[];
  return {
    orderNo: o.order_no, issueDate: new Date(o.issued_at).toLocaleDateString('sv-SE', { timeZone: TZ }), validFrom: o.valid_from, validTo: o.valid_to,
    company: tnRow.legal_name || tnRow.name || '', signerTitle: (raw('cong_ty.chuc_danh_ky') as string) || 'Giám đốc', signerName: (raw('cong_ty.giam_doc') as string) ?? '',
    signerImg: gd?.img ?? null, sealImg: seal, signerShowName: showName(gd),
    dispatcherName: iss?.full_name ?? (o.issued_by && o.issued_by === me.id ? me.name : null), dispatcherImg: dh?.img ?? null, dispatcherShowName: showName(dh),
    driver1Sign: s1?.img ?? null, driver1ShowName: showName(s1), driver2Sign: s2?.img ?? null, driver2ShowName: showName(s2),
    driver1: who('lai_xe_1'), driver2: who('lai_xe_2'), assistant: who('phu_xe')?.name ?? null,
    plate: veh?.plate ?? '', seats: vt.data ? (vt.data as { reg_seats: number; reg_berths: number }).reg_seats + (vt.data as { reg_seats: number; reg_berths: number }).reg_berths : null,
    routeName: dirName(route ?? undefined, t.direction), distanceKm: route?.distance_km ?? null, registeredCode: route?.registered_code ?? null,
    itinerary: (t.direction === 've' ? route?.itinerary_ve || reverseItinerary(route?.itinerary ?? '') : route?.itinerary) || null,
    fromStop: from, toStop: to,
    legs: [1, 2, 3, 4].map((i) => { const l = legRows.find((x) => x.seq === i); return { time: l?.depart_time ?? null, date: l?.depart_date ?? null }; }),
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
  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const [d, t] = await Promise.all([
          rpc<{ order_no: string | null; legs: { seq: number; trip_id: string | null; time: string | null; date: string | null }[] }>('transport_order_draft', { p_trip_id: tripId }),
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
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void issue()}>{busy ? 'Đang cấp…' : orderNo ? 'Lưu & in lại' : 'Cấp lệnh & in'}</button>
            <button type="button" className="btn link" onClick={onClose}>Thôi</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
