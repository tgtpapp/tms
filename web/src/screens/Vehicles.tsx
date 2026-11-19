import { SeatIcon } from '../components/SeatIcon';
import { DeleteButton } from '../components/DeleteButton';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { AddVehicle, DOC_COLS, DocAlerts, VEHICLE_COLS, VehicleList, type Doc, type Vehicle } from './VehicleList';

type BodyStyle = 'ghe_ngoi' | 'giuong_nam' | 'limousine' | 'phong_nam' | 'khac';
type Fuel = 'dau' | 'xang' | 'dien' | 'khi' | 'hybrid';
type SeatKind = 'ghe' | 'giuong' | 'tai_xe' | 'cua';

interface VehicleType {
  id: string; code: string; name: string; brand: string | null; model_code: string | null;
  body_style: BodyStyle; decks: number; reg_seats: number; reg_berths: number; reg_standing: number;
  curb_weight_kg: number | null; gross_weight_kg: number | null; fuel: Fuel | null; amenities: string[];
  layout_rows: number; layout_cols: number; is_active: boolean;
}
interface Seat {
  vehicle_type_id: string; label: string; deck: number; row_no: number; col_no: number;
  kind: SeatKind; is_priority: boolean; is_sellable: boolean;
}

const BODY: Record<BodyStyle, string> = {
  ghe_ngoi: 'Ghế ngồi', giuong_nam: 'Giường nằm', limousine: 'Limousine', phong_nam: 'Phòng nằm (cabin)', khac: 'Khác',
};
const FUEL: Record<Fuel, string> = { dau: 'Dầu diesel', xang: 'Xăng', dien: 'Điện', khi: 'Khí (CNG/LNG)', hybrid: 'Hybrid' };
const KIND: Record<SeatKind, string> = { ghe: 'ghế', giuong: 'giường', tai_xe: 'tài xế', cua: 'cửa lên xuống' };
const isExtra = (k: SeatKind) => k === 'tai_xe' || k === 'cua';

