// Giai đoạn 6.2 – Trung chuyển: gom vé cần đón / trả tận nơi vào lượt, giao người chạy; người chạy đánh dấu đã đón / trả.
import { useCallback, useEffect, useState } from 'react';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

type Kind = 'don' | 'tra';
interface TripLite { id: string; route_id: string; direction: 'di' | 've'; depart_at: string }
interface StaffLite { id: string; full_name: string; is_active: boolean }
export interface TcTicket {
  id: string; trip_id: string; seat_label: string; passenger_name: string | null; passenger_phone: string | null;
  pickup_note: string | null; dropoff_note: string | null; tc_don: boolean; tc_tra: boolean; from_stop_id: string; to_stop_id: string;
}
export interface Run { id: string; service_date: string; kind: Kind; staff_id: string | null; vehicle_note: string | null; start_time: string | null; note: string | null }
export interface Item { run_id: string; ticket_id: string; kind: Kind; seq: number; done_at: string | null }

const TZ = 'Asia/Ho_Chi_Minh';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const KIND: Record<Kind, string> = { don: 'Đón', tra: 'Trả' };
export const TC_COLS = 'id, trip_id, seat_label, passenger_name, passenger_phone, pickup_note, dropoff_note, tc_don, tc_tra, from_stop_id, to_stop_id';
export const addr = (t: TcTicket, k: Kind) => (k === 'don' ? t.pickup_note : t.dropoff_note) || '(chưa ghi địa chỉ)';

