// Hợp đồng lao động (như app cũ): mỗi người mỗi năm 1 hợp đồng, lập tự động từ hồ sơ nhân sự, số tự cấp 001/<năm>/HĐLĐ-<ký hiệu>.
// Lương mặc định = lương chuyển khoản của tháng bắt đầu (Cấu hình › BHXH & lương chuyển khoản), sửa được trên từng HĐ.
// Xem / in, lưu PDF vào Năm › Nhân sự › Hợp đồng lao động › <họ tên>. Không xóa, chỉ hủy (giữ số).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { PaperView } from '../components/ProfilePapers';
import { fmtDate, today } from '../components/Documents';
import { resetFolders } from '../lib/dispatchPapers';
import { KIND_NAME, contractPages, loadLaborCtx, loadTerms, saveContractPdf, type Allow, type Contract, type Kind, type Terms } from '../lib/laborContract';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Staff { id: string; user_id: string | null; full_name: string; position: string; job_title: string | null; joined_on: string; left_on: string | null; is_active: boolean }
interface Form { id: string | null; number: string | null; staff: Staff; kind: Kind; start_on: string; end_on: string; salary: string; position: string; department: string; job_desc: string; allow: Record<keyof Allow, string>; req: string }
const POSITION: Record<string, string> = { lai_xe: 'Lái xe', phu_xe: 'Phụ xe', nhan_vien: 'Nhân viên' };
const COLS = 'id, staff_id, year, seq, number, kind, start_on, end_on, salary, position, department, job_desc, allowances, status, cancel_reason';
const num = (n: number) => n.toLocaleString('vi-VN');
const parse = (s: string) => Number(String(s).replace(/[^0-9]/g, '')) || 0;
const ALLOW: [keyof Allow, string][] = [['an_trua', 'Hỗ trợ ăn trưa'], ['xang', 'Hỗ trợ xăng xe / đi lại'], ['dien_thoai', 'Hỗ trợ điện thoại'], ['khac', 'Hỗ trợ khác']];

