import { mergeRecordPapers, RECORD_OF, recordExpiry } from '../lib/recordPapers';
import { Modal } from '../components/Modal';
import { StaffSignature } from '../components/StaffSignature';
import { Avatar, StaffAvatar, useAvatars } from '../components/StaffAvatar';
import { BulkPaperSave, PaperActions, PaperView, type Me } from '../components/ProfilePapers';
import { staffCvPages } from '../lib/staffCv';
import { profileChanged } from '../lib/profileAutoArchive';
import { rankOf, StaffCards, StaffDashboard, StaffOrg, StaffReport, useOrgCfg } from '../components/StaffOverview';
import { LeaveOfStaff, LeavePage } from '../components/StaffLeave';
import { downloadXlsx, type XCell } from '../lib/xlsxWrite';
import { readSheet, type Cell } from '../lib/sheetRead';
import type { Page } from '../lib/profilePapers';
import { StaffContracts } from '../components/StaffContracts';
import { FilePreviews } from '../components/FilePreview';
import { DeleteButton } from '../components/DeleteButton';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  DeleteDupButton, DOC_COLS, DocFields, DocRow, docState, FilesButton, isDupDoc, paperNo, fmtDate, OldDocs, Scanner, SHORT, today, toRpc, type Doc, type DocState, type Scanned,
  type Values, valuesFromDoc,
} from '../components/Documents';
import { DOC_TYPES, docTypeOf, type DocTypeDef } from '../lib/docTypes';
import type { FieldValue } from '../lib/documents';
import { prepareFile, uploadFiles } from '../lib/documents';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { cachedRows } from '../lib/rowCache';

type Position = 'lai_xe' | 'phu_xe' | 'nhan_vien';
type Gender = 'nam' | 'nu';
type Contract = 'khong_xac_dinh' | 'xac_dinh' | 'thu_viec' | 'thoi_vu' | 'khoan_viec' | 'khac';

