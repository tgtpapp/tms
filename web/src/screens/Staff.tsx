import { mergeRecordPapers, recordExpiry } from '../lib/recordPapers';
import { Modal } from '../components/Modal';
import { StaffSignature } from '../components/StaffSignature';
import { Avatar, StaffAvatar, useAvatars } from '../components/StaffAvatar';
import { BulkPaperSave, PaperActions, type Me } from '../components/ProfilePapers';
import { StaffContracts } from '../components/StaffContracts';
import { FilePreviews } from '../components/FilePreview';
import { DeleteButton } from '../components/DeleteButton';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  DOC_COLS, DocFields, DocRow, docState, FilesButton, fmtDate, OldDocs, Scanner, SHORT, today, toRpc, type Doc, type DocState, type Scanned,
  type Values,
} from '../components/Documents';
import { DOC_TYPES, docTypeOf, type DocTypeDef } from '../lib/docTypes';
import type { FieldValue } from '../lib/documents';
import { uploadFiles } from '../lib/documents';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';

type Position = 'lai_xe' | 'phu_xe' | 'nhan_vien';
type Gender = 'nam' | 'nu';
type Contract = 'khong_xac_dinh' | 'xac_dinh' | 'thu_viec' | 'thoi_vu' | 'khoan_viec' | 'khac';

interface Staff {
  id: string; user_id: string | null; full_name: string; position: Position; phone: string | null; branch_id: string | null;
  joined_on: string; left_on: string | null; is_active: boolean; job_title: string | null;
}
interface StaffPrivate { staff_id: string; birth_date: string | null; gender: Gender | null; address: string | null; current_address: string | null; contract_type: Contract | null; note: string | null }
interface Option { id: string; label: string }
type RecordKind = 'suc_khoe' | 'vi_pham' | 'tai_nan' | 'khen_thuong' | 'ky_luat' | 'dao_tao';
interface StaffRecord {
  id: string; staff_id: string; kind: RecordKind; occurred_on: string; doc_no: string | null; title: string;
  vehicle_id: string | null; data: Record<string, FieldValue>; files: string[];
}
interface LicenseRow { staff_id: string; license_class: string | null; license_expires: string | null; vehicle_type_id: string; need: string; ok: boolean; reason: string | null }

const POSITION: Record<Position, string> = { lai_xe: 'Lái xe', phu_xe: 'Phụ xe', nhan_vien: 'Nhân viên' };
/** Chức vụ hiển thị: chức vụ tự đặt, chưa có thì theo vị trí (Lái xe / Phụ xe / Nhân viên). */
const jobLabel = (s: { job_title: string | null; position: Position }) => s.job_title?.trim() || POSITION[s.position];
const jobKey = (s: { job_title: string | null; position: Position }) => jobLabel(s).toLocaleLowerCase('vi').replace(/\s+/g, ' ');
/** Thẻ chọn theo chức vụ đang có (không cố định): Giám đốc, Kế toán, Lái xe… — thêm chức vụ mới là có thẻ mới. */
function jobTabs(list: { job_title: string | null; position: Position }[]): { key: string; label: string; n: number }[] {
  const m = new Map<string, { key: string; label: string; n: number; rank: number }>();
  for (const s of list) {
    const key = jobKey(s);
    const t = m.get(key) ?? { key, label: jobLabel(s), n: 0, rank: 9 };
    t.n++;
    t.rank = Math.min(t.rank, s.position === 'lai_xe' ? 1 : s.position === 'phu_xe' ? 2 : 3);
    m.set(key, t);
  }
  return [...m.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, 'vi'));
}
const CONTRACT: Record<Contract, string> = {
  khong_xac_dinh: 'Không xác định thời hạn', xac_dinh: 'Xác định thời hạn', thu_viec: 'Thử việc', thoi_vu: 'Thời vụ',
  khoan_viec: 'Khoán việc', khac: 'Khác',
};
const STAFF_DOCS = DOC_TYPES.filter((d) => d.owner === 'nhan_su' && !d.record);
const RECORD_DOCS = DOC_TYPES.filter((d) => d.owner === 'nhan_su' && d.record);
/** Giấy bắt buộc theo chức danh (lái xe kinh doanh vận tải: GPLX, khám sức khỏe, tập huấn – cần xác minh đủ danh mục). */
const REQUIRED: Record<Position, string[]> = {
  lai_xe: ['cccd', 'gplx', 'kham_suc_khoe', 'tap_huan'], phu_xe: ['cccd'], nhan_vien: ['cccd'],
};

/* ------------------------------------------------------------------ Tuổi, thâm niên */

function yearsBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return y2 - y1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0);
}
function seniority(joined: string, left: string | null): string {
  const end = left ?? today();
  const months = Math.max(0, (Number(end.slice(0, 4)) - Number(joined.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(joined.slice(5, 7)));
  return months >= 12 ? `${Math.floor(months / 12)} năm ${months % 12} tháng` : `${months} tháng`;
}
/** Tuổi tối đa lái xe chở người trên 29 chỗ, xe giường nằm: 57 (nam), 55 (nữ) – Luật TTATGT đường bộ 2024, Điều 59. */
function ageCheck(p: StaffPrivate | undefined, position: Position): { text: string; state: 'het_han' | 'sap_het' } | null {
  if (position !== 'lai_xe' || !p?.birth_date || !p.gender) return null;
  const limit = p.gender === 'nam' ? 57 : 55;
  const age = yearsBetween(p.birth_date, today());
  if (age >= limit) return { text: `${age} tuổi – đã quá tuổi lái xe trên 29 chỗ / giường nằm (tối đa ${limit})`, state: 'het_han' };
  if (age >= limit - 1) return { text: `${age} tuổi – sắp đến tuổi tối đa lái xe trên 29 chỗ / giường nằm (${limit})`, state: 'sap_het' };
  return null;
}

/* ------------------------------------------------------------------ Màn hình */

export function StaffScreen({ ctx, perms }: { ctx: AccountContext; perms: Permissions }) {
  const toast = useToast();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [priv, setPriv] = useState<StaffPrivate[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [users, setUsers] = useState<Option[]>([]);
  const [branches, setBranches] = useState<Option[]>([]);
  const [warnDays, setWarnDays] = useState(30);
  const [open, setOpen] = useState<string | null>(null);
  const [records, setRecords] = useState<StaffRecord[]>([]);
  const [types, setTypes] = useState<Option[]>([]);
  const [licenses, setLicenses] = useState<LicenseRow[]>([]);
  const [tab, setTab] = useState('');   // '' = Tất cả; còn lại = khóa chức vụ (chữ thường)
  const [showLeft, setShowLeft] = useState(false);
  const canEdit = perms.has('staff.manage');
  const canView = perms.has('staff.view_all');   // không có: chỉ thấy hồ sơ của chính mình

  const load = useCallback(async () => {
    const [s, p, d, u, b, w, r, vt, lm] = await Promise.all([
      supabase.from('staff_members').select('id, user_id, full_name, position, phone, branch_id, joined_on, left_on, is_active, job_title').order('full_name'),
      supabase.from('staff_private').select('staff_id, birth_date, gender, address, current_address, contract_type, note'),
      supabase.from('documents').select(DOC_COLS).eq('owner_kind', 'nhan_su'),
      supabase.from('app_users').select('id, full_name, phone').order('full_name'),
      supabase.from('branches').select('id, name').order('name'),
      supabase.from('tenant_settings').select('value').eq('key', 'giay_to.canh_bao_truoc_ngay').maybeSingle(),
      supabase.from('staff_records').select('id, staff_id, kind, occurred_on, doc_no, title, vehicle_id, data, files').order('occurred_on', { ascending: false }),
      supabase.from('vehicle_types').select('id, name').eq('is_active', true).order('name'),
      supabase.rpc('license_matrix'),
    ]);
    const err = s.error ?? p.error ?? d.error ?? b.error ?? w.error ?? r.error ?? vt.error ?? lm.error;
    if (err) return toast('error', err.message);
    // Không có ô Xem tất cả (vd lái xe): chỉ thấy hồ sơ của chính mình
    setStaff(((s.data ?? []) as Staff[]).filter((x) => canView || x.user_id === ctx.user_id));
    setPriv((p.data ?? []) as StaffPrivate[]);
    setDocs((d.data ?? []) as Doc[]);
    setUsers(((u.data ?? []) as { id: string; full_name: string; phone: string }[]).map((x) => ({ id: x.id, label: `${x.full_name} · ${x.phone}` })));
    setBranches(((b.data ?? []) as { id: string; name: string }[]).map((x) => ({ id: x.id, label: x.name })));
    setWarnDays(Number(w.data?.value ?? 30) || 30);
    setRecords((r.data ?? []) as StaffRecord[]);
    setTypes(((vt.data ?? []) as { id: string; name: string }[]).map((x) => ({ id: x.id, label: x.name })));
    setLicenses((lm.data ?? []) as LicenseRow[]);
  }, [toast, canView, ctx.user_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const tenantId = ctx.tenant_id ?? '';
  const canArchive = perms.has('archive.manage');
  const me: Me = { id: ctx.user_id, name: ctx.full_name ?? '' };
  const [bulk, setBulk] = useState(false);
  // Giấy khám SK / tập huấn ghi trong Lý lịch hành nghề cũng tính (như khi xếp xe)
  const papers = useMemo(() => mergeRecordPapers(docs.filter((d) => d.is_current), records, (sid, type, exp): Doc => ({
    id: `ly-lich:${sid}:${type}`, vehicle_id: null, staff_id: sid, doc_type: type, doc_no: null, issuer: null, issued_on: null, valid_from: null,
    expires_on: exp, data: {}, files: [], note: 'Theo Lý lịch hành nghề', is_current: true, created_at: '' })), [docs, records]);
  const common = { tenantId, priv, docs, papers, users, branches, warnDays, canEdit, records, types, licenses, reload: load, canArchive, me, labor: { view: perms.has('labor.view'), add: perms.has('labor.add'), edit: perms.has('labor.edit') } };
  const avas = useAvatars(tenantId || null);
  const shown = staff.filter((s) => showLeft || s.is_active);
  const tabs = jobTabs(shown);
  const cur = tabs.some((t) => t.key === tab) ? tab : '';
  return (
    <>
      <div className="staff-top">
        <div className="vx-tabs staff-tabs" role="tablist" aria-label="Nhóm">
          {[{ key: '', label: 'Tất cả', n: shown.length }, ...tabs].map((t) => (
            <button key={t.key || '*'} type="button" role="tab" aria-selected={cur === t.key} className={cur === t.key ? 'on' : ''} onClick={() => { setTab(t.key); setOpen(null); }}>
              {t.label} ({t.n})
            </button>
          ))}
        </div>
        {canEdit && canArchive && (
          <button type="button" className="btn small" title="Lưu lý lịch hành nghề của tất cả lái xe đang làm vào Lưu trữ hồ sơ" onClick={() => setBulk(true)}>💾 Lưu lý lịch</button>
        )}
        {bulk && <BulkPaperSave kind="driver" tenantId={tenantId} me={me} onClose={() => setBulk(false)}
          items={staff.filter((x) => x.is_active && x.position === 'lai_xe').map((x) => ({ id: x.id, label: x.full_name }))} />}
        {canEdit && <StaffAlerts staff={staff} priv={priv} docs={papers} warnDays={warnDays} avas={avas} onOpen={(id) => {
          setTab('');
          setOpen(id);
          setTimeout(() => document.getElementById(`nv-${id}`)?.scrollIntoView({ behavior: 'smooth' }), 50);
        }} />}
      </div>
      <StaffList {...common} staff={staff} myUserId={ctx.user_id} open={open} setOpen={setOpen} cur={cur} showLeft={showLeft} setShowLeft={setShowLeft} avas={avas} />
      {canEdit && <StaffForm key="new" {...common} staff={staff} />}
    </>
  );
}

/* ------------------------------------------------------------------ Thêm / sửa hồ sơ */

const EMPTY = {
  full_name: '', job_title: '', position: 'lai_xe' as Position, phone: '', branch_id: '', joined_on: '', left_on: '', is_active: true,
  user_id: '', birth_date: '', gender: '' as Gender | '', address: '', current_address: '', contract_type: '' as Contract | '', note: '',
};
type Form = typeof EMPTY;

function formOf(s: Staff, p: StaffPrivate | undefined): Form {
  return {
    full_name: s.full_name, job_title: s.job_title ?? '', position: s.position, phone: s.phone ?? '', branch_id: s.branch_id ?? '', joined_on: s.joined_on,
    left_on: s.left_on ?? '', is_active: s.is_active, user_id: s.user_id ?? '', birth_date: p?.birth_date ?? '',
    gender: p?.gender ?? '', address: p?.address ?? '', current_address: p?.current_address ?? '', contract_type: p?.contract_type ?? '', note: p?.note ?? '',
  };
}

/** Điền hồ sơ từ CCCD / GPLX đọc được (chỉ ô đọc được). */
function applyToForm(f: Form, v: Values): Form {
  const pick = (k: string) => (v[k] ?? '').trim();
  const next = { ...f };
  if (pick('nv.ho_ten')) next.full_name = pick('nv.ho_ten');
  if (pick('nv.ngay_sinh')) next.birth_date = pick('nv.ngay_sinh');
  if (pick('nv.noi_thuong_tru')) next.address = pick('nv.noi_thuong_tru');
  const g = pick('nv.gioi_tinh').toLowerCase();
  if (g.startsWith('nam') || g === 'male') next.gender = 'nam';
  else if (g.startsWith('nữ') || g.startsWith('nu') || g === 'female') next.gender = 'nu';
  return next;
}

interface Pending { key: string; def: DocTypeDef; scanned: Scanned }
interface Common {
  tenantId: string; priv: StaffPrivate[]; docs: Doc[]; papers: Doc[]; users: Option[]; branches: Option[]; warnDays: number; canEdit: boolean;
  records: StaffRecord[]; types: Option[]; licenses: LicenseRow[]; reload: () => Promise<void>;
  canArchive: boolean; me: Me; labor: { view: boolean; add: boolean; edit: boolean };
}

function StaffForm(props: Common & { staff: Staff[]; editing?: Staff; onDone?: () => void }) {
  const { tenantId, users, branches, staff, editing, onDone, reload } = props;
  const toast = useToast();
  const [f, setF] = useState<Form>(() => (editing ? formOf(editing, props.priv.find((p) => p.staff_id === editing.id)) : EMPTY));
  const [scanType, setScanType] = useState('cccd');
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [id] = useState(() => editing?.id ?? crypto.randomUUID());
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const linked = new Set(staff.filter((s) => s.user_id && s.id !== editing?.id).map((s) => s.user_id));

  function onScanned(def: DocTypeDef, s: Scanned) {
    if (s.files.length === 0) return toast('error', s.aiNote);
    setPending((p) => [...p.filter((x) => x.def.code !== def.code), { key: crypto.randomUUID(), def, scanned: s }]);
    setF((cur) => applyToForm(cur, s.values));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.full_name.trim()) return toast('error', 'Nhập họ tên');
    if (!f.joined_on) return toast('error', 'Nhập ngày vào công ty');
    if (f.phone && !/^0[0-9]{9}$/.test(f.phone.trim())) return toast('error', 'Số điện thoại phải gồm 10 số, bắt đầu bằng 0');
    setBusy(true);
    try {
      await rpc('save_staff', { p_id: id, p: { ...f, full_name: f.full_name.trim(), phone: f.phone.trim(), is_active: !f.left_on } });
    } catch (err) {
      setBusy(false);
      return toast('error', errMsg(err));
    }
    let failed = 0;
    for (const p of pending) {
      try {
        const paths = await uploadFiles(tenantId, 'nhan_su', id, f.full_name, p.def.code, p.scanned.files);
        await rpc('add_staff_document', { p_staff_id: id, p_doc_type: p.def.code, ...toRpc(p.def, p.scanned.values),
                                          p_files: paths, p_note: null, p_request_id: p.key });
      } catch (err) {
        failed++;
        toast('error', `${p.def.name}: ${errMsg(err)}`);
      }
    }
    setBusy(false);
    const name = f.full_name.trim();
    toast('ok', failed ? `Đã lưu ${name}, còn ${failed} giấy tờ chưa lưu – thêm lại ở mục Giấy tờ` : editing ? `Đã lưu hồ sơ ${name}` : `Đã thêm ${name}`);
    await reload();
    if (editing) onDone?.();
    else {
      setF(EMPTY);
      setPending([]);
    }
  }

  const scanDef = docTypeOf(scanType)!;
  const Wrap = editing ? 'div' : 'section';

  return (
    <Wrap className={editing ? 'form' : 'card form'}>
      {!editing && <h2>Thêm lái xe / nhân viên</h2>}
      {!editing && (
        <div className="sub">
          <b className="small">Đọc nhanh từ giấy tờ</b>
          <select aria-label="Loại giấy để đọc" value={scanType} onChange={(e) => setScanType(e.target.value)}>
            {STAFF_DOCS.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
          </select>
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
            </div>
          ))}
        </div>
      )}
      <form className="form" onSubmit={submit}>
        <div className="grid2">
          <label>Họ tên<input value={f.full_name} onChange={set('full_name')} required /></label>
          <label>Chức vụ<input value={f.job_title} onChange={set('job_title')} list="chuc-vu" maxLength={80} placeholder="vd: Giám đốc, Kế toán, Điều hành, Lái xe" /></label>
          <datalist id="chuc-vu">{[...new Set([...props.staff.map((x) => x.job_title?.trim() ?? '').filter(Boolean), 'Giám đốc', 'Phó giám đốc', 'Kế toán', 'Điều hành', 'Người điều hành vận tải', 'Bán vé', 'Lái xe', 'Phụ xe', 'Bảo vệ', 'Tạp vụ'])].map((x) => <option key={x} value={x} />)}</datalist>
          <label>Nhóm (để xếp chuyến, giấy tờ bắt buộc)
            <select value={f.position} onChange={set('position')}>
              {Object.entries(POSITION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Ngày vào công ty<input type="date" value={f.joined_on} onChange={set('joined_on')} max={today()} required /></label>
          <label>Số điện thoại<input value={f.phone} onChange={set('phone')} inputMode="tel" /></label>
          <label>Chi nhánh
            <select value={f.branch_id} onChange={set('branch_id')}>
              <option value="">—</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </label>
          <label>Ngày sinh<input type="date" value={f.birth_date} onChange={set('birth_date')} /></label>
          <label>Giới tính
            <select value={f.gender} onChange={set('gender')}>
              <option value="">—</option>
              <option value="nam">Nam</option>
              <option value="nu">Nữ</option>
            </select>
          </label>
          <label>Nơi thường trú<input value={f.address} onChange={set('address')} /></label>
          <label>Chỗ ở hiện nay<input value={f.current_address} onChange={set('current_address')} maxLength={300} placeholder="Nơi đang ở thực tế (nếu khác thường trú)" /></label>
          <label>Hình thức hợp đồng lao động
            <select value={f.contract_type} onChange={set('contract_type')}>
              <option value="">—</option>
              {Object.entries(CONTRACT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Tài khoản đăng nhập (nếu có)
            <select value={f.user_id} onChange={set('user_id')}>
              <option value="">Không liên kết</option>
              {users.filter((u) => !linked.has(u.id)).map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
          {editing && <label>Ngày nghỉ việc<input type="date" value={f.left_on} onChange={set('left_on')} /></label>}
          <label>Ghi chú<input value={f.note} onChange={set('note')} /></label>
        </div>
        <p className="muted small">Ngày sinh, giới tính, nơi thường trú, giấy tờ cá nhân: chỉ người quản lý nhân sự và chính người đó xem được.</p>
        <div className="actions">
          <button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : editing ? 'Lưu hồ sơ' : 'Lưu nhân viên'}</button>
          {editing && <button type="button" className="btn link" onClick={onDone}>Hủy</button>}
        </div>
      </form>
    </Wrap>
  );
}

/* ------------------------------------------------------------------ Danh sách */

function StaffList(props: Common & { staff: Staff[]; myUserId: string | null; open: string | null; setOpen: (id: string | null) => void;
  cur: string; showLeft: boolean; setShowLeft: (v: boolean) => void; avas: Record<string, string> }) {
  const { staff, priv, papers, warnDays, canEdit, myUserId, open, setOpen, branches, cur, showLeft, setShowLeft, avas } = props;
  const left = staff.filter((s) => !s.is_active).length;

  const shown = staff.filter((s) => showLeft || s.is_active);
  return (
    <section className="card">
      <div className="item-head">
        <h2>Lái xe & nhân viên ({staff.filter((s) => s.is_active).length})</h2>
        {left > 0 && (
          <button className="btn small" onClick={() => setShowLeft(!showLeft)}>
            {showLeft ? 'Ẩn người đã nghỉ' : `Hiện người đã nghỉ (${left})`}
          </button>
        )}
      </div>
      {staff.length === 0 && <p className="muted">Chưa có lái xe / nhân viên.</p>}
      <div className="staff-cards">
        {shown.filter((s) => !cur || jobKey(s) === cur).map((s) => {
          const mine = s.user_id === myUserId;
          const canOpen = canEdit || mine;
          const p = priv.find((x) => x.staff_id === s.id);
          const gplx = docs.find((d) => d.staff_id === s.id && d.doc_type === 'gplx' && d.is_current);
          const bad = canEdit ? problems(s, p, papers, warnDays).length : 0;
          return (
            <div key={s.id} id={`nv-${s.id}`} className={`staff-card pos-${s.position}${s.is_active ? '' : ' off'}`}>
              <div className="sc-top">
                <Avatar name={s.full_name} url={avas[s.id]} />
                <div className="sc-name">
                  <b>{s.full_name}</b>
                  <span className="sc-job">{jobLabel(s)}</span>
                </div>
              </div>
              <div className="sc-info small">
                {s.phone && <span>📞 <a href={`tel:${s.phone}`}>{s.phone}</a></span>}
                {s.position === 'lai_xe' && <span>GPLX: {gplx?.data?.hang ? `hạng ${gplx.data.hang}` : 'Chưa có'}</span>}
                {s.branch_id && <span>{branches.find((b) => b.id === s.branch_id)?.label ?? ''}</span>}
                {p?.current_address && <span>🏠 {p.current_address}</span>}
                <span className="muted">Vào {fmtDate(s.joined_on)} · {seniority(s.joined_on, s.left_on)}</span>
              </div>
              <div className="sc-badges">
                <span className="badge">{POSITION[s.position]}</span>
                {!s.is_active && <span className="badge locked">Đã nghỉ {s.left_on ? fmtDate(s.left_on) : ''}</span>}
                {mine && <span className="badge">Tôi</span>}
                {bad > 0 && <span className="badge warn-badge">{bad} việc cần xử lý</span>}
              </div>
              {canOpen && (
                <button className="btn small sc-open" aria-label={`Hồ sơ ${s.full_name}`} onClick={() => setOpen(s.id)}>
                  {canEdit ? 'Sửa' : 'Hồ sơ'}
                </button>
              )}
              {open === s.id && canOpen && (
                <Modal wide title={`Hồ sơ ${s.full_name}`} onClose={() => setOpen(null)}>
                  <StaffDetail {...props} s={s} p={p} mine={mine} />
                </Modal>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StaffDetail(props: Common & { staff: Staff[]; s: Staff; p: StaffPrivate | undefined; mine: boolean }) {
  const { s, p, docs, tenantId, warnDays, canEdit, reload } = props;
  const [editing, setEditing] = useState(false);
  const mine = useMemo(() => docs.filter((d) => d.staff_id === s.id), [docs, s.id]);
  const age = ageCheck(p, s.position);
  const required = REQUIRED[s.position];

  if (editing) return <div className="sub"><StaffForm {...props} editing={s} onDone={() => setEditing(false)} /></div>;

  return (
    <div className="sub">
      <StaffAvatar tenantId={tenantId} staffId={s.id} name={s.full_name} canEdit={canEdit || props.mine} />
      <dl className="info small">
        <dt>Ngày sinh</dt><dd>{p?.birth_date ? `${fmtDate(p.birth_date)} (${yearsBetween(p.birth_date, today())} tuổi)` : '—'}</dd>
        <dt>Giới tính</dt><dd>{p?.gender === 'nam' ? 'Nam' : p?.gender === 'nu' ? 'Nữ' : '—'}</dd>
        <dt>Nơi thường trú</dt><dd>{p?.address ?? '—'}</dd>
        <dt>Chỗ ở hiện nay</dt><dd>{p?.current_address ?? '—'}</dd>
        <dt>Hợp đồng</dt><dd>{p?.contract_type ? CONTRACT[p.contract_type] : '—'}</dd>
        {p?.note && <><dt>Ghi chú</dt><dd>{p.note}</dd></>}
      </dl>
      {age && <p className={`small state-${age.state}`}>{age.text}</p>}
      {canEdit && <div className="actions"><button className="btn small" onClick={() => setEditing(true)}>Sửa hồ sơ</button>
        <DeleteButton kind="staff" id={s.id} name={s.full_name} note="Giấy tờ, lý lịch của người này cũng bị xóa." onDone={reload} /></div>}
      {props.labor.view && <StaffContracts s={s} contractType={p?.contract_type} tenantId={tenantId} me={props.me} canArchive={props.canArchive}
                                           canAdd={props.labor.add} canEdit={props.labor.edit} />}
      <StaffSignature tenantId={tenantId} staffId={s.id} canEdit={canEdit} />
      <h3>Giấy tờ</h3>
      <ul className="list">
        {STAFF_DOCS.map((def) => (
          <DocRow key={def.code} def={def} doc={mine.find((d) => d.doc_type === def.code && d.is_current)} tenantId={tenantId}
                  recordExp={recordExpiry(props.records, s.id, def.code)}
                  owner={{ kind: 'nhan_su', id: s.id, label: s.full_name }} warnDays={warnDays} canEdit={canEdit}
                  required={required.includes(def.code)} reload={reload} />
        ))}
      </ul>
      <OldDocs docs={mine} />
      {s.position === 'lai_xe' && <LicenseCheck rows={props.licenses.filter((l) => l.staff_id === s.id)} types={props.types} />}
      <Records {...props} s={s} />
    </div>
  );
}

/* ------------------------------------------------------------------ Hạng GPLX theo loại xe */

function LicenseCheck({ rows, types }: { rows: LicenseRow[]; types: Option[] }) {
  if (rows.length === 0) return null;
  const hang = rows[0].license_class;
  return (
    <>
      <h3>Loại xe được lái {hang ? `(GPLX hạng ${hang})` : ''}</h3>
      <ul className="list small">
        {rows.map((r) => (
          <li key={r.vehicle_type_id} className={r.ok ? 'state-con_han' : 'state-het_han'}>
            {r.ok ? '✓' : '✗'} {types.find((t) => t.id === r.vehicle_type_id)?.label ?? '?'} <span className="muted">(cần hạng {r.need})</span>
            {r.reason && ` – ${r.reason}`}
          </li>
        ))}
      </ul>
      <p className="muted small">Hạng cần theo số chỗ trên giấy kiểm định (đã trừ chỗ người lái); quy đổi GPLX cấp trước 2025: cần xác minh.</p>
    </>
  );
}

/* ------------------------------------------------------------------ Lý lịch hành nghề */

const KIND_OF: Record<string, RecordKind> = {
  ll_suc_khoe: 'suc_khoe', ll_vi_pham: 'vi_pham', ll_tai_nan: 'tai_nan', ll_khen_thuong: 'khen_thuong', ll_ky_luat: 'ky_luat', ll_dao_tao: 'dao_tao',
};
const defOfKind = (k: RecordKind) => RECORD_DOCS.find((d) => KIND_OF[d.code] === k)!;

function recordValues(def: DocTypeDef, r: StaffRecord): Values {
  const v: Values = {};
  for (const x of def.fields) {
    const raw = x.key === 'ngay' ? r.occurred_on : x.key === 'so_giay' ? r.doc_no : x.key === 'noi_dung' ? r.title
      : x.key === 'xe.bien_so' ? r.data?.bien_so : r.data?.[x.key];
    v[x.key] = raw == null ? '' : String(raw);
  }
  return v;
}

function Records(props: Common & { s: Staff }) {
  const { s, records, canEdit, tenantId, reload } = props;
  const toast = useToast();
  const [filter, setFilter] = useState<RecordKind | ''>('');
  const [form, setForm] = useState<{ id: string | null; code: string; values: Values; scanned: Scanned | null; req: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = records.filter((r) => r.staff_id === s.id);
  const shown = mine.filter((r) => !filter || r.kind === filter);

  async function save() {
    if (!form) return;
    const def = docTypeOf(form.code)!;
    const v = form.values;
    if (!v.ngay) return toast('error', 'Nhập ngày');
    if (!(v.noi_dung ?? '').trim()) return toast('error', `Nhập ${def.fields.find((x) => x.key === 'noi_dung')?.label.toLowerCase()}`);
    setBusy(true);
    try {
      const data: Record<string, FieldValue> = {};
      for (const x of def.fields) {
        if (['ngay', 'so_giay', 'noi_dung', 'xe.bien_so'].includes(x.key)) continue;
        const t = (v[x.key] ?? '').trim();
        data[x.key] = t === '' ? null : x.kind === 'int' || x.kind === 'money' ? Number(t.replace(/[^0-9]/g, '')) : t;
      }
      const paths = !form.id && form.scanned?.files.length
        ? await uploadFiles(tenantId, 'nhan_su', s.id, s.full_name, form.code, form.scanned.files) : [];
      await rpc('save_staff_record', {
        p_id: form.id, p_staff_id: s.id, p_kind: KIND_OF[form.code], p_occurred_on: v.ngay, p_doc_no: v.so_giay || null,
        p_title: v.noi_dung, p_plate: v['xe.bien_so'] || null, p_data: data, p_files: paths, p_request_id: form.req,
      });
      toast('ok', `Đã lưu lý lịch: ${def.name}`);
      setForm(null);
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const def = form ? docTypeOf(form.code)! : null;
  return (
    <>
      <div className="item-head">
        <h3>Lý lịch hành nghề ({mine.length})</h3>
        {canEdit && !form && (
          <button className="btn small" onClick={() => setForm({ id: null, code: 'll_vi_pham', values: {}, scanned: null, req: crypto.randomUUID() })}>
            Thêm vào lý lịch
          </button>
        )}
      </div>
      {s.position === 'lai_xe' && <PaperActions kind="driver" id={s.id} label={s.full_name} tenantId={tenantId} me={props.me} canSave={props.canArchive} />}
      {form && def && (
        <div className="sub form">
          {!form.id && (
            <select aria-label="Mục lý lịch" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value, values: {}, scanned: null })}>
              {RECORD_DOCS.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
            </select>
          )}
          {!form.id && (
            <Scanner key={form.code} def={def} onScanned={(sc) => {
              if (sc.files.length === 0) return toast('error', sc.aiNote);
              const values = { ...form.values };
              for (const [k, v] of Object.entries(sc.values)) if (v) values[k] = v;
              setForm({ ...form, values, scanned: sc });
            }} />
          )}
          {!form.id && <p className="muted small">{form.scanned ? `${form.scanned.aiNote} · ${form.scanned.files.length} tệp` : 'Có biên bản / quyết định thì tải lên để AI đọc; không có thì nhập tay.'}</p>}
          <FilePreviews files={form.id ? records.find((r) => r.id === form.id)?.files ?? [] : []} blobs={form.scanned?.files.map((f) => f.blob) ?? []} />
          {form.scanned && form.scanned.warnings.length > 0 && <ul className="warn small">{form.scanned.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <DocFields def={def} values={form.values} onChange={(values) => setForm({ ...form, values })} />
          <div className="actions">
            <button type="button" className="btn small primary" disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu lý lịch'}</button>
            <button type="button" className="btn small link" onClick={() => setForm(null)}>Hủy</button>
          </div>
        </div>
      )}
      {mine.length > 0 && (
        <div className="chips" role="group" aria-label="Lọc lý lịch">
          <button type="button" className={filter === '' ? 'btn small primary' : 'btn small'} onClick={() => setFilter('')}>Tất cả</button>
          {RECORD_DOCS.map((d) => {
            const k = KIND_OF[d.code];
            const n = mine.filter((r) => r.kind === k).length;
            return n > 0 && (
              <button key={d.code} type="button" className={filter === k ? 'btn small primary' : 'btn small'} onClick={() => setFilter(k)}>
                {d.name} ({n})
              </button>
            );
          })}
        </div>
      )}
      <ul className="list small">
        {shown.map((r) => {
          const d = defOfKind(r.kind);
          return (
            <li key={r.id} className="item">
              <div className="item-head">
                <div>
                  <b>{fmtDate(r.occurred_on)} · {d.name}</b>{r.doc_no ? ` · Số ${r.doc_no}` : ''}
                  <div>{r.title}{r.data?.bien_so ? ` · xe ${r.data.bien_so}` : ''}
                    {r.data?.hinh_thuc ? ` · ${r.data.hinh_thuc}` : ''}
                    {typeof r.data?.so_tien === 'number' ? ` · ${r.data.so_tien.toLocaleString('vi-VN')} đ` : ''}</div>
                </div>
                <div className="actions">
                  <FilesButton files={r.files} />
                  {canEdit && <button className="btn small" onClick={() => setForm({ id: r.id, code: d.code, values: recordValues(d, r), scanned: null, req: crypto.randomUUID() })}>Sửa</button>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/* ------------------------------------------------------------------ Cảnh báo */

function problems(s: Staff, p: StaffPrivate | undefined, docs: Doc[], warnDays: number): { text: string; state: DocState }[] {
  const out: { text: string; state: DocState }[] = [];
  if (!s.is_active) return out;
  for (const def of STAFF_DOCS) {
    const req = REQUIRED[s.position].includes(def.code);
    const st = docState(def, docs.find((d) => d.staff_id === s.id && d.doc_type === def.code && d.is_current), warnDays, req);
    if (st.state === 'het_han' || st.state === 'sap_het' || (st.state === 'thieu' && req)) out.push({ text: `${SHORT[def.code]}: ${st.text}`, state: st.state });
  }
  const age = ageCheck(p, s.position);
  if (age) out.push({ text: age.text, state: age.state });
  return out;
}

/** Cảnh báo dạng chuông: số việc cần xử lý; bấm mở danh sách gộp theo từng người, bấm tên mở hồ sơ. */
function StaffAlerts(props: { staff: Staff[]; priv: StaffPrivate[]; docs: Doc[]; warnDays: number; avas: Record<string, string>; onOpen: (id: string) => void }) {
  const { staff, priv, docs, warnDays, avas, onOpen } = props;
  const [show, setShow] = useState(false);
  const order: Record<DocState, number> = { het_han: 0, sap_het: 1, thieu: 2, con_han: 3, co: 4 };
  const people = staff.map((s) => ({ s, items: problems(s, priv.find((x) => x.staff_id === s.id), docs, warnDays).sort((a, b) => order[a.state] - order[b.state]) }))
    .filter((x) => x.items.length > 0)
    .sort((a, b) => order[a.items[0]!.state] - order[b.items[0]!.state] || b.items.length - a.items.length || a.s.full_name.localeCompare(b.s.full_name, 'vi'));
  const total = people.reduce((n, x) => n + x.items.length, 0);
  const urgent = people.some((x) => x.items[0]!.state === 'het_han');
  return (
    <>
      <button type="button" className={`bell${total ? ' has' : ''}${urgent ? ' urgent' : ''}`} onClick={() => setShow(true)} disabled={!total}
              aria-label={total ? `Cảnh báo: ${total} việc cần xử lý của ${people.length} người` : 'Không có cảnh báo'} title={total ? `${total} việc cần xử lý` : 'Không có cảnh báo'}>
        <span aria-hidden="true">🔔</span>
        {total > 0 && <b className="bell-n">{total > 99 ? '99+' : total}</b>}
      </button>
      {show && (
        <Modal wide title={`Cảnh báo lái xe & nhân viên · ${people.length} người`} onClose={() => setShow(false)}>
          <ul className="alert-people">
            {people.map(({ s, items }) => (
              <li key={s.id}>
                <button type="button" className="ap-head" onClick={() => { setShow(false); onOpen(s.id); }} aria-label={`Mở hồ sơ ${s.full_name}`}>
                  <Avatar name={s.full_name} url={avas[s.id]} size={36} />
                  <span className="ap-name"><b>{s.full_name}</b><small className="muted">{jobLabel(s)}</small></span>
                  <span className={`badge ${items.some((x) => x.state === 'het_han') ? 'locked' : 'warn-badge'}`}>{items.length}</span>
                </button>
                <div className="ap-items">
                  {items.map((r, i) => <span key={i} className={`ap-chip state-${r.state}`}>{r.text}</span>)}
                </div>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}
