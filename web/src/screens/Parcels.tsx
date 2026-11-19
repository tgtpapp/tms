// Giai đoạn 6.3 – Gửi hàng: nhận hàng (thu cước), gắn chuyến, đã đến, giao hàng (thu cước người nhận + thu hộ), trả thu hộ, hủy.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { fmtDate, today } from '../components/Documents';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

type Status = 'nhan' | 'tren_xe' | 'den' | 'giao' | 'huy';
export interface Shipment {
  id: string; code: string; trip_id: string | null; service_date: string; from_stop_id: string; to_stop_id: string;
  sender_name: string | null; sender_phone: string; receiver_name: string | null; receiver_phone: string; description: string;
  packages: number; weight_kg: number | null; fee: number; fee_payer: 'nguoi_gui' | 'nguoi_nhan'; fee_paid_at: string | null;
  cod_amount: number; cod_collected_at: string | null; cod_paid_out_at: string | null; status: Status; note: string | null;
  delivered_to: string | null;
}
export const SHIP_COLS = 'id, code, trip_id, service_date, from_stop_id, to_stop_id, sender_name, sender_phone, receiver_name, receiver_phone, description, packages, weight_kg, fee, fee_payer, fee_paid_at, cod_amount, cod_collected_at, cod_paid_out_at, status, note, delivered_to';
export const STATUS: Record<Status, [string, string]> = {
  nhan: ['Đã nhận', 'idle'], tren_xe: ['Đã lên xe', 'warn-badge'], den: ['Đã đến', 'warn-badge'], giao: ['Đã giao', ''], huy: ['Đã hủy', 'locked'],
};
const TZ = 'Asia/Ho_Chi_Minh';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
export const money = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
/** Số tiền còn phải thu khi giao */
export const dueOnDelivery = (s: Shipment) => (s.fee_paid_at ? 0 : s.fee) + (s.cod_collected_at ? 0 : s.cod_amount);

interface Trip { id: string; depart_at: string; route_id: string; direction: 'di' | 've' }
interface Stop { id: string; name: string }
const EMPTY = { trip_id: '', from: '', to: '', sender_name: '', sender_phone: '', receiver_name: '', receiver_phone: '', description: '',
  packages: '1', weight: '', value: '', fee: '', payer: 'nguoi_gui' as 'nguoi_gui' | 'nguoi_nhan', cod: '', method: 'tien_mat', note: '' };

