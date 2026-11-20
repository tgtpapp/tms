// Văn bản: sổ công văn / quyết định / thông báo có số. Soạn → xem trước → Lưu & cấp số (001 trở đi, mỗi loại 1 dãy theo năm,
// không trùng, không dùng lại) → xem / in, lưu PDF vào Lưu trữ hồ sơ. Không xóa, chỉ hủy (giữ số trong sổ).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { PaperView } from '../components/ProfilePapers';
import { WordEditor } from '../components/WordEditor';
import { fmtDate, today } from '../components/Documents';
import { resetFolders } from '../lib/dispatchPapers';
import {
  CODE_NAME, TEMPLATES, autoTitle, defaults, docPages, isWord, loadDocCtx, saveDocPdf, tplOf, type Content, type OfficialDoc, type Template,
} from '../lib/officialDocs';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Staff { id: string; full_name: string; is_active: boolean }
interface Form { id: string | null; number: string | null; template: Template; signed_on: string; title: string; titleAuto: boolean; staff_id: string; content: Content; req: string; archive: boolean }
type Field = { key: string; label: string; area?: number; type?: string; ph?: string; hint?: string };

const FIELDS: Record<Template, Field[]> = {
  qd_bo_nhiem: [
    { key: 'chuc_danh', label: 'Chức danh bổ nhiệm' }, { key: 'hieu_luc', label: 'Có hiệu lực từ ngày', type: 'date', hint: 'Để trống thì lấy ngày ký' },
    { key: 'trinh_do', label: 'Trình độ chuyên môn / chuyên ngành đào tạo' }, { key: 'tham_nien', label: 'Thâm niên trong lĩnh vực vận tải (năm)', type: 'number' },
    { key: 'phu_cap', label: 'Phụ cấp trách nhiệm / tháng (nếu có)', type: 'number' }, { key: 'noi_nhan', label: 'Nơi nhận (mỗi dòng một nơi)', area: 3 },
  ],
  qd_atgt: [
    { key: 'ten_ban', label: 'Tên Ban' }, { key: 'muc_dich', label: 'Mục đích (sau chữ "Xét yêu cầu")' },
    { key: 'thanh_vien', label: 'Thành viên (mỗi dòng: Họ tên | Chức vụ tại công ty | Chức danh trong Ban)', area: 5 },
    { key: 'nhiem_vu', label: 'Nhiệm vụ của Ban (mỗi dòng một nhiệm vụ)', area: 6 }, { key: 'noi_nhan', label: 'Nơi nhận (mỗi dòng một nơi)', area: 2 },
  ],
  qd_giam_sat: [
    { key: 'thoi_han_tu', label: 'Thời hạn thực hiện kể từ ngày', type: 'date', hint: 'Để trống thì lấy ngày hiệu lực' },
    { key: 'hieu_luc', label: 'Quyết định có hiệu lực từ ngày', type: 'date', hint: 'Để trống thì lấy ngày ký. Bộ phận lấy theo Phòng ban trong hồ sơ nhân viên. Căn cứ VBHN 58/VBHN-BXD, NĐ 218/2026 theo mẫu nhà xe: cần xác minh trước khi ký.' },
    { key: 'noi_nhan', label: 'Nơi nhận (mỗi dòng một nơi)', area: 3 },
  ],
  quyet_dinh: [
    { key: 'can_cu', label: 'Căn cứ (mỗi dòng một căn cứ)', area: 3 }, { key: 'dieu', label: 'Các điều (mỗi dòng là 1 Điều, tự đánh Điều 1, Điều 2…)', area: 6 },
    { key: 'noi_nhan', label: 'Nơi nhận (mỗi dòng một nơi)', area: 3 },
  ],
  cong_van: [
    { key: 'kinh_gui', label: 'Kính gửi (mỗi dòng một nơi)', area: 2 }, { key: 'noi_dung', label: 'Nội dung (mỗi dòng một đoạn)', area: 8 },
    { key: 'noi_nhan', label: 'Nơi nhận (mỗi dòng một nơi)', area: 3 },
  ],
  word_qd: [], word_cv: [], word_tb: [],
  thong_bao: [
    { key: 'noi_dung', label: 'Nội dung (mỗi dòng một đoạn)', area: 8 }, { key: 'noi_nhan', label: 'Nơi nhận (mỗi dòng một nơi)', area: 3 },
  ],
};

