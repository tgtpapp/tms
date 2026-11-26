// Sửa chữa xe (như app cũ): phiếu PSX…, xe, ngày, km, gara, hạng mục (nội dung · SL · đơn giá), ảnh hóa đơn.
import { useCallback, useEffect, useState } from 'react';
import { MonthPicker } from '../components/MonthPicker';
import { RepairPrint } from '../components/RepairPrint';
import { Modal } from '../components/Modal';
import { FilePreviews, FilesViewButton } from '../components/FilePreview';
import { fmtDate, today } from '../components/Documents';
import { prepareFile, uploadFiles } from '../lib/documents';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { profileChanged } from '../lib/profileAutoArchive';

interface Order { id: string; code: string; vehicle_id: string; driver_id: string | null; repaired_on: string; odo_km: number | null; workshop: string | null; kind: string; note: string | null; files: string[]; created_by: string | null }
interface Item { order_id: string; seq: number; content: string; unit: string | null; qty: number; unit_price: number }
interface Veh { id: string; plate: string; is_active: boolean }
interface Line { content: string; unit: string; qty: string; unit_price: string }
interface Form { id: string | null; vehicle_id: string; driver_id: string; repaired_on: string; odo_km: string; workshop: string; kind: string; note: string; files: string[]; add: File[]; lines: Line[] }

const KIND: Record<string, string> = { bao_duong: 'Bảo dưỡng', sua_chua: 'Sửa chữa', thay_the: 'Thay thế phụ tùng' };
const money = (n: number) => `${Math.round(n).toLocaleString('vi-VN')} đ`;
const total = (l: { qty: number; unit_price: number }[]) => l.reduce((a, x) => a + Number(x.qty) * Number(x.unit_price), 0);
const EMPTY_LINE: Line = { content: '', unit: '', qty: '1', unit_price: '' };

