// Giai đoạn 6.4 – Vận tải hợp đồng: hợp đồng, danh sách hành khách, ký / chạy / xong, thu tiền, in.
// Pháp lý (cần xác minh): bản in là thông tin hợp đồng + danh sách hành khách mang theo xe; mẫu hợp đồng chính thức theo quy định hiện hành cần xác minh.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

type Status = 'nhap' | 'da_ky' | 'dang_chay' | 'xong' | 'huy';
export interface Charter {
  id: string; code: string; customer_name: string; customer_phone: string; customer_tax_code: string | null; customer_address: string | null;
  pickup_place: string; destination: string; itinerary: string | null; start_at: string; end_at: string; passengers: number;
  vehicle_id: string | null; driver1_id: string | null; driver2_id: string | null; price: number; deposit: number; status: Status;
  note: string | null; cancel_reason: string | null;
}
interface Pax { charter_id: string; seq: number; full_name: string; phone: string | null; birth_year: number | null }
interface Veh { id: string; plate: string; is_active: boolean }
interface Staff { id: string; full_name: string; is_active: boolean }

export const CH_COLS = 'id, code, customer_name, customer_phone, customer_tax_code, customer_address, pickup_place, destination, itinerary, start_at, end_at, passengers, vehicle_id, driver1_id, driver2_id, price, deposit, status, note, cancel_reason';
export const CH_STATUS: Record<Status, [string, string]> = {
  nhap: ['Nháp', 'idle'], da_ky: ['Đã ký', 'warn-badge'], dang_chay: ['Đang chạy', 'warn-badge'], xong: ['Xong', ''], huy: ['Đã hủy', 'locked'],
};
const TZ = 'Asia/Ho_Chi_Minh';
export const dt = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false });
const toLocal = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 16);   // giờ Việt Nam cho ô datetime-local
const fromLocal = (v: string) => (v ? new Date(`${v}:00+07:00`).toISOString() : '');
const money = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
const EMPTY = { customer_name: '', customer_phone: '', customer_tax_code: '', customer_address: '', pickup_place: '', destination: '', itinerary: '',
  start: '', end: '', passengers: '', vehicle_id: '', driver1_id: '', driver2_id: '', price: '', deposit: '', note: '', pax: '' };

const paxText = (l: Pax[]) => l.map((p) => [p.full_name, p.phone ?? '', p.birth_year ?? ''].filter((x) => x !== '').join(' - ')).join('\n');
const parsePax = (t: string) => t.split('\n').map((x) => x.trim()).filter(Boolean).map((line) => {
  const parts = line.split(/\s*[-–,;]\s*/);
  const phone = parts.find((x) => /^0\d{9}$/.test(x.replace(/\D/g, '')) && x.replace(/\D/g, '').length === 10)?.replace(/\D/g, '') ?? null;
  const year = parts.find((x) => /^(19|20)\d{2}$/.test(x)) ?? null;
  return { full_name: parts[0], phone, birth_year: year ? Number(year) : null };
});

