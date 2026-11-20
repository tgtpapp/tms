// Soạn / sửa / xem trước / in / lưu hồ sơ Hợp đồng lao động – dùng chung cho mục Hợp đồng lao động và hồ sơ Lái xe & nhân viên.
// Quy tắc lưu hồ sơ như app cũ: bấm Lưu hoặc In là tự tạo PDF vào Năm › Nhân sự › Hợp đồng lao động › Họ tên
// (mỗi người mỗi năm 1 bản, sửa thì đè, nội dung không đổi thì bỏ qua).
import { useState } from 'react';
import { Modal } from './Modal';
import { PaperView, type Me } from './ProfilePapers';
import { resetFolders } from '../lib/dispatchPapers';
import { KIND_NAME, contractPages, loadLaborCtx, saveContractPdf, type Allow, type Contract, type Kind } from '../lib/laborContract';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

export interface CStaff { id: string; full_name: string; position: string; job_title: string | null; joined_on: string; left_on: string | null; is_active: boolean }
export interface CForm {
  id: string | null; number: string | null; staff: CStaff; kind: Kind; start_on: string; end_on: string; salary: string; position: string; department: string;
  job_desc: string; allow: Record<keyof Allow, string>; req: string;
}
export const CONTRACT_COLS = 'id, staff_id, year, seq, number, kind, start_on, end_on, salary, position, department, job_desc, allowances, status, cancel_reason';
const POSITION: Record<string, string> = { lai_xe: 'Lái xe', phu_xe: 'Phụ xe', nhan_vien: 'Nhân viên' };
export const ALLOW: [keyof Allow, string][] = [['an_trua', 'Hỗ trợ ăn trưa'], ['xang', 'Hỗ trợ xăng xe / đi lại'], ['dien_thoai', 'Hỗ trợ điện thoại'], ['khac', 'Hỗ trợ khác']];
const num = (n: number) => n.toLocaleString('vi-VN');
const parse = (s: string) => Number(String(s).replace(/[^0-9]/g, '')) || 0;
/** Lương chuyển khoản theo "staff_id|YYYY-MM" (bảng BHXH & lương theo tháng). */
export type PayMap = Record<string, number>;

export async function loadPay(year: number, staffId?: string): Promise<PayMap> {
  let q = supabase.from('staff_pay_months').select('staff_id, month, transfer_pay').gte('month', `${year}-01-01`).lte('month', `${year}-12-01`);
  if (staffId) q = q.eq('staff_id', staffId);
  const { data } = await q;
  return Object.fromEntries(((data ?? []) as { staff_id: string; month: string; transfer_pay: number }[]).map((x) => [`${x.staff_id}|${x.month.slice(0, 7)}`, Number(x.transfer_pay)]));
}

/** Mặc định như app cũ: 01/01 (hoặc ngày vào làm trong năm) → 31/12 (hoặc ngày nghỉ việc); lương = lương chuyển khoản tháng bắt đầu. */
export function contractDefaults(s: CStaff, year: number, contractType: string | null | undefined, pay: PayMap): CForm {
  const kind: Kind = contractType === 'khong_xac_dinh' || contractType === 'thoi_vu' ? contractType : 'xac_dinh';
  const start = s.joined_on > `${year}-01-01` && s.joined_on.startsWith(String(year)) ? s.joined_on : `${year}-01-01`;
  const end = !s.is_active && s.left_on && s.left_on.startsWith(String(year)) && s.left_on >= start ? s.left_on : `${year}-12-31`;
  return { id: null, number: null, staff: s, kind, start_on: start, end_on: kind === 'khong_xac_dinh' ? '' : end, salary: String(pay[`${s.id}|${start.slice(0, 7)}`] ?? 0),
    position: s.job_title || POSITION[s.position] || '', department: '', job_desc: '', allow: { an_trua: '', xang: '', dien_thoai: '', khac: '' }, req: crypto.randomUUID() };
}
export function formOf(k: Contract, s: CStaff): CForm {
  return { id: k.id, number: k.number, staff: s, kind: k.kind, start_on: k.start_on, end_on: k.end_on ?? '', salary: String(k.salary), position: k.position ?? '',
    department: k.department ?? '', job_desc: k.job_desc ?? '', allow: Object.fromEntries(ALLOW.map(([a]) => [a, k.allowances?.[a] ? String(k.allowances[a]) : ''])) as CForm['allow'], req: '' };
}
export const contractArgs = (x: CForm, req: string | null) => ({
  p_id: x.id, p_staff_id: x.staff.id, p_kind: x.kind, p_start_on: x.start_on, p_end_on: x.kind === 'khong_xac_dinh' ? null : x.end_on || null, p_salary: parse(x.salary),
  p_position: x.position, p_department: x.department, p_job_desc: x.job_desc,
  p_allowances: Object.fromEntries(ALLOW.map(([k]) => [k, parse(x.allow[k])]).filter(([, v]) => Number(v) > 0)), p_request_id: req,
});

