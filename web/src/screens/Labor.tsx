// Hợp đồng lao động (như app cũ): mỗi người mỗi năm 1 hợp đồng, lập tự động từ hồ sơ nhân sự, số tự cấp 001/<năm>/HĐLĐ-<ký hiệu>.
// Lương mặc định = lương chuyển khoản của tháng bắt đầu (Cấu hình › BHXH & lương chuyển khoản), sửa được trên từng HĐ.
// Xem / in, lưu PDF vào Năm › Nhân sự › Hợp đồng lao động › <họ tên>. Không xóa, chỉ hủy (giữ số).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtDate, today } from '../components/Documents';
import { CONTRACT_COLS, ContractEditor, contractArgs, contractDefaults, formOf, loadPay, useContracts, type CForm, type PayMap } from '../components/ContractEditor';
import { KIND_NAME, loadTerms, type Contract, type Terms } from '../lib/laborContract';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Staff { id: string; user_id: string | null; full_name: string; position: string; job_title: string | null; joined_on: string; left_on: string | null; is_active: boolean }
const POSITION: Record<string, string> = { lai_xe: 'Lái xe', phu_xe: 'Phụ xe', nhan_vien: 'Nhân viên' };
const num = (n: number) => n.toLocaleString('vi-VN');

export function LaborScreen({ ctx, perms }: { ctx: AccountContext; perms: Permissions }) {
  const toast = useToast();
  const tenantId = ctx.tenant_id ?? '';
  const me = useMemo(() => ({ id: ctx.user_id, name: ctx.full_name ?? '' }), [ctx.user_id, ctx.full_name]);
  const canArchive = perms.has('archive.manage');
  const canTerms = perms.has('settings.edit');
  // Ô quyền Hợp đồng lao động: Thêm / Sửa / Xóa. Không ai tự lập / sửa / hủy hợp đồng của chính mình (chỉ xem bản PDF).
  const canAdd = perms.has('labor.add'), canEdit = perms.has('labor.edit'), canDel = perms.has('labor.delete');
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const [staff, setStaff] = useState<Staff[]>([]);
  const [list, setList] = useState<Contract[]>([]);
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [pay, setPay] = useState<PayMap>({});
  const [terms, setTerms] = useState<Terms>({ payDay: 5, hours: 8, off: 'CN' });
  const [f, setF] = useState<CForm | null>(null);
  const [busy0, setBusy] = useState('');
  const C = useContracts(tenantId, me, canArchive);
  const busy = busy0 || C.busy;
  const [showOld, setShowOld] = useState(false);
  const [kieu, setKieuS] = useState<'bang' | 'the'>(() => { try { return localStorage.getItem('tms.hdld.kieu') === 'the' ? 'the' : 'bang'; } catch { return 'bang'; } });
  const setKieu = (v: 'bang' | 'the') => { setKieuS(v); try { localStorage.setItem('tms.hdld.kieu', v); } catch { /* chỉ đổi trong phiên */ } };

  const load = useCallback(async () => {
    const [s, c, p, m, t] = await Promise.all([
      supabase.from('staff_members').select('id, user_id, full_name, position, job_title, joined_on, left_on, is_active'),
      supabase.from('labor_contracts').select(CONTRACT_COLS).eq('year', year).order('seq'),
      supabase.from('staff_private').select('staff_id, contract_type'),
      loadPay(year),
      loadTerms(),
    ]);
    if (c.error) return toast('error', c.error.message);
    setStaff(((s.data ?? []) as Staff[]).sort((a, b) => a.full_name.localeCompare(b.full_name, 'vi')));
    setList((c.data ?? []) as Contract[]);
    setKinds(Object.fromEntries(((p.data ?? []) as { staff_id: string; contract_type: string | null }[]).map((x) => [x.staff_id, x.contract_type ?? ''])));
    setPay(m);
    setTerms(t);
  }, [year, toast]);
  useEffect(() => { void load(); }, [load]);

  // Người có làm trong năm: vào trước 31/12, chưa nghỉ trước 01/01
  const viewAll = perms.has('labor.view_all');   // không có: chỉ thấy hợp đồng của chính mình
  const people = staff.filter((s) => (viewAll || s.user_id === ctx.user_id) && s.joined_on <= `${year}-12-31` && (s.is_active || (s.left_on ?? '') >= `${year}-01-01`));
  const active = (id: string) => list.find((k) => k.staff_id === id && k.status === 'hieu_luc');
  const missing = people.filter((s) => !active(s.id) && s.user_id !== ctx.user_id);

  const defaultsOf = (s: Staff) => contractDefaults(s, year, kinds[s.id], pay);
  async function save() {
    if (f && await C.save(f)) { setF(null); await load(); }
  }
  async function createAll() {
    if (!missing.length) return;
    if (!window.confirm(`Lập hợp đồng năm ${year} cho ${missing.length} người chưa có (số cấp lần lượt theo tên)?`)) return;
    const errs: string[] = [], ids: string[] = [];
    for (const [i, s] of missing.entries()) {
      setBusy(`Đang lập ${i + 1}/${missing.length}: ${s.full_name}`);
      try { ids.push((await rpc<{ id: string }>('save_labor_contract', contractArgs(defaultsOf(s), crypto.randomUUID()))).id); } catch (e) { errs.push(`${s.full_name}: ${errMsg(e)}`); }
    }
    setBusy('');
    toast(errs.length ? 'error' : 'ok', errs.length ? errs.join('\n') : `Đã lập ${missing.length} hợp đồng`);
    await load();
    // như app cũ: lập / lưu hợp đồng là tự tạo PDF vào hồ sơ
    if (canArchive && ids.length) {
      const { data } = await supabase.from('labor_contracts').select(CONTRACT_COLS).in('id', ids);
      await C.archiveMany((data ?? []) as Contract[]);
    }
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

  /** Nút thao tác 1 người (dùng chung cho kiểu bảng và kiểu thẻ) */
  const acts = (s: (typeof people)[number], k: ReturnType<typeof active>) => !k
    ? (canAdd && s.user_id !== ctx.user_id ? <button className="btn small" aria-label={`Lập HĐ ${s.full_name}`} onClick={() => setF(defaultsOf(s))}>Lập HĐ</button> : null)
    : <>
      {canEdit && s.user_id !== ctx.user_id
        ? <button className="btn small" aria-label={`Xem HĐ ${s.full_name}`} disabled={!!busy} onClick={() => void C.show(k, s.full_name)}>Xem / in</button>
        : <button className="btn small" aria-label={`Xem HĐ ${s.full_name}`} disabled={!!busy} onClick={() => void C.showPdf(k, s.full_name)}>Xem hợp đồng (PDF)</button>}
      {canEdit && s.user_id !== ctx.user_id && <button className="btn small" aria-label={`Sửa HĐ ${s.full_name}`} onClick={() => setF(formOf(k, s))}>Sửa</button>}
      {canEdit && canArchive && s.user_id !== ctx.user_id && <button className="btn small" disabled={!!busy} onClick={() => void C.archive(k)}>Lưu hồ sơ</button>}
      {canDel && s.user_id !== ctx.user_id && <button className="btn small link danger-text" onClick={() => void cancel(k)}>Hủy</button>}
    </>;

  return (
    <section className="card">
      <div className="hd-bar">
        <h2>Hợp đồng lao động năm {year} ({actives.length})</h2>
        <div className="hd-tools">
          {canAdd && missing.length > 0 && <button className="btn small primary" disabled={!!busy} onClick={() => void createAll()}>Lập HĐ cho {missing.length} người chưa có</button>}
          {canEdit && canArchive && actives.length > 0 && <button className="btn small" disabled={!!busy} onClick={() => void C.archiveMany(actives)}>Lưu hồ sơ tất cả ({actives.length})</button>}
          {list.some((k) => k.status === 'da_huy') && <button className="btn small" onClick={() => setShowOld(!showOld)}>{showOld ? 'Ẩn HĐ đã hủy' : 'Hiện HĐ đã hủy'}</button>}
          <div className="seg" role="group" aria-label="Kiểu xem">
            <button type="button" className={kieu === 'bang' ? 'on' : ''} aria-pressed={kieu === 'bang'} onClick={() => setKieu('bang')}>Bảng</button>
            <button type="button" className={kieu === 'the' ? 'on' : ''} aria-pressed={kieu === 'the'} onClick={() => setKieu('the')}>Thẻ</button>
          </div>
          <span className="hd-year">Năm <input type="number" min={2000} max={2100} value={year} aria-label="Năm" onChange={(e) => Number(e.target.value) >= 2000 && setYear(Number(e.target.value))} /></span>
        </div>
      </div>
      {busy && <p className="small muted">{busy}</p>}
      {kieu === 'bang' ? (
      <div className="table-wrap">
        <table className="plist hd-tbl">
          <thead><tr><th>Số HĐLĐ</th><th>Họ và tên</th><th>Loại HĐ</th><th>Từ ngày</th><th>Đến ngày</th><th>Lương</th><th>Tình trạng</th><th /></tr></thead>
          <tbody>
            {people.map((s) => {
              const k = active(s.id);
              if (!k) return (
                <tr key={s.id}><td className="muted">Chưa lập</td><td><b>{s.full_name}</b><div className="small muted">{s.job_title || POSITION[s.position]}</div></td><td colSpan={5} />
                  <td className="actions">{acts(s, k)}</td></tr>
              );
              const [st, cls] = state(k);
              return (
                <tr key={s.id}>
                  <td><b>{k.number}</b></td><td><b>{s.full_name}</b><div className="small muted">{k.position}</div></td><td>{KIND_NAME[k.kind]}</td>
                  <td>{fmtDate(k.start_on)}</td><td>{k.end_on ? fmtDate(k.end_on) : '—'}</td><td className="r">{num(Number(k.salary))}</td><td className={cls}>{st}</td>
                  <td className="actions">{acts(s, k)}</td>
                </tr>
              );
            })}
            {showOld && list.filter((k) => k.status === 'da_huy').map((k) => (
              <tr key={k.id} className="muted"><td>{k.number}</td><td>{nameOf(k.staff_id)}</td><td colSpan={5} className="error-text small">Đã hủy: {k.cancel_reason}</td><td /></tr>
            ))}
          </tbody>
        </table>
      </div>
      ) : (
      <div className="hd-cards">
        {people.map((s) => {
          const k = active(s.id);
          const [st, cls] = k ? state(k) : ['Chưa lập', 'muted'];
          return (
            <div key={s.id} className="hd-card">
              <div className="hd-card-h"><b>{s.full_name}</b><span className={`small ${cls}`}>{st}</span></div>
              <div className="small muted">{k ? k.position : (s.job_title || POSITION[s.position])}</div>
              {k ? <div className="small">
                <div><b>{k.number}</b> · {KIND_NAME[k.kind]}</div>
                <div>{fmtDate(k.start_on)} → {k.end_on ? fmtDate(k.end_on) : 'không thời hạn'} · Lương {num(Number(k.salary))}</div>
              </div> : <div className="small muted">Chưa lập hợp đồng năm {year}</div>}
              <div className="actions">{acts(s, k)}</div>
            </div>
          );
        })}
        {showOld && list.filter((k) => k.status === 'da_huy').map((k) => (
          <div key={k.id} className="hd-card muted"><div className="hd-card-h"><b>{nameOf(k.staff_id)}</b><span className="small">{k.number}</span></div>
            <div className="error-text small">Đã hủy: {k.cancel_reason}</div></div>
        ))}
      </div>
      )}

      {canTerms && <div className="sub form">
        <h3>Điều khoản chung trong hợp đồng</h3>
        <div className="grid3">
          <label>Ngày trả lương hằng tháng<input type="number" min={1} max={31} value={terms.payDay} disabled={!canTerms} onChange={(e) => setTerms({ ...terms, payDay: Number(e.target.value) })} /></label>
          <label>Giờ làm việc / ngày<input type="number" min={1} max={12} value={terms.hours} disabled={!canTerms} onChange={(e) => setTerms({ ...terms, hours: Number(e.target.value) })} /></label>
          <label>Ngày nghỉ hằng tuần<select value={terms.off} disabled={!canTerms} onChange={(e) => setTerms({ ...terms, off: e.target.value as Terms['off'] })}>
            <option value="CN">Chủ nhật (làm Thứ 2 → Thứ 7)</option><option value="T7CN">Thứ 7 và Chủ nhật (làm Thứ 2 → Thứ 6)</option></select></label>
        </div>
        <div className="actions"><button className="btn small" onClick={() => void saveTerms()}>Lưu điều khoản chung</button></div>
      </div>}

      {f && <ContractEditor form={f} setForm={setF} pay={pay} busy={busy} onSave={() => void save()} onClose={() => setF(null)} />}
      {C.viewer}
    </section>
  );
}
