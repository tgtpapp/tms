// Văn bản: sổ công văn / quyết định / thông báo có số. Soạn → xem trước → Lưu & cấp số (001 trở đi, mỗi loại 1 dãy theo năm,
// không trùng, không dùng lại) → xem / in, lưu PDF vào Lưu trữ hồ sơ. Không xóa, chỉ hủy (giữ số trong sổ).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { PaperView } from '../components/ProfilePapers';
import { WordEditor } from '../components/WordEditor';
import { fmtDate, today } from '../components/Documents';
import { resetFolders } from '../lib/dispatchPapers';
import {
  CODE_NAME, autoTitle, codeLabel, defaults, docPages, isWord, loadDocCtx, saveDocPdf, tplOf, tvPage, type Content, type DocCtx, type OfficialDoc, type Template,
} from '../lib/officialDocs';
import { TV_HT, TV_LY_DO, earliest, notice, tvFacts } from '../lib/resignation';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase, type AccountContext } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { sanitizeHtml } from '../lib/sanitize';

/** Menu soạn văn bản mới: nhóm gọn, tên ngắn. Điện thoại: khay trượt từ dưới lên; tablet / máy tính: thả xuống dưới nút. */
const MENU: [string, [Template, string][]][] = [
  ['Quyết định', [['qd_bo_nhiem', 'Bổ nhiệm người điều hành vận tải'], ['qd_atgt', 'Thành lập Ban An toàn giao thông'],
    ['qd_giam_sat', 'Giao nhiệm vụ giám sát ATGT (kèm hồ sơ theo dõi)'], ['qd_thoi_viec', 'Thôi việc (kèm đơn xin nghỉ việc)'], ['quyet_dinh', 'Quyết định khác']]],
  ['Công văn, thông báo', [['cong_van', 'Công văn'], ['thong_bao', 'Thông báo']]],
  ['Hợp đồng', [['hd_bai_xe', 'Thuê bãi đậu xe']]],
  ['Tự soạn từ file Word / AI', [['word_qd', 'Quyết định'], ['word_cv', 'Công văn'], ['word_tb', 'Thông báo']]],
];
function NewDocMenu({ onPick }: { onPick: (t: Template) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="pick-menu" ref={box}>
      <button type="button" className="btn primary" aria-label="Soạn văn bản mới" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>+ Soạn văn bản</button>
      {open && <>
        <div className="pick-backdrop" onClick={() => setOpen(false)} />
        <div className="pick-pop" role="menu" aria-label="Chọn mẫu văn bản">
          <div className="pick-title"><b>Soạn văn bản mới</b><button type="button" className="btn small link" onClick={() => setOpen(false)}>Đóng</button></div>
          {MENU.map(([g, items]) => (
            <div key={g} className="pick-group"><div className="pick-g">{g}</div>
              {items.map(([k, name]) => (
                <button key={k} type="button" role="menuitem" data-tpl={k} title={tplOf(k).name} onClick={() => { setOpen(false); onPick(k); }}>{name}</button>
              ))}
            </div>
          ))}
        </div>
      </>}
    </div>
  );
}
const addDay = (s: string) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
interface Staff { id: string; full_name: string; is_active: boolean; department: string | null }
interface Form { id: string | null; number: string | null; template: Template; signed_on: string; title: string; titleAuto: boolean; staff_id: string; content: Content; req: string; archive: boolean }
type Field = { key: string; label: string; area?: number; type?: string; ph?: string; hint?: string; options?: [string, string][] };

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
  word_qd: [], word_cv: [], word_tb: [], qd_thoi_viec: [],
  hd_bai_xe: [
    { key: 'vai_tro', label: 'Nhà xe là', options: [['thue', 'Bên thuê bãi (Bên B)'], ['cho_thue', 'Bên cho thuê bãi (Bên A)']] },
    { key: 'ben_ten', label: 'Tên bên kia (đơn vị / cá nhân)', ph: 'vd: Bến xe khách Biên Hòa' }, { key: 'ben_dia_chi', label: 'Địa chỉ bên kia' },
    { key: 'ben_mst', label: 'Mã số thuế / Số CCCD bên kia' }, { key: 'ben_dt', label: 'Điện thoại bên kia', type: 'tel' },
    { key: 'ben_dai_dien', label: 'Người đại diện bên kia' }, { key: 'ben_chuc_vu', label: 'Chức vụ người đại diện' },
    { key: 'ben_tk', label: 'Tài khoản ngân hàng bên kia' },
    { key: 'bai_dia_chi', label: 'Địa chỉ bãi đậu xe' }, { key: 'bai_quy_mo', label: 'Diện tích / số chỗ đậu', ph: 'vd: 1.000 m², 20 chỗ' },
    { key: 'so_xe', label: 'Biển số xe đậu (mỗi dòng một xe, để trống nếu không ghi)', area: 3 },
    { key: 'gia', label: 'Giá thuê (đồng/tháng)', type: 'number' }, { key: 'thanh_toan', label: 'Cách thanh toán', area: 2 },
    { key: 'tu_ngay', label: 'Hiệu lực từ ngày', type: 'date', hint: 'Để trống thì lấy ngày ký' }, { key: 'den_ngay', label: 'Đến ngày', type: 'date' },
    { key: 'khac', label: 'Thỏa thuận khác (mỗi dòng một ý, nếu có)', area: 3 },
  ],
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
  // Nghỉ việc: hồ sơ người được chọn (tính ngày báo trước, thâm niên…), ngày nghỉ người dùng đã tự sửa thì không tự gợi ý nữa
  const [tv, setTv] = useState<DocCtx | null>(null);
  const [tvTouched, setTvTouched] = useState(false);

  const load = useCallback(async () => {
    const [d, s, t, g] = await Promise.all([
      supabase.from('official_docs').select('id, template, code, year, seq, number, signed_on, title, staff_id, content, status, cancel_reason, created_at').order('year', { ascending: false }).order('code').order('seq', { ascending: false }),
      supabase.from('staff_members').select('id, full_name, is_active, department').order('full_name'),
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
    if (t === 'qd_thoi_viec') { content.ngay_don = today(); content.cap_nhat = perms.has('staff.edit') ? '1' : ''; }
    setTv(null); setTvTouched(false);
    setF({ id: null, number: null, template: t, signed_on: today(), title: autoTitle(t, content), titleAuto: true, staff_id: '', content, req: crypto.randomUUID(), archive: canArchive });
  }
  function startEdit(d: OfficialDoc) {
    setF({ id: d.id, number: d.number, template: d.template, signed_on: d.signed_on, title: d.title, titleAuto: false, staff_id: d.staff_id ?? '',
      content: { ...defaults(d.template, noi, director), ...d.content }, req: crypto.randomUUID(), archive: canArchive });
    setTv(null); setTvTouched(true);
  }
  // Nghỉ việc: đổi người → tải hồ sơ, gợi ý ngày nghỉ sớm nhất hợp lệ theo số ngày báo trước
  useEffect(() => {
    if (!f || f.template !== 'qd_thoi_viec' || !f.staff_id) { setTv(null); return; }
    let on = true;
    void loadDocCtx(tenantId, me, f.staff_id).then((x) => { if (on) setTv(x); }).catch((e) => toast('error', errMsg(e)));
    return () => { on = false; };
  }, [f?.template, f?.staff_id, tenantId, me, toast]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!tv?.person || tvTouched || !f || f.template !== 'qd_thoi_viec') return;
    const c = f.content;
    const v = c.hinh_thuc === 'hethan' && tv.person.hd?.end ? addDay(tv.person.hd.end) : c.ngay_don ? earliest(tv.person, c.ngay_don, tv.offSat) : '';
    if (v && v !== c.ngay_nghi) setC('ngay_nghi', v);
  }, [tv, tvTouched, f?.content.ngay_don, f?.content.hinh_thuc]);   // eslint-disable-line react-hooks/exhaustive-deps
  /** Sửa tự do: đưa bản đang dựng từ mẫu vào khung soạn (sửa từng chữ, mở Word, nhờ AI) */
  async function freeEdit(w: 'don' | 'qd') {
    if (!f) return;
    if (!f.staff_id) return toast('error', 'Chọn người nghỉ việc trước');
    try {
      const x = tv ?? await loadDocCtx(tenantId, me, f.staff_id);
      setC(w === 'don' ? 'html_don' : 'html_qd', tvPage(w, '', f.signed_on, f.title, f.content, x, true).replace(/^<div[^>]*>|<\/div>$/g, ''));
    } catch (e) { toast('error', errMsg(e)); }
  }
  const setC = (k: string, v: string) => setF((x) => {
    if (!x) return x;
    const content = { ...x.content, [k]: v };
    return { ...x, content, title: x.titleAuto && autoTitle(x.template, content) ? autoTitle(x.template, content) : x.title };
  });

  async function preview(t: Template, number: string, signed: string, title: string, content: Content, staffId: string | null, only?: 'don' | 'qd') {
    setBusy('Đang dựng văn bản…');
    try {
      const x = await loadDocCtx(tenantId, me, staffId);
      setView({ title: `${only === 'don' ? 'Đơn xin nghỉ việc' : only === 'qd' ? 'Quyết định thôi việc' : tplOf(t).name} · ${number}`, pages: docPages(t, number, signed, title, content, x, only) });
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
    if (f.template === 'qd_thoi_viec' && (!f.staff_id || !f.content.ngay_nghi)) return toast('error', 'Chọn người nghỉ việc và nhập ngày nghỉ');
    if (isWord(f.template) && !(f.content.html ?? '').replace(/<[^>]+>|&nbsp;/g, '').trim()) return toast('error', 'Văn bản đang trống: mở file Word, gõ nội dung hoặc nhờ AI soạn');
    setBusy(f.id ? 'Đang lưu…' : 'Đang cấp số…');
    try {
      const r = await rpc<{ id: string; number: string }>('save_official_doc', {
        p_id: f.id, p_template: f.template, p_signed_on: f.signed_on, p_title: f.title.trim(), p_staff_id: f.staff_id || null, p_content: f.content, p_request_id: f.id ? null : f.req,
      });
      toast('ok', f.id ? `Đã lưu văn bản số ${r.number}` : `Đã cấp số ${r.number}`);
      if (f.template === 'qd_thoi_viec' && f.content.cap_nhat === '1' && perms.has('staff.edit')) {
        try { await rpc('mark_staff_left', { p_staff_id: f.staff_id, p_left_on: f.content.ngay_nghi }); toast('ok', `Đã chuyển hồ sơ ${nameOf(f.staff_id)} sang Nghỉ việc`); }
        catch (e) { toast('error', `Chưa chuyển được hồ sơ sang Nghỉ việc: ${errMsg(e)}`); }
      }
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

  const pendingNo = (x: Form) => x.number ?? `……/${x.signed_on.slice(0, 4)}/${codeLabel(tplOf(x.template).code)}-…`;
  // Xem trước bên cạnh khi soạn (như app cũ): văn bản 2 phần (đơn + quyết định) xem theo thẻ
  const [pctx, setPctx] = useState<DocCtx | null>(null);
  const [pvTab, setPvTab] = useState<'don' | 'qd'>('qd');
  const fStaff = f?.staff_id ?? null, fOpen = !!f;
  useEffect(() => {
    if (!fOpen) { setPctx(null); return; }
    let on = true;
    void loadDocCtx(tenantId, me, fStaff || null).then((x) => { if (on) setPctx(x); }).catch(() => undefined);
    return () => { on = false; };
  }, [fOpen, fStaff, tenantId, me]);
  const livePages = useMemo(() => {
    if (!f || !pctx) return [];
    try { return docPages(f.template, pendingNo(f), f.signed_on, f.title, f.content, pctx, f.template === 'qd_thoi_viec' ? pvTab : undefined); } catch { return []; }
  }, [f, pctx, pvTab]);   // eslint-disable-line react-hooks/exhaustive-deps
  const fields = f ? FIELDS[f.template] : [];
  /** Form Nghỉ việc (như app cũ) + sửa tự do từng mẫu */
  function tvForm() {
    if (!f) return null;
    const c = f.content, p = tv?.person ?? null, k = p ? notice(p) : null;
    const min = p && c.ngay_don ? earliest(p, c.ngay_don, tv!.offSat) : '';
    const x = p ? tvFacts(p, c, tv!.offSat) : null;
    const thieu = c.hinh_thuc === 'don' && !!c.ngay_nghi && !!min && c.ngay_nghi < min;
    const others = staff.filter((s) => s.is_active && s.id !== f.staff_id);
    const dept = staff.find((s) => s.id === f.staff_id)?.department ?? null;
    const inp = (key: string, label: string, type = 'text', ph = '', list = '') => (
      <label>{label}<input type={type} value={c[key] ?? ''} list={list || undefined} placeholder={ph}
        onChange={(e) => { if (key === 'ngay_nghi') setTvTouched(true); setC(key, e.target.value); }} /></label>
    );
    const free = (w: 'don' | 'qd', name: string) => {
      const key = w === 'don' ? 'html_don' : 'html_qd', on = !!(c[key] ?? '').replace(/<[^>]+>|&nbsp;/g, '').trim();
      return (
        <div className="tv-free">
          <div className="actions">
            {!on && <button type="button" className="btn small" onClick={() => void freeEdit(w)}>✏️ Sửa tự do {name}</button>}
            {on && <button type="button" className="btn small" onClick={() => { if (window.confirm(`Bỏ các chỗ đã sửa tay, dựng lại ${name} từ thông tin đã nhập?`)) setC(key, ''); }}>↺ Dựng lại {name} theo mẫu</button>}
          </div>
          {on && <>
            <p className="small muted">Đang sửa tự do {name}: các ô nhập phía trên không còn tự thay vào {name} này. Sửa trực tiếp, mở file Word hoặc gõ yêu cầu cho AI soạn lại.</p>
            <WordEditor html={c[key] ?? ''} onChange={(h) => setF((y) => (y ? { ...y, content: { ...y.content, [key]: h } } : y))} />
          </>}
        </div>
      );
    };
    return (
      <>
        {p && (
          <div className={`tv-info${thieu ? ' warn' : ''}`}>
            <div><b>{k!.txt}</b>{c.hinh_thuc === 'thoathuan' ? ' (thỏa thuận thì không bắt buộc)' : ''}.{p.hd ? ` HĐLĐ số ${p.hd.number}.` : ' Chưa có hợp đồng lao động trong app.'}</div>
            {min && c.hinh_thuc === 'don' && <div>Ngày nghỉ sớm nhất hợp lệ: <b>{fmtDate(min)}</b> {thieu ? <span className="badge suspended">Thiếu báo trước</span> : <span className="badge">Đủ thời hạn báo trước</span>}</div>}
            {c.hinh_thuc === 'hethan' && p.hd?.end && <div>Hợp đồng hết hạn ngày <b>{fmtDate(p.hd.end)}</b>.</div>}
            {x?.tn && <div>Thời gian làm việc: <b>{x.tn}</b>{p.joined ? ` (từ ${fmtDate(p.joined)})` : ''}.</div>}
            {x?.han && <div>Hạn thanh toán lương, phép, trợ cấp và chốt BHXH: <b>{fmtDate(x.han)}</b> (14 ngày làm việc).</div>}
          </div>
        )}
        <datalist id="tv-staff">{[...others].sort((a, b) => Number(b.department === dept) - Number(a.department === dept)).map((s) => <option key={s.id} value={s.full_name} />)}</datalist>
        <h3>Đơn xin nghỉ việc</h3>
        <div className="grid2">
          {inp('ngay_don', 'Ngày làm đơn', 'date')}
          {inp('ngay_nghi', 'Xin nghỉ từ ngày (tự gợi ý theo ngày báo trước, sửa được)', 'date')}
          <label>Lý do nghỉ việc<select value={c.ly_do ?? ''} onChange={(e) => setC('ly_do', e.target.value)}>{TV_LY_DO.map((l) => <option key={l}>{l}</option>)}</select></label>
          {inp('truong_bp', 'Trưởng bộ phận (ký ý kiến)', 'text', 'Chọn hoặc gõ tên', 'tv-staff')}
        </div>
        {inp('ly_do_ct', 'Ghi rõ lý do (nếu cần)', 'text', 'vd: chuyển về quê chăm sóc bố mẹ')}
        <div className="grid2">
          {inp('nguoi_bg', 'Bàn giao công việc cho', 'text', 'Chọn hoặc gõ tên', 'tv-staff')}
          {inp('ngay_bg', 'Hoàn tất bàn giao trước ngày (trống: ngày làm việc cuối)', 'date')}
        </div>
        <label>Nội dung bàn giao (mỗi dòng một mục)<textarea rows={2} value={c.noi_dung_bg ?? ''} onChange={(e) => setC('noi_dung_bg', e.target.value)}
          placeholder={'vd: Xe 60B-123.45 kèm giấy tờ xe\nThẻ nhận dạng lái xe, đồng phục'} /></label>
        {free('don', 'đơn')}
        <h3>Quyết định thôi việc</h3>
        <label>Hình thức chấm dứt<select value={c.hinh_thuc ?? 'don'} onChange={(e) => setC('hinh_thuc', e.target.value)}>{TV_HT.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}</select></label>
        <label>Nơi nhận (mỗi dòng một nơi)<textarea rows={2} value={c.noi_nhan ?? ''} onChange={(e) => setC('noi_nhan', e.target.value)} /></label>
        {perms.has('staff.edit') && <label className="check"><input type="checkbox" checked={c.cap_nhat === '1'} onChange={(e) => setC('cap_nhat', e.target.checked ? '1' : '')} /> Khi lưu: chuyển hồ sơ nhân viên sang "Nghỉ việc" từ ngày nghỉ</label>}
        {free('qd', 'quyết định')}
      </>
    );
  }
  return (
    <section className="card">
      <div className="item-head">
        <h2>Văn bản ({shown.length})</h2>
        <NewDocMenu onPick={startNew} />
      </div>
      <div className="grid3 form">
        <label>Năm<select value={year} onChange={(e) => setYear(e.target.value)}>{years.map((y) => <option key={y}>{y}</option>)}</select></label>
        <label>Loại<select value={code} onChange={(e) => setCode(e.target.value)}><option value="">Tất cả</option>{Object.entries(CODE_NAME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Tìm<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Số, trích yếu, người liên quan" /></label>
      </div>
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
        <Modal xwide title={f.id ? `Sửa văn bản số ${f.number}` : `Soạn: ${tplOf(f.template).name}`} onClose={() => { if (!busy) setF(null); }}>
          <div className="doc-edit">
          <div className="form">
            <div className="grid2">
              <label>Số văn bản<input value={f.number ?? 'Tự cấp khi lưu (001 trở đi)'} disabled /></label>
              <label>Ngày ký<input type="date" value={f.signed_on} onChange={(e) => setF({ ...f, signed_on: e.target.value })} /></label>
              <label>Nơi ký<input value={f.content.noi ?? ''} onChange={(e) => setC('noi', e.target.value)} placeholder="vd: Đồng Nai" /></label>
              {f.template !== 'qd_atgt' && f.template !== 'hd_bai_xe' && (
                <label>{f.template === 'qd_bo_nhiem' ? 'Người được bổ nhiệm' : f.template === 'qd_giam_sat' ? 'Người được giao nhiệm vụ' : f.template === 'qd_thoi_viec' ? 'Người nghỉ việc' : 'Người liên quan (nếu có)'}
                  <select value={f.staff_id} onChange={(e) => setF({ ...f, staff_id: e.target.value })}>
                    <option value="">— Chọn nhân viên —</option>
                    {staff.filter((s) => s.is_active || s.id === f.staff_id).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                  </select></label>
              )}
            </div>
            <label>{f.template === 'cong_van' || f.template === 'word_cv' ? 'Trích yếu (V/v …)' : 'Trích yếu (Về việc …)'}
              <input value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value, titleAuto: false })}
                placeholder={f.template === 'cong_van' ? 'vd: đăng ký khai thác tuyến' : 'vd: Về việc khen thưởng'} /></label>
            {f.template === 'qd_thoi_viec' && tvForm()}
            {isWord(f.template) && <WordEditor html={f.content.html ?? ''} onChange={(h) => setF((x) => (x ? { ...x, content: { ...x.content, html: h } } : x))} />}
            {fields.map((x) => (
              <label key={x.key}>{x.label}
                {x.options ? <select value={f.content[x.key] ?? ''} onChange={(e) => setC(x.key, e.target.value)}>{x.options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  : x.area ? <textarea rows={x.area} value={f.content[x.key] ?? ''} onChange={(e) => setC(x.key, e.target.value)} />
                  : <input type={x.type ?? 'text'} value={f.content[x.key] ?? ''} onChange={(e) => setC(x.key, e.target.value)} placeholder={x.ph} />}
                {x.hint && <small className="muted">{x.hint}</small>}
              </label>
            ))}
            {canArchive && <label className="check"><input type="checkbox" checked={f.archive} onChange={(e) => setF({ ...f, archive: e.target.checked })} /> Lưu PDF vào Lưu trữ hồ sơ</label>}
            <div className="actions">
              {f.template === 'qd_thoi_viec' && <button className="btn" disabled={!!busy} onClick={() => void preview(f.template, pendingNo(f), f.signed_on, f.title, f.content, f.staff_id || null, 'don')}>Xem đơn</button>}
              <button className="btn" disabled={!!busy} onClick={() => void preview(f.template, pendingNo(f), f.signed_on, f.title, f.content, f.staff_id || null, f.template === 'qd_thoi_viec' ? 'qd' : undefined)}>{f.template === 'qd_thoi_viec' ? 'Xem quyết định' : 'Xem trước'}</button>
              <button className="btn primary" disabled={!!busy} onClick={() => void save()}>{f.id ? 'Lưu' : 'Lưu & cấp số'}</button>
            </div>
          </div>
          <aside className="doc-pv" aria-label="Xem trước">
            {f.template === 'qd_thoi_viec' && (
              <div className="vx-tabs" role="tablist" aria-label="Phần văn bản">
                {([['don', 'Đơn xin nghỉ việc'], ['qd', 'Quyết định thôi việc']] as const).map(([k, l]) =>
                  <button key={k} type="button" role="tab" aria-selected={pvTab === k} className={pvTab === k ? 'on' : ''} onClick={() => setPvTab(k)}>{l}</button>)}
              </div>
            )}
            {!livePages.length && <p className="small muted">Đang dựng bản xem trước…</p>}
            {livePages.map((html, i) => <div key={i} className="lenh dp" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />)}
          </aside>
          </div>
        </Modal>
      )}
      {view && <PaperView title={view.title} pages={view.pages.map((html) => ({ html, land: false }))} onClose={() => setView(null)} />}
    </section>
  );
}