export function LaborScreen({ ctx, perms }: { ctx: AccountContext; perms: Permissions }) {
  const toast = useToast();
  const tenantId = ctx.tenant_id ?? '';
  const me = useMemo(() => ({ id: ctx.user_id, name: ctx.full_name ?? '' }), [ctx.user_id, ctx.full_name]);
  const canArchive = perms.has('archive.manage');
  const canTerms = perms.has('settings.manage');
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const [staff, setStaff] = useState<Staff[]>([]);
  const [list, setList] = useState<Contract[]>([]);
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [pay, setPay] = useState<Record<string, number>>({});
  const [terms, setTerms] = useState<Terms>({ payDay: 5, hours: 8, off: 'CN' });
  const [f, setF] = useState<Form | null>(null);
  const [view, setView] = useState<{ title: string; pages: string[] } | null>(null);
  const [busy, setBusy] = useState('');
  const [showOld, setShowOld] = useState(false);

  const load = useCallback(async () => {
    const [s, c, p, m, t] = await Promise.all([
      supabase.from('staff_members').select('id, user_id, full_name, position, job_title, joined_on, left_on, is_active'),
      supabase.from('labor_contracts').select(COLS).eq('year', year).order('seq'),
      supabase.from('staff_private').select('staff_id, contract_type'),
      supabase.from('staff_pay_months').select('staff_id, month, transfer_pay').gte('month', `${year}-01-01`).lte('month', `${year}-12-01`),
      loadTerms(),
    ]);
    if (c.error) return toast('error', c.error.message);
    setStaff(((s.data ?? []) as Staff[]).sort((a, b) => a.full_name.localeCompare(b.full_name, 'vi')));
    setList((c.data ?? []) as Contract[]);
    setKinds(Object.fromEntries(((p.data ?? []) as { staff_id: string; contract_type: string | null }[]).map((x) => [x.staff_id, x.contract_type ?? ''])));
    setPay(Object.fromEntries(((m.data ?? []) as { staff_id: string; month: string; transfer_pay: number }[]).map((x) => [`${x.staff_id}|${x.month.slice(0, 7)}`, Number(x.transfer_pay)])));
    setTerms(t);
  }, [year, toast]);
  useEffect(() => { void load(); }, [load]);

  // Người có làm trong năm: vào trước 31/12, chưa nghỉ trước 01/01
  const viewAll = perms.has('labor.view_all');   // không có: chỉ thấy hợp đồng của chính mình
  const people = staff.filter((s) => (viewAll || s.user_id === ctx.user_id) && s.joined_on <= `${year}-12-31` && (s.is_active || (s.left_on ?? '') >= `${year}-01-01`));
  const active = (id: string) => list.find((k) => k.staff_id === id && k.status === 'hieu_luc');
  const missing = people.filter((s) => !active(s.id));

  /** Mặc định như app cũ: từ 01/01 (hoặc ngày vào làm trong năm) đến 31/12 (hoặc ngày nghỉ việc); lương = lương chuyển khoản tháng bắt đầu. */
  function defaultsOf(s: Staff): Omit<Form, 'req'> {
    const ct = kinds[s.id];
    const kind: Kind = ct === 'khong_xac_dinh' || ct === 'thoi_vu' ? ct : 'xac_dinh';
    const start = s.joined_on > `${year}-01-01` && s.joined_on.startsWith(String(year)) ? s.joined_on : `${year}-01-01`;
    const end = !s.is_active && s.left_on && s.left_on.startsWith(String(year)) && s.left_on >= start ? s.left_on : `${year}-12-31`;
    return { id: null, number: null, staff: s, kind, start_on: start, end_on: kind === 'khong_xac_dinh' ? '' : end, salary: String(pay[`${s.id}|${start.slice(0, 7)}`] ?? 0),
      position: s.job_title || POSITION[s.position] || '', department: '', job_desc: '', allow: { an_trua: '', xang: '', dien_thoai: '', khac: '' } };
  }
  const args = (x: Omit<Form, 'req'>, req: string | null) => ({
    p_id: x.id, p_staff_id: x.staff.id, p_kind: x.kind, p_start_on: x.start_on, p_end_on: x.kind === 'khong_xac_dinh' ? null : x.end_on || null, p_salary: parse(x.salary),
    p_position: x.position, p_department: x.department, p_job_desc: x.job_desc,
    p_allowances: Object.fromEntries(ALLOW.map(([k]) => [k, parse(x.allow[k])]).filter(([, v]) => Number(v) > 0)), p_request_id: req,
  });

  async function save() {
    if (!f) return;
    if (!f.start_on || (f.kind !== 'khong_xac_dinh' && !f.end_on)) return toast('error', 'Nhập ngày bắt đầu và ngày kết thúc');
    setBusy(f.id ? 'Đang lưu…' : 'Đang cấp số…');
    try {
      const r = await rpc<{ number: string }>('save_labor_contract', args(f, f.id ? null : f.req));
      toast('ok', f.id ? `Đã lưu hợp đồng ${r.number}` : `Đã lập hợp đồng số ${r.number}`);
      setF(null);
      await load();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function createAll() {
    if (!missing.length) return;
    if (!window.confirm(`Lập hợp đồng năm ${year} cho ${missing.length} người chưa có (số cấp lần lượt theo tên)?`)) return;
    const errs: string[] = [];
    for (const [i, s] of missing.entries()) {
      setBusy(`Đang lập ${i + 1}/${missing.length}: ${s.full_name}`);
      try { await rpc('save_labor_contract', args(defaultsOf(s), crypto.randomUUID())); } catch (e) { errs.push(`${s.full_name}: ${errMsg(e)}`); }
    }
    setBusy('');
    toast(errs.length ? 'error' : 'ok', errs.length ? errs.join('\n') : `Đã lập ${missing.length} hợp đồng`);
    await load();
  }
  async function show(k: Contract) {
    setBusy('Đang dựng hợp đồng…');
    try { setView({ title: `Hợp đồng lao động ${k.number} · ${nameOf(k.staff_id)}`, pages: contractPages(k, await loadLaborCtx(tenantId, me, k.staff_id)) }); }
    catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function archive(ks: Contract[]) {
    resetFolders();
    const errs: string[] = [];
    for (const [i, k] of ks.entries()) {
      setBusy(`Đang lưu vào hồ sơ ${i + 1}/${ks.length}: ${nameOf(k.staff_id)}`);
      try { await saveContractPdf(k, await loadLaborCtx(tenantId, me, k.staff_id)); } catch (e) { errs.push(`${nameOf(k.staff_id)}: ${errMsg(e)}`); }
    }
    setBusy('');
    toast(errs.length ? 'error' : 'ok', errs.length ? errs.join('\n') : `Đã lưu ${ks.length} hợp đồng vào hồ sơ`);
  }
  async function cancel(k: Contract) {
    const reason = window.prompt(`Hủy hợp đồng số ${k.number}? Số này giữ trong sổ, không cấp lại.\nNhập lý do hủy:`);
    if (!reason?.trim()) return;
    try { await rpc('cancel_labor_contract', { p_id: k.id, p_reason: reason }); toast('ok', `Đã hủy hợp đồng ${k.number}`); await load(); }
    catch (e) { toast('error', errMsg(e)); }
  }
  async function saveTerms() {
    const { error } = await supabase.from('tenant_settings').upsert([
      { key: 'hdld.ngay_tra_luong', value: terms.payDay }, { key: 'hdld.gio_ngay', value: terms.hours }, { key: 'hdld.ngay_nghi', value: terms.off },
    ], { onConflict: 'tenant_id,key' });
    if (error) return toast('error', error.message);
    toast('ok', 'Đã lưu điều khoản chung');
  }
  const nameOf = (id: string) => staff.find((s) => s.id === id)?.full_name ?? '';
  const state = (k: Contract) => {
    if (!k.end_on) return ['Không thời hạn', 'state-con_han'];
    const n = Math.round((Date.parse(k.end_on) - Date.parse(today())) / 86400000);
    return n < 0 ? ['Đã hết hạn', 'state-het_han'] : n <= 30 ? [`Còn ${n} ngày`, 'state-sap_het'] : ['Còn hạn', 'state-con_han'];
  };
  const actives = list.filter((k) => k.status === 'hieu_luc');

  return (
    <section className="card">
      <div className="item-head">
        <h2>Hợp đồng lao động năm {year} ({actives.length})</h2>
        <label className="inline">Năm <input type="number" min={2000} max={2100} value={year} style={{ width: 90 }} onChange={(e) => Number(e.target.value) >= 2000 && setYear(Number(e.target.value))} /></label>
      </div>
      <p className="small muted">Mỗi người mỗi năm 1 hợp đồng, mặc định từ 01/01 (hoặc ngày vào làm) đến 31/12. Số tự cấp 001/{year}/HĐLĐ-…, không trùng, không dùng lại số đã hủy.
        Lương mặc định lấy từ Lương chuyển khoản của tháng bắt đầu (Cấu hình › BHXH &amp; lương chuyển khoản), sửa được trên từng hợp đồng.
        Lưu hồ sơ: <b>Năm › Nhân sự › Hợp đồng lao động › họ tên</b>. Căn cứ pháp lý trong mẫu theo app cũ: cần xác minh.</p>
      <div className="actions" style={{ flexWrap: 'wrap' }}>
        {missing.length > 0 && <button className="btn small primary" disabled={!!busy} onClick={() => void createAll()}>Lập HĐ cho {missing.length} người chưa có</button>}
        {canArchive && actives.length > 0 && <button className="btn small" disabled={!!busy} onClick={() => void archive(actives)}>Lưu hồ sơ tất cả ({actives.length})</button>}
        {list.some((k) => k.status === 'da_huy') && <button className="btn small" onClick={() => setShowOld(!showOld)}>{showOld ? 'Ẩn HĐ đã hủy' : 'Hiện HĐ đã hủy'}</button>}
        {busy && <span className="small muted">{busy}</span>}
      </div>
      <div className="table-wrap">
        <table className="plist">
          <thead><tr><th>Số HĐLĐ</th><th>Họ và tên</th><th>Loại HĐ</th><th>Từ ngày</th><th>Đến ngày</th><th>Lương</th><th>Tình trạng</th><th /></tr></thead>
          <tbody>
            {people.map((s) => {
              const k = active(s.id);
              if (!k) return (
                <tr key={s.id}><td className="muted">Chưa lập</td><td><b>{s.full_name}</b><div className="small muted">{s.job_title || POSITION[s.position]}</div></td><td colSpan={5} />
                  <td><button className="btn small" aria-label={`Lập HĐ ${s.full_name}`} onClick={() => setF({ ...defaultsOf(s), req: crypto.randomUUID() })}>Lập HĐ</button></td></tr>
              );
              const [st, cls] = state(k);
              return (
                <tr key={s.id}>
                  <td><b>{k.number}</b></td><td><b>{s.full_name}</b><div className="small muted">{k.position}</div></td><td>{KIND_NAME[k.kind]}</td>
                  <td>{fmtDate(k.start_on)}</td><td>{k.end_on ? fmtDate(k.end_on) : '—'}</td><td className="r">{num(Number(k.salary))}</td><td className={cls}>{st}</td>
                  <td className="actions">
                    <button className="btn small" aria-label={`Xem HĐ ${s.full_name}`} disabled={!!busy} onClick={() => void show(k)}>Xem / in</button>
                    <button className="btn small" aria-label={`Sửa HĐ ${s.full_name}`} onClick={() => setF({ id: k.id, number: k.number, staff: s, kind: k.kind, start_on: k.start_on, end_on: k.end_on ?? '',
                      salary: String(k.salary), position: k.position ?? '', department: k.department ?? '', job_desc: k.job_desc ?? '',
                      allow: Object.fromEntries(ALLOW.map(([a]) => [a, k.allowances?.[a] ? String(k.allowances[a]) : ''])) as Form['allow'], req: '' })}>Sửa</button>
                    {canArchive && <button className="btn small" disabled={!!busy} onClick={() => void archive([k])}>Lưu hồ sơ</button>}
                    <button className="btn small link danger-text" onClick={() => void cancel(k)}>Hủy</button>
                  </td>
                </tr>
              );
            })}
            {showOld && list.filter((k) => k.status === 'da_huy').map((k) => (
              <tr key={k.id} className="muted"><td>{k.number}</td><td>{nameOf(k.staff_id)}</td><td colSpan={5} className="error-text small">Đã hủy: {k.cancel_reason}</td><td /></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sub form">
        <h3>Điều khoản chung trong hợp đồng</h3>
        <div className="grid3">
          <label>Ngày trả lương hằng tháng<input type="number" min={1} max={31} value={terms.payDay} disabled={!canTerms} onChange={(e) => setTerms({ ...terms, payDay: Number(e.target.value) })} /></label>
          <label>Giờ làm việc / ngày<input type="number" min={1} max={12} value={terms.hours} disabled={!canTerms} onChange={(e) => setTerms({ ...terms, hours: Number(e.target.value) })} /></label>
          <label>Ngày nghỉ hằng tuần<select value={terms.off} disabled={!canTerms} onChange={(e) => setTerms({ ...terms, off: e.target.value as Terms['off'] })}>
            <option value="CN">Chủ nhật (làm Thứ 2 → Thứ 7)</option><option value="T7CN">Thứ 7 và Chủ nhật (làm Thứ 2 → Thứ 6)</option></select></label>
        </div>
        {canTerms && <div className="actions"><button className="btn small" onClick={() => void saveTerms()}>Lưu điều khoản chung</button></div>}
      </div>

      {f && (
        <Modal wide title={f.id ? `Sửa hợp đồng ${f.number} · ${f.staff.full_name}` : `Lập hợp đồng lao động · ${f.staff.full_name}`} onClose={() => { if (!busy) setF(null); }}>
          <div className="form">
            <div className="grid2">
              <label>Số HĐLĐ<input value={f.number ?? 'Tự cấp khi lưu (001 trở đi)'} disabled /></label>
              <label>Loại hợp đồng<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}>
                {(Object.keys(KIND_NAME) as Kind[]).map((k) => <option key={k} value={k}>{KIND_NAME[k]}</option>)}</select></label>
              <label>Từ ngày<input type="date" value={f.start_on} onChange={(e) => setF({ ...f, start_on: e.target.value })} /></label>
              {f.kind !== 'khong_xac_dinh' && <label>Đến ngày<input type="date" value={f.end_on} onChange={(e) => setF({ ...f, end_on: e.target.value })} /></label>}
              <label>Lương theo công việc / chức danh (đồng/tháng)
                <input inputMode="numeric" aria-label="Lương ghi trên hợp đồng" value={parse(f.salary) ? num(parse(f.salary)) : ''} placeholder="0" onChange={(e) => setF({ ...f, salary: e.target.value })} />
                <small className="muted">Mặc định: lương chuyển khoản tháng {f.start_on.slice(5, 7)}/{f.start_on.slice(0, 4)} = {num(pay[`${f.staff.id}|${f.start_on.slice(0, 7)}`] ?? 0)} đ
                  {' '}<button type="button" className="btn small link" onClick={() => setF({ ...f, salary: String(pay[`${f.staff.id}|${f.start_on.slice(0, 7)}`] ?? 0) })}>Lấy lại</button></small></label>
              <label>Vị trí<input value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} /></label>
              <label>Phòng ban<input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></label>
            </div>
            <label>Công việc cần thực hiện (Phụ lục I, mỗi dòng một việc; để trống dùng mô tả chung như app cũ)
              <textarea rows={4} value={f.job_desc} onChange={(e) => setF({ ...f, job_desc: e.target.value })} /></label>
            <h4>Phụ lục II: phụ cấp, hỗ trợ (đồng/tháng, để trống = Không áp dụng)</h4>
            <div className="grid2">
              {ALLOW.map(([k, l]) => <label key={k}>{l}<input inputMode="numeric" value={parse(f.allow[k]) ? num(parse(f.allow[k])) : ''} placeholder="0" onChange={(e) => setF({ ...f, allow: { ...f.allow, [k]: e.target.value } })} /></label>)}
            </div>
            <div className="actions">
              <button className="btn primary" disabled={!!busy} onClick={() => void save()}>{f.id ? 'Lưu' : 'Lập & cấp số'}</button>
              <button className="btn" disabled={!!busy} onClick={() => setF(null)}>Đóng</button>
            </div>
          </div>
        </Modal>
      )}
      {view && <PaperView title={view.title} pages={view.pages.map((html) => ({ html, land: false }))} onClose={() => setView(null)} />}
    </section>
  );
}