/** Điều hành: trung chuyển trong ngày */
export function Transfers({ day, trips, staff, ends, canEdit }: {
  day: string; trips: TripLite[]; staff: StaffLite[]; ends: (routeId: string, dir: 'di' | 've') => string; canEdit: boolean;
}) {
  const toast = useToast();
  const [tickets, setTickets] = useState<TcTicket[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [edit, setEdit] = useState<{ id: string | null; kind: Kind; staff: string; vehicle: string; time: string; note: string; pick: string[] } | null>(null);

  const tripIds = trips.map((t) => t.id).join(',');
  const load = useCallback(async () => {
    const ids = tripIds ? tripIds.split(',') : [];
    const [tk, rn] = await Promise.all([
      ids.length ? supabase.from('seat_inventory').select(TC_COLS).in('trip_id', ids).in('status', ['dat', 'da_tt', 'cho_xep'])
        .or('tc_don.eq.true,tc_tra.eq.true') : Promise.resolve({ data: [], error: null }),
      supabase.from('transfer_runs').select('id, service_date, kind, staff_id, vehicle_note, start_time, note').eq('service_date', day).order('start_time'),
    ]);
    if (tk.error || rn.error) return toast('error', (tk.error ?? rn.error)!.message);
    const rl = (rn.data ?? []) as Run[];
    setTickets((tk.data ?? []) as TcTicket[]);
    setRuns(rl);
    if (rl.length) {
      const it = await supabase.from('transfer_items').select('run_id, ticket_id, kind, seq, done_at').in('run_id', rl.map((r) => r.id)).order('seq');
      setItems((it.data ?? []) as Item[]);
    } else setItems([]);
  }, [day, tripIds, toast]);
  useEffect(() => { void load(); }, [load]);

  const tripOf = (id: string) => trips.find((t) => t.id === id);
  const label = (t: TcTicket) => {
    const tr = tripOf(t.trip_id);
    return `${tr ? hhmm(tr.depart_at) : ''} · ghế ${t.seat_label} · ${t.passenger_name ?? 'Khách'}${t.passenger_phone ? ` ${t.passenger_phone}` : ''}`;
  };
  const assigned = (k: Kind) => new Set(items.filter((i) => i.kind === k).map((i) => i.ticket_id));
  const waiting = (k: Kind) => tickets.filter((t) => (k === 'don' ? t.tc_don : t.tc_tra) && !assigned(k).has(t.id));

  async function save() {
    if (!edit) return;
    try {
      await rpc('save_transfer_run', {
        p_id: edit.id, p_date: day, p_kind: edit.kind, p_staff_id: edit.staff || null, p_vehicle_note: edit.vehicle || null,
        p_start: edit.time || null, p_note: edit.note || null, p_ticket_ids: edit.pick,
      });
      toast('ok', `Đã lưu lượt ${KIND[edit.kind].toLowerCase()} ${edit.pick.length} khách`);
      setEdit(null);
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }
  async function del(id: string) {
    try {
      await rpc('delete_transfer_run', { p_id: id });
      toast('ok', 'Đã xóa lượt trung chuyển');
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }

  const total = (k: Kind) => tickets.filter((t) => (k === 'don' ? t.tc_don : t.tc_tra)).length;
  const done = (k: Kind) => items.filter((i) => i.kind === k && i.done_at).length;

  return (
    <section className="card">
      <h2>Trung chuyển</h2>
      <p className="small">Đón tận nơi {done('don')}/{total('don')} · Trả tận nơi {done('tra')}/{total('tra')}</p>
      {(['don', 'tra'] as Kind[]).map((k) => (
        <div key={k} className="sub">
          <div className="item-head">
            <b>Chờ xếp lượt {KIND[k].toLowerCase()} ({waiting(k).length})</b>
            {canEdit && waiting(k).length > 0 && !edit && (
              <button className="btn small primary" onClick={() => setEdit({ id: null, kind: k, staff: '', vehicle: '', time: '', note: '', pick: waiting(k).map((t) => t.id) })}>
                Tạo lượt {KIND[k].toLowerCase()}
              </button>
            )}
          </div>
          {waiting(k).length === 0 && <p className="muted small">Không có khách chờ.</p>}
          <ul className="queue-list small">
            {waiting(k).map((t) => <li key={t.id}>{label(t)} · <b>{addr(t, k)}</b></li>)}
          </ul>
        </div>
      ))}
      {edit && (
        <div className="sub form">
          <b>{edit.id ? 'Sửa' : 'Tạo'} lượt {KIND[edit.kind].toLowerCase()}</b>
          <div className="grid2">
            <label>Người chạy trung chuyển
              <select aria-label="Người chạy trung chuyển" value={edit.staff} onChange={(e) => setEdit({ ...edit, staff: e.target.value })}>
                <option value="">Chưa giao</option>
                {staff.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
              </select>
            </label>
            <label>Xe trung chuyển<input value={edit.vehicle} onChange={(e) => setEdit({ ...edit, vehicle: e.target.value })} placeholder="vd 60A-123.45" /></label>
            <label>Giờ bắt đầu<input type="time" value={edit.time} onChange={(e) => setEdit({ ...edit, time: e.target.value })} /></label>
            <label>Ghi chú<input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} placeholder="vd khu Tân Phong" /></label>
          </div>
          <div className="checklist">
            {[...tickets.filter((t) => (edit.kind === 'don' ? t.tc_don : t.tc_tra) && (!assigned(edit.kind).has(t.id) || edit.pick.includes(t.id)))].map((t) => (
              <label key={t.id} className="check">
                <input type="checkbox" checked={edit.pick.includes(t.id)}
                       onChange={(e) => setEdit({ ...edit, pick: e.target.checked ? [...edit.pick, t.id] : edit.pick.filter((x) => x !== t.id) })} />
                {label(t)} · {addr(t, edit.kind)}
              </label>
            ))}
          </div>
          <div className="actions">
            <button className="btn primary" onClick={() => void save()}>Lưu lượt</button>
            <button className="btn link" onClick={() => setEdit(null)}>Thôi</button>
          </div>
        </div>
      )}
      {runs.length > 0 && (
        <ul className="list">
          {runs.map((r) => {
            const mine = items.filter((i) => i.run_id === r.id);
            return (
              <li key={r.id} className="item">
                <div className="item-head">
                  <div>
                    <b>Lượt {KIND[r.kind].toLowerCase()}{r.start_time ? ` ${r.start_time.slice(0, 5)}` : ''}</b>
                    <span className="muted small"> · {staff.find((s) => s.id === r.staff_id)?.full_name ?? 'chưa giao người'}{r.vehicle_note ? ` · ${r.vehicle_note}` : ''}{r.note ? ` · ${r.note}` : ''}</span>
                    <div className="small">{mine.filter((i) => i.done_at).length}/{mine.length} khách đã {r.kind === 'don' ? 'đón' : 'trả'}</div>
                  </div>
                  {canEdit && (
                    <div className="actions">
                      <button className="btn small" onClick={() => setEdit({ id: r.id, kind: r.kind, staff: r.staff_id ?? '', vehicle: r.vehicle_note ?? '',
                        time: r.start_time?.slice(0, 5) ?? '', note: r.note ?? '', pick: mine.map((i) => i.ticket_id) })}>Sửa</button>
                      {!mine.some((i) => i.done_at) && <button className="btn small link" onClick={() => void del(r.id)}>Xóa</button>}
                    </div>
                  )}
                </div>
                <ol className="queue-list small">
                  {mine.map((i) => {
                    const t = tickets.find((x) => x.id === i.ticket_id);
                    return <li key={i.ticket_id} className={i.done_at ? 'state-con_han' : ''}>{t ? `${label(t)} · ${addr(t, r.kind)}` : 'Vé đã hủy'}{i.done_at ? ' ✓' : ''}</li>;
                  })}
                </ol>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Người chạy trung chuyển: lượt của tôi */
export function MyTransfers({ day }: { day: string }) {
  const toast = useToast();
  const [runs, setRuns] = useState<Run[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [tickets, setTickets] = useState<TcTicket[]>([]);
  const load = useCallback(async () => {
    try {
      const rl = await rpc<Run[]>('my_transfer_runs', { p_date: day });
      setRuns(rl);
      if (!rl.length) return;
      const it = await supabase.from('transfer_items').select('run_id, ticket_id, kind, seq, done_at').in('run_id', rl.map((r) => r.id)).order('seq');
      const il = (it.data ?? []) as Item[];
      setItems(il);
      if (il.length) {
        const tk = await supabase.from('seat_inventory').select(TC_COLS).in('id', il.map((i) => i.ticket_id));
        setTickets((tk.data ?? []) as TcTicket[]);
      }
    } catch (e) {
      toast('error', errMsg(e));
    }
  }, [day, toast]);
  useEffect(() => { void load(); }, [load]);

  async function mark(r: Run, ticket: string, v: boolean) {
    try {
      await rpc('transfer_done', { p_run_id: r.id, p_ticket_id: ticket, p_done: v });
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    }
  }

  if (runs.length === 0) return null;
  return (
    <section className="card">
      <h2>Trung chuyển của tôi</h2>
      {runs.map((r) => (
        <div key={r.id} className="sub">
          <b>Lượt {KIND[r.kind].toLowerCase()}{r.start_time ? ` ${r.start_time.slice(0, 5)}` : ''}{r.vehicle_note ? ` · ${r.vehicle_note}` : ''}</b>
          {r.note && <span className="muted small">{r.note}</span>}
          <ul className="drv-list">
            {items.filter((i) => i.run_id === r.id).map((i, n) => {
              const t = tickets.find((x) => x.id === i.ticket_id);
              return (
                <li key={i.ticket_id} className={i.done_at ? 'drv-pax boarded' : 'drv-pax'}>
                  <label className="check drv-board">
                    <input type="checkbox" aria-label={`Đã ${r.kind === 'don' ? 'đón' : 'trả'} khách ${n + 1}`} checked={!!i.done_at}
                           onChange={(e) => void mark(r, i.ticket_id, e.target.checked)} />
                    <b>{n + 1}</b>
                  </label>
                  <div className="drv-info">
                    <div>{t?.passenger_name ?? 'Khách'} {t?.passenger_phone && <a className="drv-call" href={`tel:${t.passenger_phone}`}>{t.passenger_phone}</a>}</div>
                    <div className="small"><b>{t ? addr(t, r.kind) : ''}</b> · ghế {t?.seat_label}</div>
                  </div>
                  <span />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