export function ChartersScreen() {
  const toast = useToast();
  const [list, setList] = useState<Charter[]>([]);
  const [pax, setPax] = useState<Pax[]>([]);
  const [paid, setPaid] = useState<Record<string, number>>({});
  const [vehicles, setVehicles] = useState<Veh[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [edit, setEdit] = useState<{ id: string | null; f: typeof EMPTY } | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [printing, setPrinting] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, v, s] = await Promise.all([
      supabase.from('charters').select(CH_COLS).order('start_at', { ascending: false }).limit(200),
      supabase.from('vehicles').select('id, plate, is_active').order('plate'),
      supabase.from('staff_members').select('id, full_name, is_active').neq('position', 'nhan_vien').order('full_name'),
    ]);
    const err = c.error ?? v.error ?? s.error;
    if (err) return toast('error', err.message);
    const cl = (c.data ?? []) as Charter[];
    setList(cl);
    setVehicles((v.data ?? []) as Veh[]);
    setStaff((s.data ?? []) as Staff[]);
    if (cl.length) {
      const [p, pd] = await Promise.all([
        supabase.from('charter_passengers').select('charter_id, seq, full_name, phone, birth_year').in('charter_id', cl.map((x) => x.id)).order('seq'),
        rpc<{ charter_id: string; paid: number }[]>('charter_paid', { p_ids: cl.map((x) => x.id) }),
      ]);
      setPax((p.data ?? []) as Pax[]);
      setPaid(Object.fromEntries(pd.map((x) => [x.charter_id, Number(x.paid)])));
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!printing) return;
    const t = setTimeout(() => { window.print(); setPrinting(null); }, 300);
    return () => clearTimeout(t);
  }, [printing]);

  const plate = (id: string | null) => vehicles.find((v) => v.id === id)?.plate ?? '';
  const who = (id: string | null) => staff.find((s) => s.id === id)?.full_name ?? '';

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const f = edit.f;
    try {
      const r = await rpc<{ code: string }>('save_charter', {
        p_id: edit.id,
        p: { ...f, start_at: fromLocal(f.start), end_at: fromLocal(f.end), passengers: Number(f.passengers) || 0, price: Number(f.price) || 0,
             deposit: Number(f.deposit) || 0, vehicle_id: f.vehicle_id || null, driver1_id: f.driver1_id || null, driver2_id: f.driver2_id || null },
        p_passengers: parsePax(f.pax),
      });
      toast('ok', `Đã lưu hợp đồng ${r.code}`);
      setEdit(null);
      await load();
    } catch (err) {
      toast('error', errMsg(err));
    }
  }
  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast('ok', ok);
      await load();
    } catch (err) {
      toast('error', errMsg(err));
    }
  }

  const shown = list.filter((c) => showDone || (c.status !== 'xong' && c.status !== 'huy'));
  const pr = list.find((c) => c.id === printing);
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => edit && setEdit({ ...edit, f: { ...edit.f, [k]: e.target.value } });

  return (
    <>
      {!edit && <section className="card"><button className="btn primary" onClick={() => setEdit({ id: null, f: EMPTY })}>+ Hợp đồng mới</button></section>}
      {edit && (
        <form className="card form" onSubmit={(e) => void save(e)}>
          <h2>{edit.id ? 'Sửa hợp đồng' : 'Hợp đồng mới'}</h2>
          <div className="grid2">
            <label>Bên thuê (người / công ty)<input value={edit.f.customer_name} onChange={set('customer_name')} required /></label>
            <label>SĐT bên thuê<input inputMode="tel" value={edit.f.customer_phone} onChange={set('customer_phone')} required /></label>
            <label>Mã số thuế (nếu có)<input value={edit.f.customer_tax_code} onChange={set('customer_tax_code')} /></label>
            <label>Địa chỉ bên thuê<input value={edit.f.customer_address} onChange={set('customer_address')} /></label>
            <label>Điểm đón<input value={edit.f.pickup_place} onChange={set('pickup_place')} required /></label>
            <label>Điểm đến<input value={edit.f.destination} onChange={set('destination')} required /></label>
            <label>Đi lúc<input type="datetime-local" value={edit.f.start} onChange={set('start')} required /></label>
            <label>Về lúc<input type="datetime-local" value={edit.f.end} onChange={set('end')} required /></label>
            <label>Số khách<input type="number" min={1} max={100} inputMode="numeric" value={edit.f.passengers} onChange={set('passengers')} required /></label>
            <label>Xe
              <select value={edit.f.vehicle_id} onChange={set('vehicle_id')}>
                <option value="">Chưa chọn</option>
                {vehicles.filter((v) => v.is_active).map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}
              </select>
            </label>
            <label>Lái xe 1
              <select value={edit.f.driver1_id} onChange={set('driver1_id')}>
                <option value="">Chưa chọn</option>
                {staff.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
              </select>
            </label>
            <label>Lái xe 2 / phụ xe
              <select value={edit.f.driver2_id} onChange={set('driver2_id')}>
                <option value="">Không</option>
                {staff.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
              </select>
            </label>
            <label>Giá hợp đồng (đồng)<input type="number" min={0} step={1000} inputMode="numeric" value={edit.f.price} onChange={set('price')} required /></label>
            <label>Đặt cọc thỏa thuận (đồng)<input type="number" min={0} step={1000} inputMode="numeric" value={edit.f.deposit} onChange={set('deposit')} /></label>
          </div>
          <label>Lộ trình<textarea rows={2} value={edit.f.itinerary} onChange={set('itinerary')} placeholder="vd Biên Hòa – QL20 – Đà Lạt và ngược lại" /></label>
          <label>Danh sách hành khách (mỗi dòng: Họ tên - SĐT - năm sinh)<textarea rows={5} value={edit.f.pax} onChange={set('pax')} /></label>
          <label>Ghi chú<input value={edit.f.note} onChange={set('note')} /></label>
          <div className="actions">
            <button className="btn primary">Lưu hợp đồng</button>
            <button type="button" className="btn link" onClick={() => setEdit(null)}>Thôi</button>
          </div>
        </form>
      )}
      <section className="card">
        <div className="item-head">
          <h2>Hợp đồng ({shown.length})</h2>
          <label className="check small"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Hiện hợp đồng đã xong / hủy</label>
        </div>
        {shown.length === 0 && <p className="muted">Chưa có hợp đồng.</p>}
        <ul className="list">
          {shown.map((c) => {
            const p = pax.filter((x) => x.charter_id === c.id);
            const got = paid[c.id] ?? 0;
            const [lb, cls] = CH_STATUS[c.status];
            return (
              <li key={c.id} className="item">
                <div className="item-head">
                  <div>
                    <b>{c.code}</b> <span className={`badge ${cls}`}>{lb}</span> · {c.customer_name} <a href={`tel:${c.customer_phone}`}>{c.customer_phone}</a>
                    <div className="small">{c.pickup_place} → {c.destination} · {dt(c.start_at)} – {dt(c.end_at)}</div>
                    <div className="small muted">{plate(c.vehicle_id) || 'chưa có xe'} · {who(c.driver1_id) || 'chưa có lái xe'}{c.driver2_id ? `, ${who(c.driver2_id)}` : ''} · {p.length}/{c.passengers} khách có tên
                      · Đã thu {money(got)} / {money(c.price)}{c.cancel_reason ? ` · Hủy: ${c.cancel_reason}` : ''}</div>
                  </div>
                  <div className="actions">
                    <button className="btn small" onClick={() => setPrinting(c.id)}>In</button>
                    {c.status !== 'xong' && c.status !== 'huy' && (
                      <>
                        <button className="btn small" onClick={() => setEdit({ id: c.id, f: { customer_name: c.customer_name, customer_phone: c.customer_phone,
                          customer_tax_code: c.customer_tax_code ?? '', customer_address: c.customer_address ?? '', pickup_place: c.pickup_place, destination: c.destination,
                          itinerary: c.itinerary ?? '', start: toLocal(c.start_at), end: toLocal(c.end_at), passengers: String(c.passengers), vehicle_id: c.vehicle_id ?? '',
                          driver1_id: c.driver1_id ?? '', driver2_id: c.driver2_id ?? '', price: String(c.price), deposit: String(c.deposit), note: c.note ?? '', pax: paxText(p) } })}>Sửa</button>
                        {c.status === 'nhap' && <button className="btn small primary" onClick={() => void act(() => rpc('set_charter_status', { p_id: c.id, p_status: 'da_ky', p_reason: null }), `Đã ký ${c.code}`)}>Ký</button>}
                        {c.status === 'da_ky' && <button className="btn small primary" onClick={() => void act(() => rpc('set_charter_status', { p_id: c.id, p_status: 'dang_chay', p_reason: null }), `${c.code} bắt đầu chạy`)}>Bắt đầu</button>}
                        {c.status === 'dang_chay' && <button className="btn small primary" onClick={() => void act(() => rpc('set_charter_status', { p_id: c.id, p_status: 'xong', p_reason: null }), `${c.code} đã xong`)}>Xong</button>}
                        {got < c.price && <PayButton c={c} rest={c.price - got} act={act} />}
                        <CancelButton c={c} act={act} />
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      {pr && (
        <div className="print-area charter-print">
          <h2 style={{ textAlign: 'center' }}>THÔNG TIN HỢP ĐỒNG VẬN CHUYỂN HÀNH KHÁCH · {pr.code}</h2>
          <p>Bên thuê: {pr.customer_name} · SĐT {pr.customer_phone}{pr.customer_tax_code ? ` · MST ${pr.customer_tax_code}` : ''}{pr.customer_address ? ` · ${pr.customer_address}` : ''}</p>
          <p>Điểm đón: {pr.pickup_place} · Điểm đến: {pr.destination}{pr.itinerary ? ` · Lộ trình: ${pr.itinerary}` : ''}</p>
          <p>Thời gian: {dt(pr.start_at)} – {dt(pr.end_at)} · Xe: {plate(pr.vehicle_id)} · Lái xe: {who(pr.driver1_id)}{pr.driver2_id ? `, ${who(pr.driver2_id)}` : ''} · Số khách: {pr.passengers}</p>
          <p>Giá hợp đồng: {money(pr.price)}</p>
          <h3>Danh sách hành khách</h3>
          <table className="plist">
            <thead><tr><th>STT</th><th>Họ tên</th><th>SĐT</th><th>Năm sinh</th></tr></thead>
            <tbody>{pax.filter((x) => x.charter_id === pr.id).map((x) => <tr key={x.seq}><td>{x.seq}</td><td>{x.full_name}</td><td>{x.phone}</td><td>{x.birth_year}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

function PayButton({ c, rest, act }: { c: Charter; rest: number; act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ amount: String(rest), method: 'chuyen_khoan' });
  if (!open) return <button className="btn small" onClick={() => setOpen(true)}>Thu tiền</button>;
  return (
    <div className="inline-form">
      <label>Số tiền<input type="number" min={1} max={rest} inputMode="numeric" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></label>
      <label>Bằng<select value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })}><option value="chuyen_khoan">Chuyển khoản</option><option value="tien_mat">Tiền mặt</option></select></label>
      <button className="btn small primary" onClick={() => void act(() => rpc('charter_payment', { p_id: c.id, p_amount: Number(v.amount), p_method: v.method, p_note: null }), `Đã thu ${money(Number(v.amount))} hợp đồng ${c.code}`).then(() => setOpen(false))}>Ghi thu</button>
      <button className="btn small link" onClick={() => setOpen(false)}>Thôi</button>
    </div>
  );
}

function CancelButton({ c, act }: { c: Charter; act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) return <button className="btn small link" onClick={() => setOpen(true)}>Hủy</button>;
  return (
    <div className="inline-form">
      <label>Lý do hủy<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <button className="btn small danger" disabled={!reason.trim()} onClick={() => void act(() => rpc('set_charter_status', { p_id: c.id, p_status: 'huy', p_reason: reason }), `Đã hủy ${c.code}`)}>Xác nhận hủy</button>
      <button className="btn small link" onClick={() => setOpen(false)}>Thôi</button>
    </div>
  );
}

/** Lái xe: hợp đồng của tôi (đã ký / đang chạy) */
export function MyCharters() {
  const toast = useToast();
  const [list, setList] = useState<Charter[]>([]);
  const [pax, setPax] = useState<Pax[]>([]);
  const load = useCallback(async () => {
    const c = await supabase.from('charters').select(CH_COLS).in('status', ['da_ky', 'dang_chay']).order('start_at');
    const cl = (c.data ?? []) as Charter[];
    setList(cl);
    if (cl.length) {
      const p = await supabase.from('charter_passengers').select('charter_id, seq, full_name, phone, birth_year').in('charter_id', cl.map((x) => x.id)).order('seq');
      setPax((p.data ?? []) as Pax[]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function mark(c: Charter, s: Status) {
    try {
      await rpc('set_charter_status', { p_id: c.id, p_status: s, p_reason: null });
      toast('ok', s === 'dang_chay' ? `Bắt đầu chạy ${c.code}` : `Đã xong ${c.code}`);
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }
  if (list.length === 0) return null;
  return (
    <section className="card">
      <h2>Hợp đồng của tôi</h2>
      <ul className="list">
        {list.map((c) => (
          <li key={c.id} className="item">
            <div className="item-head">
              <div>
                <b>{c.code}</b> <span className={`badge ${CH_STATUS[c.status][1]}`}>{CH_STATUS[c.status][0]}</span>
                <div className="small">{c.pickup_place} → {c.destination} · {dt(c.start_at)} – {dt(c.end_at)}</div>
                <div className="small">Bên thuê: {c.customer_name} <a href={`tel:${c.customer_phone}`}>{c.customer_phone}</a>{c.itinerary ? ` · ${c.itinerary}` : ''}</div>
              </div>
              {c.status === 'da_ky' && <button className="btn primary" onClick={() => void mark(c, 'dang_chay')}>Bắt đầu chạy</button>}
              {c.status === 'dang_chay' && <button className="btn primary" onClick={() => void mark(c, 'xong')}>Đã xong</button>}
            </div>
            <ol className="queue-list small">
              {pax.filter((x) => x.charter_id === c.id).map((x) => (
                <li key={x.seq}>{x.full_name}{x.phone ? <> · <a href={`tel:${x.phone}`}>{x.phone}</a></> : ''}{x.birth_year ? ` · ${x.birth_year}` : ''}</li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </section>
  );
}