export function VehiclesScreen({ ctx, perms }: { ctx: AccountContext; perms: Permissions }) {
  const toast = useToast();
  const [types, setTypes] = useState<VehicleType[]>([]);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [warnDays, setWarnDays] = useState(30);
  const [open, setOpen] = useState<string | null>(null);
  const canEdit = perms.has('vehicle.manage');

  const load = useCallback(async () => {
    const [t, s, v, d, w] = await Promise.all([
      supabase.from('vehicle_types').select('id, code, name, brand, model_code, body_style, decks, reg_seats, reg_berths, reg_standing, curb_weight_kg, gross_weight_kg, fuel, amenities, layout_rows, layout_cols, is_active').order('code'),
      supabase.from('vehicle_type_seats').select('vehicle_type_id, label, deck, row_no, col_no, kind, is_priority, is_sellable'),
      supabase.from('vehicles').select(VEHICLE_COLS).order('plate'),
      supabase.from('documents').select(DOC_COLS).eq('owner_kind', 'xe'),
      supabase.from('tenant_settings').select('value').eq('key', 'giay_to.canh_bao_truoc_ngay').maybeSingle(),
    ]);
    const err = t.error ?? s.error ?? v.error ?? d.error ?? w.error;
    if (err) return toast('error', err.message);
    setTypes((t.data ?? []) as VehicleType[]);
    setSeats((s.data ?? []) as Seat[]);
    setVehicles((v.data ?? []) as Vehicle[]);
    setDocs((d.data ?? []) as Doc[]);
    setWarnDays(Number(w.data?.value ?? 30) || 30);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const tenantId = ctx.tenant_id ?? '';
  return (
    <>
      <DocAlerts vehicles={vehicles} docs={docs} warnDays={warnDays} onOpen={(id) => {
        setOpen(id);
        setTimeout(() => document.getElementById(`xe-${id}`)?.scrollIntoView({ behavior: 'smooth' }), 50);
      }} />
      {canEdit && <AddVehicle tenantId={tenantId} types={types} reload={load} />}
      <VehicleList tenantId={tenantId} vehicles={vehicles} types={types} docs={docs} warnDays={warnDays} canEdit={canEdit}
                   open={open} setOpen={setOpen} reload={load}
                   layout={(typeId) => {
                     const t = types.find((x) => x.id === typeId);
                     return t ? <SeatLayout type={t} seats={seats.filter((s) => s.vehicle_type_id === t.id)} canEdit={canEdit} reload={load} /> : null;
                   }} />
      <VehicleTypesSection types={types} seats={seats} canEdit={canEdit} reload={load} />
    </>
  );
}

/* ------------------------------------------------------------------ Loại xe */

const EMPTY = {
  code: '', name: '', brand: '', model_code: '', body_style: 'ghe_ngoi' as BodyStyle, decks: '1',
  reg_seats: '', reg_berths: '', reg_standing: '', curb_weight_kg: '', gross_weight_kg: '', fuel: '' as Fuel | '', amenities: '',
};
const num = (v: string) => (v.trim() === '' ? null : Number(v));

function VehicleTypesSection(props: { types: VehicleType[]; seats: Seat[]; canEdit: boolean; reload: () => Promise<void> }) {
  const { types, seats, canEdit, reload } = props;
  const toast = useToast();
  const [f, setF] = useState(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const values = {
      code: f.code.trim(), name: f.name.trim(), brand: f.brand.trim() || null, model_code: f.model_code.trim() || null,
      body_style: f.body_style, decks: Number(f.decks),
      reg_seats: num(f.reg_seats) ?? 0, reg_berths: num(f.reg_berths) ?? 0, reg_standing: num(f.reg_standing) ?? 0,
      curb_weight_kg: num(f.curb_weight_kg), gross_weight_kg: num(f.gross_weight_kg), fuel: f.fuel || null,
      amenities: f.amenities.split(',').map((x) => x.trim()).filter(Boolean),
    };
    if (values.reg_seats + values.reg_berths + values.reg_standing <= 0) {
      setBusy(false);
      return toast('error', 'Nhập số người cho phép chở theo giấy kiểm định');
    }
    const q = editId
      ? supabase.from('vehicle_types').update(values).eq('id', editId).select('id')
      : supabase.from('vehicle_types').insert(values).select('id');
    const { error } = await q;
    setBusy(false);
    if (error) return toast('error', error.code === '23505' ? 'Mã loại xe đã có' : error.message);
    toast('ok', editId ? 'Đã lưu loại xe' : `Đã thêm loại xe ${values.name}`);
    setF(EMPTY);
    setEditId(null);
    await reload();
  }

  async function toggle(t: VehicleType) {
    const { error } = await supabase.from('vehicle_types').update({ is_active: !t.is_active }).eq('id', t.id);
    if (error) return toast('error', error.message);
    toast('ok', t.is_active ? 'Đã ngừng dùng loại xe' : 'Đã dùng lại loại xe');
    await reload();
  }

  function startEdit(t: VehicleType) {
    setEditId(t.id);
    setF({
      code: t.code, name: t.name, brand: t.brand ?? '', model_code: t.model_code ?? '', body_style: t.body_style,
      decks: String(t.decks), reg_seats: String(t.reg_seats), reg_berths: String(t.reg_berths), reg_standing: String(t.reg_standing),
      curb_weight_kg: t.curb_weight_kg?.toString() ?? '', gross_weight_kg: t.gross_weight_kg?.toString() ?? '',
      fuel: t.fuel ?? '', amenities: t.amenities.join(', '),
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const inactive = types.filter((t) => !t.is_active).length;

  return (
    <>
      {canEdit && (
        <form className="card form" onSubmit={submit}>
          <h2>{editId ? 'Sửa loại xe' : 'Thêm loại xe'}</h2>
          <div className="grid2">
            <label>Mã loại xe<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required /></label>
            <label>Tên loại xe<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="vd: Giường nằm 40 chỗ" required /></label>
            <label>Nhãn hiệu<input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} placeholder="vd: Thaco" /></label>
            <label>Số loại<input value={f.model_code} onChange={(e) => setF({ ...f, model_code: e.target.value })} placeholder="vd: TB120SL" /></label>
            <label>Kiểu xe
              <select value={f.body_style} onChange={(e) => setF({ ...f, body_style: e.target.value as BodyStyle })}>
                {Object.entries(BODY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>Số tầng
              <select value={f.decks} onChange={(e) => setF({ ...f, decks: e.target.value })}>
                <option value="1">1 tầng</option>
                <option value="2">2 tầng</option>
              </select>
            </label>
          </div>
          <p className="muted small">Số người cho phép chở — ghi đúng theo Giấy chứng nhận kiểm định:</p>
          <div className="grid2">
            <label>Chỗ ngồi<input type="number" min={0} max={100} inputMode="numeric" value={f.reg_seats} onChange={(e) => setF({ ...f, reg_seats: e.target.value })} /></label>
            <label>Chỗ nằm<input type="number" min={0} max={100} inputMode="numeric" value={f.reg_berths} onChange={(e) => setF({ ...f, reg_berths: e.target.value })} /></label>
            <label>Chỗ đứng<input type="number" min={0} max={100} inputMode="numeric" value={f.reg_standing} onChange={(e) => setF({ ...f, reg_standing: e.target.value })} /></label>
            <label>Khối lượng bản thân (kg)<input type="number" min={1} inputMode="numeric" value={f.curb_weight_kg} onChange={(e) => setF({ ...f, curb_weight_kg: e.target.value })} /></label>
            <label>Khối lượng toàn bộ cho phép (kg)<input type="number" min={1} inputMode="numeric" value={f.gross_weight_kg} onChange={(e) => setF({ ...f, gross_weight_kg: e.target.value })} /></label>
            <label>Nhiên liệu
              <select value={f.fuel} onChange={(e) => setF({ ...f, fuel: e.target.value as Fuel | '' })}>
                <option value="">—</option>
                {Object.entries(FUEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>Tiện ích (cách nhau dấu phẩy)<input value={f.amenities} onChange={(e) => setF({ ...f, amenities: e.target.value })} placeholder="vd: wifi, WC, nước uống" /></label>
          </div>
          <div className="actions">
            <button className="btn primary" disabled={busy}>{editId ? 'Lưu loại xe' : 'Thêm loại xe'}</button>
            {editId && <button type="button" className="btn link" onClick={() => { setEditId(null); setF(EMPTY); }}>Hủy sửa</button>}
          </div>
        </form>
      )}
      <section className="card">
        <div className="item-head">
          <h2>Loại xe ({types.filter((t) => t.is_active).length})</h2>
          {inactive > 0 && (
            <button className="btn small" onClick={() => setShowInactive(!showInactive)}>
              {showInactive ? 'Ẩn loại ngừng dùng' : `Hiện loại ngừng dùng (${inactive})`}
            </button>
          )}
        </div>
        {types.length === 0 && <p className="muted">Chưa có loại xe.</p>}
        <ul className="list">
          {types.filter((t) => showInactive || t.is_active).map((t) => {
            const mine = seats.filter((s) => s.vehicle_type_id === t.id);
            return (
              <li key={t.id} className="item">
                <div className="item-head">
                  <div>
                    <b>{t.name}</b> <span className="muted small">· {t.code} · {BODY[t.body_style]} · {t.decks} tầng</span>
                    {!t.is_active && <span className="badge locked">Ngừng dùng</span>}
                    <div className="muted small">
                      Kiểm định: {t.reg_seats} ngồi, {t.reg_berths} nằm, {t.reg_standing} đứng
                      {[t.brand, t.model_code].some(Boolean) && ` · ${[t.brand, t.model_code].filter(Boolean).join(' ')}`}
                      {t.fuel && ` · ${FUEL[t.fuel]}`}
                      {t.amenities.length > 0 && ` · ${t.amenities.join(', ')}`}
                    </div>
                    <div className="muted small">Sơ đồ: {summary(mine)}</div>
                  </div>
                  <div className="actions">
                    <button className="btn small" onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? 'Đóng' : 'Sơ đồ ghế'}</button>
                    {canEdit && <button className="btn small" onClick={() => startEdit(t)}>Sửa</button>}
                    {canEdit && <button className="btn small" onClick={() => void toggle(t)}>{t.is_active ? 'Ngừng dùng' : 'Dùng lại'}</button>}
                    {canEdit && <DeleteButton kind="vehicle_type" id={t.id} name={t.name} onDone={reload} />}
                  </div>
                </div>
                {open === t.id && <SeatLayout type={t} seats={mine} canEdit={canEdit} reload={reload} />}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

function summary(list: { kind: SeatKind; is_sellable: boolean; is_priority: boolean }[]): string {
  if (list.length === 0) return 'chưa vẽ';
  const ghe = list.filter((s) => s.kind === 'ghe').length;
  const giuong = list.filter((s) => s.kind === 'giuong').length;
  const sell = list.filter((s) => s.is_sellable).length;
  const prio = list.filter((s) => s.is_priority).length;
  return [ghe && `${ghe} ghế`, giuong && `${giuong} giường`].filter(Boolean).join(', ')
    + ` · ${sell} chỗ bán` + (prio ? ` · ${prio} chỗ ưu tiên` : '');
}

/* ------------------------------------------------------------------ Sơ đồ ghế */

interface Cell { label: string; kind: SeatKind; priority: boolean; sellable: boolean }
type Tool = 'ghe' | 'giuong' | 'tai_xe' | 'cua' | 'trong' | 'uu_tien' | 'khong_ban' | 'doi_so';
const TOOLS: Record<Tool, string> = {
  ghe: 'Ghế', giuong: 'Giường', tai_xe: 'Tài xế', cua: 'Cửa lên xuống', trong: 'Lối đi / trống', uu_tien: 'Chỗ ưu tiên', khong_ban: 'Không bán (phụ xe)', doi_so: 'Đổi số ghế',
};
const key = (d: number, r: number, c: number) => `${d}-${r}-${c}`;
const DECK_PREFIX = ['A', 'B'];

/** Đánh số lại theo tầng (A, B) rồi theo hàng, cột: A01, A02… */
function renumber(cells: Map<string, Cell>, decks: number, rows: number, cols: number): Map<string, Cell> {
  const next = new Map<string, Cell>();
  for (let d = 1; d <= decks; d++) {
    let n = 0;
    for (let r = 1; r <= rows; r++) {
      for (let c = 1; c <= cols; c++) {
        const cell = cells.get(key(d, r, c));
        if (cell) next.set(key(d, r, c), isExtra(cell.kind) ? cell : { ...cell, label: `${DECK_PREFIX[d - 1]}${String(++n).padStart(2, '0')}` });
      }
    }
  }
  return next;
}

function SeatLayout(props: { type: VehicleType; seats: Seat[]; canEdit: boolean; reload: () => Promise<void> }) {
  const { type, seats, canEdit, reload } = props;
  const toast = useToast();
  const initial = useMemo(() => new Map<string, Cell>(seats.map((s): [string, Cell] => [key(s.deck, s.row_no, s.col_no),
    { label: s.label, kind: s.kind, priority: s.is_priority, sellable: s.is_sellable }])), [seats]);
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState(type.layout_rows || 6);
  const [cols, setCols] = useState(type.layout_cols || 3);
  const [cells, setCells] = useState<Map<string, Cell>>(initial);
  const [tool, setTool] = useState<Tool>(type.body_style === 'ghe_ngoi' ? 'ghe' : 'giuong');
  const [quick, setQuick] = useState({ aisle: '2', kind: (type.body_style === 'ghe_ngoi' ? 'ghe' : 'giuong') as SeatKind });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) setCells(initial);
  }, [initial, editing]);

  const shownRows = editing ? rows : type.layout_rows;
  const shownCols = editing ? cols : type.layout_cols;
  const list = Array.from(cells.entries()).map(([k, c]) => ({ k, ...c }));
  const ghe = list.filter((c) => c.kind === 'ghe').length;
  const giuong = list.filter((c) => c.kind === 'giuong').length;

  function tap(d: number, r: number, c: number) {
    if (!editing) return;
    const k = key(d, r, c);
    const cur = cells.get(k);
    const next = new Map(cells);
    if (tool === 'ghe' || tool === 'giuong') {
      next.set(k, cur && !isExtra(cur.kind) ? { ...cur, kind: tool } : { label: nextLabel(d), kind: tool, priority: false, sellable: true });
    } else if (tool === 'tai_xe' || tool === 'cua') {
      next.set(k, cur?.kind === tool ? cur : { label: extraLabel(tool), kind: tool, priority: false, sellable: false });
    } else if (tool === 'trong') {
      next.delete(k);
    } else if (cur && isExtra(cur.kind)) {
      if (tool === 'doi_so') { setRenaming(k); return; }
      return;
    } else if (cur && tool === 'uu_tien') {
      next.set(k, { ...cur, priority: !cur.priority });
    } else if (cur && tool === 'khong_ban') {
      next.set(k, { ...cur, sellable: !cur.sellable });
    } else if (cur && tool === 'doi_so') {
      setRenaming(k);
      return;
    }
    setCells(next);
  }

  function nextLabel(d: number): string {
    const used = new Set(Array.from(cells.values()).map((c) => c.label.toUpperCase()));
    for (let n = 1; ; n++) {
      const l = `${DECK_PREFIX[d - 1]}${String(n).padStart(2, '0')}`;
      if (!used.has(l)) return l;
    }
  }

  function extraLabel(kind: 'tai_xe' | 'cua'): string {
    const base = kind === 'tai_xe' ? 'TX' : 'CUA';
    const used = new Set(Array.from(cells.values()).map((c) => c.label.toUpperCase()));
    for (let n = 1; ; n++) {
      const l = n === 1 ? base : `${base}${n}`;
      if (!used.has(l)) return l;
    }
  }

  function quickFill() {
    const aisles = new Set(quick.aisle.split(/[,\s]+/).map(Number).filter((n) => n >= 1));
    const next = new Map<string, Cell>();
    cells.forEach((v, k) => { if (isExtra(v.kind)) next.set(k, v); });   // giữ ô tài xế / cửa
    for (let d = 1; d <= type.decks; d++)
      for (let r = 1; r <= rows; r++)
        for (let c = 1; c <= cols; c++)
          if (!aisles.has(c) && !next.has(key(d, r, c))) next.set(key(d, r, c), { label: '', kind: quick.kind, priority: false, sellable: true });
    setCells(renumber(next, type.decks, rows, cols));
  }

  function resize(r: number, c: number) {
    setRows(r);
    setCols(c);
    const next = new Map<string, Cell>();
    cells.forEach((v, k) => {
      const [, rr, cc] = k.split('-').map(Number);
      if (rr <= r && cc <= c) next.set(k, v);
    });
    setCells(next);
  }

  async function save() {
    setBusy(true);
    try {
      await rpc('set_seat_layout', {
        p_type_id: type.id, p_rows: rows, p_cols: cols,
        p_seats: list.map((c) => {
          const [deck, row, col] = c.k.split('-').map(Number);
          return { label: c.label, deck, row, col, kind: c.kind, priority: c.priority, sellable: c.sellable };
        }),
      });
      toast('ok', 'Đã lưu sơ đồ ghế');
      setEditing(false);
      setRenaming(null);
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const warnings: string[] = [];
  if (ghe > type.reg_seats) warnings.push(`Sơ đồ có ${ghe} ghế, vượt ${type.reg_seats} chỗ ngồi theo kiểm định`);
  if (giuong > type.reg_berths) warnings.push(`Sơ đồ có ${giuong} giường, vượt ${type.reg_berths} chỗ nằm theo kiểm định`);
  if (list.length > 0 && !list.some((c) => c.priority)) warnings.push('Xe tuyến cố định phải có chỗ ưu tiên (người khuyết tật, người cao tuổi, phụ nữ mang thai)');
  const renamingCell = renaming ? cells.get(renaming) : undefined;

  return (
    <div className="sub">
      <div className="item-head">
        <h3>Sơ đồ ghế · {ghe} ghế, {giuong} giường</h3>
        {canEdit && !editing && <button className="btn small" onClick={() => { setRows(type.layout_rows || 6); setCols(type.layout_cols || 3); setEditing(true); }}>Sửa sơ đồ</button>}
      </div>

      {editing && (
        <div className="form">
          <div className="inline-form">
            <label>Số hàng<input type="number" min={1} max={30} inputMode="numeric" value={rows} onChange={(e) => resize(Math.min(30, Math.max(1, Number(e.target.value) || 1)), cols)} /></label>
            <label>Số cột<input type="number" min={1} max={8} inputMode="numeric" value={cols} onChange={(e) => resize(rows, Math.min(8, Math.max(1, Number(e.target.value) || 1)))} /></label>
          </div>
          <div className="inline-form">
            <label>Cột lối đi<input value={quick.aisle} onChange={(e) => setQuick({ ...quick, aisle: e.target.value })} placeholder="vd: 2 hoặc 2, 4" /></label>
            <label>Loại chỗ
              <select value={quick.kind} onChange={(e) => setQuick({ ...quick, kind: e.target.value as SeatKind })}>
                <option value="ghe">Ghế</option>
                <option value="giuong">Giường</option>
              </select>
            </label>
            <button type="button" className="btn small" onClick={quickFill}>Tạo nhanh</button>
            <button type="button" className="btn small" onClick={() => setCells(renumber(cells, type.decks, rows, cols))}>Đánh số lại</button>
          </div>
          <div className="chips" role="group" aria-label="Công cụ vẽ">
            {(Object.keys(TOOLS) as Tool[]).map((t) => (
              <button key={t} type="button" className={tool === t ? 'btn small primary' : 'btn small'} aria-pressed={tool === t}
                      onClick={() => { setTool(t); setRenaming(null); }}>{TOOLS[t]}</button>
            ))}
          </div>
          <p className="muted small">Chọn công cụ rồi chạm vào ô. Đầu xe ở phía trên. Ô tài xế và cửa không bán, không tính vào số chỗ.</p>
        </div>
      )}

      {shownRows > 0 && shownCols > 0 ? (
        <div className="decks">
          {Array.from({ length: type.decks }, (_, i) => i + 1).map((d) => (
            <div key={d} className="deck">
              {type.decks > 1 && <div className="muted small">Tầng {d === 1 ? 'dưới' : 'trên'}</div>}
              <div className="seat-grid" style={{ gridTemplateColumns: `repeat(${shownCols}, minmax(40px, 56px))` }}>
                {Array.from({ length: shownRows * shownCols }, (_, idx) => {
                  const r = Math.floor(idx / shownCols) + 1;
                  const c = (idx % shownCols) + 1;
                  const k = key(d, r, c);
                  const cell = cells.get(k);
                  const cls = ['seat', cell ? cell.kind : 'empty', cell?.priority && 'priority', cell && !cell.sellable && !isExtra(cell.kind) && 'nosell', renaming === k && 'selected']
                    .filter(Boolean).join(' ');
                  return (
                    <button key={k} type="button" className={cls} disabled={!editing}
                            aria-label={`Tầng ${d} hàng ${r} cột ${c}${cell ? `: ${KIND[cell.kind]} ${cell.label}` : ': trống'}`}
                            onClick={() => tap(d, r, c)}>
                      {cell && <SeatIcon kind={cell.kind} size={isExtra(cell.kind) ? 18 : 14} />}
                      {cell && <span className="cap">{cell.kind === 'tai_xe' ? 'Tài xế' : cell.kind === 'cua' ? 'Cửa' : cell.label}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : <p className="muted small">Chưa vẽ sơ đồ ghế.</p>}

      <p className="muted small legend">
        <span className="seat ghe sample" /> ghế <span className="seat giuong sample" /> giường
        <span className="seat tai_xe sample" /> tài xế <span className="seat cua sample" /> cửa lên xuống
        <span className="seat ghe priority sample" /> ưu tiên <span className="seat ghe nosell sample" /> không bán
      </p>

      {editing && renamingCell && (
        <div className="inline-form">
          <label>Số ghế mới
            <input autoFocus maxLength={10} value={renamingCell.label}
                   onChange={(e) => setCells(new Map(cells).set(renaming!, { ...renamingCell, label: e.target.value.toUpperCase() }))} />
          </label>
          <button type="button" className="btn small" onClick={() => setRenaming(null)}>Xong</button>
        </div>
      )}

      {warnings.length > 0 && <ul className="warn small">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}

      {editing && (
        <div className="actions">
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void save()}>Lưu sơ đồ</button>
          <button type="button" className="btn small link" onClick={() => { setEditing(false); setRenaming(null); setCells(initial); }}>Hủy</button>
        </div>
      )}
    </div>
  );
}
