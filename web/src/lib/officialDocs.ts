// Văn bản (công văn, quyết định, thông báo): mẫu in + lưu PDF vào Lưu trữ hồ sơ (như các mẫu quyết định của app cũ).
// Lưu: <năm ký> / Pháp lý công ty / <loại văn bản> (khớp cả thư mục "01. Pháp lý công ty"); lưu lại thì thay bản cũ.
// Căn cứ pháp lý ghi trong mẫu: theo app cũ, cần xác minh.
import { supabase } from './supabase';
import { boss, bossCol, company, signCol, type Boss, type Company } from './profilePapers';
import { loadSigns, type Sign } from './signatures';
import { TV_LY_DO, tvBlank, tvDonHtml, tvQdHtml, type TvPerson } from './resignation';
import { savePdf } from './dispatchPapers';
import { paginate } from './pdfMaker';

export type Template = 'qd_bo_nhiem' | 'qd_atgt' | 'qd_giam_sat' | 'cong_van' | 'quyet_dinh' | 'thong_bao' | 'word_qd' | 'word_cv' | 'word_tb' | 'qd_thoi_viec';
export const isWord = (t: Template) => t.startsWith('word_');
export type Content = Record<string, string>;
export interface OfficialDoc {
  id: string; template: Template; code: DocCode; year: number; seq: number; number: string; signed_on: string; title: string;
  staff_id: string | null; content: Content; status: 'hieu_luc' | 'da_huy'; cancel_reason: string | null; created_at: string;
}

export type DocCode = 'QD' | 'CV' | 'TB' | 'QDTV';
export const TEMPLATES: { key: Template; name: string; folder: string; code: DocCode }[] = [
  { key: 'qd_bo_nhiem', name: 'Quyết định bổ nhiệm người điều hành vận tải', folder: 'Quyết định bổ nhiệm người điều hành', code: 'QD' },
  { key: 'qd_atgt', name: 'Quyết định thành lập Ban An toàn giao thông', folder: 'Quyết định thành lập Ban ATGT', code: 'QD' },
  { key: 'qd_giam_sat', name: 'Quyết định giao nhiệm vụ giám sát, quản lý ATGT (kèm bộ hồ sơ theo dõi)', folder: 'Quyết định giao nhiệm vụ', code: 'QD' },
  { key: 'quyet_dinh', name: 'Quyết định khác', folder: 'Quyết định', code: 'QD' },
  { key: 'qd_thoi_viec', name: 'Đơn xin nghỉ việc + Quyết định thôi việc', folder: 'Nghỉ việc', code: 'QDTV' },
  { key: 'cong_van', name: 'Công văn', folder: 'Công văn', code: 'CV' },
  { key: 'thong_bao', name: 'Thông báo', folder: 'Thông báo', code: 'TB' },
  { key: 'word_qd', name: 'Quyết định tự soạn (từ file Word / AI)', folder: 'Quyết định', code: 'QD' },
  { key: 'word_cv', name: 'Công văn tự soạn (từ file Word / AI)', folder: 'Công văn', code: 'CV' },
  { key: 'word_tb', name: 'Thông báo tự soạn (từ file Word / AI)', folder: 'Thông báo', code: 'TB' },
];
/** Các ô điền tự động trong văn bản tự soạn: gõ hoặc chèn vào văn bản, khi xem / in / lưu sẽ thay bằng thông tin thật. */
export const FIELDS: [string, string][] = [
  ['{Số văn bản}', 'Số văn bản (cấp khi lưu)'], ['{Ngày ký}', 'ngày … tháng … năm …'], ['{Ngày ký ngắn}', 'dd/mm/yyyy'], ['{Nơi ký}', 'Nơi ký'],
  ['{Trích yếu}', 'Trích yếu'], ['{Công ty}', 'Tên công ty (in hoa)'], ['{Tên công ty}', 'Tên công ty'], ['{Địa chỉ công ty}', 'Địa chỉ công ty'],
  ['{Giám đốc}', 'Họ tên giám đốc'], ['{Chữ ký giám đốc}', 'Khối ký: chức danh, chữ ký, con dấu, họ tên'],
  ['{Ông/Bà}', 'Ông / Bà'], ['{Họ tên}', 'Họ tên người được chọn'], ['{HỌ TÊN}', 'HỌ TÊN in hoa'], ['{Ngày sinh}', 'Ngày sinh'], ['{Giới tính}', 'Giới tính'],
  ['{Số CCCD}', 'Số CCCD'], ['{Ngày cấp CCCD}', 'Ngày cấp CCCD'], ['{Nơi cấp CCCD}', 'Nơi cấp CCCD'], ['{Địa chỉ thường trú}', 'Nơi thường trú'],
  ['{Chỗ ở hiện nay}', 'Chỗ ở hiện nay'], ['{Điện thoại}', 'Điện thoại'], ['{Chức vụ}', 'Chức vụ'], ['{Ngày vào làm}', 'Ngày vào công ty'],
  ['{Chữ ký và dấu}', 'Chữ ký giám đốc + con dấu (đặt trong ô ký)'], ['{Chữ ký người làm đơn}', 'Chữ ký của người được chọn'],
];
export const tplOf = (k: Template) => TEMPLATES.find((t) => t.key === k)!;
export const CODE_NAME: Record<string, string> = { QD: 'Quyết định', QDTV: 'Quyết định thôi việc', CV: 'Công văn', TB: 'Thông báo' };
/** Ký hiệu in trong số văn bản */
export const codeLabel = (c: DocCode) => (c === 'QD' ? 'QĐ' : c === 'QDTV' ? 'QĐTV' : c);