export function ParcelsScreen() {
  const toast = useToast();
  const [day, setDay] = useState(today());
  const [list, setList] = useState<Shipment[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [f, setF] = useState(EMPTY);
  const [req, setReq] = useState(() => crypto.randomUUID());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, t, st, r] = await Promise.all([
      q.replace(/\D/g, '').length >= 6
        ? supabase.from('shipments').select(SHIP_COLS).or(`receiver_phone.ilike.%${q.replace(/\D/g, '')}%,sender_phone.ilike.%${q.replace(/\D/g, '')}%`).order('created_at', { ascending: false }).limit(50)
        : supabase.from('shipments').select(SHIP_COLS).eq('service_date', day).order('created_at', { ascending: false }),
      supabase.from('trips').select('id, depart_at, route_id, direction').eq('service_date', day).eq('status', 'mo').order('depart_at'),
      supabase.from('stops').select('id, name').eq('is_active', true).order('name'),
      supabase.from('routes').select('id, name'),
    ]);
    const err = s.error ?? t.error ?? st.error ?? r.error;
    if (err) return toast('error', err.message);
    setList((s.data ?? []) as Shipment[]);
    setTrips((t.data ?? []) as Trip[]);
    setStops((st.data ?? []) as Stop[]);
    setRoutes(Object.fromEntries(((r.data ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name])));
  }, [day, q, toast]);
  useEffect(() => { void load(); }, [load]);

  const stopName = (id: string) => stops.find((s) => s.id === id)?.name ?? '?';
  const tripName = (id: string | null) => {
    const t = trips.find((x) => x.id === id);
    return t ? `${hhmm(t.depart_at)} ${routes[t.route_id] ?? ''}` : '';
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await rpc<{ code: string; repeated: boolean }>('create_shipment', {
        p: {
          trip_id: f.trip_id || null, service_date: day, from_stop_id: f.from, to_stop_id: f.to, sender_name: f.sender_name, sender_phone: f.sender_phone,
          receiver_name: f.receiver_name, receiver_phone: f.receiver_phone, description: f.description, packages: Number(f.packages) || 1,
          weight_kg: f.weight || null, declared_value: f.value || null, fee: Number(f.fee) || 0, fee_payer: f.payer, cod_amount: Number(f.cod) || 0, note: f.note,
        },
        p_method: f.payer === 'nguoi_gui' ? f.method : null, p_request_id: req,
      });
      toast('ok', `Đã nhận hàng, phiếu ${r.code}${f.payer === 'nguoi_gui' && Number(f.fee) ? ` · thu cước ${money(Number(f.fee))}` : ''}`);
      setF({ ...EMPTY, trip_id: f.trip_id, from: f.from, to: f.to });
      setReq(crypto.randomUUID());
      await load();
    } catch (err) {
      toast('error', errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="card form" onSubmit={(e) => void create(e)}>
        <h2>Nhận hàng gửi</h2>
        <div className="grid2">
          <label>Đi chuyến (có thể chọn sau)
            <select value={f.trip_id} onChange={(e) => setF({ ...f, trip_id: e.target.value })}>
              <option value="">Chưa chọn chuyến</option>
              {trips.map((t) => <option key={t.id} value={t.id}>{tripName(t.id)}</option>)}
            </select>
          </label>
          <label>Hàng gì<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="vd 1 thùng trái cây" required /></label>
          <label>Gửi tại
            <select value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} required>
              <option value="">Chọn nơi gửi</option>
              {stops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>Nhận tại
            <select value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} required>
              <option value="">Chọn nơi nhận</option>
              {stops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>SĐT người gửi<input inputMode="tel" value={f.sender_phone} onChange={(e) => setF({ ...f, sender_phone: e.target.value })} required /></label>
          <label>Tên người gửi<input value={f.sender_name} onChange={(e) => setF({ ...f, sender_name: e.target.value })} /></label>
          <label>SĐT người nhận<input inputMode="tel" value={f.receiver_phone} onChange={(e) => setF({ ...f, receiver_phone: e.target.value })} required /></label>
          <label>Tên người nhận<input value={f.receiver_name} onChange={(e) => setF({ ...f, receiver_name: e.target.value })} /></label>
          <label>Số kiện<input type="number" min={1} inputMode="numeric" value={f.packages} onChange={(e) => setF({ ...f, packages: e.target.value })} /></label>
          <label>Cân nặng (kg)<input type="number" min={0} step="0.1" inputMode="decimal" value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} /></label>
          <label>Giá trị khai báo (đồng)<input type="number" min={0} inputMode="numeric" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></label>
          <label>Cước (đồng)<input type="number" min={0} step={1000} inputMode="numeric" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} required /></label>
          <label>Người trả cước
            <select value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value as 'nguoi_gui' | 'nguoi_nhan' })}>
              <option value="nguoi_gui">Người gửi (thu ngay)</option>
              <option value="nguoi_nhan">Người nhận (thu khi giao)</option>
            </select>
          </label>
          {f.payer === 'nguoi_gui' && (
            <label>Thu cước bằng
              <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
                <option value="tien_mat">Tiền mặt</option>
                <option value="chuyen_khoan">Chuyển khoản</option>
              </select>
            </label>
          )}
          <label>Thu hộ (COD, đồng)<input type="number" min={0} step={1000} inputMode="numeric" value={f.cod} onChange={(e) => setF({ ...f, cod: e.target.value })} placeholder="0 nếu không thu hộ" /></label>
          <label>Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        </div>
        <button className="btn primary" disabled={busy}>Nhận hàng</button>
      </form>

      <section className="card">
        <h2>Phiếu gửi hàng {q ? '(tìm theo SĐT)' : `ngày ${fmtDate(day)}`} ({list.length})</h2>
        <div className="inline-form">
          <label>Ngày<input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
          <label>Tìm SĐT người gửi / nhận<input inputMode="tel" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ít nhất 6 số" /></label>
        </div>
        {list.length === 0 && <p className="muted">Chưa có phiếu.</p>}
        <ul className="list">
          {list.map((s) => <ParcelRow key={s.id} s={s} stopName={stopName} tripName={tripName} trips={trips} reload={load} manage />)}
        </ul>
      </section>
    </>
  );
}