export function DocsScreen({ ctx, perms }: { ctx: AccountContext; perms: Permissions }) {
  const toast = useToast();
  const tenantId = ctx.tenant_id ?? '';
  const me = useMemo(() => ({ id: ctx.user_id, name: ctx.full_name ?? '' }), [ctx.user_id, ctx.full_name]);
  const canArchive = perms.has('archive.manage');
  const [docs, setDocs] = useState<OfficialDoc[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [year, setYear] = useState(today().slice(0, 4));
  const [code, setCode] = useState('');
  const [q, setQ] = useState('');
  const [f, setF] = useState<Form | null>(null);
  const [view, setView] = useState<{ title: string; pages: string[] } | null>(null);
  const [busy, setBusy] = useState('');
  const [noi, setNoi] = useState('');
  const [director, setDirector] = useState('');

  const load = useCallback(async () => {
    const [d, s, t, g] = await Promise.all([
      supabase.from('official_docs').select('id, template, code, year, seq, number, signed_on, title, staff_id, content, status, cancel_reason, created_at').order('year', { ascending: false }).order('code').order('seq', { ascending: false }),
      supabase.from('staff_members').select('id, full_name, is_active').order('full_name'),
      supabase.from('tenants').select('address').maybeSingle(),
      supabase.from('tenant_settings').select('value').eq('key', 'cong_ty.giam_doc').maybeSingle(),
    ]);
    if (d.error) return toast('error', d.error.message);
    setDocs((d.data ?? []) as OfficialDoc[]);
    setStaff((s.data ?? []) as Staff[]);
    setNoi(String((t.data as { address?: string | null } | null)?.address ?? '').split(',').pop()?.trim().replace(/^(tỉnh|thành phố|tp\.?)\s*/i, '') ?? '');
    setDirector(String((g.data as { value?: unknown } | null)?.value ?? ''));
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const years = [...new Set([today().slice(0, 4), ...docs.map((x) => String(x.year))])].sort().reverse();
  const ql = q.trim().toLowerCase();
  const shown = docs.filter((x) => String(x.year) === year && (!code || x.code === code)
    && (!ql || [x.number, x.title, staff.find((s) => s.id === x.staff_id)?.full_name].join(' ').toLowerCase().includes(ql)));
  const nameOf = (id: string | null) => (id ? staff.find((s) => s.id === id)?.full_name ?? '' : '');

  function startNew(t: Template) {
    const content = defaults(t, noi, director);
    setF({ id: null, number: null, template: t, signed_on: today(), title: autoTitle(t, content), titleAuto: true, staff_id: '', content, req: crypto.randomUUID(), archive: canArchive });
  }
  function startEdit(d: OfficialDoc) {
    setF({ id: d.id, number: d.number, template: d.template, signed_on: d.signed_on, title: d.title, titleAuto: false, staff_id: d.staff_id ?? '',
      content: { ...defaults(d.template, noi, director), ...d.content }, req: crypto.randomUUID(), archive: canArchive });
  }
  const setC = (k: string, v: string) => setF((x) => {
    if (!x) return x;
    const content = { ...x.content, [k]: v };
    return { ...x, content, title: x.titleAuto && autoTitle(x.template, content) ? autoTitle(x.template, content) : x.title };
  });

  async function preview(t: Template, number: string, signed: string, title: string, content: Content, staffId: string | null) {
    setBusy('Đang dựng văn bản…');
    try {
      const x = await loadDocCtx(tenantId, me, staffId);
      setView({ title: `${tplOf(t).name} · ${number}`, pages: docPages(t, number, signed, title, content, x) });
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function archive(d: OfficialDoc) {
    resetFolders();
    await saveDocPdf(d, await loadDocCtx(tenantId, me, d.staff_id));
  }

  async function save() {
    if (!f) return;
    if (!f.signed_on || !f.title.trim()) return toast('error', 'Nhập ngày ký và trích yếu');
    if (f.template === 'qd_bo_nhiem' && !f.staff_id) return toast('error', 'Chọn người được bổ nhiệm');
    if (f.template === 'qd_giam_sat' && !f.staff_id) return toast('error', 'Chọn người được giao nhiệm vụ giám sát');
    if (isWord(f.template) && !(f.content.html ?? '').replace(/<[^>]+>|&nbsp;/g, '').trim()) return toast('error', 'Văn bản đang trống: mở file Word, gõ nội dung hoặc nhờ AI soạn');
    setBusy(f.id ? 'Đang lưu…' : 'Đang cấp số…');
    try {
      const r = await rpc<{ id: string; number: string }>('save_official_doc', {
        p_id: f.id, p_template: f.template, p_signed_on: f.signed_on, p_title: f.title.trim(), p_staff_id: f.staff_id || null, p_content: f.content, p_request_id: f.id ? null : f.req,
      });
      toast('ok', f.id ? `Đã lưu văn bản số ${r.number}` : `Đã cấp số ${r.number}`);
      if (f.archive) {
        setBusy('Đang lưu PDF vào hồ sơ…');
        const { data } = await supabase.from('official_docs').select('id, template, code, year, seq, number, signed_on, title, staff_id, content, status, cancel_reason, created_at').eq('id', r.id).single();
        try { await archive(data as OfficialDoc); toast('ok', `Đã lưu văn bản ${r.number} vào hồ sơ`); }
        catch (e) { toast('error', `Đã cấp số ${r.number} nhưng chưa lưu được vào hồ sơ: ${errMsg(e)}`); }
      }
      setF(null);
      await load();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function cancel(d: OfficialDoc) {
    const reason = window.prompt(`Hủy văn bản số ${d.number}? Số này giữ trong sổ, không cấp lại.\nNhập lý do hủy:`);
    if (!reason?.trim()) return;
    try { await rpc('cancel_official_doc', { p_id: d.id, p_reason: reason }); toast('ok', `Đã hủy văn bản ${d.number}`); await load(); }
    catch (e) { toast('error', errMsg(e)); }
  }
  async function saveOne(d: OfficialDoc) {
    setBusy(`Đang lưu ${d.number} vào hồ sơ…`);
    try { await archive(d); toast('ok', `Đã lưu văn bản ${d.number} vào hồ sơ`); }
    catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }

  const fields = f ? FIELDS[f.template] : [];
  return (
    <section className="card">
      <div className="item-head">
        <h2>Văn bản ({shown.length})</h2>
        <select aria-label="Soạn văn bản mới" value="" onChange={(e) => { if (e.target.value) startNew(e.target.value as Template); }}>
          <option value="">+ Soạn văn bản…</option>
          {TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
        </select>
      </div>
      <div className="grid3 form">
        <label>Năm<select value={year} onChange={(e) => setYear(e.target.value)}>{years.map((y) => <option key={y}>{y}</option>)}</select></label>
        <label>Loại<select value={code} onChange={(e) => setCode(e.target.value)}><option value="">Tất cả</option>{Object.entries(CODE_NAME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Tìm<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Số, trích yếu, người liên quan" /></label>
      </div>
      <p className="small muted">Số tự cấp khi lưu: mỗi loại (Quyết định / Công văn / Thông báo) một dãy riêng theo năm ký, bắt đầu 001, không trùng, không dùng lại số đã hủy.
        Lưu PDF vào Lưu trữ hồ sơ: <b>Năm › Pháp lý công ty › loại văn bản</b>. Căn cứ pháp lý trong mẫu theo app cũ: cần xác minh.</p>
      {busy && <p className="upload">{busy}</p>}
      {shown.length === 0 ? <p className="muted">Chưa có văn bản năm {year}.</p> : (
        <div className="table-wrap">
          <table className="plist">
            <thead><tr><th>Số</th><th>Ngày ký</th><th>Loại</th><th>Trích yếu</th><th /></tr></thead>
            <tbody>{shown.map((d) => (
              <tr key={d.id} className={d.status === 'da_huy' ? 'muted' : ''}>
                <td><b>{d.number}</b></td>
                <td>{fmtDate(d.signed_on)}</td>
                <td>{tplOf(d.template).name}</td>
                <td>{d.title}{nameOf(d.staff_id) && <div className="small muted">{nameOf(d.staff_id)}</div>}
                  {d.status === 'da_huy' && <div className="small error-text">Đã hủy: {d.cancel_reason}</div>}</td>
                <td className="actions">
                  <button className="btn small" aria-label={`Xem văn bản ${d.number}`} onClick={() => void preview(d.template, d.number, d.signed_on, d.title, d.content, d.staff_id)}>Xem / in</button>
                  {d.status === 'hieu_luc' && <>
                    <button className="btn small" aria-label={`Sửa văn bản ${d.number}`} onClick={() => startEdit(d)}>Sửa</button>
                    {canArchive && <button className="btn small" disabled={!!busy} onClick={() => void saveOne(d)}>Lưu hồ sơ</button>}
                    <button className="btn small link danger-text" onClick={() => void cancel(d)}>Hủy</button>
                  </>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {f && (
        <Modal wide title={f.id ? `Sửa văn bản số ${f.number}` : `Soạn: ${tplOf(f.template).name}`} onClose={() => { if (!busy) setF(null); }}>
          <div className="form">
            <div className="grid2">
              <label>Số văn bản<input value={f.number ?? 'Tự cấp khi lưu (001 trở đi)'} disabled /></label>
              <label>Ngày ký<input type="date" value={f.signed_on} onChange={(e) => setF({ ...f, signed_on: e.target.value })} /></label>
              <label>Nơi ký<input value={f.content.noi ?? ''} onChange={(e) => setC('noi', e.target.value)} placeholder="vd: Đồng Nai" /></label>
              {f.template !== 'qd_atgt' && (
                <label>{f.template === 'qd_bo_nhiem' ? 'Người được bổ nhiệm' : f.template === 'qd_giam_sat' ? 'Người được giao nhiệm vụ' : 'Người liên quan (nếu có)'}
                  <select value={f.staff_id} onChange={(e) => setF({ ...f, staff_id: e.target.value })}>
                    <option value="">— Chọn nhân viên —</option>
                    {staff.filter((s) => s.is_active || s.id === f.staff_id).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                  </select></label>
              )}
            </div>
            <label>{f.template === 'cong_van' || f.template === 'word_cv' ? 'Trích yếu (V/v …)' : 'Trích yếu (Về việc …)'}
              <input value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value, titleAuto: false })}
                placeholder={f.template === 'cong_van' ? 'vd: đăng ký khai thác tuyến' : 'vd: Về việc khen thưởng'} /></label>
            {isWord(f.template) && <WordEditor html={f.content.html ?? ''} onChange={(h) => setF((x) => (x ? { ...x, content: { ...x.content, html: h } } : x))} />}
            {fields.map((x) => (
              <label key={x.key}>{x.label}
                {x.area ? <textarea rows={x.area} value={f.content[x.key] ?? ''} onChange={(e) => setC(x.key, e.target.value)} />
                  : <input type={x.type ?? 'text'} value={f.content[x.key] ?? ''} onChange={(e) => setC(x.key, e.target.value)} placeholder={x.ph} />}
                {x.hint && <small className="muted">{x.hint}</small>}
              </label>
            ))}
            {canArchive && <label className="check"><input type="checkbox" checked={f.archive} onChange={(e) => setF({ ...f, archive: e.target.checked })} /> Lưu PDF vào Lưu trữ hồ sơ</label>}
            <div className="actions">
              <button className="btn" disabled={!!busy} onClick={() => void preview(f.template, f.number ?? `……/${f.signed_on.slice(0, 4)}/${tplOf(f.template).code === 'QD' ? 'QĐ' : tplOf(f.template).code}-…`, f.signed_on, f.title, f.content, f.staff_id || null)}>Xem trước</button>
              <button className="btn primary" disabled={!!busy} onClick={() => void save()}>{f.id ? 'Lưu' : 'Lưu & cấp số'}</button>
            </div>
          </div>
        </Modal>
      )}
      {view && <PaperView title={view.title} pages={view.pages.map((html) => ({ html, land: false }))} onClose={() => setView(null)} />}
    </section>
  );
}