/** Nội dung mặc định khi soạn mới (theo app cũ). */
export function defaults(t: Template, noi: string, director: string): Content {
  const base = { noi };
  if (isWord(t)) return { ...base, html: '' };
  if (t === 'qd_thoi_viec') return { ...base, ngay_don: '', ngay_nghi: '', ly_do: TV_LY_DO[0]!, ly_do_ct: '', truong_bp: '', nguoi_bg: '', ngay_bg: '', noi_dung_bg: '',
    hinh_thuc: 'don', cap_nhat: '1', noi_nhan: '- Như Điều 4;\n- Lưu: VT, HS.', html_don: '', html_qd: '' };
  if (t === 'qd_bo_nhiem') return { ...base, chuc_danh: 'Người trực tiếp điều hành hoạt động vận tải', hieu_luc: '', trinh_do: '', tham_nien: '', phu_cap: '',
    noi_nhan: '- Như Điều 4;\n- Sở GTVT (để khai hồ sơ GPKD);\n- Lưu: VT, HS.' };
  if (t === 'qd_atgt') return { ...base, ten_ban: 'Ban An toàn giao thông',
    muc_dich: 'tăng cường công tác bảo đảm trật tự, an toàn giao thông trong hoạt động kinh doanh vận tải hành khách',
    thanh_vien: `${director || '……………………'} | Giám đốc | Trưởng ban\n…………………… | Phụ trách điều hành | Phó ban\n…………………… | Kế toán | Thành viên\n…………………… | Lái xe đại diện | Thành viên`,
    nhiem_vu: ['Xây dựng, tổ chức thực hiện quy chế quản lý an toàn giao thông của công ty.', 'Kiểm tra điều kiện an toàn kỹ thuật của xe, giấy tờ xe và lái xe trước khi khởi hành.',
      'Quản lý hồ sơ, sức khỏe, thời gian lái xe và tập huấn nghiệp vụ cho lái xe, nhân viên phục vụ trên xe.', 'Phổ biến, nhắc nhở lái xe chấp hành pháp luật giao thông; xử lý hoặc đề xuất xử lý vi phạm.',
      'Thống kê, báo cáo và phối hợp điều tra, giải quyết khi xảy ra tai nạn giao thông.', 'Phối hợp với cơ quan chức năng trong công tác bảo đảm an toàn giao thông.'].join('\n'), noi_nhan: '- Như Điều 4;\n- Lưu: VT.' };
  if (t === 'qd_giam_sat') return { ...base, hieu_luc: '', thoi_han_tu: '', noi_nhan: '- Như Điều 6;\n- Bộ phận điều hành, kỹ thuật, nhân sự;\n- Lưu: VT, HS.' };
  if (t === 'cong_van') return { ...base, kinh_gui: '', noi_dung: '', noi_nhan: '- Như trên;\n- Lưu: VT.' };
  if (t === 'quyet_dinh') return { ...base, can_cu: 'Căn cứ Điều lệ tổ chức và hoạt động của Công ty;', dieu: '', noi_nhan: '- Như Điều …;\n- Lưu: VT.' };
  return { ...base, noi_dung: '', noi_nhan: '- Toàn thể nhân viên;\n- Lưu: VT.' };
}
/** Trích yếu tự đặt theo mẫu (người dùng vẫn sửa được). */
export const autoTitle = (t: Template, c: Content) =>
  t === 'qd_bo_nhiem' ? `Về việc bổ nhiệm ${c.chuc_danh || 'Người trực tiếp điều hành hoạt động vận tải'}`
    : t === 'qd_atgt' ? `Về việc thành lập ${c.ten_ban || 'Ban An toàn giao thông'}`
    : t === 'qd_giam_sat' ? 'Về việc giao nhiệm vụ giám sát, quản lý an toàn giao thông và bộ hồ sơ theo dõi thực hiện'
    : t === 'qd_thoi_viec' ? 'Về việc chấm dứt hợp đồng lao động' : '';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const lines = (s: string | undefined) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
const dm = (iso: string | undefined) => { if (!iso) return 'ngày ..... tháng ..... năm ......'; const [y, m, d] = iso.split('-'); return `ngày ${d} tháng ${m} năm ${y}`; };
const dd = (iso: string | null | undefined) => (iso ? iso.split('-').reverse().join('/') : '......./....../..........');
const dots = (v: string | null | undefined, n = 30) => (v ? `<b>${esc(v)}</b>` : '.'.repeat(n));
const money = (n: number) => n.toLocaleString('vi-VN');

export interface DocCtx { company: Company; boss: Boss; title: string; person: Person | null; offSat: boolean }
export interface Person extends TvPerson { address: string | null; current: string | null }

