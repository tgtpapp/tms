// Bộ phận giấy tờ dùng chung (xe, lái xe, nhân viên…): ô nhập theo loại giấy, chọn ảnh + AI đọc,
// dòng giấy tờ (xem / sửa / thêm bản mới), giấy cũ, trạng thái hạn.
import { useRef, useState, type ReactNode } from 'react';
import { docTypeOf, type DocTypeDef, type OwnerKind } from '../lib/docTypes';
import { prepareFile, readByAI, signedUrl, uploadFiles, type FieldValue, type PreparedFile } from '../lib/documents';
import { errMsg, rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';

export interface Doc {
  id: string; vehicle_id: string | null; staff_id: string | null; doc_type: string; doc_no: string | null; issuer: string | null;
  issued_on: string | null; valid_from: string | null; expires_on: string | null; data: Record<string, FieldValue>;
  files: string[]; note: string | null; is_current: boolean; created_at: string;
}
export const DOC_COLS = 'id, vehicle_id, staff_id, doc_type, doc_no, issuer, issued_on, valid_from, expires_on, data, files, note, is_current, created_at';

export const SHORT: Record<string, string> = {
  dang_ky: 'Đăng ký', kiem_dinh: 'Kiểm định', bh_tnds: 'BH TNDS', bh_vat_chat: 'BH vật chất', bh_hanh_khach: 'BH hành khách',
  phu_hieu: 'Phù hiệu', hop_dong_thue: 'HĐ thuê', cai_tao: 'Cải tạo',
  cccd: 'CCCD', gplx: 'GPLX', kham_suc_khoe: 'Khám sức khỏe', tap_huan: 'Tập huấn', hop_dong_ld: 'HĐ lao động',
};

// Ngày theo giờ Việt Nam
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
export const fmtDate = (d: string | null) => (d ? d.split('-').reverse().join('/') : '—');
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/* ------------------------------------------------------------------ Trạng thái hạn */

export type DocState = 'thieu' | 'het_han' | 'sap_het' | 'con_han' | 'co';
export function docState(def: DocTypeDef, doc: Doc | undefined, warnDays: number, required = def.required): { state: DocState; text: string } {
  if (!doc) return { state: 'thieu', text: required ? 'Chưa có' : 'Chưa có (không bắt buộc)' };
  if (!doc.expires_on) return { state: 'co', text: def.hasExpiry ? 'Chưa nhập ngày hết hạn' : 'Đã có' };
  const left = daysBetween(today(), doc.expires_on);
  if (left < 0) return { state: 'het_han', text: `Hết hạn ${fmtDate(doc.expires_on)}` };
  if (left <= warnDays) return { state: 'sap_het', text: `Sắp hết hạn ${fmtDate(doc.expires_on)} (còn ${left} ngày)` };
  return { state: 'con_han', text: `Còn hạn đến ${fmtDate(doc.expires_on)}` };
}

/* ------------------------------------------------------------------ Giá trị ô nhập */

export type Values = Record<string, string>;
const CORE: Record<string, keyof Pick<Doc, 'doc_no' | 'issuer' | 'issued_on' | 'valid_from' | 'expires_on'>> = {
  so_giay: 'doc_no', noi_cap: 'issuer', ngay_cap: 'issued_on', hieu_luc_tu: 'valid_from', het_han: 'expires_on',
};

export function valuesFromAi(def: DocTypeDef, fields: Record<string, FieldValue>): Values {
  const v: Values = {};
  for (const x of def.fields) v[x.key] = fields[x.key] == null ? '' : String(fields[x.key]);
  return v;
}
function valuesFromDoc(def: DocTypeDef, d: Doc): Values {
  const v: Values = {};
  for (const x of def.fields) {
    const raw = CORE[x.key] ? d[CORE[x.key]] : d.data?.[x.key];
    v[x.key] = raw == null ? '' : String(raw);
  }
  return v;
}
export function toRpc(def: DocTypeDef, v: Values) {
  const data: Record<string, FieldValue> = {};
  for (const x of def.fields) {
    if (CORE[x.key]) continue;
    const s = (v[x.key] ?? '').trim();
    data[x.key] = s === '' ? null : x.kind === 'int' || x.kind === 'money' ? Number(s.replace(/[^0-9]/g, '')) : s;
  }
  const g = (k: string) => (v[k] ?? '').trim() || null;
  return { p_doc_no: g('so_giay'), p_issuer: g('noi_cap'), p_issued_on: g('ngay_cap'), p_valid_from: g('hieu_luc_tu'),
           p_expires_on: g('het_han'), p_data: data };
}

export function DocFields({ def, values, onChange }: { def: DocTypeDef; values: Values; onChange: (v: Values) => void }) {
  const short = SHORT[def.code] ?? def.name;
  return (
    <div className="grid2">
      {def.fields.map((x) => (
        <label key={x.key}>{x.label}
          <input aria-label={`${short}: ${x.label}`} value={values[x.key] ?? ''}
                 type={x.kind === 'date' ? 'date' : x.kind === 'text' ? 'text' : 'number'}
                 inputMode={x.kind === 'int' || x.kind === 'money' ? 'numeric' : undefined}
                 onChange={(e) => onChange({ ...values, [x.key]: e.target.value })} />
          {x.kind === 'money' && values[x.key] && <span className="muted small">{Number(values[x.key]).toLocaleString('vi-VN')} đ</span>}
        </label>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Chọn ảnh + AI đọc */

export interface Scanned { files: PreparedFile[]; values: Values; aiNote: string; warnings: string[] }

/** Giấy 1 mặt: 1 ô chọn (tối đa 4 ảnh/PDF). Giấy nhiều mặt (CCCD, GPLX): mỗi mặt 1 ô, đủ mặt thì AI tự đọc. */
export function Scanner({ def, onScanned }: { def: DocTypeDef; onScanned: (s: Scanned) => void }) {
  const [busy, setBusy] = useState<{ on: boolean; sec: number }>({ on: false, sec: 0 });
  const [sides, setSides] = useState<(PreparedFile | null)[]>(() => (def.sides ?? []).map(() => null));
  // Giữ bản mới nhất ngoài state: chọn 2 mặt liên tiếp thật nhanh vẫn không mất mặt trước
  const sidesRef = useRef(sides);
  const short = SHORT[def.code] ?? def.name;

  async function read(files: PreparedFile[]) {
    const t0 = Date.now();
    setBusy({ on: true, sec: 0 });
    const tick = setInterval(() => setBusy({ on: true, sec: Math.round((Date.now() - t0) / 1000) }), 1000);
    try {
      const r = await readByAI(def.code, files);
      onScanned({ files, values: valuesFromAi(def, r.fields), warnings: r.warnings,
                  aiNote: `AI đã đọc xong (${((Date.now() - t0) / 1000).toFixed(1)} giây). Kiểm tra lại trước khi lưu.` });
    } catch (e) {
      onScanned({ files, values: valuesFromAi(def, {}), warnings: [], aiNote: errMsg(e) });
    } finally {
      clearInterval(tick);
      setBusy({ on: false, sec: 0 });
    }
  }

  async function pickMany(list: FileList | null) {
    if (!list || list.length === 0) return;
    try {
      await read(await Promise.all(Array.from(list).slice(0, 4).map(prepareFile)));
    } catch (e) {
      onScanned({ files: [], values: valuesFromAi(def, {}), warnings: [], aiNote: errMsg(e) });
    }
  }

  async function pickSide(i: number, list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    try {
      const prepared = await prepareFile(file);
      const next = sidesRef.current.map((x, k) => (k === i ? prepared : x));
      sidesRef.current = next;
      setSides(next);
      if (next.every(Boolean)) await read(next as PreparedFile[]);
    } catch (e) {
      onScanned({ files: [], values: valuesFromAi(def, {}), warnings: [], aiNote: errMsg(e) });
    }
  }

  if (busy.on) return <p className="upload">AI đang đọc… {busy.sec} giây</p>;

  if (def.sides) {
    const chosen = sides.filter(Boolean) as PreparedFile[];
    return (
      <div className="sides">
        {def.sides.map((side, i) => (
          <label key={side} className={sides[i] ? 'upload done' : 'upload'}>
            <span>{sides[i] ? `✓ Đã chọn ${side.toLowerCase()} – chạm để chọn lại` : `Chụp / tải ${side.toLowerCase()} ${def.name}`}</span>
            <input type="file" accept="image/*" aria-label={`Tải ảnh ${short} – ${side}`}
                   onChange={(e) => { void pickSide(i, e.target.files); e.target.value = ''; }} />
          </label>
        ))}
        {chosen.length > 0 && chosen.length < def.sides.length && (
          <button type="button" className="btn small" onClick={() => void read(chosen)}>Đọc với {chosen.length} mặt đã chọn</button>
        )}
      </div>
    );
  }

  return (
    <label className="upload">
      <span>{`Chụp / tải ảnh ${def.name} (tối đa 4 ảnh hoặc PDF)`}</span>
      <input type="file" accept="image/*,application/pdf" multiple aria-label={`Tải ảnh ${short}`}
             onChange={(e) => { void pickMany(e.target.files); e.target.value = ''; }} />
    </label>
  );
}

/* ------------------------------------------------------------------ Xem tệp */

export function FilesButton({ files }: { files: string[] }) {
  const toast = useToast();
  async function open() {
    try {
      for (const p of files) window.open(await signedUrl(p), '_blank', 'noopener');
    } catch (e) {
      toast('error', errMsg(e));
    }
  }
  if (files.length === 0) return null;
  return <button type="button" className="btn small link" onClick={() => void open()}>Xem {files.length} tệp</button>;
}

/* ------------------------------------------------------------------ Một dòng giấy tờ của 1 chủ */

export interface DocOwner { kind: OwnerKind; id: string; label: string }
const ADD_RPC: Partial<Record<OwnerKind, { fn: string; idParam: string }>> = {
  xe: { fn: 'add_vehicle_document', idParam: 'p_vehicle_id' },
  nhan_su: { fn: 'add_staff_document', idParam: 'p_staff_id' },
};

export function DocRow(props: {
  def: DocTypeDef; doc?: Doc; tenantId: string; owner: DocOwner; warnDays: number; canEdit: boolean; required?: boolean;
  reload: () => Promise<void>; check?: (values: Values) => ReactNode;
}) {
  const { def, doc, tenantId, owner, warnDays, canEdit, reload, check } = props;
  const toast = useToast();
  const [mode, setMode] = useState<'view' | 'add' | 'edit'>('view');
  const [scanned, setScanned] = useState<Scanned | null>(null);
  const [values, setValues] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const [reqId, setReqId] = useState(() => crypto.randomUUID());
  const st = docState(def, doc, warnDays, props.required ?? def.required);
  const short = SHORT[def.code] ?? def.name;

  async function saveNew() {
    if (!scanned || scanned.files.length === 0) return toast('error', 'Hãy tải lên ảnh giấy tờ');
    setBusy(true);
    try {
      const paths = await uploadFiles(tenantId, owner.kind, owner.id, owner.label, def.code, scanned.files);
      const r = ADD_RPC[owner.kind];
      if (!r) throw new Error('Loại giấy tờ này lưu ở Cấu hình công ty');
      await rpc(r.fn, { [r.idParam]: owner.id, p_doc_type: def.code, ...toRpc(def, values), p_files: paths, p_note: null, p_request_id: reqId });
      toast('ok', `Đã lưu ${def.name}`);
      setMode('view');
      setScanned(null);
      setReqId(crypto.randomUUID());
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!doc) return;
    setBusy(true);
    try {
      const r = toRpc(def, values);
      await rpc('update_document', { p_id: doc.id, p_doc_no: r.p_doc_no, p_issuer: r.p_issuer, p_issued_on: r.p_issued_on,
                                     p_valid_from: r.p_valid_from, p_expires_on: r.p_expires_on, p_data: r.p_data, p_note: doc.note });
      toast('ok', `Đã sửa ${def.name}`);
      setMode('view');
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="item">
      <div className="item-head">
        <div>
          <b>{def.name}</b>
          <div className={`small state-${st.state}`}>{st.text}{doc?.doc_no ? ` · Số ${doc.doc_no}` : ''}{doc?.issuer ? ` · ${doc.issuer}` : ''}</div>
        </div>
        <div className="actions">
          {doc && <FilesButton files={doc.files} />}
          {canEdit && mode === 'view' && (
            <>
              {doc && <button className="btn small" aria-label={`Sửa ${short}`} onClick={() => { setValues(valuesFromDoc(def, doc)); setMode('edit'); }}>Sửa</button>}
              <button className="btn small" aria-label={`Thêm ${short}`} onClick={() => { setScanned(null); setValues(valuesFromAi(def, {})); setMode('add'); }}>
                {doc ? 'Thêm bản mới' : 'Thêm'}
              </button>
            </>
          )}
        </div>
      </div>
      {mode !== 'view' && (
        <div className="sub">
          {mode === 'add' && (
            <>
              <Scanner def={def} onScanned={(s) => {
                if (s.files.length === 0) return toast('error', s.aiNote);
                setScanned(s);
                setValues((cur) => {
                  const next = { ...cur };
                  for (const [k, v] of Object.entries(s.values)) if (v) next[k] = v;
                  return next;
                });
              }} />
              {scanned && <p className="muted small">{scanned.aiNote} · {scanned.files.length} tệp</p>}
              {scanned && scanned.warnings.length > 0 && <ul className="warn small">{scanned.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
              {doc && <p className="muted small">Lưu bản mới thì bản hiện tại chuyển sang giấy cũ (vẫn giữ lại).</p>}
            </>
          )}
          <DocFields def={def} values={values} onChange={setValues} />
          {check?.(values)}
          <div className="actions">
            <button type="button" className="btn small primary" disabled={busy || (mode === 'add' && !scanned)}
                    onClick={() => void (mode === 'add' ? saveNew() : saveEdit())}>{busy ? 'Đang lưu…' : 'Lưu giấy tờ'}</button>
            <button type="button" className="btn small link" onClick={() => setMode('view')}>Hủy</button>
          </div>
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ Giấy cũ */

export function OldDocs({ docs }: { docs: Doc[] }) {
  const [show, setShow] = useState(false);
  const old = docs.filter((d) => !d.is_current).sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (old.length === 0) return null;
  return (
    <>
      <button className="btn small link" onClick={() => setShow(!show)}>{show ? 'Ẩn giấy cũ' : `Hiện giấy cũ (${old.length})`}</button>
      {show && (
        <ul className="list small">
          {old.map((d) => (
            <li key={d.id} className="muted">
              {docTypeOf(d.doc_type)?.name ?? d.doc_type} · {d.doc_no ?? 'không số'} · {d.expires_on ? `hết hạn ${fmtDate(d.expires_on)}` : 'không thời hạn'}
              <FilesButton files={d.files} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
