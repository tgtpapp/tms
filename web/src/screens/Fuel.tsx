// Nhiên liệu (như app cũ): nhập dầu vào bồn, cấp dầu từ bồn cho xe, đổ ngoài cây xăng; tồn bồn, giá bình quân, tiêu hao theo xe.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { fmtDate, today } from '../components/Documents';
import { prepareFile, signedUrl, uploadFiles } from '../lib/documents';
import { DEFAULT_FUEL, FUEL_KIND, fuelLedger, normLevel, type FuelEntry, type FuelKind, type FuelSettings } from '../lib/fuel';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Veh { id: string; plate: string; is_active: boolean; fuel_norm: number | null }
interface Drv { id: string; full_name: string; position: string; is_active: boolean }
interface Form { id: string | null; kind: FuelKind; entry_date: string; entry_time: string; vehicle_id: string; driver_id: string; odo_km: string; liters: string;
  unit_price: string; supplier: string; invoice_no: string; note: string; files: string[]; add: File[] }

const num = (n: number, d = 0) => n.toLocaleString('vi-VN', { maximumFractionDigits: d });
const money = (n: number) => `${num(Math.round(n))} đ`;
const nowTime = () => new Date().toTimeString().slice(0, 5);
const monthEnd = (ym: string) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; };

export function FuelScreen({ ctx, perms }: { ctx: AccountContext; perms: Permissions }) {
  const toast = useToast();
  const canEdit = perms.has('vehicle.manage');
  const [rows, setRows] = useState<FuelEntry[]>([]);
  const [set, setSet] = useState<FuelSettings>(DEFAULT_FUEL);
  const [vehicles, setVehicles] = useState<Veh[]>([]);
  const [drivers, setDrivers] = useState<Drv[]>([]);
  const [tab, setTab] = useState<'phieu' | 'xe' | 'cai'>('phieu');
  const [month, setMonth] = useState(today().slice(0, 7));
  const [veh, setVeh] = useState('');
  const [kind, setKind] = useState<FuelKind | ''>('');
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [e, s, v, d] = await Promise.all([
      supabase.from('fuel_entries').select('id, code, kind, entry_date, entry_time, vehicle_id, driver_id, odo_km, liters, unit_price, supplier, invoice_no, note, files'),
      supabase.from('fuel_settings').select('tank_name, fuel_type, capacity_l, opening_l, opening_price, opening_on, alert_l').maybeSingle(),
      supabase.from('vehicles').select('id, plate, is_active, fuel_norm').order('plate'),
      supabase.from('staff_members').select('id, full_name, position, is_active').order('full_name'),
    ]);
    if (e.error) return toast('error', e.error.message);
    setRows(((e.data ?? []) as FuelEntry[]).map((r) => ({ ...r, liters: Number(r.liters), entry_time: r.entry_time?.slice(0, 5) ?? null })));
    if (s.data) setSet({ ...(s.data as FuelSettings), capacity_l: Number(s.data.capacity_l), opening_l: Number(s.data.opening_l), alert_l: Number(s.data.alert_l) });
    setVehicles(((v.data ?? []) as Veh[]).map((x) => ({ ...x, fuel_norm: x.fuel_norm == null ? null : Number(x.fuel_norm) })));
    setDrivers((d.data ?? []) as Drv[]);
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const led = useMemo(() => fuelLedger(rows, set), [rows, set]);
  const plate = (id: string | null) => (id ? vehicles.find((v) => v.id === id)?.plate ?? '?' : '');
  const driver = (id: string | null) => (id ? drivers.find((v) => v.id === id)?.full_name ?? '' : '');
  const inMonth = (r: FuelEntry) => !month || (r.entry_date >= `${month}-01` && r.entry_date < monthEnd(month));
  const shown = led.list.filter((r) => inMonth(r) && (!veh || r.vehicle_id === veh) && (!kind || r.kind === kind)).reverse();
  const out = shown.filter((r) => r.kind !== 'nhap');
  const pct = set.capacity_l > 0 ? Math.max(0, Math.min(100, (led.tank / set.capacity_l) * 100)) : 0;
  const low = led.tank <= set.alert_l;

  function open(r: FuelEntry | null, k: FuelKind = 'bon') {
    if (r) setF({ id: r.id, kind: r.kind, entry_date: r.entry_date, entry_time: r.entry_time ?? '', vehicle_id: r.vehicle_id ?? '', driver_id: r.driver_id ?? '',
      odo_km: r.odo_km?.toString() ?? '', liters: String(r.liters), unit_price: r.unit_price?.toString() ?? '', supplier: r.supplier ?? '', invoice_no: r.invoice_no ?? '',
      note: r.note ?? '', files: r.files, add: [] });
    else setF({ id: null, kind: k, entry_date: today(), entry_time: nowTime(), vehicle_id: k === 'nhap' ? '' : veh, driver_id: '', odo_km: '', liters: '',
      unit_price: k === 'bon' ? '' : String(k === 'nhap' ? Math.round(led.avg) || '' : ''), supplier: '', invoice_no: '', note: '', files: [], add: [] });
  }
  async function save() {
    if (!f || !ctx.tenant_id) return;
    setBusy(true);
    try {
      let files = f.files;
      if (f.add.length) {
        const prepared = await Promise.all(f.add.map(prepareFile));
        const owner = f.kind === 'nhap' || !f.vehicle_id ? 'bon-dau' : f.vehicle_id;
        files = [...files, ...(await uploadFiles(ctx.tenant_id, 'xe', owner, f.kind === 'nhap' ? 'BON' : plate(f.vehicle_id), 'nhien_lieu', prepared))];
      }
      await rpc('save_fuel', { p_id: f.id, p: { ...f, add: undefined, files } });
      toast('ok', f.id ? 'Đã lưu phiếu' : `Đã thêm phiếu ${FUEL_KIND[f.kind].short.toLowerCase()}`);
      setF(null);
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  async function del(r: FuelEntry) {
    const { error } = await supabase.from('fuel_entries').delete().eq('id', r.id);
    if (error) return toast('error', errMsg(error));
    toast('ok', `Đã xóa phiếu ${r.code}`);
    await load();
  }
  async function view(path: string) {
    try { window.open(await signedUrl(path), '_blank', 'noopener'); } catch (e) { toast('error', errMsg(e)); }
  }

  // Theo xe trong tháng: lít, tiền, km chạy (giữa các lần đổ có km), L/100km so với định mức
  const byVeh = vehicles.map((v) => {
    const L = led.list.filter((r) => r.vehicle_id === v.id && r.kind !== 'nhap' && inMonth(r));
    const lit = L.reduce((a, r) => a + r.liters, 0), amount = L.reduce((a, r) => a + (led.map.get(r.id)?.amount ?? 0), 0);
    const withKm = L.filter((r) => (led.map.get(r.id)?.km ?? 0) > 0);
    const km = withKm.reduce((a, r) => a + (led.map.get(r.id)?.km ?? 0), 0), litKm = withKm.reduce((a, r) => a + r.liters, 0);
    return { v, n: L.length, lit, amount, km, per100: km ? (litKm / km) * 100 : 0 };
  }).filter((x) => x.n > 0 || (x.v.is_active && !veh));

  return (
    <>
      <section className="card">
        <div className="item-head">
          <h2>Nhiên liệu</h2>
          {canEdit && <div className="actions">
            <button className="btn primary" onClick={() => open(null, 'bon')}>+ Cấp dầu từ bồn</button>
            <button className="btn" onClick={() => open(null, 'ngoai')}>+ Đổ ngoài</button>
            <button className="btn" onClick={() => open(null, 'nhap')}>+ Nhập bồn</button>
          </div>}
        </div>
        <div className="fuel-tank">
          <div className={`fuel-bar${low ? ' low' : ''}`} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Tồn bồn"><i style={{ width: `${pct}%` }} /></div>
          <div><b>{set.tank_name}</b>: tồn <b className={low ? 'danger-text' : ''}>{num(led.tank, 2)} lít</b> / {num(set.capacity_l)} lít ({Math.round(pct)}%)
            · giá bình quân <b>{money(led.avg)}</b>/lít · {set.fuel_type}
            {low && <span className="badge locked">Dưới mức cảnh báo {num(set.alert_l)} lít, cần nhập thêm</span>}</div>
        </div>
        <div className="seg" role="tablist" aria-label="Xem">
          {([['phieu', 'Phiếu'], ['xe', 'Theo xe'], ['cai', 'Thiết lập']] as const).map(([k, l]) =>
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab !== 'cai' && <div className="inline-form">
          <label>Tháng<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
          <label>Xe<select value={veh} onChange={(e) => setVeh(e.target.value)}><option value="">Tất cả xe</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
          {tab === 'phieu' && <label>Loại<select value={kind} onChange={(e) => setKind(e.target.value as FuelKind | '')}><option value="">Tất cả</option>
            {(Object.keys(FUEL_KIND) as FuelKind[]).map((k) => <option key={k} value={k}>{FUEL_KIND[k].short}</option>)}</select></label>}
          {month && <button className="btn small link" onClick={() => setMonth('')}>Xem mọi tháng</button>}
        </div>}
      </section>

      {tab === 'phieu' && (
        <section className="card">
          <p className="small muted">{shown.length} phiếu · cấp cho xe {num(out.reduce((a, r) => a + r.liters, 0), 2)} lít · {money(out.reduce((a, r) => a + (led.map.get(r.id)?.amount ?? 0), 0))}
            {' · '}nhập bồn {num(shown.filter((r) => r.kind === 'nhap').reduce((a, r) => a + r.liters, 0), 2)} lít</p>
          {shown.length === 0 && <p className="muted">Chưa có phiếu.</p>}
          <div className="table-wrap">
            <table className="plist">
              <thead><tr><th>Số phiếu</th><th>Ngày</th><th>Xe · lái xe</th><th>Km</th><th>Lít</th><th>Đơn giá</th><th>Thành tiền</th><th>Tiêu hao</th><th>Tồn bồn</th><th /></tr></thead>
              <tbody>
                {shown.map((r) => {
                  const m = led.map.get(r.id);
                  const lv = normLevel(m?.per100 ?? 0, vehicles.find((v) => v.id === r.vehicle_id)?.fuel_norm ?? null);
                  return (
                    <tr key={r.id}>
                      <td><b>{r.code}</b><div className="small muted">{FUEL_KIND[r.kind].short}</div></td>
                      <td>{fmtDate(r.entry_date)}<div className="small muted">{r.entry_time}</div></td>
                      <td>{r.kind === 'nhap' ? <span className="small">{r.supplier}</span> : <><b>{plate(r.vehicle_id)}</b><div className="small muted">{driver(r.driver_id)}{r.kind === 'ngoai' && r.supplier ? ` · ${r.supplier}` : ''}</div></>}
                        {r.note && <div className="small muted">{r.note}</div>}
                        {r.files.map((p, i) => <button key={p} className="btn small link" onClick={() => void view(p)}>Chứng từ {i + 1}</button>)}</td>
                      <td>{r.odo_km ? num(r.odo_km) : ''}{m?.km ? <div className="small muted">+{num(m.km)} km</div> : null}</td>
                      <td className={r.kind === 'nhap' ? 'ok-text' : ''}><b>{r.kind === 'nhap' ? '+' : ''}{num(r.liters, 2)}</b></td>
                      <td>{m ? num(Math.round(m.price)) : ''}{r.kind === 'bon' && r.unit_price == null && <div className="small muted">bình quân</div>}</td>
                      <td>{m ? num(m.amount) : ''}</td>
                      <td>{m?.per100 ? <span className={`badge${lv === 'bad' ? ' locked' : lv === 'warn' ? ' warn-badge' : ''}`}>{num(m.per100, 1)} L/100km</span> : ''}</td>
                      <td className="small">{r.kind !== 'ngoai' && m ? num(m.tank, 2) : ''}</td>
                      <td className="hs-act">{canEdit && <><button className="btn small" onClick={() => open(r)}>Sửa</button>
                        <button className="btn small link danger-text" onClick={() => void del(r)}>Xóa</button></>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'xe' && (
        <section className="card">
          <p className="small muted">Tiêu hao tính từ km giữa 2 lần đổ dầu liên tiếp có ghi km. Định mức đặt ở thẻ Thiết lập.</p>
          <div className="table-wrap">
            <table className="plist">
              <thead><tr><th>Xe</th><th>Số lần</th><th>Lít</th><th>Tiền</th><th>Km chạy</th><th>Tiêu hao</th><th>Định mức</th></tr></thead>
              <tbody>
                {byVeh.map((x) => {
                  const lv = normLevel(x.per100, x.v.fuel_norm);
                  return (
                    <tr key={x.v.id}>
                      <td><b>{x.v.plate}</b></td><td>{x.n}</td><td>{num(x.lit, 2)}</td><td>{num(x.amount)}</td><td>{x.km ? num(x.km) : ''}</td>
                      <td>{x.per100 ? <span className={`badge${lv === 'bad' ? ' locked' : lv === 'warn' ? ' warn-badge' : ''}`}>{num(x.per100, 1)} L/100km</span> : ''}</td>
                      <td>{x.v.fuel_norm ? `${num(x.v.fuel_norm, 1)} L/100km` : <span className="muted small">chưa đặt</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr><th>Cộng</th><th>{byVeh.reduce((a, x) => a + x.n, 0)}</th><th>{num(byVeh.reduce((a, x) => a + x.lit, 0), 2)}</th><th>{num(byVeh.reduce((a, x) => a + x.amount, 0))}</th><th>{num(byVeh.reduce((a, x) => a + x.km, 0))}</th><th /><th /></tr></tfoot>
            </table>
          </div>
        </section>
      )}

      {tab === 'cai' && <FuelSetup key={`${JSON.stringify(set)}${vehicles.length}`} set={set} vehicles={vehicles} canEdit={canEdit} onSaved={load} />}

      {f && (
        <Modal title={f.id ? `Sửa phiếu · ${FUEL_KIND[f.kind].label}` : FUEL_KIND[f.kind].label} onClose={() => setF(null)}>
          <div className="form">
            <div className="grid2">
              <label>Ngày<input type="date" value={f.entry_date} onChange={(e) => setF({ ...f, entry_date: e.target.value })} /></label>
              <label>Giờ<input type="time" value={f.entry_time} onChange={(e) => setF({ ...f, entry_time: e.target.value })} /></label>
              {f.kind !== 'nhap' && <>
                <label>Xe<select value={f.vehicle_id} onChange={(e) => setF({ ...f, vehicle_id: e.target.value })}>
                  <option value="">Chọn xe</option>{vehicles.filter((v) => v.is_active || v.id === f.vehicle_id).map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
                <label>Lái xe<select value={f.driver_id} onChange={(e) => setF({ ...f, driver_id: e.target.value })}>
                  <option value="">—</option>{drivers.filter((d) => (d.is_active && d.position === 'lai_xe') || d.id === f.driver_id).map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</select></label>
                <label>Km đồng hồ (Odo)<input type="number" min={0} inputMode="numeric" value={f.odo_km} onChange={(e) => setF({ ...f, odo_km: e.target.value })} /></label>
              </>}
              <label>Số lít<input type="number" min={0} step="0.01" inputMode="decimal" value={f.liters} onChange={(e) => setF({ ...f, liters: e.target.value })} /></label>
              <label>Đơn giá (đ/lít){f.kind === 'bon' && <span className="small muted"> · để trống = giá bình quân {num(Math.round(led.avg))}</span>}
                <input type="number" min={0} step={10} inputMode="numeric" value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /></label>
              {f.kind !== 'bon' && <label>{f.kind === 'nhap' ? 'Nhà cung cấp' : 'Cây xăng'}<input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></label>}
              {f.kind !== 'bon' && <label>Số hóa đơn<input value={f.invoice_no} onChange={(e) => setF({ ...f, invoice_no: e.target.value })} /></label>}
              <label>Ghi chú<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            </div>
            <p className="small"><b>Thành tiền: {money((Number(f.liters) || 0) * (Number(f.unit_price) || (f.kind === 'bon' ? led.avg : 0)))}</b></p>
            <label>Ảnh hóa đơn / trụ bơm / phiếu
              <input type="file" multiple accept="image/*,application/pdf" onChange={(e) => setF({ ...f, add: [...f.add, ...Array.from(e.target.files ?? [])] })} />
            </label>
            {(f.files.length > 0 || f.add.length > 0) && <p className="small muted">{f.files.length} tệp đã lưu{f.add.length ? ` · ${f.add.length} tệp sẽ tải lên` : ''}</p>}
            <div className="actions">
              <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu phiếu'}</button>
              <button type="button" className="btn link" onClick={() => setF(null)}>Thôi</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function FuelSetup({ set, vehicles, canEdit, onSaved }: { set: FuelSettings; vehicles: Veh[]; canEdit: boolean; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [s, setS] = useState({ ...set, opening_on: set.opening_on ?? '' });
  const [norm, setNorm] = useState<Record<string, string>>(Object.fromEntries(vehicles.map((v) => [v.id, v.fuel_norm?.toString() ?? ''])));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await supabase.from('fuel_settings').upsert({ tank_name: s.tank_name.trim() || DEFAULT_FUEL.tank_name, fuel_type: s.fuel_type.trim() || DEFAULT_FUEL.fuel_type,
        capacity_l: Number(s.capacity_l) || 0, opening_l: Number(s.opening_l) || 0, opening_price: Math.round(Number(s.opening_price) || 0),
        opening_on: s.opening_on || null, alert_l: Number(s.alert_l) || 0 });
      if (r.error) throw r.error;
      for (const v of vehicles) {
        const n = norm[v.id] ? Number(norm[v.id]) : null;
        if (n !== v.fuel_norm) {
          const u = await supabase.from('vehicles').update({ fuel_norm: n }).eq('id', v.id);
          if (u.error) throw u.error;
        }
      }
      toast('ok', 'Đã lưu thiết lập nhiên liệu');
      await onSaved();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card form">
      <h3 className="section-title">Bồn dầu</h3>
      <div className="grid2">
        <label>Tên bồn<input value={s.tank_name} disabled={!canEdit} onChange={(e) => setS({ ...s, tank_name: e.target.value })} /></label>
        <label>Loại nhiên liệu<input value={s.fuel_type} disabled={!canEdit} onChange={(e) => setS({ ...s, fuel_type: e.target.value })} /></label>
        <label>Sức chứa (lít)<input type="number" min={0} value={s.capacity_l} disabled={!canEdit} onChange={(e) => setS({ ...s, capacity_l: Number(e.target.value) })} /></label>
        <label>Cảnh báo khi tồn dưới (lít)<input type="number" min={0} value={s.alert_l} disabled={!canEdit} onChange={(e) => setS({ ...s, alert_l: Number(e.target.value) })} /></label>
        <label>Tồn đầu kỳ (lít)<input type="number" step="0.01" value={s.opening_l} disabled={!canEdit} onChange={(e) => setS({ ...s, opening_l: Number(e.target.value) })} /></label>
        <label>Giá tồn đầu kỳ (đ/lít)<input type="number" min={0} value={s.opening_price} disabled={!canEdit} onChange={(e) => setS({ ...s, opening_price: Number(e.target.value) })} /></label>
        <label>Ngày tồn đầu kỳ<input type="date" value={s.opening_on} disabled={!canEdit} onChange={(e) => setS({ ...s, opening_on: e.target.value })} /></label>
      </div>
      <p className="small muted">Phiếu trước ngày tồn đầu kỳ không tính vào tồn bồn (vẫn tính tiêu hao). Để trống ngày = tính mọi phiếu.</p>
      <h3 className="section-title">Định mức tiêu hao từng xe (lít / 100 km)</h3>
      <div className="grid2">
        {vehicles.filter((v) => v.is_active || v.fuel_norm).map((v) => (
          <label key={v.id}>{v.plate}<input type="number" min={0} step="0.1" inputMode="decimal" value={norm[v.id] ?? ''} disabled={!canEdit}
            onChange={(e) => setNorm({ ...norm, [v.id]: e.target.value })} /></label>
        ))}
      </div>
      {canEdit && <div className="actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu thiết lập'}</button></div>}
    </section>
  );
}