/** Lấy dữ liệu để in: công ty, chữ ký giám đốc + con dấu, người liên quan. */
export async function loadDocCtx(tenantId: string, me: { id: string | null; name: string }, staffId: string | null): Promise<DocCtx> {
  const [c, b, ct, person] = await Promise.all([
    company(), boss(tenantId, me),
    supabase.from('tenant_settings').select('key, value').in('key', ['cong_ty.chuc_danh_ky', 'hdld.ngay_nghi']),
    staffId ? loadPerson(tenantId, staffId) : Promise.resolve(null),
  ]);
  const set = (k: string) => String(((ct.data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value ?? '');
  return { company: c, boss: b.b, title: set('cong_ty.chuc_danh_ky') || 'Giám đốc', person, offSat: set('hdld.ngay_nghi') === 'T7CN' };
}
async function loadPerson(tenantId: string, id: string): Promise<Person | null> {
  const [s, p, d, k, sg] = await Promise.all([
    supabase.from('staff_members').select('full_name, phone, job_title, position, joined_on, department, user_id').eq('id', id).maybeSingle(),
    supabase.from('staff_private').select('birth_date, gender, address, current_address').eq('staff_id', id).maybeSingle(),
    supabase.from('documents').select('doc_no, issued_on, issuer, data').eq('staff_id', id).eq('doc_type', 'cccd').eq('is_current', true).maybeSingle(),
    supabase.from('labor_contracts').select('number, kind, start_on, end_on').eq('staff_id', id).eq('status', 'hieu_luc').order('start_on', { ascending: false }).limit(1).maybeSingle(),
    loadSigns(tenantId, [`nv_${id}`], true).catch(() => new Map<string, Sign>()),
  ]);
  if (!s.data) return null;
  const hd = k.data as { number: string; kind: string; start_on: string; end_on: string | null } | null;
  const own = sg.get(`nv_${id}`);
  const pv = p.data as { birth_date: string | null; gender: string | null; address: string | null; current_address?: string | null } | null;
  const sm = s.data as { full_name: string; phone: string | null; job_title: string | null; position: string; joined_on: string; department: string | null };
  const cd = d.data as { doc_no: string | null; issued_on: string | null; issuer: string | null; data: Record<string, unknown> | null } | null;
  return { current: pv?.current_address ?? null, phone: sm.phone, job: sm.job_title || ({ lai_xe: 'Lái xe', phu_xe: 'Phụ xe', nhan_vien: 'Nhân viên' } as Record<string, string>)[sm.position] || null,
    joined: sm.joined_on, dept: sm.department, name: sm.full_name, birth: pv?.birth_date ?? null, gender: pv?.gender === 'nu' ? 'Nữ' : pv?.gender === 'nam' ? 'Nam' : null,
    cccd: cd?.doc_no ?? null, cccdOn: cd?.issued_on ?? null, cccdBy: cd?.issuer ?? null, address: pv?.address || String(cd?.data?.['nv.noi_thuong_tru'] ?? '') || null,
    sign: own?.img ? own : null, hd: hd ? { number: hd.number, kind: hd.kind, start: hd.start_on, end: hd.end_on } : null };
}

const head = (x: DocCtx, number: string, signed: string, noi: string, vv?: string) => `<table style="width:100%;border-collapse:collapse"><tr>
  <td style="width:44%;text-align:center;vertical-align:top"><b>${esc(x.company.name.toUpperCase())}</b><div style="width:90px;border-top:1px solid #000;margin:3px auto"></div>Số: ${esc(number)}
    ${vv ? `<div style="font-size:12.5px;margin-top:2px">V/v ${esc(vv.replace(/^V\/v\s*/i, ''))}</div>` : ''}</td>
  <td style="text-align:center;vertical-align:top"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><b>Độc lập - Tự do - Hạnh phúc</b><div style="width:150px;border-top:1px solid #000;margin:3px auto"></div><i>${esc(noi || '……………')}, ${dm(signed)}</i></td></tr></table>`;
const foot = (x: DocCtx, noiNhan: string, title?: string[]) => `<table style="width:100%;border-collapse:collapse;margin-top:14px"><tr>
  <td style="width:50%;vertical-align:top;font-size:13px"><b><i>Nơi nhận:</i></b>${lines(noiNhan).map((l) => `<br>${esc(l)}`).join('')}</td>
  ${bossCol(x.boss, (title ?? [x.title]).map((l) => esc(l.toUpperCase())).join('<br>'), 50)}</tr></table>`;
const wrap = (s: string) => `<div style="font-size:14px;line-height:1.5;text-align:justify">${s}</div>`;

/** Văn bản tự soạn: thay các ô {…} bằng thông tin thật. */
export function fillFields(html: string, number: string, signed: string, title: string, c: Content, x: DocCtx): string {
  const e = x.person;
  const sign = `<table style="width:100%;border-collapse:collapse"><tr><td style="width:50%"></td>${bossCol(x.boss, esc(x.title.toUpperCase()), 50)}</tr></table>`;
  const map: Record<string, string> = {
    '{Số văn bản}': esc(number), '{Ngày ký}': dm(signed), '{Ngày ký ngắn}': dd(signed), '{Nơi ký}': esc(c.noi || '……………'), '{Trích yếu}': esc(title),
    '{Công ty}': esc(x.company.name.toUpperCase()), '{Tên công ty}': esc(x.company.name), '{Địa chỉ công ty}': esc(x.company.address),
    '{Giám đốc}': esc(x.boss.gdName), '{Chữ ký giám đốc}': sign,
    '{Ông/Bà}': e?.gender === 'Nữ' ? 'Bà' : 'Ông', '{Họ tên}': dots(e?.name), '{HỌ TÊN}': dots(e?.name.toUpperCase()), '{Ngày sinh}': dd(e?.birth),
    '{Giới tính}': dots(e?.gender, 8), '{Số CCCD}': dots(e?.cccd, 14), '{Ngày cấp CCCD}': dd(e?.cccdOn), '{Nơi cấp CCCD}': dots(e?.cccdBy, 14),
    '{Địa chỉ thường trú}': dots(e?.address, 30), '{Chỗ ở hiện nay}': dots(e?.current, 30), '{Điện thoại}': dots(e?.phone, 12), '{Chức vụ}': dots(e?.job, 14),
    '{Ngày vào làm}': dd(e?.joined),
    '{Chữ ký và dấu}': bossInner(x.boss), '{Chữ ký người làm đơn}': e?.sign?.img ? `<img src="${e.sign.img}" alt="" style="max-height:64px;max-width:190px">` : '',
  };
  // Word hay tách chữ trong ô {…} ra nhiều đoạn định dạng: gom lại trước khi thay
  return html.replace(/\{(?:<[^>]+>|[^{}<])*\}/g, (m) => { const k = m.replace(/<[^>]+>/g, ''); return map[k] ?? m; });
}
/** Ô chữ ký giám đốc + con dấu (như bossCol) */
const bossInner = (b: Boss) => `${b.seal ? `<img src="${b.seal}" alt="" style="position:absolute;left:50%;top:0;height:94px;transform:translateX(-78%);opacity:.9">` : ''}${b.gd?.img ? `<img src="${b.gd.img}" alt="" style="position:relative;max-height:70px;max-width:180px">` : ''}`;
/** Đơn / quyết định thôi việc: dựng từ mẫu (snap = bản đưa vào khung sửa tự do: ảnh chữ ký, số văn bản thành ô {…}) */
export function tvPage(which: 'don' | 'qd', number: string, signed: string, title: string, c: Content, x: DocCtx, snap = false): string {
  const p = x.person ?? tvBlank;
  const sgBoss = signCol(esc(x.title.toUpperCase()), '(Ký tên, đóng dấu)', snap ? '{Chữ ký và dấu}' : bossInner(x.boss), x.boss.gdName, x.boss.gd ?? { img: null, hasName: false }, 50);
  const sgMe = snap ? '{Chữ ký người làm đơn}' : p.sign?.img ? `<img src="${p.sign.img}" alt="" style="max-height:64px;max-width:190px">` : '';
  const o = { co: x.company.name, number: snap ? '{Số văn bản}' : number, signed, title, c, p, offSat: x.offSat, sgBoss, sgMe };
  return wrap(which === 'don' ? tvDonHtml(o) : tvQdHtml(o));
}
/** Các trang in của văn bản: văn bản tự soạn tự chia trang A4; mẫu có sẵn 1 trang (dài thì thu nhỏ vừa trang). */
export function docPages(t: Template, number: string, signed: string, title: string, c: Content, x: DocCtx, only?: 'don' | 'qd'): string[] {
  if (t === 'qd_thoi_viec') {
    return (only ? [only] : ['don', 'qd'] as const).map((w) => {
      const own = w === 'don' ? c.html_don : c.html_qd;
      return own?.replace(/<[^>]+>|&nbsp;/g, '').trim() ? wrap(fillFields(own, number, signed, title, c, x)) : tvPage(w, number, signed, title, c, x);
    });
  }
  if (t === 'qd_giam_sat') return paginate(giamSatBlocks(number, signed, title, c, x).map((b) => `<div style="font-size:14px;line-height:1.5;text-align:justify">${b}</div>`));
  if (!isWord(t)) return [docHtml(t, number, signed, title, c, x)];
  const filled = fillFields(c.html || '', number, signed, title, c, x);
  const box = document.createElement('div');
  box.innerHTML = filled;
  const blocks = Array.from(box.childNodes).map((n) => (n instanceof Element ? n.outerHTML : (n.textContent ?? '').trim() ? `<p>${esc(n.textContent ?? '')}</p>` : '')).filter(Boolean);
  return paginate(blocks.map((b) => `<div style="font-size:14px;line-height:1.5">${b}</div>`));
}

/** Trang in của 1 văn bản. number: số đã cấp, hoặc chữ chờ khi xem trước bản chưa lưu. */
export function docHtml(t: Template, number: string, signed: string, title: string, c: Content, x: DocCtx): string {
  const co = x.company.name || 'Công ty', CO = co.toUpperCase();
  if (t === 'qd_bo_nhiem') {
    const e = x.person, ong = e?.gender === 'Nữ' ? 'Bà' : 'Ông', cd = c.chuc_danh || 'Người trực tiếp điều hành hoạt động vận tải', hl = c.hieu_luc || signed;
    const li = (l: string, v: string) => `<li style="margin:3px 0"><b>${l}:</b> ${v}</li>`;
    const tasks = ['Trực tiếp tổ chức, điều hành hoạt động vận tải của phương tiện và người lái xe thuộc đơn vị, bảo đảm tuân thủ đúng quy định pháp luật.',
      'Quản lý, theo dõi dữ liệu từ thiết bị giám sát hành trình (GPS) và camera lắp trên xe; kịp thời phát hiện, nhắc nhở và chấn chỉnh lái xe vi phạm tốc độ, thời gian lái xe.',
      'Tổ chức lập và lưu trữ hồ sơ, lý lịch phương tiện, lý lịch hành nghề của lái xe; theo dõi công tác bảo dưỡng, kiểm định và an toàn kỹ thuật phương tiện.',
      'Chịu trách nhiệm trước Giám đốc và trước pháp luật về công tác quản lý an toàn giao thông và điều hành vận tải của đơn vị.'];
    return wrap(`${head(x, number, signed, c.noi)}
      <h2 style="text-align:center;margin:16px 0 2px;font-size:19px">QUYẾT ĐỊNH</h2><div style="text-align:center;font-weight:bold;margin-bottom:10px">${esc(title)}</div>
      <div style="text-align:center;font-weight:bold;margin-bottom:8px">GIÁM ĐỐC ${esc(CO)}</div>
      <div style="font-style:italic;margin-left:18px"><div>- Căn cứ Luật Đường bộ ngày 27 tháng 6 năm 2024;</div><div>- Căn cứ Nghị định số 158/2024/NĐ-CP của Chính phủ quy định về hoạt động vận tải đường bộ;</div>
        <div>- Căn cứ Điều lệ tổ chức và hoạt động của Công ty;</div><div>- Căn cứ năng lực, trình độ chuyên môn và nhu cầu công tác thực tế của đơn vị.</div></div>
      <div style="text-align:center;font-weight:bold;margin:12px 0 6px">QUYẾT ĐỊNH:</div>
      <p style="margin:4px 0"><b>Điều 1.</b> Bổ nhiệm ${ong} có tên dưới đây giữ chức vụ <b>${esc(cd)}</b> của ${esc(co)}, kể từ ${dm(hl)}:</p>
      <ul style="margin:4px 0 4px 18px;padding-left:18px">${li('Họ và tên (viết in hoa)', dots(e?.name.toUpperCase()))}${li('Ngày, tháng, năm sinh', `${dd(e?.birth)} &nbsp; <b>Giới tính:</b> ${dots(e?.gender, 10)}`)}
        ${li('Số CCCD/CMND/Hộ chiếu', `${dots(e?.cccd, 14)} &nbsp; <b>Ngày cấp:</b> ${dd(e?.cccdOn)} &nbsp; <b>Nơi cấp:</b> ${dots(e?.cccdBy, 14)}`)}${li('Địa chỉ thường trú', dots(e?.address, 40))}
        ${li('Trình độ chuyên môn / Chuyên ngành đào tạo', dots(c.trinh_do))}${li('Thâm niên / Kinh nghiệm công tác trong lĩnh vực vận tải', c.tham_nien ? `<b>${esc(c.tham_nien)}</b> năm` : '....... năm')}</ul>
      <p style="margin:6px 0 2px"><b>Điều 2. Trách nhiệm và Quyền hạn:</b> ${ong} ${dots(e?.name, 20)} có trách nhiệm giúp Giám đốc thực hiện các nhiệm vụ sau:</p>
      <ol style="margin:2px 0;padding-left:34px">${tasks.map((r) => `<li style="margin:2px 0">${r}</li>`).join('')}</ol>
      <p style="margin:6px 0 2px"><b>Điều 3. Chế độ đãi ngộ:</b> ${ong} ${dots(e?.name, 20)} được hưởng lương${Number(c.phu_cap) ? `, phụ cấp trách nhiệm <b>${money(Number(c.phu_cap))} đồng/tháng</b>` : ', phụ cấp'} và chế độ chính sách theo quy định hiện hành của Công ty và quy định của pháp luật lao động.</p>
      <p style="margin:6px 0 2px"><b>Điều 4. Điều khoản thi hành:</b></p>
      <ol style="margin:2px 0;padding-left:34px"><li>Quyết định này có hiệu lực kể từ ${dm(hl)}.</li><li>Bộ phận nhân sự, Bộ phận kế toán, Bộ phận điều hành vận tải và ${ong} ${dots(e?.name, 20)} chịu trách nhiệm thi hành Quyết định này.</li></ol>
      ${foot(x, c.noi_nhan || '- Như Điều 4;\n- Sở GTVT (để khai hồ sơ GPKD);\n- Lưu: VT, HS.', ['Đại diện đơn vị kinh doanh vận tải', x.title])}`);
  }
  if (t === 'qd_atgt') {
    const mem = lines(c.thanh_vien).map((l) => l.split(/\s*\|\s*/));
    const b = 'border:1px solid #000;padding:3px 6px';
    return wrap(`${head(x, number, signed, c.noi)}
      <h2 style="text-align:center;margin:16px 0 0;font-size:19px">QUYẾT ĐỊNH</h2><div style="text-align:center;font-style:italic;margin-bottom:8px">${esc(title)}</div>
      <div style="text-align:center;font-weight:bold;margin-bottom:8px">GIÁM ĐỐC ${esc(CO)}</div>
      <div style="margin-left:6px"><div>- Căn cứ Luật Đường bộ số 35/2024/QH15 và Luật Trật tự, an toàn giao thông đường bộ số 36/2024/QH15;</div><div>- Căn cứ Nghị định số 158/2024/NĐ-CP của Chính phủ quy định về hoạt động vận tải đường bộ;</div>
        <div>- Căn cứ Điều lệ tổ chức và hoạt động của ${esc(co)};</div><div>- Xét yêu cầu ${esc(c.muc_dich)}.</div></div>
      <div style="text-align:center;font-weight:bold;margin:12px 0 6px">QUYẾT ĐỊNH</div>
      <p style="margin:4px 0"><b>Điều 1.</b> Thành lập <b>${esc(c.ten_ban)}</b> của ${esc(co)} gồm các thành viên sau:</p>
      <table style="width:100%;border-collapse:collapse;margin:4px 0 6px"><tr><th style="${b};width:7%">STT</th><th style="${b}">Họ và tên</th><th style="${b}">Chức vụ tại công ty</th><th style="${b}">Chức danh trong Ban</th></tr>
        ${mem.map((m, i) => `<tr><td style="${b};text-align:center">${i + 1}</td><td style="${b}">${esc(m[0] ?? '')}</td><td style="${b}">${esc(m[1] ?? '')}</td><td style="${b}">${esc(m[2] ?? '')}</td></tr>`).join('')}</table>
      <p style="margin:4px 0"><b>Điều 2.</b> Nhiệm vụ của ${esc(c.ten_ban)}:</p>${lines(c.nhiem_vu).map((l, i) => `<p style="margin:2px 0 2px 18px">${i + 1}. ${esc(l)}</p>`).join('')}
      <p style="margin:4px 0"><b>Điều 3.</b> Quyết định này có hiệu lực kể từ ngày ký. Ban hoạt động theo nhiệm vụ được giao và chịu sự chỉ đạo trực tiếp của Giám đốc.</p>
      <p style="margin:4px 0"><b>Điều 4.</b> Các ông (bà) có tên tại Điều 1, các bộ phận có liên quan chịu trách nhiệm thi hành quyết định này.</p>
      ${foot(x, c.noi_nhan || '- Như Điều 4;\n- Lưu: VT.')}`);
  }
  if (t === 'quyet_dinh') {
    return wrap(`${head(x, number, signed, c.noi)}
      <h2 style="text-align:center;margin:16px 0 0;font-size:19px">QUYẾT ĐỊNH</h2><div style="text-align:center;font-weight:bold;margin-bottom:8px">${esc(title)}</div>
      <div style="text-align:center;font-weight:bold;margin-bottom:8px">GIÁM ĐỐC ${esc(CO)}</div>
      <div style="font-style:italic;margin-left:18px">${lines(c.can_cu).map((l) => `<div>- ${esc(l.replace(/^-\s*/, ''))}</div>`).join('')}</div>
      <div style="text-align:center;font-weight:bold;margin:12px 0 6px">QUYẾT ĐỊNH:</div>
      ${lines(c.dieu).map((l, i) => `<p style="margin:4px 0"><b>Điều ${i + 1}.</b> ${esc(l.replace(/^Điều\s*\d+\.?\s*/i, ''))}</p>`).join('')}
      ${foot(x, c.noi_nhan)}`);
  }
  if (t === 'cong_van') {
    const kg = lines(c.kinh_gui);
    return wrap(`${head(x, number, signed, c.noi, title)}
      <div style="margin:16px 0 8px;text-align:center"><b>Kính gửi:</b> ${kg.length > 1 ? `<div style="display:inline-block;text-align:left;vertical-align:top">${kg.map((l) => `- ${esc(l.replace(/^-\s*/, ''))}`).join('<br>')}</div>` : esc(kg[0] ?? '……………………')}</div>
      ${lines(c.noi_dung).map((l) => `<p style="margin:4px 0;text-indent:28px">${esc(l)}</p>`).join('')}
      ${foot(x, c.noi_nhan)}`);
  }
  return wrap(`${head(x, number, signed, c.noi)}
    <h2 style="text-align:center;margin:16px 0 0;font-size:19px">THÔNG BÁO</h2><div style="text-align:center;font-weight:bold;margin-bottom:10px">${esc(title)}</div>
    ${lines(c.noi_dung).map((l) => `<p style="margin:4px 0;text-indent:28px">${esc(l)}</p>`).join('')}
    ${foot(x, c.noi_nhan)}`);
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Lưu PDF văn bản vào <năm ký> / Pháp lý công ty / <loại> (QĐ giao nhiệm vụ giám sát: <năm> / An toàn giao thông / Quyết định giao nhiệm vụ). */
export async function saveDocPdf(d: OfficialDoc, x: DocCtx): Promise<void> {
  const tp = tplOf(d.template);
  const who = (d.template === 'qd_bo_nhiem' || d.template === 'qd_giam_sat' || d.template === 'qd_thoi_viec') && x.person ? ` · ${x.person.name}` : '';
  await savePdf(d.template === 'qd_giam_sat' ? [String(d.year), '09. An toàn giao thông', tp.folder] : d.template === 'qd_thoi_viec' ? [String(d.year), 'Nhân sự', tp.folder] : [String(d.year), 'Pháp lý công ty', tp.folder], `${CODE_NAME[d.code]} số ${d.number}${who} · ${d.title}`.slice(0, 200), `${slug(d.number)}.pdf`,
    docPages(d.template, d.number, d.signed_on, d.title, d.content, x).map((html) => ({ html, land: false })), 'Lưu từ Văn bản', `vb:${d.id}`);
}

// ------------------------------------------------------------------ QĐ giao nhiệm vụ giám sát, quản lý ATGT (theo mẫu nhà xe cung cấp)
const GS_DIEU: [string, string[]][] = [
  ['Điều 2. Mục tiêu, nguyên tắc thực hiện', [
    'Chủ động phòng ngừa nguy cơ, bảo đảm an toàn giao thông; phát hiện, cảnh báo, chấn chỉnh vi phạm kịp thời.',
    'Giám sát dựa trên dữ liệu, hồ sơ, thông tin xác minh; ghi nhận khách quan, có thời gian và người xử lý.',
    'Không thay thế trách nhiệm của Giám đốc, người trực tiếp điều hành vận tải, lái xe hoặc bộ phận chuyên môn theo quy định.',
    'Trường hợp nguy cơ tức thời, ưu tiên cảnh báo, yêu cầu dừng tại vị trí an toàn và báo cáo cấp có thẩm quyền; không yêu cầu lái xe thao tác điện thoại khi đang điều khiển xe.',
    'Thông tin, dữ liệu cá nhân, hình ảnh, hành trình được truy cập, sử dụng, lưu trữ đúng mục đích và theo quy định pháp luật.']],
  ['Điều 3. Nhiệm vụ cụ thể của giám sát an toàn giao thông', []],
  ['#3.1. Kiểm tra, phối hợp trước khi giao chuyến', [
    'Phối hợp điều hành kiểm tra hồ sơ, điều kiện của lái xe: giấy phép lái xe phù hợp loại xe; giấy chứng nhận/điều kiện tập huấn nghiệp vụ vận tải theo quy định; tình trạng sức khỏe và các điều kiện cần thiết khác.',
    'Kiểm tra tình trạng pháp lý và điều kiện vận hành của phương tiện: đăng ký, kiểm định, bảo hiểm bắt buộc, phù hiệu và các giấy tờ/điều kiện cần thiết khác còn hiệu lực theo loại hình vận tải.',
    'Kiểm tra thông tin giao nhiệm vụ: lái xe, phương tiện, tuyến/hành trình, thời gian, điểm đi/đến, yêu cầu đặc thù và phân công liên quan.',
    'Phối hợp kiểm tra lịch sử dữ liệu giám sát hành trình/camera (đối với phương tiện thuộc diện phải lắp), các cảnh báo chưa xử lý và các nguy cơ có thể ảnh hưởng đến chuyến mới.',
    'Phối hợp xác nhận thời gian lái xe và nghỉ ngơi; không bố trí lịch có nguy cơ vi phạm giới hạn pháp luật.',
    'Kiểm tra hoặc phối hợp xác nhận tình trạng thiết bị giám sát hành trình, camera và các thiết bị bắt buộc; báo kỹ thuật/điều hành xử lý nếu lỗi.',
    'Thông tin cho điều hành và lãnh đạo khi phát hiện xe/lái xe chưa đủ điều kiện; kiến nghị không giao chuyến cho đến khi khắc phục.']],
  ['#3.2. Theo dõi, giám sát khi xe đang hoạt động', [
    'Theo dõi dữ liệu thiết bị giám sát hành trình và thiết bị ghi nhận hình ảnh người lái xe (nếu thuộc diện phải lắp), hệ thống quản lý của Công ty.',
    'Phát hiện, ghi nhận, thông báo và theo dõi khắc phục các trường hợp: vượt tốc độ; vi phạm thời gian lái xe; sai hành trình; dừng/đỗ bất thường; thiết bị mất kết nối hoặc dữ liệu gián đoạn; nguy cơ bất thường khác.',
    'Khi phát hiện vi phạm thời gian lái xe liên tục, thời gian trong ngày/tuần, sai hành trình hoặc thiết bị không hoạt động, kịp thời thông tin cho lái xe để điều chỉnh/khắc phục và thông báo điều hành.',
    'Không liên lạc theo cách làm lái xe mất tập trung. Nếu cần liên hệ, ưu tiên thông báo qua điều hành hoặc yêu cầu lái xe dừng tại nơi an toàn trước khi trao đổi.',
    'Đối với sự cố, thời tiết, đường sá, ùn tắc, tai nạn, nguy cơ trên tuyến: ghi nhận, cảnh báo, phối hợp điều hành phương án an toàn.',
    'Tiếp nhận phản ánh/đề xuất của lái xe về điều kiện an toàn, phương tiện, hành trình, thời gian làm việc; ghi nhận và phản hồi hoặc chuyển cấp có thẩm quyền.']],
  ['#3.3. Xử lý cảnh báo và vi phạm', [
    'Phân loại sự việc theo mức độ: (i) cảnh báo/nhắc nhở; (ii) vi phạm cần xác minh; (iii) nguy cơ nghiêm trọng cần xử lý ngay.',
    'Đối chiếu dữ liệu, xác minh với lái xe/điều hành và tài liệu liên quan trước khi lập kết luận nội bộ.',
    'Thông báo nhắc nhở, yêu cầu khắc phục; ghi nhận thời điểm thông báo, người nhận, nội dung, thời hạn khắc phục và kết quả.',
    'Đề xuất biện pháp theo quy chế Công ty: huấn luyện bổ sung, nhắc nhở, lập biên bản, xem xét kỷ luật theo quy định; hoặc tạm dừng giao nhiệm vụ khi có căn cứ và nguy cơ an toàn.',
    'Đối với nguy cơ mất an toàn nghiêm trọng hoặc khẩn cấp, báo ngay lãnh đạo/điều hành và đề xuất biện pháp bảo vệ người, phương tiện; không tự ý vượt quá thẩm quyền được giao.',
    'Định kỳ kiểm tra việc khắc phục và tái phạm; cập nhật hồ sơ lái xe.']],
  ['#3.4. Kết thúc chuyến/ca làm việc', [
    'Tổng hợp quãng đường xe đã thực hiện; phối hợp theo dõi lịch bảo dưỡng, sửa chữa và kết quả thực hiện bảo dưỡng của từng phương tiện.',
    'Thống kê vi phạm tốc độ, thời gian lái xe, sai hành trình, gián đoạn dữ liệu thiết bị giám sát hành trình/camera (nếu thuộc diện), sự cố mất an toàn.',
    'Báo cáo lãnh đạo/điều hành các vi phạm và sự cố cần xử lý; đề xuất khắc phục, bảo dưỡng, đào tạo hoặc biện pháp quản lý.',
    'Đối với xe khách, phối hợp nhắc lái xe thực hiện các trách nhiệm kết thúc ca/hành trình theo pháp luật, bao gồm kiểm tra khoang hành khách trước khi rời xe.']],
  ['#3.5. Công tác định kỳ tháng, quý, năm', [
    'Thống kê số vụ tai nạn, sự cố, nguyên nhân và mức độ theo từng lái xe và toàn đơn vị; tổng hợp xu hướng và nguy cơ.',
    'Phối hợp xây dựng, rà soát và thực hiện phương án xử lý sự cố gây mất an toàn giao thông.',
    'Đối với tai nạn từ nghiêm trọng trở lên trong hoạt động kinh doanh vận tải, phối hợp tổ chức đánh giá, rút kinh nghiệm đối với toàn bộ lái xe theo quy định.',
    'Phối hợp các bộ phận tổ chức tập huấn nghiệp vụ vận tải, phổ biến quy định mới, nội quy và các điểm nguy cơ.',
    'Kiến nghị cải thiện tuyến, lịch chạy, phân công, phương tiện, quy trình, công tác giám sát và biện pháp phòng ngừa.',
    'Định kỳ rà soát hồ sơ, đảm bảo dữ liệu và hồ sơ nhiệm vụ quản lý an toàn được lưu trữ tối thiểu 03 năm theo quy định áp dụng.']],
  ['Điều 4. Quyền hạn', [
    'Được cấp quyền truy cập cần thiết vào hệ thống giám sát hành trình, camera, hồ sơ phương tiện, hồ sơ lái xe và dữ liệu chuyến vận tải để thực hiện nhiệm vụ.',
    'Được yêu cầu các bộ phận và lái xe cung cấp thông tin, phối hợp xác minh, khắc phục vấn đề an toàn.',
    'Được phát hành cảnh báo/nhắc nhở an toàn theo quy trình nội bộ.',
    'Được đề xuất điều chỉnh lịch, đổi lái xe/xe, tạm hoãn hoặc tạm dừng giao chuyến khi phát hiện nguy cơ hoặc điều kiện không bảo đảm; việc quyết định và thực hiện theo phân quyền Công ty và quy định pháp luật.',
    'Được báo cáo trực tiếp Giám đốc khi sự việc khẩn cấp, nghiêm trọng hoặc vượt thẩm quyền.',
    'Được đề xuất đào tạo, khen thưởng, xử lý vi phạm, sửa chữa/bảo dưỡng, cải tiến quy trình và hệ thống giám sát.']],
  ['Điều 5. Trách nhiệm, phối hợp và báo cáo', [
    'Thực hiện nhiệm vụ trung thực, đầy đủ, kịp thời; không bỏ qua, sửa sai lệch hoặc che giấu vi phạm dữ liệu.',
    'Chịu trách nhiệm về việc ghi nhận, báo cáo và theo dõi xử lý trong phạm vi được giao; không chịu thay trách nhiệm pháp luật của các chủ thể khác.',
    'Điều hành vận tải chịu trách nhiệm phối hợp bố trí xe/lái xe, lịch vận hành và quyết định điều hành thuộc thẩm quyền.',
    'Phòng kỹ thuật/đơn vị phụ trách xe chịu trách nhiệm kiểm tra, sửa chữa, bảo dưỡng và xác nhận tình trạng kỹ thuật.',
    'Lái xe chịu trách nhiệm kiểm tra phương tiện trước khi khởi hành, chấp hành pháp luật, nội quy, thời gian lái xe, hành trình, tốc độ, sử dụng thiết bị theo quy định và báo cáo sự cố.',
    'Giám sát an toàn báo cáo: (a) ngay khi có sự cố/nguy cơ nghiêm trọng; (b) cuối ngày theo mẫu; (c) tuần/tháng hoặc theo yêu cầu lãnh đạo.']],
];
const GS_PL7: string[][] = [
  ['Trước khi giao chuyến', 'Rà soát điều kiện xe/lái xe, dữ liệu cảnh báo, lịch lái và nghỉ, phối hợp điều hành', 'Checklist trước chuyến; ghi nhận cảnh báo'],
  ['Trong hành trình', 'Theo dõi dữ liệu; cảnh báo; phối hợp xử lý bất thường; ghi nhận sự cố', 'Sổ giám sát; log cảnh báo'],
  ['Kết thúc chuyến/ca', 'Tổng hợp quãng đường, vi phạm, thiết bị, sự cố; phối hợp bảo dưỡng', 'Báo cáo cuối ca/ngày'],
  ['Hằng tuần', 'Rà soát vi phạm tái diễn, tồn đọng và khắc phục; trao đổi điều hành', 'Bảng tổng hợp tuần'],
  ['Hằng tháng', 'Thống kê tai nạn/sự cố, phân tích, đề xuất, tập huấn, rà soát hồ sơ', 'Báo cáo tháng'],
  ['Quý/năm hoặc theo yêu cầu', 'Đánh giá xu hướng, phương án sự cố, tập huấn, rà soát quy trình và hồ sơ', 'Báo cáo/biên bản đánh giá'],
];
const GS_PL8: string[][] = [
  ['Quyết định giao nhiệm vụ, phân công và cập nhật', 'Công ty', 'Theo quy định'],
  ['Checklist kiểm tra trước chuyến / hồ sơ xác nhận', 'Giám sát/điều hành', 'Theo quy định áp dụng'],
  ['Dữ liệu, báo cáo giám sát; bảng cảnh báo/vi phạm', 'Giám sát an toàn', 'Tối thiểu 03 năm khi thuộc hồ sơ Điều 11'],
  ['Biên bản xác minh, xử lý và khắc phục', 'Giám sát/nhân sự', 'Theo quy định áp dụng'],
  ['Báo cáo sự cố, tai nạn và đánh giá rút kinh nghiệm', 'Công ty', 'Theo quy định áp dụng'],
  ['Hồ sơ tập huấn nghiệp vụ vận tải, phổ biến nội quy', 'Nhân sự/giám sát', 'Theo quy định áp dụng'],
  ['Hồ sơ bảo dưỡng, sửa chữa, theo dõi quãng đường', 'Kỹ thuật', 'Theo quy định áp dụng'],
];
const tb = (head: string[], rows: string[][]) => { const b = 'border:1px solid #000;padding:3px 6px;font-size:12.5px;vertical-align:top';
  return `<table style="width:100%;border-collapse:collapse;margin:4px 0"><tr>${head.map((h) => `<th style="${b};background:#e2e8f0">${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td style="${b}">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`; };
/** Các khối nội dung (để tự chia trang A4). */
export function giamSatBlocks(number: string, signed: string, title: string, c: Content, x: DocCtx): string[] {
  const e = x.person, ong = e?.gender === 'Nữ' ? 'bà' : 'ông', hl = c.hieu_luc || signed, tu = c.thoi_han_tu || hl, CO = (x.company.name || 'Công ty').toUpperCase();
  const B: string[] = [];
  B.push(`${head(x, number, signed, c.noi)}<h2 style="text-align:center;margin:16px 0 0;font-size:19px">QUYẾT ĐỊNH</h2><div style="text-align:center;font-weight:bold">${esc(title)}</div>
    <div style="text-align:center;font-style:italic;margin-bottom:8px">(Áp dụng cho đơn vị kinh doanh vận tải bằng xe ô tô)</div><div style="text-align:center;font-weight:bold;margin-bottom:8px">GIÁM ĐỐC ${esc(CO)}</div>`);
  B.push(`<div style="font-style:italic;margin-left:18px"><div>- Căn cứ Luật Đường bộ năm 2024;</div><div>- Căn cứ Luật Trật tự, an toàn giao thông đường bộ năm 2024;</div>
    <div>- Căn cứ Nghị định 158/2024/NĐ-CP ngày 18/12/2024 của Chính phủ quy định về hoạt động vận tải đường bộ, được sửa đổi, bổ sung và hợp nhất tại Văn bản hợp nhất 58/VBHN-BXD ngày 02/7/2026;</div>
    <div>- Căn cứ quy định pháp luật hiện hành, nhu cầu tổ chức quản lý và bảo đảm an toàn trong hoạt động vận tải của Công ty;</div></div>
    <div style="text-align:center;font-weight:bold;margin:12px 0 6px">QUYẾT ĐỊNH:</div>`);
  B.push(`<p style="margin:4px 0"><b>Điều 1. Giao nhiệm vụ và thông tin người được giao</b></p>
    <p style="margin:2px 0 2px 18px">Giao ${ong}: ${dots(e?.name, 40)}</p><p style="margin:2px 0 2px 18px">Chức danh/chức vụ: ${dots(e?.job, 40)}</p>
    <p style="margin:2px 0 2px 18px">Bộ phận: ${dots(e?.dept, 40)}</p><p style="margin:2px 0 2px 18px">Thời hạn thực hiện: kể từ ngày ${dd(tu)} cho đến khi có quyết định thay thế hoặc điều chỉnh.</p>
    <p style="margin:2px 0 2px 18px">Phạm vi: toàn bộ xe, lái xe, chuyến vận chuyển và hoạt động vận tải thuộc phạm vi quản lý của Công ty; thực hiện phối hợp với điều hành, nhân sự, kỹ thuật, dịch vụ khách hàng và các bộ phận liên quan.</p>`);
  for (const [h, items] of GS_DIEU) {
    B.push(`<p style="margin:6px 0 2px">${h.startsWith('#') ? `<b><i>${esc(h.slice(1))}</i></b>` : `<b>${esc(h)}</b>`}</p>`);
    items.forEach((t) => B.push(`<p style="margin:2px 0 2px 18px">- ${esc(t)}</p>`));
  }
  B.push(`<p style="margin:6px 0 2px"><b>Điều 6. Hiệu lực và tổ chức thực hiện</b></p><p style="margin:2px 0 2px 18px">Quyết định có hiệu lực từ ngày ${dd(hl)}. Các bộ phận, cá nhân liên quan và ${ong} ${dots(e?.name, 20)} chịu trách nhiệm thực hiện.</p>`);
  B.push(`<table style="width:100%;border-collapse:collapse;margin-top:14px"><tr><td style="width:34%;vertical-align:top;font-size:13px"><b><i>Nơi nhận:</i></b>${lines(c.noi_nhan).map((l) => `<br>${esc(l)}`).join('')}</td>
    <td style="width:30%;text-align:center;vertical-align:top"><b>NGƯỜI ĐƯỢC GIAO NHIỆM VỤ</b><br><i style="font-size:12px">(Ký xác nhận)</i><div style="height:96px"></div><b>${esc(e?.name ?? '')}</b></td>
    ${bossCol(x.boss, esc(x.title.toUpperCase()), 36)}</tr></table>`);
  B.push(`<h3 style="margin:18px 0 4px;font-size:15px">PHỤ LỤC 7 – LỊCH CÔNG VIỆC GỢI Ý CHO GIÁM SÁT AN TOÀN</h3>${tb(['Thời điểm', 'Việc thực hiện', 'Hồ sơ / đầu ra'], GS_PL7)}`);
  B.push(`<h3 style="margin:14px 0 4px;font-size:15px">PHỤ LỤC 8 – DANH MỤC HỒ SƠ LƯU TRỮ</h3>${tb(['STT', 'Hồ sơ', 'Người/bộ phận lưu', 'Thời gian lưu'], GS_PL8.map((r, i) => [String(i + 1), ...r]))}
    <p style="margin:4px 0;font-size:12.5px"><i>Lưu ý: Văn bản hợp nhất 58/VBHN-BXD nêu thời gian lưu trữ tối thiểu 03 năm đối với các hồ sơ, sổ sách được dẫn chiếu tại khoản 9 Điều 11; cần xác định đúng loại hồ sơ thuộc phạm vi này. Không dùng bảng này để rút ngắn thời hạn lưu trữ khác do pháp luật quy định.</i></p>
    <p style="margin:4px 0;font-size:12.5px">Hồ sơ lưu tự động trên phần mềm: <b>Lưu trữ hồ sơ › Năm › An toàn giao thông</b> (Quyết định giao nhiệm vụ, Checklist trước chuyến, Sổ giám sát hằng ngày, Biên bản xác minh, Sự cố khẩn cấp, Báo cáo tuần / tháng / năm).</p>`);
  B.push(`<h3 style="margin:14px 0 4px;font-size:15px">PHỤ LỤC 9 – CĂN CỨ VÀ LƯU Ý KHI ÁP DỤNG</h3>
    <p style="margin:2px 0">Căn cứ trọng tâm: Điều 11 Văn bản hợp nhất 58/VBHN-BXD ngày 02/7/2026 của Bộ Xây dựng, hợp nhất Nghị định 158/2024/NĐ-CP và nội dung sửa đổi, bổ sung tại Nghị định 218/2026/NĐ-CP.</p>
    <p style="margin:2px 0">Điều 11 tập trung yêu cầu đơn vị kinh doanh vận tải có bộ phận quản lý an toàn; nhân sự theo dõi, giám sát xe và lái xe; giao nhiệm vụ; rà soát dữ liệu trước chuyến; tiếp nhận phản ánh; phối hợp bố trí lái xe bảo đảm thời gian lái và nghỉ; giám sát trong hành trình; thống kê, báo cáo sau chuyến/ca; nhiệm vụ định kỳ tháng, quý, năm và lưu trữ.</p>
    <p style="margin:2px 0">Tài liệu này là mẫu quản trị nội bộ, không phải biểu mẫu bắt buộc của cơ quan nhà nước. Công ty cần điều chỉnh tên chức danh, phạm vi xe, loại hình vận tải, phân quyền, quy chế xử lý và quy trình ứng phó sự cố phù hợp thực tế; đối chiếu văn bản pháp luật chính thức khi ký ban hành.</p>`);
  return B;
}