/** Một phiếu: dùng ở màn Gửi hàng và màn lái xe (manage = false: chỉ báo đến, giao hàng) */
export function ParcelRow({ s, stopName, tripName, trips, reload, manage }: {
  s: Shipment; stopName: (id: string) => string; tripName: (id: string | null) => string; trips: Trip[] | null;
  reload: () => Promise<void>; manage: boolean;
}) {
  const toast = useToast();
  const [act, setAct] = useState<'' | 'xe' | 'giao' | 'huy'>('');
  const [v, setV] = useState({ trip: s.trip_id ?? '', receiver: s.receiver_name ?? '', method: 'tien_mat', reason: '' });
  const due = dueOnDelivery(s);
  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast('ok', ok);
      setAct('');
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }
  const [lb, cls] = STATUS[s.status];
  return (
    <li className="item">
      <div className="item-head">
        <div>
          <b>{s.code}</b> <span className={`badge ${cls}`}>{lb}</span>
          <div className="small">{s.description} · {s.packages} kiện{s.weight_kg ? ` · ${s.weight_kg} kg` : ''} · {stopName(s.from_stop_id)} → {stopName(s.to_stop_id)}</div>
          <div className="small">Nhận: {s.receiver_name ?? ''} <a href={`tel:${s.receiver_phone}`}>{s.receiver_phone}</a> · Gửi: {s.sender_name ?? ''} <a href={`tel:${s.sender_phone}`}>{s.sender_phone}</a></div>
          <div className="small muted">
            Cước {money(s.fee)} ({s.fee_paid_at ? 'đã thu' : 'người nhận trả'}){s.cod_amount ? ` · Thu hộ ${money(s.cod_amount)}${s.cod_paid_out_at ? ' (đã trả người gửi)' : s.cod_collected_at ? ' (đã thu, chưa trả người gửi)' : ''}` : ''}
            {s.trip_id ? ` · Chuyến ${tripName(s.trip_id)}` : ''}{s.delivered_to ? ` · Giao cho ${s.delivered_to}` : ''}
          </div>
        </div>
        {s.status !== 'giao' && s.status !== 'huy' && (
          <div className="actions">
            {manage && s.status === 'nhan' && <button className="btn small" onClick={() => setAct('xe')}>Lên xe</button>}
            {(s.status === 'nhan' || s.status === 'tren_xe') && (
              <button className="btn small" onClick={() => void run(() => rpc('set_shipment_status', { p_id: s.id, p_status: 'den', p_trip_id: null, p_reason: null }), `Phiếu ${s.code} đã đến`)}>Đã đến</button>
            )}
            <button className="btn small primary" onClick={() => setAct('giao')}>Giao hàng{due ? ` · thu ${money(due)}` : ''}</button>
            {manage && <button className="btn small link" onClick={() => setAct('huy')}>Hủy</button>}
          </div>
        )}
        {manage && s.status === 'giao' && s.cod_amount > 0 && !s.cod_paid_out_at && (
          <button className="btn small primary" onClick={() => void run(() => rpc('pay_out_cod', { p_id: s.id, p_method: 'tien_mat' }), `Đã trả thu hộ ${money(s.cod_amount)} cho người gửi`)}>
            Trả thu hộ {money(s.cod_amount)}
          </button>
        )}
      </div>
      {act === 'xe' && trips && (
        <div className="inline-form">
          <label>Chuyến<select value={v.trip} onChange={(e) => setV({ ...v, trip: e.target.value })}>
            <option value="">Chọn chuyến</option>
            {trips.map((t) => <option key={t.id} value={t.id}>{tripName(t.id)}</option>)}
          </select></label>
          <button className="btn small primary" disabled={!v.trip} onClick={() => void run(() => rpc('set_shipment_status', { p_id: s.id, p_status: 'tren_xe', p_trip_id: v.trip, p_reason: null }), `Phiếu ${s.code} đã lên xe`)}>Xác nhận</button>
          <button className="btn small link" onClick={() => setAct('')}>Thôi</button>
        </div>
      )}
      {act === 'giao' && (
        <div className="inline-form">
          <label>Người nhận hàng<input value={v.receiver} onChange={(e) => setV({ ...v, receiver: e.target.value })} /></label>
          {due > 0 && (
            <label>Thu {money(due)} bằng<select value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })}>
              <option value="tien_mat">Tiền mặt</option>
              <option value="chuyen_khoan">Chuyển khoản</option>
            </select></label>
          )}
          <button className="btn small primary" onClick={() => void run(() => rpc('deliver_shipment', { p_id: s.id, p_receiver: v.receiver, p_method: v.method }),
            `Đã giao phiếu ${s.code}${due ? ` · thu ${money(due)}` : ''}`)}>Xác nhận giao</button>
          <button className="btn small link" onClick={() => setAct('')}>Thôi</button>
        </div>
      )}
      {act === 'huy' && (
        <div className="inline-form">
          <label>Lý do hủy<input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></label>
          <button className="btn small danger" disabled={!v.reason.trim()} onClick={() => void run(() => rpc('set_shipment_status', { p_id: s.id, p_status: 'huy', p_trip_id: null, p_reason: v.reason }),
            `Đã hủy phiếu ${s.code}${s.fee_paid_at ? `, hoàn cước ${money(s.fee)}` : ''}`)}>Xác nhận hủy</button>
          <button className="btn small link" onClick={() => setAct('')}>Thôi</button>
        </div>
      )}
    </li>
  );
}
