import { Modal } from '../components/Modal';
import { VehicleProfile } from '../components/VehicleProfile';
import { VehicleLeases } from '../components/VehicleLeases';
import { BulkPaperSave, type Me } from '../components/ProfilePapers';
import { DeleteButton } from '../components/DeleteButton';
import { Avatar, StaffAvatar, useAvatars } from '../components/StaffAvatar';
import { personColor } from '../lib/personColor';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { loadMaint, type Maint } from '../lib/maintenance';
import {
  DocFields, DocRow, docState, fmtDate, OldDocs, Scanner, SHORT, today, toRpc, type Doc, type DocState, type Scanned, type Values,
} from '../components/Documents';
import { DOC_TYPES, docTypeOf, plateKey, PLATE_RE, type DocTypeDef } from '../lib/docTypes';
import { uploadFiles } from '../lib/documents';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

export { DOC_COLS, type Doc } from '../components/Documents';

/* ------------------------------------------------------------------ Kiểu dữ liệu */

export interface VehicleTypeLite { id: string; code: string; name: string; reg_seats: number; reg_berths: number; is_active: boolean }
export interface Vehicle {
  id: string; plate: string; vehicle_type_id: string; chassis_no: string | null; engine_no: string | null;
  owner_name: string | null; color: string | null; country_of_origin: string | null; manufacture_year: number | null; driver_pay: number;
  condition: 'nguyen_chiec' | 'cai_tao'; ownership: 'so_huu' | 'thue' | 'hop_tac' | 'xa_vien'; acquired_on: string | null;
  business_type: 'tuyen_co_dinh' | 'hop_dong' | 'ca_hai'; gsht_provider: string | null; gsht_device_no: string | null;
  camera_provider: string | null; camera_device_no: string | null; note: string | null; is_active: boolean;
}
export const VEHICLE_COLS = 'id, plate, vehicle_type_id, chassis_no, engine_no, owner_name, color, country_of_origin, manufacture_year, condition, ownership, acquired_on, business_type, gsht_provider, gsht_device_no, camera_provider, camera_device_no, note, is_active, driver_pay';

const OWNERSHIP = { so_huu: 'Xe của nhà xe', thue: 'Xe thuê', hop_tac: 'Hợp tác kinh doanh', xa_vien: 'Xe của xã viên HTX' } as const;
const BUSINESS = { tuyen_co_dinh: 'Tuyến cố định', hop_dong: 'Hợp đồng', ca_hai: 'Tuyến cố định + hợp đồng' } as const;
const VEHICLE_DOCS = DOC_TYPES.filter((d) => d.owner === 'xe');

/** Niên hạn xe khách theo NĐ 158/2024 (Điều 13): tuyến > 300 km 15 năm, ≤ 300 km 20 năm (cần xác minh cách tính năm cuối). */
export function lifeLimit(year: number | null): { text: string; short: string; state: 'het_han' | 'sap_het' | 'con_han' } | null {
  if (!year) return null;
  const now = Number(today().slice(0, 4));
  const y15 = year + 15;
  const y20 = year + 20;
  const text = `Niên hạn: tuyến trên 300 km đến hết ${y15}, tuyến từ 300 km trở xuống đến hết ${y20}`;
  return { text, short: String(y20), state: now > y20 ? 'het_han' : now > y15 || now === y20 ? 'sap_het' : 'con_han' };
}

/* ------------------------------------------------------------------ Thêm xe (đọc nhanh từ giấy tờ) */

const EMPTY_VEHICLE = {
  plate: '', vehicle_type_id: '', chassis_no: '', engine_no: '', owner_name: '', color: '', country_of_origin: '',
  manufacture_year: '', condition: 'nguyen_chiec' as Vehicle['condition'], ownership: 'so_huu' as Vehicle['ownership'],
  acquired_on: '', business_type: 'tuyen_co_dinh' as Vehicle['business_type'], gsht_provider: '', gsht_device_no: '',
  camera_provider: '', camera_device_no: '', note: '', driver_pay: '',
};
type VehicleForm = typeof EMPTY_VEHICLE;