/** Các thao tác: lưu (tự lưu PDF vào hồ sơ), xem trước (In cũng tự lưu hồ sơ), lưu hồ sơ. */
export function useContracts(tenantId: string, me: Me, canArchive: boolean) {
  const toast = useToast();
  const [view, setView] = useState<{ title: string; pages: string[]; k: Contract } | null>(null);
  const [busy, setBusy] = useState('');

  async function archive(k: Contract, quiet = false): Promise<boolean> {
    if (!canArchive) return false;
    resetFolders();
    try {
      const r = await saveContractPdf(k, await loadLaborCtx(tenantId, me, k.staff_id));
      if (!quiet || r === 'saved') toast('ok', r === 'saved' ? `Đã lưu PDF hợp đồng ${k.number} vào hồ sơ` : `PDF hợp đồng ${k.number} đã có trong hồ sơ (nội dung không đổi)`);
      return true;
    } catch (e) { toast('error', `Chưa lưu được PDF hợp đồng vào hồ sơ: ${errMsg(e)}`); return false; }
  }
  async function save(f: CForm): Promise<boolean> {
    if (!f.start_on || (f.kind !== 'khong_xac_dinh' && !f.end_on)) { toast('error', 'Nhập ngày bắt đầu và ngày kết thúc'); return false; }
    setBusy(f.id ? 'Đang lưu…' : 'Đang cấp số…');
    try {
      const r = await rpc<{ id: string; number: string }>('save_labor_contract', contractArgs(f, f.id ? null : f.req));
      toast('ok', f.id ? `Đã lưu hợp đồng ${r.number}` : `Đã lập hợp đồng số ${r.number}`);
      if (canArchive) {
        setBusy('Đang tạo PDF hợp đồng vào hồ sơ…');
        const { data } = await supabase.from('labor_contracts').select(CONTRACT_COLS).eq('id', r.id).single();
        await archive(data as Contract, true);
      }
      return true;
    } catch (e) { toast('error', errMsg(e)); return false; } finally { setBusy(''); }
  }
  async function show(k: Contract, name: string) {
    setBusy('Đang dựng hợp đồng…');
    try { setView({ title: `Hợp đồng lao động ${k.number} · ${name}`, pages: contractPages(k, await loadLaborCtx(tenantId, me, k.staff_id)), k }); }
    catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function archiveMany(ks: Contract[]) {
    let n = 0;
    for (const [i, k] of ks.entries()) { setBusy(`Đang lưu vào hồ sơ ${i + 1}/${ks.length}…`); if (await archive(k, true)) n++; }
    setBusy('');
    toast('ok', `Xong: ${n}/${ks.length} hợp đồng đã có trong hồ sơ`);
  }
  const viewer = view && (
    <PaperView title={view.title} pages={view.pages.map((html) => ({ html, land: false }))} onClose={() => setView(null)}
               onPrint={() => { void archive(view.k, true); }} />
  );
  return { busy, save, show, archive, archiveMany, viewer };
}

export function ContractEditor({ form, setForm, pay, busy, onSave, onClose }: {
  form: CForm; setForm: (f: CForm) => void; pay: PayMap; busy: string; onSave: () => void; onClose: () => void;
}) {
  const f = form;
  const def = pay[`${f.staff.id}|${f.start_on.slice(0, 7)}`] ?? 0;
  return (
    <Modal wide title={f.id ? `Sửa hợp đồng ${f.number} · ${f.staff.full_name}` : `Soạn hợp đồng lao động · ${f.staff.full_name}`} onClose={() => { if (!busy) onClose(); }}>
      <div className="form">
        <div className="grid2">
          <label>Số HĐLĐ<input value={f.number ?? 'Tự cấp khi lưu (001 trở đi)'} disabled /></label>
          <label>Loại hợp đồng<select value={f.kind} onChange={(e) => setForm({ ...f, kind: e.target.value as Kind })}>
            {(Object.keys(KIND_NAME) as Kind[]).map((k) => <option key={k} value={k}>{KIND_NAME[k]}</option>)}</select></label>
          <label>Hợp đồng từ ngày<input type="date" aria-label="Từ ngày" value={f.start_on} onChange={(e) => setForm({ ...f, start_on: e.target.value })} /></label>
          {f.kind !== 'khong_xac_dinh' && <label>Hợp đồng đến ngày<input type="date" aria-label="Đến ngày" value={f.end_on} onChange={(e) => setForm({ ...f, end_on: e.target.value })} /></label>}
          <label>Lương theo công việc / chức danh (đồng/tháng)
            <input inputMode="numeric" aria-label="Lương ghi trên hợp đồng" value={parse(f.salary) ? num(parse(f.salary)) : ''} placeholder="0" onChange={(e) => setForm({ ...f, salary: e.target.value })} />
            <small className="muted">Mặc định: lương chuyển khoản tháng {f.start_on.slice(5, 7)}/{f.start_on.slice(0, 4)} = {num(def)} đ
              {' '}<button type="button" className="btn small link" onClick={() => setForm({ ...f, salary: String(def) })}>Lấy lại</button></small></label>
          <label>Vị trí<input value={f.position} onChange={(e) => setForm({ ...f, position: e.target.value })} /></label>
          <label>Phòng ban<input value={f.department} onChange={(e) => setForm({ ...f, department: e.target.value })} /></label>
        </div>
        <label>Mô tả công việc riêng (mỗi dòng một việc; để trống thì dùng mô tả công việc mẫu trong Phụ lục I)
          <textarea rows={4} value={f.job_desc} onChange={(e) => setForm({ ...f, job_desc: e.target.value })} /></label>
        <h4>Phụ lục II: phụ cấp, hỗ trợ (đồng/tháng, để trống = Không áp dụng)</h4>
        <div className="grid2">
          {ALLOW.map(([k, l]) => <label key={k}>{l}<input inputMode="numeric" value={parse(f.allow[k]) ? num(parse(f.allow[k])) : ''} placeholder="0" onChange={(e) => setForm({ ...f, allow: { ...f.allow, [k]: e.target.value } })} /></label>)}
        </div>
        {busy && <p className="upload">{busy}</p>}
        <div className="actions">
          <button className="btn primary" disabled={!!busy} onClick={onSave}>{f.id ? 'Lưu' : 'Lập & cấp số'}</button>
          <button className="btn" disabled={!!busy} onClick={onClose}>Đóng</button>
        </div>
      </div>
    </Modal>
  );
}