interface Staff {
  id: string; user_id: string | null; full_name: string; position: Position; phone: string | null; branch_id: string | null;
  joined_on: string; left_on: string | null; is_active: boolean; job_title: string | null; department: string | null;
}
interface StaffPrivate { staff_id: string; birth_date: string | null; gender: Gender | null; address: string | null; current_address: string | null; hometown: string | null; contract_type: Contract | null; note: string | null; bhxh_no: string | null; bank_account: string | null }
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
/** Chức vụ trùng tên nhóm (vd "Lái Xe" – nhóm Lái xe): không hiện tên nhóm lần nữa */
const sameAsGroup = (s: { job_title: string | null; position: Position }) => jobKey(s) === POSITION[s.position].toLocaleLowerCase('vi');
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
  const [mod, setMod] = useState<'hs' | 'tq' | 'sd' | 'np' | 'the' | 'bc'>('hs');   // tab của module
  const canEdit = perms.has('staff.manage');
  const canView = perms.has('staff.view_all');   // không có: chỉ thấy hồ sơ của chính mình

  const load = useCallback(async () => {
    const [s, p, d, u, b, w, r, vt, lm] = await Promise.all([
      supabase.from('staff_members').select('id, user_id, full_name, position, phone, branch_id, joined_on, left_on, is_active, job_title, department').order('full_name'),
      supabase.from('staff_private').select('staff_id, birth_date, gender, address, current_address, hometown, contract_type, note, bhxh_no, bank_account'),
      cachedRows(`${ctx.tenant_id}:${ctx.user_id}:giay_to_nv`, 'documents', DOC_COLS, (q) => q.eq('owner_kind', 'nhan_su')),
      supabase.from('app_users').select('id, full_name, phone').order('full_name'),
      supabase.from('branches').select('id, name').order('name'),
      supabase.from('tenant_settings').select('value').eq('key', 'giay_to.canh_bao_truoc_ngay').maybeSingle(),
      cachedRows(`${ctx.tenant_id}:${ctx.user_id}:ly_lich`, 'staff_records', 'id, staff_id, kind, occurred_on, doc_no, title, vehicle_id, data, files', undefined, (q) => q.order('occurred_on', { ascending: false })),
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
  }, [toast, canView, ctx.user_id, ctx.tenant_id]);

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
  // sửa xong (hồ sơ, giấy tờ, lý lịch, hợp đồng…) → báo để Lưu trữ hồ sơ tự cập nhật bản PDF
  const reload = useCallback(async () => { await load(); profileChanged(); }, [load]);
  const common = { tenantId, priv, docs, papers, users, branches, warnDays, canEdit, records, types, licenses, reload, canArchive, me, labor: { view: perms.has('labor.view'), add: perms.has('labor.add'), edit: perms.has('labor.edit') },
    leave: { add: perms.has('leave.add'), edit: perms.has('leave.edit'), viewAll: perms.has('leave.view_all') }, myUserId: ctx.user_id };
  const avas = useAvatars(tenantId || null);
  const shown = staff.filter((s) => showLeft || s.is_active);
  const tabs = jobTabs(shown);
  const cur = tabs.some((t) => t.key === tab) ? tab : '';
  // Chip đang chọn luôn nằm trong tầm nhìn (chỉ cuộn ngang hàng chip, không cuộn trang)
  const chipsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = chipsRef.current;
    const on = box?.querySelector<HTMLElement>('button.on');
    if (!box || !on) return;
    if (on.offsetLeft < box.scrollLeft || on.offsetLeft + on.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = on.offsetLeft - 8;
  }, [cur]);
  // Từ Tổng quan / Sơ đồ: bấm 1 người → về tab Hồ sơ, mở hồ sơ (chỉ người được mở: quản lý nhân sự hoặc chính mình)
  const openFromTab = (id: string) => {
    const x = staff.find((y) => y.id === id);
    if (!x || !(canEdit || x.user_id === ctx.user_id)) return;
    setMod('hs'); setTab(''); setOpen(id);
  };
  const MODS: { k: typeof mod; label: string; show: boolean }[] = [
    { k: 'hs', label: 'Hồ sơ', show: true }, { k: 'tq', label: 'Tổng quan', show: true }, { k: 'sd', label: 'Sơ đồ tổ chức', show: true },
    { k: 'np', label: 'Nghỉ phép', show: perms.has('leave.view_all') },
    { k: 'the', label: 'In thẻ', show: canEdit }, { k: 'bc', label: 'Báo cáo nhân sự', show: true },
  ];
  const ov = { staff, priv, avas, onOpen: openFromTab };
  return (
    <>
      {canView && (
        <div className="nsx-mtabs" role="tablist" aria-label="Lái xe & nhân viên">
          {MODS.filter((m) => m.show).map((m) => (
            <button key={m.k} type="button" role="tab" aria-selected={mod === m.k} className={mod === m.k ? 'on' : ''} onClick={() => setMod(m.k)}>{m.label}</button>
          ))}
        </div>
      )}
      {canView && mod === 'tq' && <StaffDashboard {...ov} papers={papers} warnDays={warnDays} branches={branches}
        onAdd={canEdit ? () => { setMod('hs'); setTimeout(() => document.getElementById('nv-moi')?.scrollIntoView({ behavior: 'smooth' }), 80); } : undefined} />}
      {canView && mod === 'sd' && <section className="card"><StaffOrg {...ov} branches={branches} canConfig={perms.has('settings.edit')} /></section>}
      {canView && canEdit && mod === 'the' && <section className="card"><StaffCards {...ov} branches={branches} /></section>}
      {canView && mod === 'bc' && <section className="card"><StaffReport {...ov} /></section>}
      {canView && mod === 'np' && perms.has('leave.view_all') && <LeavePage staff={staff} perms={common.leave} myUserId={ctx.user_id} avas={avas} onOpen={openFromTab} tenantId={tenantId} me={me} />}
      {(!canView || mod === 'hs') && <>
      <div className="staff-top">
        <div className="nsx-chips" role="tablist" aria-label="Lọc theo chức vụ" ref={chipsRef}>
          {/* chỉ xem được hồ sơ của mình (lái xe, nhân viên): 1 thẻ "Thông tin của tôi" */}
          {(canView ? [{ key: '', label: 'Tất cả', n: shown.length }, ...tabs] : [{ key: '', label: 'Thông tin của tôi', n: -1 }]).map((t) => (
            <button key={t.key || '*'} type="button" role="tab" aria-selected={cur === t.key} className={cur === t.key ? 'on' : ''}
                    onClick={() => { setTab(t.key); setOpen(null); }}>
              {t.label}{t.n >= 0 ? ` (${t.n})` : ''}
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
      <StaffList {...common} staff={staff} myUserId={ctx.user_id} open={open} setOpen={setOpen} cur={cur} showLeft={showLeft} setShowLeft={setShowLeft} avas={avas} selfOnly={!canView} />
      {canEdit && <StaffForm key="new" {...common} staff={staff} />}
      </>}
    </>
  );
}

/* ------------------------------------------------------------------ Thêm / sửa hồ sơ */

const EMPTY = {
  full_name: '', job_title: '', department: '', position: 'lai_xe' as Position, phone: '', branch_id: '', joined_on: '', left_on: '', is_active: true,
  user_id: '', birth_date: '', gender: '' as Gender | '', address: '', current_address: '', hometown: '', contract_type: '' as Contract | '', note: '',
  bhxh_no: '', bank_account: '',
};
type Form = typeof EMPTY;

function formOf(s: Staff, p: StaffPrivate | undefined): Form {
  return {
    full_name: s.full_name, job_title: s.job_title ?? '', department: s.department ?? '', position: s.position, phone: s.phone ?? '', branch_id: s.branch_id ?? '', joined_on: s.joined_on,
    left_on: s.left_on ?? '', is_active: s.is_active, user_id: s.user_id ?? '', birth_date: p?.birth_date ?? '',
    gender: p?.gender ?? '', address: p?.address ?? '', current_address: p?.current_address ?? '', hometown: p?.hometown ?? '', contract_type: p?.contract_type ?? '', note: p?.note ?? '',
    bhxh_no: p?.bhxh_no ?? '', bank_account: p?.bank_account ?? '',
  };
}

/** Điền hồ sơ từ CCCD / GPLX đọc được (chỉ ô đọc được). */
function applyToForm(f: Form, v: Values): Form {
  const pick = (k: string) => (v[k] ?? '').trim();
  const next = { ...f };
  if (pick('nv.ho_ten')) next.full_name = pick('nv.ho_ten');
  if (pick('nv.ngay_sinh')) next.birth_date = pick('nv.ngay_sinh');
  if (pick('nv.noi_thuong_tru')) next.address = pick('nv.noi_thuong_tru');
  if (pick('que_quan')) next.hometown = pick('que_quan');
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
  leave: { add: boolean; edit: boolean; viewAll: boolean }; myUserId: string | null;
}

function StaffForm(props: Common & { staff: Staff[]; editing?: Staff; onDone?: () => void }) {
  const { tenantId, users, branches, staff, editing, onDone, reload } = props;
  const toast = useToast();
  const [f, setF] = useState<Form>(() => (editing ? formOf(editing, props.priv.find((p) => p.staff_id === editing.id)) : EMPTY));
  const [scanType, setScanType] = useState('cccd');
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});   // giấy chưa lưu được: lý do theo loại giấy
  const [id, setId] = useState(() => editing?.id ?? crypto.randomUUID());
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const linked = new Set(staff.filter((s) => s.user_id && s.id !== editing?.id).map((s) => s.user_id));
  // Sửa hồ sơ: hiện luôn các trường giấy tờ (CCCD, GPLX, tập huấn nghiệp vụ, khám sức khỏe…) để sửa cùng lúc
  const docDefs = editing ? STAFF_DOCS.filter((d) => !(props.labor.view && d.code === 'hop_dong_ld')) : [];
  const curDoc = (code: string) => (editing ? props.docs.find((d) => d.staff_id === editing.id && d.doc_type === code && d.is_current) : undefined);
  const [docVals0] = useState<Record<string, Values>>(() => Object.fromEntries(docDefs.flatMap((def) => { const d = curDoc(def.code); return d ? [[def.code, valuesFromDoc(def, d)]] : []; })));
  const [docVals, setDocVals] = useState<Record<string, Values>>(docVals0);

  function onScanned(def: DocTypeDef, s: Scanned) {
    if (s.files.length === 0) return toast('error', s.aiNote);
    // giữ thông tin giấy đang có, AI đọc được ô nào thì thay ô đó (ô AI không đọc được không bị xóa trắng); giấy hết hạn không giữ ngày cấp / hết hạn cũ
    const d = curDoc(def.code), expired = !!d?.expires_on && d.expires_on < today();
    const old = d ? valuesFromDoc(def, d) : {};
    const vals: Values = { ...s.values };
    for (const [k, v] of Object.entries(old)) if (v && !(vals[k] ?? '').trim() && !(expired && ['ngay_cap', 'hieu_luc_tu', 'het_han'].includes(k))) vals[k] = v;
    setPending((p) => [...p.filter((x) => x.def.code !== def.code), { key: crypto.randomUUID(), def, scanned: { ...s, values: vals } }]);
    setF((cur) => applyToForm(cur, s.values));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.full_name.trim()) return toast('error', 'Nhập họ tên');
    if (!f.joined_on) return toast('error', 'Nhập ngày vào công ty');
    if (f.phone && !/^0[0-9]{9}$/.test(f.phone.trim())) return toast('error', 'Số điện thoại phải gồm 10 số, bắt đầu bằng 0');
    if (f.left_on && f.joined_on && f.left_on < f.joined_on) return toast('error', 'Ngày nghỉ việc không được trước ngày vào công ty');
    setBusy(true);
    try {
      await rpc('save_staff', { p_id: id, p: { ...f, full_name: f.full_name.trim(), phone: f.phone.trim(), is_active: !f.left_on } });
    } catch (err) {
      setBusy(false);
      return toast('error', errMsg(err));
    }
    let failed = 0;
    const why: Record<string, string> = {};
    for (const def of docDefs) {
      const d = curDoc(def.code);
      const v = docVals[def.code];
      if (!d || !v || JSON.stringify(v) === JSON.stringify(docVals0[def.code])) continue;
      if (pending.some((x) => x.def.code === def.code)) continue;   // đã chọn ảnh giấy mới: lưu thành giấy mới bên dưới
      try {
        const r = toRpc(def, v);
        await rpc('update_document', { p_id: d.id, p_doc_no: r.p_doc_no, p_issuer: r.p_issuer, p_issued_on: r.p_issued_on,
                                       p_valid_from: r.p_valid_from, p_expires_on: r.p_expires_on, p_data: r.p_data, p_note: d.note });
      } catch (err) {
        failed++;
        why[def.code] = errMsg(err);
      }
    }
    const left: Pending[] = [];
    for (const p of pending) {
      try {
        const paths = await uploadFiles(tenantId, 'nhan_su', id, f.full_name, p.def.code, p.scanned.files);
        await rpc('add_staff_document', { p_staff_id: id, p_doc_type: p.def.code, ...toRpc(p.def, p.scanned.values),
                                          p_files: paths, p_note: null, p_request_id: p.key });
      } catch (err) {
        failed++;
        why[p.def.code] = errMsg(err);
        left.push(p);
      }
    }
    setBusy(false);
    setErrs(why);
    setPending(left);
    const name = f.full_name.trim();
    await reload();
    // Giấy lỗi: giữ nguyên form và ảnh đã đọc để sửa ô báo đỏ rồi bấm Lưu lại (không phải chụp, đọc lại)
    if (failed) return toast('error', `Đã lưu ${name}, còn ${failed} giấy tờ chưa lưu được – sửa ô báo đỏ rồi bấm Lưu lại`);
    toast('ok', editing ? `Đã lưu hồ sơ ${name}` : `Đã thêm ${name}`);
    if (editing) onDone?.();
    else {
      setF(EMPTY);
      setPending([]);
      setId(crypto.randomUUID());
    }
  }

  const scanDef = docTypeOf(scanType)!;
  const Wrap = editing ? 'div' : 'section';

  return (
    <Wrap className={editing ? 'form' : 'card form'} id={editing ? undefined : 'nv-moi'}>
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
                <button type="button" className="nsx-x" aria-label={`Chọn lại ảnh ${SHORT[p.def.code] ?? p.def.name}`} title="Bỏ ảnh này, chọn ảnh khác" onClick={() => setPending(pending.filter((x) => x !== p))}>✕</button>
              </div>
              <p className="muted small">{p.scanned.aiNote} · {p.scanned.files.length} tệp</p>
              {errs[p.def.code] && <p className="nsx-err">Chưa lưu được: {errs[p.def.code]}</p>}
              {p.scanned.warnings.length > 0 && <ul className="warn small">{p.scanned.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
              <DocFields ai def={p.def} values={p.scanned.values}
                         onChange={(v) => setPending(pending.map((x) => (x === p ? { ...x, scanned: { ...x.scanned, values: v } } : x)))} />
            </div>
          ))}
        </div>
      )}
      <form className="form" onSubmit={submit}>
        <div className="grid2">
          <label>Họ tên<input value={f.full_name} onChange={set('full_name')} required /></label>
          <ChipInput label="Chức vụ" value={f.job_title} onChange={(v) => setF((cur) => ({ ...cur, job_title: v }))} placeholder="vd: Giám đốc, Kế toán, Điều hành, Lái xe"
                     options={[...props.staff.map((x) => x.job_title ?? ''), 'Giám đốc', 'Phó giám đốc', 'Kế toán', 'Điều hành', 'Người điều hành vận tải', 'Bán vé', 'Lái xe', 'Phụ xe', 'Bảo vệ', 'Tạp vụ']} />
          <ChipInput label="Phòng ban" value={f.department} onChange={(v) => setF((cur) => ({ ...cur, department: v }))} placeholder="vd: Văn phòng, Điều hành, Lái xe"
                     options={props.staff.map((x) => x.department ?? '')} />
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
          <label>Quê quán<input value={f.hometown} onChange={set('hometown')} maxLength={300} /></label>
          <label>Nơi thường trú<input value={f.address} onChange={set('address')} /></label>
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
          <label>Số sổ BHXH<input value={f.bhxh_no} onChange={set('bhxh_no')} maxLength={20} inputMode="numeric" /></label>
          <label>Tài khoản ngân hàng<input value={f.bank_account} onChange={set('bank_account')} maxLength={120} placeholder="Ngân hàng - số tài khoản" /></label>
          <label>Ghi chú<input value={f.note} onChange={set('note')} /></label>
        </div>
        {docDefs.map((def) => {
          const d = curDoc(def.code);
          const pd = pending.find((x) => x.def.code === def.code);
          const expired = !!d?.expires_on && d.expires_on < today();
          return (
            <fieldset key={def.code} className="sub">
              <legend><b>{def.name}</b></legend>
              {errs[def.code] && <p className="nsx-err">Chưa lưu được: {errs[def.code]}</p>}
              {expired && !pd && <p className="nsx-expired">Đã hết hạn {fmtDate(d!.expires_on)}. Tải ảnh giấy mới bên dưới; lưu xong giấy cũ tự chuyển vào mục giấy cũ.</p>}
              {pd ? null : (
                <div className="inline-form">
                  {d && d.files.length > 0 && <FilesButton files={d.files} />}
                  <span className="small muted">{d ? (expired ? 'Tải ảnh giấy mới:' : 'Tải ảnh mới (thay giấy đang dùng):') : 'Tải ảnh giấy tờ:'}</span>
                </div>
              )}
              {!pd && <Scanner def={def} onScanned={(sc) => onScanned(def, sc)} />}
              {d && !pd && !expired ? <DocFields def={def} values={docVals[def.code] ?? {}} onChange={(v) => setDocVals({ ...docVals, [def.code]: v })} />
                : pd ? (
                  <>
                    <p className="muted small nsx-scanline">{pd.scanned.aiNote} · {pd.scanned.files.length} tệp
                      <button type="button" className="nsx-x" aria-label={`Chọn lại ảnh ${SHORT[def.code] ?? def.name}`} title="Bỏ ảnh này, chọn ảnh khác" onClick={() => setPending(pending.filter((x) => x !== pd))}>✕</button></p>
                    <DocFields ai def={def} values={pd.scanned.values}
                               onChange={(v) => setPending(pending.map((x) => (x === pd ? { ...x, scanned: { ...x.scanned, values: v } } : x)))} />
                  </>
                ) : null}
            </fieldset>
          );
        })}
        <div className="actions">
          <button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : editing ? 'Lưu hồ sơ' : 'Lưu nhân viên'}</button>
          {editing && <button type="button" className="btn link" onClick={onDone}>Hủy</button>}
        </div>
      </form>
    </Wrap>
  );
}