function vehicleFormOf(v: Vehicle): VehicleForm {
  const s = (x: string | number | null) => (x == null ? '' : String(x));
  return {
    plate: v.plate, vehicle_type_id: v.vehicle_type_id, chassis_no: s(v.chassis_no), engine_no: s(v.engine_no),
    owner_name: s(v.owner_name), color: s(v.color), country_of_origin: s(v.country_of_origin), manufacture_year: s(v.manufacture_year),
    condition: v.condition, ownership: v.ownership, acquired_on: s(v.acquired_on), business_type: v.business_type,
    gsht_provider: s(v.gsht_provider), gsht_device_no: s(v.gsht_device_no), camera_provider: s(v.camera_provider),
    camera_device_no: s(v.camera_device_no), note: s(v.note), driver_pay: v.driver_pay ? String(v.driver_pay) : '',
  };
}
function vehicleValues(f: VehicleForm) {
  const t = (x: string) => x.trim() || null;
  return {
    plate: f.plate.trim().toUpperCase(), vehicle_type_id: f.vehicle_type_id, chassis_no: t(f.chassis_no)?.toUpperCase() ?? null,
    engine_no: t(f.engine_no)?.toUpperCase() ?? null, owner_name: t(f.owner_name), color: t(f.color), country_of_origin: t(f.country_of_origin),
    manufacture_year: f.manufacture_year ? Number(f.manufacture_year) : null, condition: f.condition, ownership: f.ownership,
    acquired_on: t(f.acquired_on), business_type: f.business_type, gsht_provider: t(f.gsht_provider), gsht_device_no: t(f.gsht_device_no),
    camera_provider: t(f.camera_provider), camera_device_no: t(f.camera_device_no), note: t(f.note),
    driver_pay: Number(String(f.driver_pay).replace(/[^0-9]/g, '')) || 0,
  };
}

/** Điền thông tin xe từ kết quả đọc giấy (chỉ ghi đè ô AI đọc được). */
function applyToVehicle(f: VehicleForm, v: Values, types: VehicleTypeLite[]): VehicleForm {
  const pick = (k: string) => (v[k] ?? '').trim();
  const next = { ...f };
  const map: [string, keyof VehicleForm][] = [
    ['xe.bien_so', 'plate'], ['xe.so_khung', 'chassis_no'], ['xe.so_may', 'engine_no'], ['xe.chu_xe', 'owner_name'],
    ['xe.mau_son', 'color'], ['xe.nam_san_xuat', 'manufacture_year'], ['xe.nuoc_san_xuat', 'country_of_origin'],
  ];
  for (const [src, dst] of map) if (pick(src)) (next as Record<string, string>)[dst] = pick(src);
  // Gợi ý loại xe khớp số chỗ theo kiểm định
  const ngoi = Number(pick('xe.cho_ngoi') || NaN);
  const nam = Number(pick('xe.cho_nam') || NaN);
  if (!next.vehicle_type_id && (Number.isFinite(ngoi) || Number.isFinite(nam))) {
    const match = types.filter((t) => t.is_active && (!Number.isFinite(ngoi) || t.reg_seats === ngoi) && (!Number.isFinite(nam) || t.reg_berths === nam));
    if (match.length === 1) next.vehicle_type_id = match[0].id;
  }
  return next;
}

interface Pending { key: string; def: DocTypeDef; scanned: Scanned }