export function RepairsScreen({ ctx, perms }: { ctx: AccountContext; perms: Permissions }) {
  const toast = useToast();
  const canEdit = perms.has('vehicle.manage');
  const [orders, setOrders] = useState<Order[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [vehicles, setVehicles] = useState<Veh[]>([]);
  // người chỉ xem phiếu xe mình (lái xe): mặc định xem mọi tháng để thấy đủ lịch sử sửa chữa xe mình
  const [month, setMonth] = useState(['repair.view_all', 'repair.add', 'repair.edit'].some((p) => perms.has(p)) ? today().slice(0, 7) : '');
  const [veh, setVeh] = useState('');
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [prn, setPrn] = useState<Order | null>(null);
  const [drivers, setDrivers] = useState<{ id: string; full_name: string; position: string; is_active: boolean }[]>([]);
  useEffect(() => { void supabase.from('staff_members').select('id, full_name, position, is_active').order('full_name').then(({ data }) => setDrivers((data ?? []) as typeof drivers)); }, []);

  const load = useCallback(async () => {
    let q = supabase.from('repair_orders').select('id, code, vehicle_id, driver_id, repaired_on, odo_km, workshop, kind, note, files, created_by').order('repaired_on', { ascending: false });
    if (month) {
      const [y, m] = month.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      q = q.gte('repaired_on', `${month}-01`).lt('repaired_on', next);
    }
    if (veh) q = q.eq('vehicle_id', veh);
    const [o, v] = await Promise.all([q, supabase.from('vehicles').select('id, plate, is_active').order('plate')]);
    if (o.error) return toast('error', o.error.message);
    const list = (o.data ?? []) as Order[];
    setOrders(list);
    setVehicles((v.data ?? []) as Veh[]);
    if (list.length) {
      const it = await supabase.from('repair_items').select('order_id, seq, content, unit, qty, unit_price').in('order_id', list.map((x) => x.id)).order('seq');
      if (it.error) toast('error', `Không tải được nội dung phiếu: ${it.error.message}`);
      setItems((it.data ?? []) as Item[]);
    } else setItems([]);
  }, [month, veh, toast]);
  useEffect(() => { void load(); }, [load]);

  const plate = (id: string) => vehicles.find((v) => v.id === id)?.plate ?? '?';
  const itemsOf = (id: string) => items.filter((x) => x.order_id === id);
  const sum = orders.reduce((a, o) => a + total(itemsOf(o.id)), 0);

  function open(o: Order | null) {
    setF(o ? { id: o.id, vehicle_id: o.vehicle_id, driver_id: o.driver_id ?? '', repaired_on: o.repaired_on, odo_km: o.odo_km?.toString() ?? '', workshop: o.workshop ?? '', kind: o.kind, note: o.note ?? '', files: o.files, add: [],
      lines: [...itemsOf(o.id).map((x) => ({ content: x.content, unit: x.unit ?? '', qty: String(x.qty), unit_price: String(x.unit_price) })), { ...EMPTY_LINE }] }
      : { id: null, vehicle_id: veh || vehicles.find((v) => v.is_active)?.id || '', driver_id: '', repaired_on: today(), odo_km: '', workshop: '', kind: 'sua_chua', note: '', files: [], add: [], lines: [{ ...EMPTY_LINE }] });
  }
  async function save() {
    if (!f || !ctx.tenant_id) return;
    if (!f.vehicle_id) return toast('error', 'Chọn xe');
    setBusy(true);
    try {
      let files = f.files;
      if (f.add.length) {
        const prepared = await Promise.all(f.add.map(prepareFile));
        files = [...files, ...(await uploadFiles(ctx.tenant_id, 'xe', f.vehicle_id, plate(f.vehicle_id), 'sua_chua', prepared))];
      }
      await rpc('save_repair', { p_id: f.id, p: { vehicle_id: f.vehicle_id, driver_id: f.driver_id || null, repaired_on: f.repaired_on, odo_km: f.odo_km, workshop: f.workshop, kind: f.kind, note: f.note, files },
        p_items: f.lines.filter((l) => l.content.trim()).map((l) => ({ content: l.content, unit: l.unit.trim(), qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0 })) });
      toast('ok', f.id ? 'Đã lưu phiếu sửa chữa' : 'Đã thêm phiếu sửa chữa');
      profileChanged();   // Lưu trữ hồ sơ tự lưu / lưu đè PDF phiếu này
      setF(null);
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  async function del(o: Order) {
    const { error } = await supabase.from('repair_orders').delete().eq('id', o.id);
    if (error) return toast('error', errMsg(error));
    toast('ok', `Đã xóa phiếu ${o.code}`);
    await load();
  }
  const setLine = (i: number, p: Partial<Line>) => f && setF({ ...f, lines: f.lines.map((l, k) => (k === i ? { ...l, ...p } : l)) });

  return (
    <>
      <section className="card">
        <div className="item-head">
          <h2>Sửa chữa · {orders.length} phiếu · {money(sum)}</h2>
          {canEdit && <button className="btn primary" onClick={() => open(null)}>+ Phiếu sửa chữa</button>}
        </div>
        <div className="inline-form">
          <MonthPicker value={month} onChange={setMonth} allowEmpty />
          <label>Xe
            <select value={veh} onChange={(e) => setVeh(e.target.value)}>
              <option value="">Tất cả xe</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}
            </select>
          </label>
          {month && <button className="btn small link" onClick={() => setMonth('')}>Xem mọi tháng</button>}
        </div>
      </section>
      <section className="card">
        {orders.length === 0 && <p className="muted">Chưa có phiếu sửa chữa.</p>}
        <div className="table-wrap">
          <table className="plist rep-table">
            <thead><tr><th>Số phiếu</th><th>Ngày</th><th>Xe</th><th>Km</th><th>Nội dung</th><th>Gara</th><th>Tiền</th><th /></tr></thead>
            <tbody>
              {orders.map((o) => {
                const its = itemsOf(o.id);
                return (
                  <tr key={o.id}>
                    <td className="c-code"><b>{o.code}</b><div className="small muted">{KIND[o.kind]}</div></td>
                    <td className="c-date" data-l="Ngày">{fmtDate(o.repaired_on)}</td>
                    <td className="c-xe" data-l="Xe">{plate(o.vehicle_id)}{o.driver_id && <div className="small muted">{drivers.find((d) => d.id === o.driver_id)?.full_name}</div>}</td>
                    <td className="c-km" data-l="Km">{o.odo_km ? o.odo_km.toLocaleString('vi-VN') : ''}</td>
                    <td className="small c-nd">{its.map((x) => `${x.content}${Number(x.qty) > 1 ? ` (x${x.qty})` : ''}`).join('; ')}{o.note && <div className="muted">{o.note}</div>}
                      <FilesViewButton files={o.files} label={`Xem ${o.files.length} hóa đơn`} /></td>
                    <td className="small c-gara" data-l="Gara">{o.workshop}</td>
                    <td className="c-tien"><b>{money(total(its))}</b></td>
                    <td className="hs-act c-act"><button className="btn small" onClick={() => setPrn(o)}>In</button>{canEdit && <><button className="btn small" onClick={() => open(o)}>Sửa</button>
                      <button className="btn small link danger-text" onClick={() => void del(o)}>Xóa</button></>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {prn && ctx.tenant_id && (
        <RepairPrint tenantId={ctx.tenant_id} me={{ id: ctx.user_id, name: ctx.full_name ?? '' }} onClose={() => setPrn(null)}
          order={{ ...prn, plate: plate(prn.vehicle_id), items: itemsOf(prn.id).map((x) => ({ content: x.content, unit: x.unit, qty: Number(x.qty), unit_price: Number(x.unit_price) })) }} />
      )}
      {f && (
        <Modal wide title={f.id ? 'Sửa phiếu sửa chữa' : 'Phiếu sửa chữa mới'} onClose={() => setF(null)}>
          <div className="form">
            <div className="grid2">
              <label>Xe<select value={f.vehicle_id} onChange={(e) => setF({ ...f, vehicle_id: e.target.value })}>
                <option value="">Chọn xe</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
              <label>Lái xe<select value={f.driver_id} onChange={(e) => setF({ ...f, driver_id: e.target.value })}>
                <option value="">Chọn lái xe</option>
                {drivers.filter((d) => (d.position === 'lai_xe' && d.is_active) || d.id === f.driver_id).map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</select></label>
              <label>Ngày<input type="date" value={f.repaired_on} onChange={(e) => setF({ ...f, repaired_on: e.target.value })} /></label>
              <label>Loại<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label>Số km (Odo)<input type="number" min={0} inputMode="numeric" value={f.odo_km} onChange={(e) => setF({ ...f, odo_km: e.target.value })} /></label>
              <label>Gara / xưởng<input value={f.workshop} onChange={(e) => setF({ ...f, workshop: e.target.value })} /></label>
              <label>Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            </div>
            <div className="rep-lines">
              <div className="rep-line rep-head"><span>Nội dung</span><span>ĐVT</span><span>SL</span><span>Đơn giá</span><span>Thành tiền</span><span /></div>
              {f.lines.map((l, i) => (
                <div className="rep-line" key={i}>
                  <label className="c-nd"><span>Nội dung</span><input value={l.content} aria-label={`Nội dung ${i + 1}`} onChange={(e) => setLine(i, { content: e.target.value })} placeholder="vd: Thay nhớt" /></label>
                  <label className="c-dvt"><span>ĐVT</span><input value={l.unit} maxLength={30} aria-label={`ĐVT ${i + 1}`} onChange={(e) => setLine(i, { unit: e.target.value })} placeholder="cái" /></label>
                  <label className="c-sl"><span>SL</span><input type="number" min={0} step="0.5" inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></label>
                  <label className="c-dg"><span>Đơn giá</span><input type="number" min={0} step={1000} inputMode="numeric" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} /></label>
                  <div className="c-tt"><span>Thành tiền</span><b>{money((Number(l.qty) || 0) * (Number(l.unit_price) || 0))}</b></div>
                  <button type="button" className="btn small link c-x" aria-label="Bỏ dòng" onClick={() => setF({ ...f, lines: f.lines.filter((_, k) => k !== i) })}>×</button>
                </div>
              ))}
            </div>
            <div className="rep-sum">
              <button type="button" className="btn small" onClick={() => setF({ ...f, lines: [...f.lines, { ...EMPTY_LINE }] })}>+ Thêm dòng</button>
              <b>Tổng: {money(f.lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0))}</b>
            </div>
            <label>Ảnh / PDF hóa đơn, phiếu mua đồ
              <input type="file" multiple accept="image/*,application/pdf" onChange={(e) => setF({ ...f, add: [...f.add, ...Array.from(e.target.files ?? [])] })} />
            </label>
            <FilePreviews files={f.files} blobs={f.add} />
            {(f.files.length > 0 || f.add.length > 0) && <p className="small muted">{f.files.length} tệp đã lưu{f.add.length ? ` · ${f.add.length} tệp sẽ tải lên` : ''}</p>}
            <div className="actions">
              <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu phiếu'}</button>
              {f.id && <button type="button" className="btn" onClick={() => { const o = orders.find((x) => x.id === f.id); if (o) { setF(null); setPrn(o); } }}>In phiếu</button>}
              <button type="button" className="btn link" onClick={() => setF(null)}>Thôi</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