/** Ô gõ tự do + hàng chip chọn nhanh (thay danh sách gợi ý của trình duyệt: trên điện thoại chỉ hiện mục trùng chữ đang gõ, khó chọn) */
function ChipInput({ label, value, onChange, options, placeholder }: { label: string; value: string; onChange: (v: string) => void; options: string[]; placeholder?: string }) {
  const seen = new Set<string>();
  const opts = options.map((x) => x.trim()).filter((x) => { const k = x.toLocaleLowerCase('vi'); if (!x || seen.has(k)) return false; seen.add(k); return true; });
  const cur = value.trim().toLocaleLowerCase('vi');
  return (
    <div className="nsx-ci">
      <label>{label}<input value={value} onChange={(e) => onChange(e.target.value)} maxLength={80} placeholder={placeholder} autoComplete="off" /></label>
      {opts.length > 0 && (
        <div className="nsx-ci-chips" role="group" aria-label={`Chọn nhanh ${label.toLowerCase()}`}>
          {opts.map((o) => (
            <button key={o} type="button" className={o.toLocaleLowerCase('vi') === cur ? 'on' : ''} aria-pressed={o.toLocaleLowerCase('vi') === cur} aria-label={`${label}: ${o}`} onClick={() => onChange(o)}>{o}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Danh sách */

/** Bỏ dấu, chữ thường: tìm "nguyen van" ra "Nguyễn Văn" */
const fold = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();

function StaffList(props: Common & { staff: Staff[]; myUserId: string | null; open: string | null; setOpen: (id: string | null) => void;
  cur: string; showLeft: boolean; setShowLeft: (v: boolean) => void; avas: Record<string, string>; selfOnly?: boolean }) {
  const { staff, priv, papers, warnDays, canEdit, myUserId, open, setOpen, branches, cur, showLeft, setShowLeft, avas } = props;
  const [q, setQ] = useState('');
  const [view, setView] = useState<'the' | 'bang'>(() => { try { return localStorage.getItem('nsx-view') === 'bang' ? 'bang' : 'the'; } catch { return 'the'; } });
  const [viewOnly, setViewOnly] = useState(false);   // mở bằng "Xem hồ sơ": chỉ xem, không vào sửa
  const pickView = (v: 'the' | 'bang') => { setView(v); try { localStorage.setItem('nsx-view', v); } catch { /* bỏ qua */ } };
  const left = staff.filter((s) => !s.is_active).length;
  const active = staff.filter((s) => s.is_active);
  const trial = active.filter((s) => priv.find((x) => x.staff_id === s.id)?.contract_type === 'thu_viec').length;

  const shown = staff.filter((s) => showLeft || s.is_active);
  const words = fold(q.trim()).split(/\s+/).filter(Boolean);
  // Thứ tự chức vụ từ lớn đến nhỏ (theo sơ đồ tổ chức đã chọn), người đã nghỉ sau cùng
  const [orgCfg] = useOrgCfg();
  const rank = useMemo(() => rankOf(staff, orgCfg, branches), [staff, orgCfg, branches]);
  const rk = (s: Staff) => rank.get(s.id) ?? 1e6;
  const list = shown.filter((s) => !cur || jobKey(s) === cur).sort((a, b) => Number(!a.is_active) - Number(!b.is_active) || rk(a) - rk(b) || a.full_name.localeCompare(b.full_name, 'vi')).filter((s) => {
    if (!words.length) return true;
    const text = fold([s.full_name, s.phone ?? '', jobLabel(s), s.department ?? ''].join(' '));
    return words.every((w) => text.includes(w));
  });
  const openOne = (id: string, onlyView: boolean) => { setViewOnly(onlyView); setOpen(id); };
  const [imp, setImp] = useState(false);
  const [norm, setNorm] = useState(false);
  // Lương cơ bản theo hợp đồng lao động đang hiệu lực (không có quyền xem thì database không trả → thẻ hiện Ngày vào làm)
  const [salary, setSalary] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (props.selfOnly) return;
    let live = true;
    void supabase.from('labor_contracts').select('staff_id, salary, start_on').eq('status', 'hieu_luc').lte('start_on', today()).order('start_on')
      .then(({ data }) => { if (!live) return; const m = new Map<string, number>(); for (const c of (data ?? []) as { staff_id: string; salary: number | null }[]) if (c.salary) m.set(c.staff_id, Number(c.salary)); setSalary(m); });
    return () => { live = false; };
  }, [props.selfOnly]);
  /** Xuất danh sách đang xem (đã lọc chức vụ / tìm kiếm). Số CCCD, địa chỉ chỉ có khi người xuất quản lý nhân sự. */
  function exportXlsx() {
    const exp = (sid: string, code: string) => papers.find((d) => d.staff_id === sid && d.doc_type === code && d.is_current);
    const dd = (x: string | null | undefined) => (x ? fmtDate(x) : '');
    const head = ['Họ và tên', 'Chức vụ', 'Nhóm', 'Bộ phận', 'Điện thoại', 'Ngày sinh', 'Giới tính', 'Ngày vào công ty', 'Thâm niên', 'Ngày nghỉ việc',
      'Hạng GPLX', 'GPLX hết hạn', 'Khám sức khỏe hết hạn', 'Tập huấn hết hạn', ...(canEdit ? ['Số CCCD', 'Quê quán', 'Nơi thường trú', 'Loại hợp đồng', 'Số sổ BHXH', 'Tài khoản ngân hàng'] : [])];
    const rows: XCell[][] = list.map((s) => {
      const p = priv.find((x) => x.staff_id === s.id);
      const g = exp(s.id, 'gplx');
      return [s.full_name, jobLabel(s), POSITION[s.position], s.department ?? '', s.phone ?? '', dd(p?.birth_date), p?.gender === 'nam' ? 'Nam' : p?.gender === 'nu' ? 'Nữ' : '',
        dd(s.joined_on), seniority(s.joined_on, s.left_on), dd(s.left_on), g?.data?.hang ? String(g.data.hang) : '', dd(g?.expires_on),
        dd(exp(s.id, 'kham_suc_khoe')?.expires_on), dd(exp(s.id, 'tap_huan')?.expires_on),
        ...(canEdit ? [exp(s.id, 'cccd')?.doc_no ?? '', p?.hometown ?? '', p?.address ?? '', p?.contract_type ? CONTRACT[p.contract_type] : '', p?.bhxh_no ?? '', p?.bank_account ?? ''] : [])];
    });
    downloadXlsx(`Lai xe va nhan vien ${today()}`, 'Lái xe & nhân viên', head, rows, [24, 18, 11, 16, 13, 12, 9, 13, 14, 12, 9, 13, 13, 13, 15, 36, 36, 20]);
  }
  const cur1 = open ? staff.find((x) => x.id === open) : undefined;
  const canOpenCur = cur1 && (canEdit || cur1.user_id === myUserId);
  const info = (s: Staff) => {
    const p = priv.find((x) => x.staff_id === s.id);
    const gplx = papers.find((d) => d.staff_id === s.id && d.doc_type === 'gplx' && d.is_current);
    const bad = canEdit ? problems(s, p, papers, warnDays).length : 0;
    return { p, gplx, bad, mine: s.user_id === myUserId, canOpen: canEdit || s.user_id === myUserId };
  };
  const call = (s: Staff) => s.phone
    ? <a className="btn small nsx-call" href={`tel:${s.phone}`} aria-label={`Gọi ${s.full_name} ${s.phone}`}>📞 Gọi <span className="nsx-num">{s.phone}</span></a>
    : null;
  const acts = (s: Staff, canOpen: boolean) => canOpen && (
    <div className="nsx-acts">
      <button type="button" className="btn small" aria-label={`Xem hồ sơ ${s.full_name}`} onClick={() => openOne(s.id, true)}>Xem hồ sơ</button>
      {canEdit && <button type="button" className="btn small primary" aria-label={`Sửa ${s.full_name}`} onClick={() => openOne(s.id, false)}>Sửa</button>}
    </div>
  );
  return (
    <section className="card">
      <div className="item-head">
        <h2>{props.selfOnly ? 'Thông tin của tôi' : `Lái xe & nhân viên (${active.length})`}</h2>
        {left > 0 && (
          <button className="btn small" onClick={() => setShowLeft(!showLeft)}>
            {showLeft ? 'Ẩn người đã nghỉ' : `Hiện người đã nghỉ (${left})`}
          </button>
        )}
        {!props.selfOnly && (
          <div className="nsx-xl">
            {list.length > 0 && <button type="button" className="btn small" onClick={exportXlsx}>⬇ Xuất Excel</button>}
            {canEdit && <button type="button" className="btn small" onClick={() => setImp(true)}>⬆ Nhập Excel</button>}
            {canEdit && <button type="button" className="btn small" onClick={() => setNorm(true)}>Aa Chuẩn hóa chức vụ</button>}
          </div>
        )}
      </div>
      {imp && <StaffImport staff={staff} priv={priv} onClose={() => setImp(false)} reload={props.reload} />}
      {norm && <NormalizeJobs staff={staff} priv={priv} onClose={() => setNorm(false)} reload={props.reload} />}
      {staff.length === 0 && <p className="muted">Chưa có lái xe / nhân viên.</p>}
      {/* chỉ có hồ sơ của mình: hiện thẳng hồ sơ dạng thẻ, không cần bấm mở */}
      {props.selfOnly && shown.length === 1 && shown[0]!.user_id === myUserId ? (
        <StaffDetail {...props} s={shown[0]!} p={priv.find((x) => x.staff_id === shown[0]!.id)} mine />
      ) : (
      <>
      {staff.length > 0 && (
        <div className="nsx-bar">
          <div className="nsx-stats">
            <span className="nsx-stat"><b>{active.length}</b> đang làm</span>
            {canEdit && <span className="nsx-stat"><b>{trial}</b> thử việc</span>}
            {left > 0 && (
              <button type="button" className={`nsx-stat${showLeft ? ' on' : ''}`} aria-pressed={showLeft} onClick={() => setShowLeft(!showLeft)}><b>{left}</b> đã nghỉ</button>
            )}
          </div>
          <div className="nsx-tools">
            <input className="nsx-search" type="search" value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="Tìm tên, điện thoại, chức vụ…" aria-label="Tìm lái xe, nhân viên" />
            <div className="nsx-seg" role="group" aria-label="Kiểu xem">
              <button type="button" className={view === 'the' ? 'on' : ''} aria-pressed={view === 'the'} onClick={() => pickView('the')}>Thẻ</button>
              <button type="button" className={view === 'bang' ? 'on' : ''} aria-pressed={view === 'bang'} onClick={() => pickView('bang')}>Bảng</button>
            </div>
          </div>
        </div>
      )}
      {staff.length > 0 && list.length === 0 && <p className="muted">Không tìm thấy ai phù hợp.</p>}
      {view === 'the' ? (
      <div className="nsx-emps">
        {list.map((s) => {
          const { p, gplx, bad, mine, canOpen } = info(s);
          const pay = salary.get(s.id);
          return (
            <div key={s.id} id={`nv-${s.id}`} className={`nsx-emp pos-${s.position}${s.is_active ? '' : ' off'}${canOpen ? ' can' : ''}`}
                 onClick={canOpen ? () => openOne(s.id, true) : undefined}>
              <span className="nsx-emp-cov">
                {!sameAsGroup(s) && <span className="nsx-emp-pos">{POSITION[s.position]}</span>}
                {bad > 0 && <span className="nsx-emp-warn" title={`${bad} việc cần xử lý`} aria-hidden="true">⚠</span>}
              </span>
              <span className="nsx-emp-ph"><Avatar name={s.full_name} url={avas[s.id]} size={112} /></span>
              {canOpen
                ? <button type="button" className="nsx-emp-nm" aria-label={`Xem hồ sơ ${s.full_name}`} onClick={(e) => { e.stopPropagation(); openOne(s.id, true); }}>{s.full_name}</button>
                : <b className="nsx-emp-nm">{s.full_name}</b>}
              <span className="nsx-emp-rl">{jobLabel(s)}</span>
              <span className="nsx-emp-tags">
                {s.department?.trim() && s.department.trim().toLocaleLowerCase('vi') !== jobKey(s) && <span className="nsx-dtag">{s.department}</span>}
                {s.is_active ? <span className="nsx-stag ok">Đang làm</span> : <span className="nsx-stag off">Đã nghỉ {s.left_on ? fmtDate(s.left_on) : ''}</span>}
                {mine && <span className="nsx-stag">Tôi</span>}
                {bad > 0 && <span className="nsx-stag warn">{bad} việc cần xử lý</span>}
              </span>
              <span className="nsx-emp-ct">
                {p?.birth_date && <span>📅 {fmtDate(p.birth_date)}</span>}
                {s.phone && <a href={`tel:${s.phone}`} aria-label={`Gọi ${s.full_name} ${s.phone}`} onClick={(e) => e.stopPropagation()}>{s.phone}</a>}
                {s.position === 'lai_xe' && <span>GPLX: {gplx?.data?.hang ? `hạng ${gplx.data.hang}` : 'Chưa có'}</span>}
                {s.branch_id && <span>{branches.find((b) => b.id === s.branch_id)?.label ?? ''}</span>}
              </span>
              <span className="nsx-emp-ft">
                <span><small>Thâm niên</small>{seniority(s.joined_on, s.left_on)}</span>
                {pay ? <span><small>Lương cơ bản</small>{pay >= 1e6 ? `${(pay / 1e6).toFixed(1).replace('.', ',')} tr` : pay.toLocaleString('vi-VN')}</span>
                  : <span><small>Ngày vào làm</small>{fmtDate(s.joined_on)}</span>}
              </span>
            </div>
          );
        })}
      </div>
      ) : (
      <div className="nsx-tblw">
        <table className="nsx-tbl">
          <thead><tr><th>Họ tên</th><th>Bộ phận</th><th>Điện thoại</th><th>GPLX</th><th>Vào làm</th><th>Tình trạng</th><th /></tr></thead>
          <tbody>
            {list.map((s) => {
              const { gplx, bad, mine, canOpen } = info(s);
              return (
                <tr key={s.id} id={`nv-${s.id}`} className={`pos-${s.position}${s.is_active ? '' : ' off'}`}>
                  <td><div className="nsx-who"><Avatar name={s.full_name} url={avas[s.id]} size={36} /><div><b>{s.full_name}</b><span className="sc-job">{jobLabel(s)}</span></div></div></td>
                  <td>{s.department ?? ''}</td>
                  <td>{call(s)}</td>
                  <td>{s.position === 'lai_xe' ? (gplx?.data?.hang ? `Hạng ${gplx.data.hang}` : 'Chưa có') : ''}</td>
                  <td className="nsx-nw">{fmtDate(s.joined_on)}<br /><span className="muted small">{seniority(s.joined_on, s.left_on)}</span></td>
                  <td>
                    <div className="sc-badges">
                      {!s.is_active && <span className="badge locked">Đã nghỉ {s.left_on ? fmtDate(s.left_on) : ''}</span>}
                      {mine && <span className="badge">Tôi</span>}
                      {bad > 0 && <span className="badge warn-badge">{bad} việc cần xử lý</span>}
                    </div>
                  </td>
                  <td>{acts(s, canOpen)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
      {cur1 && canOpenCur && (
        <Modal wide title={`Hồ sơ ${cur1.full_name}`} onClose={() => { setOpen(null); setViewOnly(false); }}>
          <StaffDetail key={`${cur1.id}:${viewOnly}`} {...props} s={cur1} p={priv.find((x) => x.staff_id === cur1.id)} mine={cur1.user_id === myUserId} startEdit={!viewOnly} />
        </Modal>
      )}
      </>
      )}
    </section>
  );
}

function StaffDetail(props: Common & { staff: Staff[]; s: Staff; p: StaffPrivate | undefined; mine: boolean; startEdit?: boolean; avas?: Record<string, string> }) {
  const { s, p, docs, tenantId, warnDays, canEdit, reload } = props;
  // Bấm "Sửa" là vào sửa luôn toàn bộ hồ sơ (vẫn chuyển được sang tab Giấy tờ / Lý lịch)
  const [editing, setEditing] = useState(canEdit && props.startEdit !== false);
  const [tab, setTab] = useState<'tt' | 'cv' | 'gt' | 'hd' | 'np' | 'll'>('tt');
  const [cv, setCv] = useState<Page[] | null>(null);
  const [cvBusy, setCvBusy] = useState(false);
  const toast = useToast();
  const mine = useMemo(() => docs.filter((d) => d.staff_id === s.id), [docs, s.id]);
  const required = REQUIRED[s.position];

  // Giấy tờ bắt buộc còn thiếu / hết hạn (tính cả giấy khám SK, tập huấn ghi trong Lý lịch hành nghề)
  const td = today();
  const warnDocs = required.filter((code) => {
    const d = props.papers.find((x) => x.staff_id === s.id && x.doc_type === code && x.is_current);
    return !d || (d.expires_on != null && d.expires_on < td);
  }).length;
  const nRec = recordsWithPapers(props.records, props.docs, s.id).length;
  const tabs: { key: typeof tab; label: string; warn?: boolean }[] = [
    { key: 'tt', label: 'Thông tin cá nhân' },
    { key: 'cv', label: 'Công việc & lương' },
    { key: 'gt', label: `${s.position === 'lai_xe' ? 'Giấy tờ lái xe' : 'Giấy tờ'}${warnDocs ? ` (thiếu ${warnDocs})` : ''}`, warn: warnDocs > 0 },
    ...(props.labor.view ? [{ key: 'hd' as const, label: 'Hợp đồng' }] : []),
    { key: 'np' as const, label: 'Nghỉ phép' },
    ...(canEdit || s.position === 'lai_xe' ? [{ key: 'll' as const, label: canEdit ? `Lý lịch hành nghề (${nRec})` : 'Lý lịch hành nghề' }] : []),
  ];

  async function printCv() {
    setCvBusy(true);
    try { setCv(await staffCvPages(tenantId, s.id, props.me, props.avas?.[s.id] ?? null)); }
    catch (e) { toast('error', errMsg(e)); } finally { setCvBusy(false); }
  }
  const cccd = props.papers.find((x) => x.staff_id === s.id && x.doc_type === 'cccd' && x.is_current);

  return (
    <div className="sub prof">
      {cv && <PaperView title={`Sơ yếu lý lịch · ${s.full_name}`} pages={cv} onClose={() => setCv(null)} />}
      <div className={`prof-head nsx-pf pos-${s.position}`}>
        <StaffAvatar tenantId={tenantId} staffId={s.id} name={s.full_name} canEdit={canEdit} />
        <div className="prof-id">
          <span className="nsx-pf-code">{[sameAsGroup(s) ? '' : POSITION[s.position], s.department?.trim().toLocaleLowerCase('vi') === jobKey(s) ? '' : s.department?.trim() ?? ''].filter(Boolean).join(' · ')}</span>
          <b className="nsx-pf-name">{s.full_name}</b>
          <span className="nsx-pf-role">{jobLabel(s)}</span>
          <span className="nsx-pf-chips">
            <span className="nsx-pf-chip">{s.is_active ? 'Đang làm' : `Đã nghỉ ${s.left_on ? fmtDate(s.left_on) : ''}`}</span>
            {s.joined_on && <span className="nsx-pf-chip">⏱ {seniority(s.joined_on, s.left_on)}</span>}
            {s.phone && <a className="nsx-pf-chip" href={`tel:${s.phone}`}>📞 {s.phone}</a>}
            {warnDocs ? <span className="nsx-pf-chip warn">Giấy tờ thiếu / hết hạn: {warnDocs}</span> : <span className="nsx-pf-chip">Giấy tờ đủ</span>}
          </span>
          <button type="button" className="btn small nsx-cvbtn" disabled={cvBusy} onClick={() => void printCv()}>{cvBusy ? 'Đang lấy dữ liệu…' : '🖨 In sơ yếu lý lịch'}</button>
        </div>
      </div>
      <div className="vx-tabs prof-tabs" role="tablist" aria-label="Hồ sơ">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={[tab === t.key && 'on', t.warn && 'warn'].filter(Boolean).join(' ')} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'tt' && editing && (
        <div className="prof-pane">
          <StaffForm {...props} editing={s} onDone={() => setEditing(false)} />
          <StaffSignature tenantId={tenantId} staffId={s.id} canEdit={canEdit} />
        </div>
      )}
      {tab === 'tt' && !editing && (
        <div className="prof-pane">
          <dl className="info">
            <dt>Ngày sinh</dt><dd>{p?.birth_date ? `${fmtDate(p.birth_date)} (${yearsBetween(p.birth_date, today())} tuổi)` : '—'}</dd>
            <dt>Giới tính</dt><dd>{p?.gender === 'nam' ? 'Nam' : p?.gender === 'nu' ? 'Nữ' : '—'}</dd>
            <dt>Điện thoại</dt><dd>{s.phone ? <a href={`tel:${s.phone}`}>{s.phone}</a> : '—'}</dd>
            <dt>Số CCCD</dt><dd>{cccd?.doc_no ?? '—'}</dd>
            {cccd && (cccd.issued_on || cccd.issuer) && <><dt>Ngày cấp, nơi cấp</dt><dd>{[cccd.issued_on ? fmtDate(cccd.issued_on) : '', cccd.issuer ?? ''].filter(Boolean).join(', ')}</dd></>}
            <dt>Quê quán</dt><dd>{p?.hometown ?? '—'}</dd>
            <dt>Nơi thường trú</dt><dd>{p?.address ?? '—'}</dd>
            {p?.note && <><dt>Ghi chú</dt><dd>{p.note}</dd></>}
          </dl>
          {canEdit && <div className="actions"><button className="btn small" onClick={() => setEditing(true)}>Sửa hồ sơ</button>
            <DeleteButton kind="staff" id={s.id} name={s.full_name} note="Giấy tờ, lý lịch của người này cũng bị xóa." onDone={reload} /></div>}
          {canEdit && <StaffSignature tenantId={tenantId} staffId={s.id} canEdit={canEdit} />}
        </div>
      )}
      {tab === 'gt' && (
        <div className="prof-pane">
          <ul className="list">
            {STAFF_DOCS.filter((def) => !(props.labor.view && def.code === 'hop_dong_ld')).map((def) => (
              <DocRow key={def.code} def={def} doc={mine.find((d) => d.doc_type === def.code && d.is_current)} tenantId={tenantId}
                      recordExp={recordExpiry(props.records, s.id, def.code)}
                      extraFiles={RECORD_OF[def.code] ? props.records.filter((r) => r.staff_id === s.id && r.kind === RECORD_OF[def.code]).flatMap((r) => r.files) : undefined}
                      owner={{ kind: 'nhan_su', id: s.id, label: s.full_name }} warnDays={warnDays} canEdit={canEdit}
                      required={required.includes(def.code)} reload={reload} clearable lockExpired />
            ))}
          </ul>
          <OldDocs docs={mine} canDelete={canEdit} onDeleted={props.reload} />
          {s.position === 'lai_xe' && <LicenseCheck rows={props.licenses.filter((l) => l.staff_id === s.id)} types={props.types} />}
        </div>
      )}
      {tab === 'cv' && <div className="prof-pane"><WorkPay s={s} p={p} branches={props.branches} papers={props.papers} /></div>}
      {tab === 'hd' && props.labor.view && (
        <div className="prof-pane">
          <ul className="list">
            <li className="item">
              <StaffContracts s={s} contractType={p?.contract_type} tenantId={tenantId} me={props.me} canArchive={props.canArchive}
                              canAdd={props.labor.add} canEdit={props.labor.edit} />
            </li>
          </ul>
        </div>
      )}
      {tab === 'np' && <div className="prof-pane"><LeaveOfStaff s={s} all={props.staff} perms={props.leave} myUserId={props.myUserId} tenantId={props.tenantId} me={props.me} /></div>}
      {tab === 'll' && <div className="prof-pane"><Records {...props} s={s} /></div>}
    </div>
  );
}

/* ------------------------------------------------------------------ Chuẩn hóa chức vụ / phòng ban */

/** Gộp chức vụ, phòng ban chỉ khác chữ hoa / thường / khoảng trắng ("Lái Xe", "lái  xe" → "Lái xe"): lấy cách viết nhiều người dùng nhất. */
function NormalizeJobs({ staff, priv, onClose, reload }: { staff: Staff[]; priv: StaffPrivate[]; onClose: () => void; reload: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const plan = useMemo(() => {
    const clean = (x: string) => x.trim().replace(/\s+/g, ' ');
    const pick = (vals: string[]) => {
      const n = new Map<string, number>();
      for (const v of vals) n.set(v, (n.get(v) ?? 0) + 1);
      // nhiều người dùng nhất; bằng nhau thì ưu tiên chỉ viết hoa chữ đầu ("Lái xe")
      const sentence = (v: string) => v === v.charAt(0).toLocaleUpperCase('vi') + v.slice(1).toLocaleLowerCase('vi');
      return [...n.entries()].sort((a, b) => b[1] - a[1] || Number(sentence(b[0])) - Number(sentence(a[0])))[0]![0];
    };
    const canon = (field: 'job_title' | 'department') => {
      const g = new Map<string, string[]>();
      for (const x of staff) { const v = x[field]; if (!v?.trim()) continue; const k = clean(v).toLocaleLowerCase('vi'); g.set(k, [...(g.get(k) ?? []), clean(v)]); }
      return new Map([...g.entries()].map(([k, vals]) => [k, pick(vals)]));
    };
    const cj = canon('job_title'), cd = canon('department');
    return staff.map((x) => {
      const j = x.job_title?.trim() ? cj.get(clean(x.job_title).toLocaleLowerCase('vi'))! : x.job_title;
      const d = x.department?.trim() ? cd.get(clean(x.department).toLocaleLowerCase('vi'))! : x.department;
      return { s: x, j, d, change: (j ?? '') !== (x.job_title ?? '') || (d ?? '') !== (x.department ?? '') };
    }).filter((x) => x.change);
  }, [staff]);
  async function run() {
    setBusy(true);
    let ok = 0;
    for (const x of plan) {
      try {
        const f = formOf(x.s, priv.find((p) => p.staff_id === x.s.id));
        await rpc('save_staff', { p_id: x.s.id, p: { ...f, job_title: x.j ?? '', department: x.d ?? '', is_active: !f.left_on } });
        ok++;
      } catch (e) { toast('error', `${x.s.full_name}: ${errMsg(e)}`); }
    }
    setBusy(false);
    await reload();
    toast('ok', `Đã chuẩn hóa ${ok} hồ sơ`);
    onClose();
  }
  return (
    <Modal title="Chuẩn hóa chức vụ, phòng ban" onClose={onClose}>
      {plan.length === 0 ? <p className="muted">Không có chức vụ / phòng ban nào viết khác nhau, không cần chuẩn hóa.</p> : (
        <>
          <div className="nsx-tblw">
            <table className="nsx-tbl">
              <thead><tr><th>Họ tên</th><th>Chức vụ</th><th>Phòng ban</th></tr></thead>
              <tbody>{plan.map((x) => (
                <tr key={x.s.id}><td>{x.s.full_name}</td>
                  <td>{(x.j ?? '') !== (x.s.job_title ?? '') ? <>{x.s.job_title} → <b>{x.j}</b></> : x.s.job_title}</td>
                  <td>{(x.d ?? '') !== (x.s.department ?? '') ? <>{x.s.department} → <b>{x.d}</b></> : x.s.department}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
      <div className="actions">
        {plan.length > 0 && <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? 'Đang chuẩn hóa…' : `Chuẩn hóa ${plan.length} hồ sơ`}</button>}
        <button type="button" className="btn link" onClick={onClose}>Đóng</button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Nhập danh sách từ Excel */

const IMP_COLS: { key: keyof Form; label: string; alias: string[] }[] = [
  { key: 'full_name', label: 'Họ và tên', alias: ['hovaten', 'hoten', 'ten', 'tennhanvien', 'tenlaixe'] },
  { key: 'phone', label: 'Điện thoại', alias: ['dienthoai', 'sodienthoai', 'sdt', 'didong'] },
  { key: 'job_title', label: 'Chức vụ', alias: ['chucvu', 'chucdanh', 'vitri'] },
  { key: 'position', label: 'Nhóm', alias: ['nhom', 'loai'] },
  { key: 'department', label: 'Bộ phận', alias: ['bophan', 'phongban', 'phong'] },
  { key: 'joined_on', label: 'Ngày vào công ty', alias: ['ngayvaocongty', 'ngayvaolam', 'ngayvao'] },
  { key: 'birth_date', label: 'Ngày sinh', alias: ['ngaysinh'] },
  { key: 'gender', label: 'Giới tính', alias: ['gioitinh'] },
  { key: 'address', label: 'Nơi thường trú', alias: ['noithuongtru', 'thuongtru', 'diachi'] },
  { key: 'hometown', label: 'Quê quán', alias: ['quequan', 'que', 'noidangkykhaisinh'] },
  { key: 'bhxh_no', label: 'Số sổ BHXH', alias: ['sosobhxh', 'sobhxh', 'bhxh'] },
  { key: 'bank_account', label: 'Tài khoản ngân hàng', alias: ['taikhoannganhang', 'taikhoan', 'stk', 'sotaikhoan'] },
  { key: 'note', label: 'Ghi chú', alias: ['ghichu'] },
];
const keyOf = (x: unknown) => fold(String(x ?? '')).replace(/[^a-z0-9]/g, '');
/** Ngày từ ô Excel: kiểu ngày, số ngày Excel, dd/mm/yyyy, yyyy-mm-dd */
function cellDate(v: Cell): string {
  if (v == null || v === '') return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  if (typeof v === 'number' && v > 20000) { const t = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5); return t.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : '';
}
const phoneOf = (v: Cell) => { let d = String(v ?? '').replace(/\D/g, ''); if (d.length === 9) d = `0${d}`; if (d.startsWith('84') && d.length === 11) d = `0${d.slice(2)}`; return d; };
interface ImpRow { row: number; f: Form; id: string; old: boolean; err: string | null }

function StaffImport({ staff, priv, onClose, reload }: { staff: Staff[]; priv: StaffPrivate[]; onClose: () => void; reload: () => Promise<void> }) {
  const toast = useToast();
  const [rows, setRows] = useState<ImpRow[]>([]);
  const [note, setNote] = useState('Chưa chọn file');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'update' | 'skip'>('update');

  function parse(cells: Cell[][]): ImpRow[] {
    let hr = -1; let map: Partial<Record<keyof Form, number>> = {};
    for (let r = 0; r < Math.min(cells.length, 20) && hr < 0; r++) {
      const m: Partial<Record<keyof Form, number>> = {};
      (cells[r] ?? []).forEach((h, i) => { const k = keyOf(h); const c = IMP_COLS.find((x) => keyOf(x.label) === k || x.alias.includes(k)); if (c && m[c.key] === undefined) m[c.key] = i; });
      if (m.full_name !== undefined) { hr = r; map = m; }
    }
    if (hr < 0) throw new Error('Không thấy cột "Họ và tên" trong file. Hãy dùng file mẫu.');
    const out: ImpRow[] = [];
    const seen = new Set<string>();
    cells.slice(hr + 1).forEach((r, k) => {
      const get = (key: keyof Form) => (map[key] === undefined ? null : r[map[key]!] ?? null);
      const name = String(get('full_name') ?? '').trim();
      if (!name) return;
      const phone = phoneOf(get('phone'));
      const old = (phone && staff.find((x) => x.phone && phoneOf(x.phone) === phone)) || undefined;
      const base = old ? formOf(old, priv.find((x) => x.staff_id === old.id)) : { ...EMPTY };
      const f: Form = { ...base, full_name: name };
      const txt = (key: keyof Form) => { const v = get(key); return v == null ? '' : String(v).trim(); };
      if (phone) f.phone = phone;
      for (const key of ['job_title', 'department', 'address', 'hometown', 'note', 'bhxh_no', 'bank_account'] as const) if (txt(key)) f[key] = txt(key);
      const pos = keyOf(txt('position') || txt('job_title'));
      if (txt('position') || !old) f.position = pos.includes('phuxe') ? 'phu_xe' : pos.includes('laixe') || pos.includes('taixe') ? 'lai_xe' : txt('position') ? 'nhan_vien' : f.position;
      const g = keyOf(txt('gender'));
      if (g) f.gender = g.startsWith('nu') ? 'nu' : g.startsWith('nam') ? 'nam' : f.gender;
      if (cellDate(get('joined_on'))) f.joined_on = cellDate(get('joined_on'));
      if (cellDate(get('birth_date'))) f.birth_date = cellDate(get('birth_date'));
      let err: string | null = null;
      if (!f.joined_on) err = 'Thiếu ngày vào công ty';
      else if (f.phone && !/^0[0-9]{9}$/.test(f.phone)) err = 'Số điện thoại phải gồm 10 số';
      else if (phone && seen.has(phone)) err = 'Trùng số điện thoại trong file';
      if (phone) seen.add(phone);
      out.push({ row: hr + k + 2, f, id: old?.id ?? crypto.randomUUID(), old: !!old, err });
    });
    return out;
  }
  async function pick(file: File | undefined) {
    if (!file) return;
    setNote(`Đang đọc ${file.name}…`);
    try { const r = parse(await readSheet(file)); setRows(r); setNote(`${file.name} · đọc được ${r.length} dòng`); }
    catch (e) { setRows([]); setNote('Chưa đọc được file'); toast('error', errMsg(e)); }
  }
  const todo = rows.filter((r) => !r.err && (!r.old || mode === 'update'));
  async function run() {
    setBusy(true);
    let ok = 0, bad = 0;
    for (const r of todo) {
      try { await rpc('save_staff', { p_id: r.id, p: { ...r.f, is_active: !r.f.left_on } }); ok++; }
      catch (e) { bad++; setRows((cur) => cur.map((x) => (x === r ? { ...x, err: errMsg(e) } : x))); }
    }
    setBusy(false);
    await reload();
    if (bad) toast('error', `Đã nhập ${ok} dòng, ${bad} dòng lỗi – xem cột Tình trạng`);
    else { toast('ok', `Đã nhập ${ok} lái xe / nhân viên`); onClose(); }
  }
  const sample = () => downloadXlsx('Mau nhap lai xe nhan vien', 'Lái xe & nhân viên', IMP_COLS.map((c) => c.label),
    [['Nguyễn Văn A', '0901234567', 'Lái xe', 'Lái xe', 'Đội xe', '01/03/2024', '12/05/1990', 'Nam', '', '', '', '', '']], [24, 13, 16, 11, 14, 14, 12, 9, 36, 36, 14, 26, 20]);
  return (
    <Modal wide title="Nhập lái xe / nhân viên từ Excel" onClose={onClose}>
      <div className="nsx-imp">
        <div className="actions">
          <label className="btn primary upload-btn">⬆ Chọn file Excel<input type="file" hidden accept=".xlsx,.xls,.csv" aria-label="Chọn file Excel nhân viên" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} /></label>
          <button type="button" className="btn" onClick={sample}>⬇ Tải file mẫu</button>
        </div>
        <p className="muted small">{note}</p>
        {rows.some((r) => r.old) && (
          <div className="nsx-seg" role="group" aria-label="Người đã có">
            <button type="button" className={mode === 'update' ? 'on' : ''} onClick={() => setMode('update')}>Cập nhật người đã có</button>
            <button type="button" className={mode === 'skip' ? 'on' : ''} onClick={() => setMode('skip')}>Bỏ qua người đã có</button>
          </div>
        )}
        {rows.length > 0 && (
          <div className="nsx-tblw">
            <table className="nsx-tbl">
              <thead><tr><th>Dòng</th><th>Họ và tên</th><th>Điện thoại</th><th>Chức vụ</th><th>Ngày vào</th><th>Tình trạng</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.row}><td>{r.row}</td><td>{r.f.full_name}</td><td>{r.f.phone}</td><td>{r.f.job_title || POSITION[r.f.position]}</td><td>{r.f.joined_on ? fmtDate(r.f.joined_on) : ''}</td>
                  <td>{r.err ? <span className="badge locked">{r.err}</span> : r.old ? <span className="badge warn-badge">{mode === 'update' ? 'Cập nhật' : 'Bỏ qua'}</span> : <span className="badge">Thêm mới</span>}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn primary" disabled={busy || todo.length === 0} onClick={() => void run()}>{busy ? 'Đang nhập…' : `Nhập ${todo.length} dòng`}</button>
          <button type="button" className="btn link" onClick={onClose}>Hủy</button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Công việc & lương */

interface PayCtr { number: string | null; kind: string; start_on: string; end_on: string | null; salary: number | null; allowances: Record<string, number> | null }
/** Công việc + lương theo hợp đồng đang hiệu lực + BHXH tháng gần nhất. Không có quyền xem thì database không trả, phần lương tự ẩn. */
function WorkPay({ s, p, branches, papers }: { s: Staff; p: StaffPrivate | undefined; branches: Option[]; papers: Doc[] }) {
  const [ctr, setCtr] = useState<PayCtr | null>(null);
  const [pay, setPay] = useState<{ month: string; has_bhxh: boolean; bhxh_pay: number; transfer_pay: number } | null>(null);
  useEffect(() => {
    let live = true;
    const td = today();
    void Promise.all([
      supabase.from('labor_contracts').select('number, kind, start_on, end_on, salary, allowances').eq('staff_id', s.id).eq('status', 'hieu_luc')
        .lte('start_on', td).order('start_on', { ascending: false }).limit(1),
      supabase.from('staff_pay_months').select('month, has_bhxh, bhxh_pay, transfer_pay').eq('staff_id', s.id).order('month', { ascending: false }).limit(1),
    ]).then(([c, m]) => {
      if (!live) return;
      setCtr(((c.data ?? []) as PayCtr[])[0] ?? null);
      setPay(((m.data ?? []) as { month: string; has_bhxh: boolean; bhxh_pay: number; transfer_pay: number }[])[0] ?? null);
    });
    return () => { live = false; };
  }, [s.id]);
  const money = (n: unknown) => `${Number(n || 0).toLocaleString('vi-VN')} đ`;
  const allow = ctr?.allowances ? Object.values(ctr.allowances).reduce((a, x) => a + (Number(x) || 0), 0) : 0;
  const gplx = papers.find((d) => d.staff_id === s.id && d.doc_type === 'gplx' && d.is_current);
  return (
    <dl className="info">
      <dt>Chức vụ</dt><dd>{jobLabel(s)}</dd>
      {!sameAsGroup(s) && <><dt>Nhóm</dt><dd>{POSITION[s.position]}</dd></>}
      <dt>Bộ phận</dt><dd>{s.department || '—'}</dd>
      {s.branch_id && <><dt>Chi nhánh</dt><dd>{branches.find((b) => b.id === s.branch_id)?.label ?? '—'}</dd></>}
      <dt>Ngày vào làm</dt><dd>{s.joined_on ? `${fmtDate(s.joined_on)} (${seniority(s.joined_on, s.left_on)})` : '—'}</dd>
      {!s.is_active && <><dt>Ngày nghỉ việc</dt><dd>{s.left_on ? fmtDate(s.left_on) : '—'}</dd></>}
      <dt>Loại hợp đồng</dt><dd>{p?.contract_type ? CONTRACT[p.contract_type] : '—'}</dd>
      {s.position === 'lai_xe' && <><dt>Hạng GPLX</dt><dd>{gplx?.data?.hang ? String(gplx.data.hang) : 'Chưa có'}</dd></>}
      {ctr && ctr.salary != null && <>
        <dt>Lương theo hợp đồng</dt><dd>{money(ctr.salary)}{ctr.number ? ` · HĐ ${ctr.number}` : ''}{ctr.end_on ? ` · đến ${fmtDate(ctr.end_on)}` : ''}</dd>
        {allow > 0 && <><dt>Phụ cấp, hỗ trợ</dt><dd>{money(allow)} / tháng</dd></>}
      </>}
      {p?.bhxh_no && <><dt>Số sổ BHXH</dt><dd>{p.bhxh_no}</dd></>}
      {p?.bank_account && <><dt>Tài khoản ngân hàng</dt><dd>{p.bank_account}</dd></>}
      {pay && <>
        <dt>BHXH tháng {pay.month.slice(5, 7)}/{pay.month.slice(0, 4)}</dt><dd>{pay.has_bhxh ? `Có đóng · lương đóng ${money(pay.bhxh_pay)}` : 'Không đóng'}</dd>
        <dt>Lương chuyển khoản</dt><dd>{money(pay.transfer_pay)}</dd>
      </>}
    </dl>
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
      <p className="muted small">Quy đổi GPLX cấp trước 2025: cần xác minh.</p>
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

/** Giấy khám SK / giấy tập huấn ở mục Giấy tờ (cả bản cũ) cũng là 1 lần trong lý lịch; trùng ngày với dòng lý lịch thì lấy dòng lý lịch. */
/** Dòng lý lịch trùng giấy khác (như máy chủ kiểm khi xóa): cùng loại + cùng ngày / cùng số với dòng khác,
 *  hoặc trùng giấy khám SK / tập huấn ở mục Giấy tờ (cùng số, ngày cấp hoặc hạn) */
function isDupRecord(r: StaffRecord, records: StaffRecord[], docs: Doc[]): boolean {
  const no = paperNo(r.doc_no, r.title);
  const type = Object.keys(RECORD_OF).find((t) => RECORD_OF[t] === r.kind);
  return records.some((x) => x.id !== r.id && x.staff_id === r.staff_id && x.kind === r.kind && (x.occurred_on === r.occurred_on || (!!no && paperNo(x.doc_no, x.title) === no)))
    || (!!type && docs.some((g) => g.staff_id === r.staff_id && g.doc_type === type
      && ((!!no && paperNo(g.doc_no) === no) || g.issued_on === r.occurred_on || (!!g.expires_on && g.expires_on === String(r.data?.het_han ?? '')))));
}

function recordsWithPapers(records: StaffRecord[], docs: Doc[], staffId: string): (StaffRecord & { fromDoc?: boolean; doc?: Doc })[] {
  const mine = records.filter((r) => r.staff_id === staffId);
  const extra = docs.filter((g) => g.staff_id === staffId && RECORD_OF[g.doc_type]).map((g) => {
    const day = g.issued_on || g.valid_from || g.created_at.slice(0, 10);
    const dt = (k: string) => String(g.data?.[k] ?? '').trim();
    const title = g.doc_type === 'kham_suc_khoe'
      ? [dt('ket_luan'), dt('hang_du_dieu_kien') && `Đủ điều kiện lái xe hạng ${dt('hang_du_dieu_kien')}`].filter(Boolean).join(' · ') || 'Khám sức khỏe'
      : 'Tập huấn nghiệp vụ';
    return { id: g.id, staff_id: staffId, kind: RECORD_OF[g.doc_type] as RecordKind, occurred_on: day, doc_no: g.doc_no, title,
      vehicle_id: null, data: { co_so: g.issuer, het_han: g.expires_on }, files: g.files, fromDoc: true, doc: g };
  }).filter((x, i, A) => !mine.some((r) => r.kind === x.kind && r.occurred_on === x.occurred_on)
    && A.findIndex((y) => y.kind === x.kind && y.occurred_on === x.occurred_on) === i);
  return [...mine, ...extra].sort((a, b) => b.occurred_on.localeCompare(a.occurred_on));
}

function Records(props: Common & { s: Staff }) {
  const { s, records, canEdit, tenantId, reload } = props;
  const toast = useToast();
  const [filter, setFilter] = useState<RecordKind | ''>('');
  const [form, setForm] = useState<{ id: string | null; code: string; values: Values; scanned: Scanned | null; req: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = recordsWithPapers(records, props.docs, s.id);
  const shown = mine.filter((r) => !filter || r.kind === filter);

  /** Gắn ảnh / PDF vào dòng lý lịch chưa có tệp (vd giấy khám SK, giấy tập huấn chuyển từ app cũ) */
  async function attach(r: StaffRecord, fs: File[]) {
    if (!fs.length) return;
    setBusy(true);
    try {
      const prepared = await Promise.all(fs.slice(0, 6).map(prepareFile));
      const paths = await uploadFiles(tenantId, 'nhan_su', s.id, s.full_name, defOfKind(r.kind).code, prepared);
      await rpc('attach_staff_record_files', { p_id: r.id, p_files: paths });
      toast('ok', `Đã gắn ${paths.length} tệp vào lý lịch`);
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    } finally { setBusy(false); }
  }

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
  if (!canEdit) {
    return s.position === 'lai_xe' ? <PaperActions kind="driver" id={s.id} label={s.full_name} tenantId={tenantId} me={props.me} canSave={false} /> : null;
  }
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
                  {canEdit && !r.fromDoc && r.files.length === 0 && (
                    <label className="btn small">📎 Gắn tệp
                      <input type="file" accept="image/*,application/pdf" multiple hidden aria-label={`Gắn tệp lý lịch ${fmtDate(r.occurred_on)} ${d.name}`}
                             onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; void attach(r, fs); }} /></label>
                  )}
                  {canEdit && !r.fromDoc && isDupRecord(r, records, props.docs) && <DeleteDupButton kind="ly_lich" id={r.id} label={`dòng ${fmtDate(r.occurred_on)} trùng`} onDone={reload} />}
                  {canEdit && r.doc && isDupDoc(r.doc, props.docs) && <DeleteDupButton kind="giay_to" id={r.id} label={`bản cũ ${fmtDate(r.occurred_on)} trùng`} onDone={reload} />}
                  {canEdit && !r.fromDoc && <button className="btn small" onClick={() => setForm({ id: r.id, code: d.code, values: recordValues(d, r), scanned: null, req: crypto.randomUUID() })}>Sửa</button>}
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

function problems(s: Staff, _p: StaffPrivate | undefined, docs: Doc[], warnDays: number): { text: string; state: DocState }[] {
  const out: { text: string; state: DocState }[] = [];
  if (!s.is_active) return out;
  for (const def of STAFF_DOCS) {
    const req = REQUIRED[s.position].includes(def.code);
    const st = docState(def, docs.find((d) => d.staff_id === s.id && d.doc_type === def.code && d.is_current), warnDays, req);
    if (st.state === 'het_han' || st.state === 'sap_het' || (st.state === 'thieu' && req)) out.push({ text: `${SHORT[def.code]}: ${st.text}`, state: st.state });
  }
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