export function AddVehicle(props: { tenantId: string; types: VehicleTypeLite[]; reload: () => Promise<void> }) {
  const { tenantId, types, reload } = props;
  const toast = useToast();
  const [f, setF] = useState<VehicleForm>(EMPTY_VEHICLE);
  const [scanType, setScanType] = useState('dang_ky');
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);

  function onScanned(def: DocTypeDef, s: Scanned) {
    if (s.files.length === 0) return toast('error', s.aiNote);
    setPending((p) => [...p.filter((x) => x.def.code !== def.code), { key: crypto.randomUUID(), def, scanned: s }]);
    setF((cur) => applyToVehicle(cur, s.values, types));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const values = vehicleValues(f);
    if (!PLATE_RE.test(plateKey(values.plate))) return toast('error', 'Biển số không đúng dạng (vd: 51B-123.45)');
    if (!values.vehicle_type_id) return toast('error', 'Chọn loại xe');
    setBusy(true);
    const id = crypto.randomUUID();
    const { error } = await supabase.from('vehicles').insert({ id, ...values });
    if (error) {
      setBusy(false);
      return toast('error', error.code === '23505' ? 'Biển số hoặc số khung đã có trong nhà xe' : error.message);
    }
    let failed = 0;
    for (const p of pending) {
      try {
        const paths = await uploadFiles(tenantId, 'xe', id, values.plate, p.def.code, p.scanned.files);
        await rpc('add_vehicle_document', { p_vehicle_id: id, p_doc_type: p.def.code, ...toRpc(p.def, p.scanned.values),
                                            p_files: paths, p_note: null, p_request_id: p.key });
      } catch (err) {
        failed++;
        toast('error', `${p.def.name}: ${errMsg(err)}`);
      }
    }
    setBusy(false);
    toast('ok', failed ? `Đã thêm xe ${values.plate}, còn ${failed} giấy tờ chưa lưu – thêm lại ở mục Giấy tờ` : `Đã thêm xe ${values.plate}`);
    setF(EMPTY_VEHICLE);
    setPending([]);
    await reload();
  }

  const scanDef = docTypeOf(scanType)!;

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Thêm xe</h2>
      <div className="sub">
        <b className="small">Đọc nhanh từ giấy tờ</b>
        <div className="inline-form">
          <select aria-label="Loại giấy để đọc" value={scanType} onChange={(e) => setScanType(e.target.value)}>
            {VEHICLE_DOCS.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
          </select>
        </div>
        <Scanner key={scanDef.code} def={scanDef} onScanned={(s) => onScanned(scanDef, s)} />
        {pending.map((p) => (
          <div key={p.key} className="item sub-item">
            <div className="item-head">
              <b>{p.def.name}</b>
              <button type="button" className="btn small link" onClick={() => setPending(pending.filter((x) => x !== p))}>Bỏ giấy này</button>
            </div>
            <p className="muted small">{p.scanned.aiNote} · {p.scanned.files.length} tệp</p>
            {p.scanned.warnings.length > 0 && <ul className="warn small">{p.scanned.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            <DocFields def={p.def} values={p.scanned.values}
                       onChange={(v) => setPending(pending.map((x) => (x === p ? { ...x, scanned: { ...x.scanned, values: v } } : x)))} />
            <PlateCheck docPlate={p.scanned.values['xe.bien_so']} plate={f.plate} />
          </div>
        ))}
      </div>
      <VehicleFields f={f} setF={setF} types={types} />
      <button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu xe'}</button>
    </form>
  );
}

function PlateCheck({ docPlate, plate }: { docPlate?: string; plate: string }) {
  if (!docPlate || !plate || plateKey(docPlate) === plateKey(plate)) return null;
  return <p className="warn small">Biển số trên giấy ({docPlate}) khác biển số xe ({plate})</p>;
}

function VehicleFields({ f, setF, types }: { f: VehicleForm; setF: (f: VehicleForm) => void; types: VehicleTypeLite[] }) {
  const set = (k: keyof VehicleForm) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="grid2">
        <label>Biển số xe<input value={f.plate} onChange={set('plate')} placeholder="vd: 51B-123.45" required /></label>
        <label>Loại xe
          <select value={f.vehicle_type_id} onChange={set('vehicle_type_id')} required>
            <option value="">Chọn loại xe</option>
            {types.filter((t) => t.is_active || t.id === f.vehicle_type_id).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code})</option>)}
          </select>
        </label>
        <label>Số khung<input value={f.chassis_no} onChange={set('chassis_no')} /></label>
        <label>Số máy<input value={f.engine_no} onChange={set('engine_no')} /></label>
        <label>Chủ sở hữu (theo đăng ký)<input value={f.owner_name} onChange={set('owner_name')} /></label>
        <label>Tiền tài (đồng / công lái xe)<input inputMode="numeric" aria-label="Tiền tài" value={f.driver_pay ? Number(String(f.driver_pay).replace(/[^0-9]/g, '')).toLocaleString('vi-VN') : ''} placeholder="0"
          onChange={(e) => setF({ ...f, driver_pay: e.target.value.replace(/[^0-9]/g, '') })} /></label>
        <label>Năm sản xuất<input type="number" min={1970} max={2100} inputMode="numeric" value={f.manufacture_year} onChange={set('manufacture_year')} /></label>
        <label>Nước sản xuất<input value={f.country_of_origin} onChange={set('country_of_origin')} /></label>
        <label>Màu sơn<input value={f.color} onChange={set('color')} /></label>
        <label>Tình trạng xe
          <select value={f.condition} onChange={set('condition')}>
            <option value="nguyen_chiec">Nguyên chiếc</option>
            <option value="cai_tao">Đã cải tạo</option>
          </select>
        </label>
        <label>Hình thức sử dụng
          <select value={f.ownership} onChange={set('ownership')}>
            {Object.entries(OWNERSHIP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Ngày bắt đầu sở hữu / sử dụng<input type="date" value={f.acquired_on} onChange={set('acquired_on')} /></label>
        <label>Loại hình kinh doanh
          <select value={f.business_type} onChange={set('business_type')}>
            {Object.entries(BUSINESS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Đơn vị giám sát hành trình<input value={f.gsht_provider} onChange={set('gsht_provider')} /></label>
        <label>Số thiết bị giám sát hành trình<input value={f.gsht_device_no} onChange={set('gsht_device_no')} /></label>
        <label>Đơn vị camera<input value={f.camera_provider} onChange={set('camera_provider')} /></label>
        <label>Số thiết bị camera<input value={f.camera_device_no} onChange={set('camera_device_no')} /></label>
        <label>Ghi chú<input value={f.note} onChange={set('note')} /></label>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Danh sách xe + giấy tờ */

export function VehicleList(props: {
  tenantId: string; vehicles: Vehicle[]; types: VehicleTypeLite[]; docs: Doc[]; warnDays: number; canEdit: boolean;
  open: string | null; setOpen: (id: string | null) => void; reload: () => Promise<void>;
  me: Me; canArchive: boolean;
  /** Sơ đồ ghế của loại xe (sửa ngay trong cửa sổ xe) */
  layout?: (typeId: string) => ReactNode;
}) {
  const { vehicles, types, docs, warnDays, canEdit, open, setOpen } = props;
  const [showInactive, setShowInactive] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [tab, setTab] = useState('');
  const avas = useAvatars(props.tenantId || null, 'anh_xe');
  const [maint, setMaint] = useState<Map<string, Maint>>(new Map());
  useEffect(() => { void loadMaint().then((x) => setMaint(new Map(x.list.map((m) => [m.row.vehicle_id, m])))).catch(() => undefined); }, [vehicles]);
  const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? '?';
  const inactive = vehicles.filter((v) => !v.is_active).length;
  const shown = vehicles.filter((v) => showInactive || v.is_active);
  // Thẻ chọn theo loại xe (như thẻ chức vụ ở Lái xe & nhân viên): chỉ loại đang có xe
  const tabs = [...new Set(shown.map((v) => v.vehicle_type_id))].map((id) => ({ key: id, label: typeName(id), n: shown.filter((v) => v.vehicle_type_id === id).length }))
    .sort((a, b) => a.label.localeCompare(b.label, 'vi'));
  const cur = tabs.some((t) => t.key === tab) ? tab : '';
  const [kieu, setKieuS] = useState<'bang' | 'the'>(() => { try { return localStorage.getItem('tms.xe.kieu') === 'the' ? 'the' : 'bang'; } catch { return 'bang'; } });
  const setKieu = (v: 'bang' | 'the') => { setKieuS(v); try { localStorage.setItem('tms.xe.kieu', v); } catch { /* chỉ đổi trong phiên */ } };
  const list = shown.filter((v) => !cur || v.vehicle_type_id === cur);
  const cur0 = open ? vehicles.find((v) => v.id === open) ?? null : null;
  const info = (v: Vehicle) => ({
    bad: vehicleProblems(v, docs, warnDays, maint).length,
    kd: docs.find((d) => d.vehicle_id === v.id && d.doc_type === 'kiem_dinh' && d.is_current),
    life: lifeLimit(v.manufacture_year),
  });
  const openBtn = (v: Vehicle) => <button className="btn small" aria-label={`Sửa xe ${v.plate}`} onClick={() => setOpen(v.id)}>{canEdit ? 'Sửa' : 'Xem'}</button>;
  const openCard = (id: string) => { setTab(''); setOpen(id); setTimeout(() => document.getElementById(`xe-${id}`)?.scrollIntoView({ behavior: 'smooth' }), 50); };

  return (
    <>
      <div className="staff-top">
        <div className="vx-tabs staff-tabs" role="tablist" aria-label="Loại xe">
          {[{ key: '', label: 'Tất cả', n: shown.length }, ...tabs].map((t) => (
            <button key={t.key || '*'} type="button" role="tab" aria-selected={cur === t.key} className={cur === t.key ? 'on' : ''} onClick={() => { setTab(t.key); setOpen(null); }}>
              {t.label} ({t.n})
            </button>
          ))}
        </div>
        {canEdit && props.canArchive && <button type="button" className="btn small" title="Lưu lý lịch phương tiện của tất cả xe đang dùng vào Lưu trữ hồ sơ" onClick={() => setBulk(true)}>💾 Lưu lý lịch xe</button>}
        {bulk && <BulkPaperSave kind="vehicle" tenantId={props.tenantId} me={props.me} onClose={() => setBulk(false)}
          items={vehicles.filter((v) => v.is_active).map((v) => ({ id: v.id, label: v.plate }))} />}
        <VehicleAlerts vehicles={vehicles} docs={docs} warnDays={warnDays} maint={maint} avas={avas} typeName={typeName} onOpen={openCard} />
      </div>
      <section className="card">
        <div className="hd-bar">
          <h2>Xe ({vehicles.filter((v) => v.is_active).length})</h2>
          <div className="hd-tools">
            {inactive > 0 && (
              <button className="btn small" onClick={() => setShowInactive(!showInactive)}>
                {showInactive ? 'Ẩn xe ngừng dùng' : `Hiện xe ngừng dùng (${inactive})`}
              </button>
            )}
            <div className="seg" role="group" aria-label="Kiểu hiển thị">
              <button type="button" className={kieu === 'bang' ? 'on' : ''} aria-pressed={kieu === 'bang'} onClick={() => setKieu('bang')}>Bảng</button>
              <button type="button" className={kieu === 'the' ? 'on' : ''} aria-pressed={kieu === 'the'} onClick={() => setKieu('the')}>Thẻ</button>
            </div>
          </div>
        </div>
        {vehicles.length === 0 && <p className="muted">Chưa có xe.</p>}
        {list.length > 0 && (kieu === 'bang' ? (
          <div className="nsx-tblw">
            <table className="nsx-tbl">
              <thead><tr><th>Biển số</th><th>Năm SX</th><th>Niên hạn</th><th>Đăng kiểm</th><th>Loại hình</th><th>Sở hữu</th><th>Tình trạng</th><th /></tr></thead>
              <tbody>
                {list.map((v) => {
                  const { bad, kd, life } = info(v);
                  return (
                    <tr key={v.id} id={`xe-${v.id}`} className={`veh-card${v.is_active ? '' : ' off'}`}>
                      <td><div className="nsx-who"><Avatar name={v.plate} url={avas[v.id]} text="🚌" size={36} /><div><b>{v.plate}</b><span className="sc-job">{typeName(v.vehicle_type_id)}</span></div></div></td>
                      <td>{v.manufacture_year ?? '—'}</td>
                      <td className={life ? `state-${life.state}` : 'muted'} title={life?.text}>{life?.short ?? '—'}</td>
                      <td>{kd?.expires_on ? fmtDate(kd.expires_on) : <span className="muted">Chưa có</span>}</td>
                      <td>{BUSINESS[v.business_type]}</td>
                      <td>{OWNERSHIP[v.ownership]}</td>
                      <td>{!v.is_active ? <span className="nsx-stag off">Ngừng dùng</span> : bad > 0 ? <span className="nsx-stag warn">{bad} việc cần xử lý</span> : <span className="nsx-stag ok">Bình thường</span>}</td>
                      <td className="actions">{openBtn(v)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="nsx-emps">
            {list.map((v) => {
              const { bad, kd, life } = info(v);
              return (
                <div key={v.id} id={`xe-${v.id}`} className={`nsx-emp nsx-emp-main veh-card${v.is_active ? '' : ' off'}`} style={{ ['--gc' as string]: personColor(v.id) }}>
                  <span className="nsx-emp-cov" />
                  <span className="nsx-emp-ph"><Avatar name={v.plate} url={avas[v.id]} text="🚌" size={112} /></span>
                  <b className="nsx-emp-nm">{v.plate}</b>
                  <span className="nsx-emp-rl">{typeName(v.vehicle_type_id)}</span>
                  <span className="nsx-emp-tags">
                    <span className="nsx-stag">{OWNERSHIP[v.ownership]}</span>
                    {!v.is_active && <span className="nsx-stag off">Ngừng dùng</span>}
                    {bad > 0 && <span className="nsx-stag warn">{bad} việc cần xử lý</span>}
                  </span>
                  <span className="nsx-emp-ct">
                    <span>{v.manufacture_year ? `Năm SX ${v.manufacture_year}` : 'Chưa nhập năm SX'}</span>
                    <span>{BUSINESS[v.business_type]}</span>
                  </span>
                  <span className="nsx-emp-ft">
                    <span><small>Đăng kiểm</small>{kd?.expires_on ? fmtDate(kd.expires_on) : 'Chưa có'}</span>
                    <span title={life?.text}><small>Niên hạn</small>{life?.short ?? '—'}</span>
                  </span>
                  <span className="nsx-emp-acts"><span className="actions">{openBtn(v)}</span></span>
                </div>
              );
            })}
          </div>
        ))}
        {cur0 && (
          <Modal wide title={`${canEdit ? 'Sửa' : 'Xem'} xe ${cur0.plate}`} onClose={() => setOpen(null)}>
            <div className="sub"><StaffAvatar tenantId={props.tenantId} staffId={cur0.id} name={cur0.plate} canEdit={canEdit} dir="anh_xe" /></div>
            <VehicleDetail vehicle={cur0} {...props} canEdit={canEdit} />
            <VehicleProfile v={cur0} canEdit={canEdit} tenantId={props.tenantId} me={props.me} canSave={props.canArchive} />
            {cur0.ownership !== 'so_huu' && <VehicleLeases v={cur0} vehicles={vehicles} tenantId={props.tenantId} me={props.me} canEdit={canEdit} onSaved={props.reload} />}
            {props.layout && <div className="sub"><p className="muted small">Sơ đồ ghế theo loại xe {typeName(cur0.vehicle_type_id)} (dùng chung cho các xe cùng loại)</p>{props.layout(cur0.vehicle_type_id)}</div>}
          </Modal>
        )}
      </section>
    </>
  );
}

function VehicleDetail(props: { tenantId: string; vehicle: Vehicle; types: VehicleTypeLite[]; docs: Doc[]; warnDays: number; canEdit: boolean; reload: () => Promise<void> }) {
  const { tenantId, vehicle, types, docs, warnDays, canEdit, reload } = props;
  const toast = useToast();
  const [editing, setEditing] = useState(canEdit);
  const [f, setF] = useState<VehicleForm>(() => vehicleFormOf(vehicle));
  const mine = useMemo(() => docs.filter((d) => d.vehicle_id === vehicle.id), [docs, vehicle.id]);
  const life = lifeLimit(vehicle.manufacture_year);

  async function saveVehicle(e: FormEvent) {
    e.preventDefault();
    const values = vehicleValues(f);
    if (!PLATE_RE.test(plateKey(values.plate))) return toast('error', 'Biển số không đúng dạng (vd: 51B-123.45)');
    const { error } = await supabase.from('vehicles').update(values).eq('id', vehicle.id);
    if (error) return toast('error', error.code === '23505' ? 'Biển số hoặc số khung đã có trong nhà xe' : error.message);
    toast('ok', 'Đã lưu thông tin xe');
    setEditing(false);
    await reload();
  }

  async function toggle() {
    const { error } = await supabase.from('vehicles').update({ is_active: !vehicle.is_active }).eq('id', vehicle.id);
    if (error) return toast('error', error.message);
    toast('ok', vehicle.is_active ? 'Đã ngừng dùng xe' : 'Đã dùng lại xe');
    await reload();
  }

  return (
    <div className="sub">
      {!editing ? (
        <dl className="info small">
          <dt>Số khung / số máy</dt><dd>{vehicle.chassis_no ?? '—'} / {vehicle.engine_no ?? '—'}</dd>
          <dt>Chủ sở hữu</dt><dd>{vehicle.owner_name ?? '—'}</dd>
          <dt>Nước sản xuất</dt><dd>{vehicle.country_of_origin ?? '—'} · {vehicle.condition === 'cai_tao' ? 'Đã cải tạo' : 'Nguyên chiếc'}</dd>
          <dt>Kinh doanh</dt><dd>{BUSINESS[vehicle.business_type]}{vehicle.acquired_on ? ` · từ ${fmtDate(vehicle.acquired_on)}` : ''}</dd>
          <dt>Giám sát hành trình</dt><dd>{[vehicle.gsht_provider, vehicle.gsht_device_no].filter(Boolean).join(' · ') || 'Chưa khai báo'}</dd>
          <dt>Camera</dt><dd>{[vehicle.camera_provider, vehicle.camera_device_no].filter(Boolean).join(' · ') || 'Chưa khai báo'}</dd>
        </dl>
      ) : (
        <form className="form" onSubmit={saveVehicle}>
          <VehicleFields f={f} setF={setF} types={types} />
          <div className="actions">
            <button className="btn small primary">Lưu thông tin xe</button>
            <button type="button" className="btn small link" onClick={() => { setEditing(false); setF(vehicleFormOf(vehicle)); }}>Hủy</button>
          </div>
        </form>
      )}
      {life && <p className={`small state-${life.state}`}>{life.text} <span className="muted">(cần xác minh cách tính)</span></p>}
      {(!vehicle.gsht_device_no || !vehicle.camera_device_no) && (
        <p className="warn small">Xe kinh doanh vận tải hành khách phải lắp thiết bị giám sát hành trình và camera ghi hình lái xe.</p>
      )}
      {canEdit && !editing && (
        <div className="actions">
          <button className="btn small" onClick={() => setEditing(true)}>Sửa thông tin xe</button>
          <button className="btn small" onClick={() => void toggle()}>{vehicle.is_active ? 'Ngừng dùng xe' : 'Dùng lại xe'}</button>
          <DeleteButton kind="vehicle" id={vehicle.id} name={`xe ${vehicle.plate}`} note="Giấy tờ của xe cũng bị xóa." onDone={reload} />
        </div>
      )}

      <h3>Giấy tờ</h3>
      <ul className="list">
        {VEHICLE_DOCS.map((def) => (
          <DocRow key={def.code} def={def} doc={mine.find((d) => d.doc_type === def.code && d.is_current)}
                  tenantId={tenantId} owner={{ kind: 'xe', id: vehicle.id, label: vehicle.plate }} warnDays={warnDays}
                  canEdit={canEdit} reload={reload} check={(v) => <PlateCheck docPlate={v['xe.bien_so']} plate={vehicle.plate} />} />
        ))}
      </ul>
      <OldDocs docs={mine} canDelete={canEdit} onDeleted={reload} />
    </div>
  );
}

/* ------------------------------------------------------------------ Cảnh báo (như Lái xe & nhân viên) */

type Prob = { text: string; state: DocState | 'nien_han' };
function vehicleProblems(v: Vehicle, docs: Doc[], warnDays: number, maint?: Map<string, Maint>): Prob[] {
  const out: Prob[] = [];
  if (!v.is_active) return out;
  for (const def of VEHICLE_DOCS) {
    const s = docState(def, docs.find((d) => d.vehicle_id === v.id && d.doc_type === def.code && d.is_current), warnDays);
    if (s.state === 'het_han' || s.state === 'sap_het' || (s.state === 'thieu' && def.required)) out.push({ text: `${SHORT[def.code]}: ${s.text}`, state: s.state });
  }
  const life = lifeLimit(v.manufacture_year);
  if (life && life.state !== 'con_han') out.push({ text: life.text, state: 'nien_han' });
  const m = maint?.get(v.id);   // bảo dưỡng: km hoặc tháng, cái nào đến trước
  if (m && (m.state === 'qua_han' || m.state === 'sap_den')) out.push({ text: m.text, state: m.state === 'qua_han' ? 'het_han' : 'sap_het' });
  return out;
}

/** Cảnh báo dạng chuông: số việc cần xử lý; bấm mở danh sách gộp theo từng xe, bấm biển số mở hồ sơ xe. */
function VehicleAlerts(props: { vehicles: Vehicle[]; docs: Doc[]; warnDays: number; maint: Map<string, Maint>; avas: Record<string, string>; typeName: (id: string) => string; onOpen: (id: string) => void }) {
  const { vehicles, docs, warnDays, maint, avas, typeName, onOpen } = props;
  const [show, setShow] = useState(false);
  const order = { het_han: 0, nien_han: 1, sap_het: 2, thieu: 3, con_han: 4, co: 5 };
  const list = vehicles.map((v) => ({ v, items: vehicleProblems(v, docs, warnDays, maint).sort((a, b) => order[a.state] - order[b.state]) }))
    .filter((x) => x.items.length > 0)
    .sort((a, b) => order[a.items[0]!.state] - order[b.items[0]!.state] || b.items.length - a.items.length || a.v.plate.localeCompare(b.v.plate));
  const total = list.reduce((n, x) => n + x.items.length, 0);
  const urgent = list.some((x) => x.items[0]!.state === 'het_han');
  return (
    <>
      <button type="button" className={`bell${total ? ' has' : ''}${urgent ? ' urgent' : ''}`} onClick={() => setShow(true)} disabled={!total}
              aria-label={total ? `Cảnh báo: ${total} việc cần xử lý của ${list.length} xe` : 'Không có cảnh báo'} title={total ? `${total} việc cần xử lý` : 'Không có cảnh báo'}>
        <span aria-hidden="true">🔔</span>
        {total > 0 && <b className="bell-n">{total > 99 ? '99+' : total}</b>}
      </button>
      {show && (
        <Modal wide title={`Cảnh báo xe · ${list.length} xe`} onClose={() => setShow(false)}>
          <ul className="alert-people">
            {list.map(({ v, items }) => (
              <li key={v.id}>
                <button type="button" className="ap-head" onClick={() => { setShow(false); onOpen(v.id); }} aria-label={`Mở hồ sơ xe ${v.plate}`}>
                  <Avatar name={v.plate} url={avas[v.id]} size={36} text="🚌" />
                  <span className="ap-name"><b>{v.plate}</b><small className="muted">{typeName(v.vehicle_type_id)}</small></span>
                  <span className={`badge ${items.some((x) => x.state === 'het_han') ? 'locked' : 'warn-badge'}`}>{items.length}</span>
                </button>
                <div className="ap-items">
                  {items.map((r, i) => <span key={i} className={`ap-chip state-${r.state === 'nien_han' ? 'sap_het' : r.state}`}>{r.text}</span>)}
                </div>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}
