// Km xe đã chạy (như app cũ "Km xe (Skysoft)"): nhập báo cáo GPS (file hoặc dán bảng), nhập tay; tổng km tháng, km lũy kế theo Odo gốc.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MonthPicker } from '../components/MonthPicker';
import { Modal } from '../components/Modal';
import { fmtDate, today } from '../components/Documents';
import { parseKmReport, type KmParse } from '../lib/kmImport';
import { plateKey } from '../lib/legacyImport';
import type { Permissions } from '../lib/permissions';
import { textToRows } from '../lib/scheduleImport';
import { readSheet } from '../lib/sheetRead';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Veh { id: string; plate: string; is_active: boolean; odo_start: number | null; odo_date: string | null }
interface Km { id: string; vehicle_id: string; run_date: string; km: number; source: string }
const num = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
const SRC: Record<string, string> = { tay: 'Nhập tay', gps: 'GPS', app_cu: 'App cũ' };
const monthEnd = (ym: string) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; };

export function VehicleKmScreen({ perms }: { perms: Permissions }) {
  const toast = useToast();
  const canEdit = perms.has('vehicle.manage');
  const [vehicles, setVehicles] = useState<Veh[]>([]);
  const [sum, setSum] = useState<Record<string, { days: number; km: number; total: number }>>({});
  const [month, setMonth] = useState(today().slice(0, 7));
  const [open, setOpen] = useState<string | null>(null);
  const [days, setDays] = useState<Km[]>([]);
  const [imp, setImp] = useState(false);
  const [one, setOne] = useState<{ id: string | null; vehicle_id: string; run_date: string; km: string } | null>(null);

  const load = useCallback(async () => {
    const [v, k] = await Promise.all([
      supabase.from('vehicles').select('id, plate, is_active, odo_start, odo_date').order('plate'),
      supabase.rpc('vehicle_km_summary', { p_from: `${month}-01`, p_to: monthEnd(month) }),
    ]);
    if (k.error) return toast('error', k.error.message);
    setVehicles((v.data ?? []) as Veh[]);
    setSum(Object.fromEntries(((k.data ?? []) as { vehicle_id: string; days: number; km: number; km_since_odo: number }[])
      .map((x) => [x.vehicle_id, { days: x.days, km: Number(x.km), total: Number(x.km_since_odo) }])));
  }, [month, toast]);
  useEffect(() => { void load(); }, [load]);
  const loadDays = useCallback(async (id: string) => {
    const { data } = await supabase.from('vehicle_km').select('id, vehicle_id, run_date, km, source').eq('vehicle_id', id)
      .gte('run_date', `${month}-01`).lt('run_date', monthEnd(month)).order('run_date');
    setDays(((data ?? []) as Km[]).map((x) => ({ ...x, km: Number(x.km) })));
  }, [month]);
  useEffect(() => { if (open) void loadDays(open); }, [open, loadDays]);

  const byVeh = useMemo(() => vehicles.map((v) => ({ v, ...(sum[v.id] ?? { days: 0, km: 0, total: 0 }) }))
    .filter((x) => x.km > 0 || x.days > 0 || x.v.is_active), [vehicles, sum]);

  async function saveOne() {
    if (!one) return;
    if (!one.vehicle_id || !one.run_date || one.km === '') return toast('error', 'Chọn xe, ngày và nhập km');
    try {
      await rpc('import_vehicle_km', { p_rows: [{ vehicle_id: one.vehicle_id, run_date: one.run_date, km: Number(one.km) }], p_source: 'tay' });
      toast('ok', 'Đã lưu km');
      setOne(null);
      await load();
      if (open) await loadDays(open);
    } catch (e) { toast('error', errMsg(e)); }
  }
  async function del(r: Km) {
    const { error } = await supabase.from('vehicle_km').delete().eq('id', r.id);
    if (error) return toast('error', errMsg(error));
    await load();
    await loadDays(r.vehicle_id);
  }

  return (
    <>
      <section className="card">
        <div className="item-head">
          <h2>Km xe đã chạy · {num(byVeh.reduce((a, x) => a + x.km, 0))} km</h2>
          {canEdit && <div className="actions">
            <button className="btn primary" onClick={() => setImp(true)}>Nhập báo cáo GPS</button>
            <button className="btn" onClick={() => setOne({ id: null, vehicle_id: '', run_date: today(), km: '' })}>+ Nhập tay</button>
          </div>}
        </div>
        <div className="inline-form"><MonthPicker value={month} onChange={setMonth} /></div>
      </section>
      <section className="card">
        <div className="table-wrap">
          <table className="plist">
            <thead><tr><th>Xe</th><th>Ngày có chạy</th><th>Km trong tháng</th><th>Km lũy kế (Odo)</th><th /></tr></thead>
            <tbody>
              {byVeh.map((x) => (
                <tr key={x.v.id}>
                  <td><b>{x.v.plate}</b></td>
                  <td>{x.days}</td>
                  <td><b>{num(x.km)}</b></td>
                  <td>{x.v.odo_start != null ? `${num(x.v.odo_start + x.total)} km` : <span className="small muted">chưa có Odo gốc (Lý lịch xe)</span>}</td>
                  <td>{x.days + x.km > 0 && <button className="btn small" onClick={() => setOpen(x.v.id)}>Từng ngày</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <KmStats vehicles={vehicles} />
      {open && (
        <Modal title={`Km từng ngày · ${vehicles.find((v) => v.id === open)?.plate ?? ''}`} onClose={() => setOpen(null)}>
          <table className="plist">
            <thead><tr><th>Ngày</th><th>Km</th><th>Nguồn</th><th /></tr></thead>
            <tbody>
              {days.map((r) => (
                <tr key={r.id}><td>{fmtDate(r.run_date)}</td><td>{num(r.km)}</td><td className="small muted">{SRC[r.source]}</td>
                  <td className="hs-act">{canEdit && <><button className="btn small" onClick={() => setOne({ id: r.id, vehicle_id: r.vehicle_id, run_date: r.run_date, km: String(r.km) })}>Sửa</button>
                    <button className="btn small link danger-text" onClick={() => void del(r)}>Xóa</button></>}</td></tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      {one && (
        <Modal title={one.id ? 'Sửa km' : 'Nhập km tay'} onClose={() => setOne(null)}>
          <div className="form">
            <label>Xe<select value={one.vehicle_id} disabled={!!one.id} onChange={(e) => setOne({ ...one, vehicle_id: e.target.value })}>
              <option value="">Chọn xe</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
            <label>Ngày<input type="date" value={one.run_date} disabled={!!one.id} onChange={(e) => setOne({ ...one, run_date: e.target.value })} /></label>
            <label>Km chạy trong ngày<input type="number" min={0} step="0.1" inputMode="decimal" value={one.km} onChange={(e) => setOne({ ...one, km: e.target.value })} /></label>
            <div className="actions"><button className="btn primary" onClick={() => void saveOne()}>Lưu</button><button className="btn link" onClick={() => setOne(null)}>Thôi</button></div>
          </div>
        </Modal>
      )}
      {imp && <KmImport vehicles={vehicles} onClose={() => setImp(false)} onDone={async (m) => { setImp(false); if (m) setMonth(m); await load(); }} />}
    </>
  );
}

function KmImport({ vehicles, onClose, onDone }: { vehicles: Veh[]; onClose: () => void; onDone: (month: string | null) => Promise<void> }) {
  const toast = useToast();
  const [p, setP] = useState<KmParse | null>(null);
  const [name, setName] = useState('');
  const [veh, setVeh] = useState('');       // khi báo cáo không có biển số
  const [day, setDay] = useState('');       // khi báo cáo không có cột ngày
  const [busy, setBusy] = useState(false);
  const byKey = useMemo(() => new Map(vehicles.map((v) => [plateKey(v.plate), v.id])), [vehicles]);

  function take(data: Parameters<typeof parseKmReport>[0], src: string) {
    const r = parseKmReport(data);
    setName(src);
    setP(r);
    setVeh(r.plate ? byKey.get(plateKey(r.plate)) ?? '' : '');
    setDay(r.to ?? '');
    if (!r.rows.length) toast('error', 'Không tìm thấy cột km trong báo cáo. Hãy xuất báo cáo tổng hợp km theo ngày / theo xe.');
  }
  async function file(f: File) {
    try { take(await readSheet(f), f.name); } catch (e) { toast('error', errMsg(e)); }
  }
  const list = (p?.rows ?? []).map((r) => {
    const vehicle_id = r.plate ? byKey.get(plateKey(r.plate)) ?? (p?.plate && r.plate === p.plate ? veh || null : null) : veh || null;
    return { ...r, vehicle_id, date: p?.noDate ? day : r.date };
  });
  const ok = list.filter((r) => r.vehicle_id && r.date);
  const unknown = [...new Set(list.filter((r) => r.plate && !r.vehicle_id).map((r) => r.plate))];

  async function save() {
    setBusy(true);
    try {
      let c = 0, u = 0, s = 0;
      for (let i = 0; i < ok.length; i += 2000) {
        const res = await rpc<{ created: number; updated: number; same: number }>('import_vehicle_km',
          { p_rows: ok.slice(i, i + 2000).map((r) => ({ vehicle_id: r.vehicle_id, run_date: r.date, km: r.km })), p_source: 'gps' });
        c += res.created; u += res.updated; s += res.same;
      }
      toast('ok', `Đã nhập km: ${c} dòng mới, ${u} dòng cập nhật${s ? `, ${s} dòng không đổi` : ''}`);
      const months = [...new Set(ok.map((r) => r.date.slice(0, 7)))].sort();
      await onDone(months[months.length - 1] ?? null);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal wide title="Nhập báo cáo km từ GPS" onClose={onClose}>
      <div className="form">
        <p className="small muted">Vào phần mềm GPS (Skysoft…), xuất báo cáo tổng hợp km theo ngày hoặc theo xe ra Excel rồi chọn file ở đây (.xls, .xlsx, .csv),
          hoặc bôi đen bảng trên trang báo cáo, sao chép rồi dán vào ô dưới.</p>
        <label>File báo cáo<input type="file" accept=".xls,.xlsx,.csv,.htm,.html" onChange={(e) => { const f = e.target.files?.[0]; if (f) void file(f); }} /></label>
        <label>Hoặc dán bảng<textarea rows={3} placeholder="Dán bảng báo cáo vào đây" onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); take(textToRows(t), 'Bảng dán'); } }} /></label>
        {p && (
          <>
            <p><b>{name}</b>: {p.rows.length} dòng km{p.from && p.to ? `, từ ${fmtDate(p.from)} đến ${fmtDate(p.to)}` : ''}</p>
            {p.noPlate && <label>Báo cáo không có biển số, chọn xe<select value={veh} onChange={(e) => setVeh(e.target.value)}>
              <option value="">Chọn xe</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>}
            {p.plate && !byKey.get(plateKey(p.plate)) && <label>Biển số {p.plate} chưa có trong danh sách xe, chọn xe<select value={veh} onChange={(e) => setVeh(e.target.value)}>
              <option value="">Chọn xe</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>}
            {p.noDate && <label>Báo cáo không có cột ngày (km cả kỳ), ghi vào ngày<input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>}
            {unknown.length > 0 && <p className="small error-text">Biển số chưa có trong danh sách xe (bỏ qua): {unknown.join(', ')}</p>}
            <div className="table-wrap" style={{ maxHeight: 280 }}>
              <table className="plist">
                <thead><tr><th>Xe</th><th>Ngày</th><th>Km</th></tr></thead>
                <tbody>{list.slice(0, 200).map((r, i) => (
                  <tr key={i} className={r.vehicle_id && r.date ? '' : 'muted'}><td>{r.vehicle_id ? vehicles.find((v) => v.id === r.vehicle_id)?.plate : r.plate || '—'}</td>
                    <td>{r.date ? fmtDate(r.date) : '—'}</td><td>{num(r.km)}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <div className="actions">
              <button className="btn primary" disabled={busy || !ok.length} onClick={() => void save()}>{busy ? 'Đang lưu…' : `Lưu ${ok.length} dòng`}</button>
              <button className="btn link" onClick={onClose}>Thôi</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Thống kê km theo ngày / tuần / tháng / năm (như app cũ) */
type Unit = 'day' | 'week' | 'month' | 'year';
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function periods(unit: Unit, ym: string, y: string): { from: string; to: string; cols: { key: string; label: string }[] } {
  if (unit === 'day' || unit === 'week') {
    const [yy, mm] = ym.split('-').map(Number), first = new Date(yy, mm - 1, 1), last = new Date(yy, mm, 0);
    if (unit === 'day') {
      return { from: iso(first), to: iso(new Date(yy, mm, 1)), cols: Array.from({ length: last.getDate() }, (_, i) => ({ key: iso(new Date(yy, mm - 1, i + 1)), label: String(i + 1) })) };
    }
    const mon = new Date(first); mon.setDate(first.getDate() - ((first.getDay() + 6) % 7));   // thứ Hai đầu tuần chứa ngày 1
    const cols: { key: string; label: string }[] = [];
    for (const d = new Date(mon); d <= last; d.setDate(d.getDate() + 7)) {
      const e = new Date(d); e.setDate(d.getDate() + 6);
      cols.push({ key: iso(d), label: `${d.getDate()}/${d.getMonth() + 1}–${e.getDate()}/${e.getMonth() + 1}` });
    }
    const end = new Date(cols[cols.length - 1].key); end.setDate(end.getDate() + 7);
    return { from: cols[0].key, to: iso(end), cols };
  }
  if (unit === 'month') {
    const n = Number(y);
    return { from: `${n}-01-01`, to: `${n + 1}-01-01`, cols: Array.from({ length: 12 }, (_, i) => ({ key: `${n}-${String(i + 1).padStart(2, '0')}-01`, label: `T${i + 1}` })) };
  }
  const n = Number(y);
  return { from: `${n - 4}-01-01`, to: `${n + 1}-01-01`, cols: Array.from({ length: 5 }, (_, i) => ({ key: `${n - 4 + i}-01-01`, label: String(n - 4 + i) })) };
}

function KmStats({ vehicles }: { vehicles: Veh[] }) {
  const toast = useToast();
  const [unit, setUnit] = useState<Unit>('day');
  const [ym, setYm] = useState(today().slice(0, 7));
  const [y, setY] = useState(today().slice(0, 4));
  const [data, setData] = useState<Map<string, number>>(new Map());
  const P = useMemo(() => periods(unit, ym, y), [unit, ym, y]);
  useEffect(() => {
    void supabase.rpc('vehicle_km_stats', { p_from: P.from, p_to: P.to, p_unit: unit }).then(({ data: d, error }) => {
      if (error) return toast('error', error.message);
      setData(new Map(((d ?? []) as { vehicle_id: string; period: string; km: number }[]).map((r) => [`${r.vehicle_id}|${r.period}`, Number(r.km)])));
    });
  }, [P, unit, toast]);
  const val = (v: string, c: string) => data.get(`${v}|${c}`) ?? 0;
  const rows = vehicles.map((v) => ({ v, sum: P.cols.reduce((a, c) => a + val(v.id, c.key), 0) })).filter((x) => x.sum > 0 || x.v.is_active);
  const total = (c: string) => rows.reduce((a, x) => a + val(x.v.id, c), 0);
  function csv() {
    const L = [['Xe', ...P.cols.map((c) => c.label), 'Cộng'], ...rows.map((x) => [x.v.plate, ...P.cols.map((c) => String(val(x.v.id, c.key) || '')), String(x.sum)]),
      ['Cộng', ...P.cols.map((c) => String(total(c.key))), String(rows.reduce((a, x) => a + x.sum, 0))]];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\uFEFF', L.map((l) => l.join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `km-xe-${unit}-${unit === 'day' || unit === 'week' ? ym : y}.csv`;
    a.click();
  }
  return (
    <section className="card">
      <div className="item-head">
        <h2>Thống kê km theo kỳ</h2>
        <div className="seg" role="tablist" aria-label="Kỳ thống kê">
          {([['day', 'Ngày'], ['week', 'Tuần'], ['month', 'Tháng'], ['year', 'Năm']] as const).map(([k, l]) =>
            <button key={k} type="button" role="tab" aria-selected={unit === k} className={unit === k ? 'on' : ''} onClick={() => setUnit(k)}>{l}</button>)}
        </div>
      </div>
      <div className="inline-form">
        {(unit === 'day' || unit === 'week') && <MonthPicker value={ym} onChange={setYm} />}
        {(unit === 'month' || unit === 'year') && <label>{unit === 'year' ? 'Đến năm' : 'Năm'}<input type="number" min={2000} max={2100} value={y} onChange={(e) => /^\d{4}$/.test(e.target.value) && setY(e.target.value)} /></label>}
        <button className="btn small" onClick={csv}>Tải Excel (CSV)</button>
      </div>
      <div className="table-wrap">
        <table className="plist km-stats">
          <thead><tr><th>Xe</th>{P.cols.map((c) => <th key={c.key}>{c.label}</th>)}<th>Cộng</th></tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.v.id}><td><b>{x.v.plate}</b></td>{P.cols.map((c) => { const k = val(x.v.id, c.key); return <td key={c.key} className={k ? '' : 'muted'}>{k ? num(k) : '·'}</td>; })}<td><b>{num(x.sum)}</b></td></tr>
          ))}</tbody>
          <tfoot><tr><th>Cộng</th>{P.cols.map((c) => <th key={c.key}>{num(total(c.key))}</th>)}<th>{num(rows.reduce((a, x) => a + x.sum, 0))}</th></tr></tfoot>
        </table>
      </div>
    </section>
  );
}
