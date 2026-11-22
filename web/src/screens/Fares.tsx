// Bảng giá vé như app cũ: theo tuyến, theo khoảng ngày áp dụng và theo từng chặng đi.
// Gõ điểm chưa có thì database tự tạo điểm và thêm vào lộ trình tuyến (bán vé chặng cần thứ tự điểm).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Route { id: string; name: string; is_active: boolean }
interface Stop { id: string; name: string }
interface Table { id: string; route_id: string; valid_from: string; valid_to: string | null; note: string | null }
interface Item { table_id: string; seq: number; from_stop_id: string | null; to_stop_id: string | null; price: number }
interface Row { from: string; to: string; price: string }

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
const fmtDate = (d: string) => d.split('-').reverse().join('/');
const money = (n: number) => n.toLocaleString('vi-VN');
const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, ' ');
const range = (t: Table) => `Từ ${fmtDate(t.valid_from)}${t.valid_to ? ` đến ${fmtDate(t.valid_to)}` : ' · không giới hạn'}`;
function status(t: Table): [string, string] {
  const d = today();
  return d < t.valid_from ? ['sap', 'Sắp áp dụng'] : t.valid_to && d > t.valid_to ? ['het', 'Hết hạn'] : ['dang', 'Đang áp dụng'];
}

export function FaresScreen({ perms }: { perms: Permissions }) {
  const toast = useToast();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [routeStops, setRouteStops] = useState<{ route_id: string; stop_id: string; seq: number }[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [sel, setSel] = useState('');
  const [form, setForm] = useState<{ id: string | null; src: Table | null; rows: Row[] } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const canAdd = perms.has('fare.add'), canEdit = perms.has('fare.edit'), canDel = perms.has('fare.delete');

  const load = useCallback(async () => {
    const [r, s, rs, t, i] = await Promise.all([
      supabase.from('routes').select('id, name, is_active').order('name'),
      supabase.from('stops').select('id, name').order('name'),
      supabase.from('route_stops').select('route_id, stop_id, seq').order('seq'),
      supabase.from('fare_tables').select('id, route_id, valid_from, valid_to, note').order('valid_from', { ascending: false }),
      supabase.from('fare_table_items').select('table_id, seq, from_stop_id, to_stop_id, price').order('seq'),
    ]);
    const err = r.error ?? s.error ?? rs.error ?? t.error ?? i.error;
    if (err) return toast('error', err.message);
    setRoutes((r.data ?? []) as Route[]);
    setStops((s.data ?? []) as Stop[]);
    setRouteStops((rs.data ?? []) as { route_id: string; stop_id: string; seq: number }[]);
    setTables((t.data ?? []) as Table[]);
    setItems((i.data ?? []) as Item[]);
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const stopName = (id: string | null) => stops.find((x) => x.id === id)?.name ?? '';
  const routeName = (id: string) => routes.find((x) => x.id === id)?.name ?? '?';
  const list = useMemo(() => tables.filter((t) => !sel || t.route_id === sel)
    .sort((a, b) => routeName(a.route_id).localeCompare(routeName(b.route_id), 'vi') || b.valid_from.localeCompare(a.valid_from)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [tables, sel, routes]);
  const rowsOf = (t: Table | null): Row[] => {
    const l = t ? items.filter((x) => x.table_id === t.id) : [];
    return l.length ? l.map((x) => ({ from: stopName(x.from_stop_id), to: stopName(x.to_stop_id), price: String(x.price) })) : [{ from: '', to: '', price: '' }];
  };

  async function remove(id: string) {
    try {
      await rpc('delete_fare_table', { p_id: id });
      toast('ok', 'Đã xóa bảng giá');
      setDel(null);
      await load();
    } catch (e) { toast('error', errMsg(e)); }
  }

  return (
    <section className="card">
      <div className="bg-top">
        <select aria-label="Chọn tuyến" value={sel} onChange={(e) => setSel(e.target.value)}>
          <option value="">Tất cả các tuyến</option>
          {routes.filter((r) => r.is_active || tables.some((t) => t.route_id === r.id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <span className="muted small">{list.length} bảng giá</span>
        <span className="grow" />
        {canAdd && <button type="button" className="btn primary" onClick={() => setForm({ id: null, src: null, rows: [{ from: '', to: '', price: '' }] })}>+ Thêm bảng giá</button>}
      </div>
      {list.length === 0 && <p className="muted bg-empty">Chưa có bảng giá. Bấm <b>Thêm bảng giá</b> để nhập giá theo tuyến, khoảng ngày và từng chặng. Khi bán vé, giá sẽ tự điền theo điểm đón, điểm trả.</p>}
      {list.map((t) => {
        const [cl, tx] = status(t);
        const l = items.filter((x) => x.table_id === t.id);
        return (
          <div key={t.id} className="bgc">
            <div className="bgc-h">
              <b>{routeName(t.route_id)}</b><span className={`bg-st ${cl}`}>{tx}</span>
              <span className="rg">{range(t)}{t.note ? ` · ${t.note}` : ''}</span>
              <span className="grow" />
              {canAdd && <button type="button" className="btn small" title="Sao chép bảng giá" onClick={() => setForm({ id: null, src: { ...t, valid_from: today(), valid_to: null }, rows: rowsOf(t) })}>Sao chép</button>}
              {canEdit && <button type="button" className="btn small" onClick={() => setForm({ id: t.id, src: t, rows: rowsOf(t) })}>Sửa</button>}
              {canDel && (del === t.id
                ? <span className="inline-form"><span className="small">Xóa bảng giá này?</span>
                    <button type="button" className="btn small danger" onClick={() => void remove(t.id)}>Xóa hẳn</button>
                    <button type="button" className="btn small link" onClick={() => setDel(null)}>Thôi</button></span>
                : <button type="button" className="btn small link danger-text" onClick={() => setDel(t.id)}>Xóa</button>)}
            </div>
            <table>
              <thead><tr><th>Điểm đi</th><th>Điểm đến</th><th className="r">Giá vé</th></tr></thead>
              <tbody>
                {l.map((x) => x.from_stop_id
                  ? <tr key={x.seq}><td>{stopName(x.from_stop_id)}</td><td>{stopName(x.to_stop_id)}</td><td className="r"><b>{money(x.price)}</b></td></tr>
                  : <tr key={x.seq} className="all"><td colSpan={2}>Giá toàn tuyến</td><td className="r"><b>{money(x.price)}</b></td></tr>)}
              </tbody>
            </table>
          </div>
        );
      })}
      {form && (
        <FareForm id={form.id} src={form.src} rows0={form.rows} routes={routes} defRoute={sel}
                  points={(rid) => {
                    const on = routeStops.filter((x) => x.route_id === rid).map((x) => stopName(x.stop_id));
                    return [...new Set([...on, ...stops.map((s) => s.name)])].filter(Boolean);
                  }}
                  onClose={() => setForm(null)} onSaved={async () => { setForm(null); await load(); }} />
      )}
    </section>
  );
}

function FareForm(props: { id: string | null; src: Table | null; rows0: Row[]; routes: Route[]; defRoute: string; points: (routeId: string) => string[];
  onClose: () => void; onSaved: () => Promise<void> }) {
  const { id, src } = props;
  const toast = useToast();
  const [route, setRoute] = useState(src?.route_id ?? props.defRoute);
  const [note, setNote] = useState(src?.note ?? '');
  const [from, setFrom] = useState(src?.valid_from ?? today());
  const [to, setTo] = useState(src?.valid_to ?? '');
  const [rows, setRows] = useState<Row[]>(props.rows0);
  const [gen, setGen] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const pts = props.points(route);
  const setRow = (i: number, p: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));

  function makeAll() {
    const list = (gen ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (list.length < 2) return toast('error', 'Nhập ít nhất 2 điểm');
    const keep = rows.filter((r) => r.from.trim() || r.to.trim() || r.price.trim());
    const have = new Set(keep.map((r) => `${norm(r.from)}|${norm(r.to)}`));
    const add: Row[] = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const k = `${norm(list[i])}|${norm(list[j])}`;
      if (have.has(k)) continue;
      have.add(k);
      add.push({ from: list[i], to: list[j], price: '' });
    }
    setRows([...keep, ...add]);
    setOrder(list);
    setGen(null);
    toast('ok', `Đã tạo ${add.length} chặng. Nhập giá cho từng chặng.`);
  }

  async function save() {
    if (!route) return toast('error', 'Vui lòng chọn tuyến');
    if (!from) return toast('error', 'Vui lòng nhập ngày bắt đầu áp dụng');
    if (to && to < from) return toast('error', 'Ngày kết thúc phải sau ngày bắt đầu');
    const list = rows.filter((r) => r.from.trim() || r.to.trim() || r.price.trim());
    for (const r of list) {
      if (!r.from.trim() !== !r.to.trim()) return toast('error', 'Mỗi chặng cần đủ điểm đi và điểm đến (hoặc để trống cả hai = giá toàn tuyến)');
      if (!(Number(r.price.replace(/\D/g, '')) > 0)) return toast('error', `Chặng ${r.from.trim() ? `${r.from.trim()} → ${r.to.trim()}` : 'toàn tuyến'} chưa có giá`);
    }
    if (!list.length) return toast('error', 'Cần ít nhất một chặng có giá');
    setBusy(true);
    try {
      await rpc('save_fare_table', {
        p_id: id, p_route_id: route, p_valid_from: from, p_valid_to: to || null, p_note: note,
        p_items: list.map((r) => ({ from: r.from.trim(), to: r.to.trim(), price: Number(r.price.replace(/\D/g, '')) })),
        p_order: order.length ? order : null,
      });
      toast('ok', 'Đã lưu bảng giá');
      await props.onSaved();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={id ? 'Sửa bảng giá' : src ? 'Sao chép bảng giá' : 'Thêm bảng giá'} onClose={props.onClose} wide>
      <div className="form">
        <div className="grid2">
          <label>Tuyến *
            <select value={route} onChange={(e) => setRoute(e.target.value)}>
              <option value="">(Chọn tuyến)</option>
              {props.routes.filter((r) => r.is_active || r.id === route).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label>Ghi chú<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="VD: Giá dịp Tết" /></label>
          <label>Áp dụng từ ngày *<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>Đến ngày<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /><small className="muted">Để trống nếu không giới hạn</small></label>
        </div>
        <div className="bg-eh">
          <b>Giá từng chặng</b><span className="grow" />
          <button type="button" className="btn small" onClick={() => setGen(gen === null ? '' : null)}>Tạo chặng từ danh sách điểm</button>
          <button type="button" className="btn small primary" onClick={() => setRows([...rows, { from: '', to: '', price: '' }])}>+ Thêm chặng</button>
        </div>
        {gen !== null && (
          <div className="bg-gen">
            <textarea rows={4} autoFocus value={gen} onChange={(e) => setGen(e.target.value)}
                      placeholder={'Nhập các điểm theo thứ tự đi, mỗi điểm một dòng\nVD:\nBến xe Vũng Tàu\nBà Rịa\nBến xe Biên Hòa'} />
            <div className="actions">
              <button type="button" className="btn small primary" onClick={makeAll}>Tạo mọi chặng</button>
              <span className="muted small">Tạo từng cặp điểm đi → điểm đến theo thứ tự, rồi nhập giá cho từng chặng. Để trống cả điểm đi và điểm đến = giá toàn tuyến.</span>
            </div>
          </div>
        )}
        <datalist id="bg-pts">{pts.map((x) => <option key={x} value={x} />)}</datalist>
        <div className="bg-rows">
          {rows.map((r, i) => (
            <div key={i} className="bg-r">
              <input list="bg-pts" aria-label={`Điểm đi, chặng ${i + 1}`} placeholder="Điểm đi" value={r.from} onChange={(e) => setRow(i, { from: e.target.value })} />
              <span className="bg-ar">→</span>
              <input list="bg-pts" aria-label={`Điểm đến, chặng ${i + 1}`} placeholder="Điểm đến" value={r.to} onChange={(e) => setRow(i, { to: e.target.value })} />
              <input inputMode="numeric" aria-label={`Giá, chặng ${i + 1}`} placeholder="Giá" className="num"
                     value={r.price ? Number(r.price.replace(/\D/g, '') || 0).toLocaleString('vi-VN') : ''}
                     onChange={(e) => setRow(i, { price: e.target.value.replace(/\D/g, '') })} />
              <button type="button" className="btn small" aria-label={`Xóa chặng ${i + 1}`} title="Xóa chặng"
                      onClick={() => setRows(rows.length > 1 ? rows.filter((_, k) => k !== i) : [{ from: '', to: '', price: '' }])}>×</button>
            </div>
          ))}
        </div>
        <div className="actions">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>Lưu</button>
          <button type="button" className="btn link" onClick={props.onClose}>Hủy</button>
        </div>
      </div>
    </Modal>
  );
}
