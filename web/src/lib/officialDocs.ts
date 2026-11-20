// Văn bản (công văn, quyết định, thông báo): mẫu in + lưu PDF vào Lưu trữ hồ sơ (như các mẫu quyết định của app cũ).
// Lưu: <năm ký> / Pháp lý công ty / <loại văn bản> (khớp cả thư mục "01. Pháp lý công ty"); lưu lại thì thay bản cũ.
// Căn cứ pháp lý ghi trong mẫu: theo app cũ, cần xác minh.
import { supabase } from './supabase';
import { boss, bossCol, company, type Boss, type Company } from './profilePapers';
import { savePdf } from './dispatchPapers';
import { paginate } from './pdfMaker';

export type Template = 'qd_bo_nhiem' | 'qd_atgt' | 'cong_van' | 'quyet_dinh' | 'thong_bao' | 'word_qd' | 'word_cv' | 'word_tb';
export const isWord = (t: Template) => t.startsWith('word_');
export type Content = Record<string, string>;
export interface OfficialDoc {
  id: string; template: Template; code: 'QD' | 'CV' | 'TB'; year: number; seq: number; number: string; signed_on: string; title: string;
  staff_id: string | null; content: Content; status: 'hieu_luc' | 'da_huy'; cancel_reason: string | null; created_at: string;
}

export const TEMPLATES: { key: Template; name: string; folder: string; code: 'QD' | 'CV' | 'TB' }[] = [
  { key: 'qd_bo_nhiem', name: 'Quyết định bổ nhiệm người điều hành vận tải', folder: 'Quyết định bổ nhiệm người điều hành', code: 'QD' },
  { key: 'qd_atgt', name: 'Quyết định thành lập Ban An toàn giao thông', folder: 'Quyết định thành lập Ban ATGT', code: 'QD' },
  { key: 'quyet_dinh', name: 'Quyết định khác', folder: 'Quyết định', code: 'QD' },
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
];
export const tplOf = (k: Template) => TEMPLATES.find((t) => t.key === k)!;
export const CODE_NAME: Record<string, string> = { QD: 'Quyết định', CV: 'Công văn', TB: 'Thông báo' };

/** Nội dung mặc định khi soạn mới (theo app cũ). */
export function defaults(t: Template, noi: string, director: string): Content {
  const base = { noi };
  if (isWord(t)) return { ...base, html: '' };
  if (t === 'qd_bo_nhiem') return { ...base, chuc_danh: 'Người trực tiếp điều hành hoạt động vận tải', hieu_luc: '', trinh_do: '', tham_nien: '', phu_cap: '',
    noi_nhan: '- Như Điều 4;\n- Sở GTVT (để khai hồ sơ GPKD);\n- Lưu: VT, HS.' };
  if (t === 'qd_atgt') return { ...base, ten_ban: 'Ban An toàn giao thông',
    muc_dich: 'tăng cường công tác bảo đảm trật tự, an toàn giao thông trong hoạt động kinh doanh vận tải hành khách',
    thanh_vien: `${director || '……………………'} | Giám đốc | Trưởng ban\n…………………… | Phụ trách điều hành | Phó ban\n…………………… | Kế toán | Thành viên\n…………………… | Lái xe đại diện | Thành viên`,
    nhiem_vu: ['Xây dựng, tổ chức thực hiện quy chế quản lý an toàn giao thông của công ty.', 'Kiểm tra điều kiện an toàn kỹ thuật của xe, giấy tờ xe và lái xe trước khi khởi hành.',
      'Quản lý hồ sơ, sức khỏe, thời gian lái xe và tập huấn nghiệp vụ cho lái xe, nhân viên phục vụ trên xe.', 'Phổ biến, nhắc nhở lái xe chấp hành pháp luật giao thông; xử lý hoặc đề xuất xử lý vi phạm.',
      'Thống kê, báo cáo và phối hợp điều tra, giải quyết khi xảy ra tai nạn giao thông.', 'Phối hợp với cơ quan chức năng trong công tác bảo đảm an toàn giao thông.'].join('\n'), noi_nhan: '- Như Điều 4;\n- Lưu: VT.' };
  if (t === 'cong_van') return { ...base, kinh_gui: '', noi_dung: '', noi_nhan: '- Như trên;\n- Lưu: VT.' };
  if (t === 'quyet_dinh') return { ...base, can_cu: 'Căn cứ Điều lệ tổ chức và hoạt động của Công ty;', dieu: '', noi_nhan: '- Như Điều …;\n- Lưu: VT.' };
  return { ...base, noi_dung: '', noi_nhan: '- Toàn thể nhân viên;\n- Lưu: VT.' };
}
/** Trích yếu tự đặt theo mẫu (người dùng vẫn sửa được). */
export const autoTitle = (t: Template, c: Content) =>
  t === 'qd_bo_nhiem' ? `Về việc bổ nhiệm ${c.chuc_danh || 'Người trực tiếp điều hành hoạt động vận tải'}`
    : t === 'qd_atgt' ? `Về việc thành lập ${c.ten_ban || 'Ban An toàn giao thông'}` : '';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const lines = (s: string | undefined) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
const dm = (iso: string | undefined) => { if (!iso) return 'ngày ..... tháng ..... năm ......'; const [y, m, d] = iso.split('-'); return `ngày ${d} tháng ${m} năm ${y}`; };
const dd = (iso: string | null | undefined) => (iso ? iso.split('-').reverse().join('/') : '......./....../..........');
const dots = (v: string | null | undefined, n = 30) => (v ? `<b>${esc(v)}</b>` : '.'.repeat(n));
const money = (n: number) => n.toLocaleString('vi-VN');

export interface DocCtx { company: Company; boss: Boss; title: string; person: Person | null }
interface Person { name: string; birth: string | null; gender: string | null; cccd: string | null; cccdOn: string | null; cccdBy: string | null; address: string | null;
  current: string | null; phone: string | null; job: string | null; joined: string | null }

/** Lấy dữ liệu để in: công ty, chữ ký giám đốc + con dấu, người liên quan. */
export async function loadDocCtx(tenantId: string, me: { id: string | null; name: string }, staffId: string | null): Promise<DocCtx> {
  const [c, b, ct, person] = await Promise.all([
    company(), boss(tenantId, me),
    supabase.from('tenant_settings').select('value').eq('key', 'cong_ty.chuc_danh_ky').maybeSingle(),
    staffId ? loadPerson(staffId) : Promise.resolve(null),
  ]);
  return { company: c, boss: b.b, title: String((ct.data as { value?: unknown } | null)?.value ?? '') || 'Giám đốc', person };
}
async function loadPerson(id: string): Promise<Person | null> {
  const [s, p, d] = await Promise.all([
    supabase.from('staff_members').select('full_name, phone, job_title, position, joined_on').eq('id', id).maybeSingle(),
    supabase.from('staff_private').select('birth_date, gender, address, current_address').eq('staff_id', id).maybeSingle(),
    supabase.from('documents').select('doc_no, issued_on, issuer, data').eq('staff_id', id).eq('doc_type', 'cccd').eq('is_current', true).maybeSingle(),
  ]);
  if (!s.data) return null;
  const pv = p.data as { birth_date: string | null; gender: string | null; address: string | null; current_address?: string | null } | null;
  const sm = s.data as { full_name: string; phone: string | null; job_title: string | null; position: string; joined_on: string };
  const cd = d.data as { doc_no: string | null; issued_on: string | null; issuer: string | null; data: Record<string, unknown> | null } | null;
  return { current: pv?.current_address ?? null, phone: sm.phone, job: sm.job_title || ({ lai_xe: 'Lái xe', phu_xe: 'Phụ xe', nhan_vien: 'Nhân viên' } as Record<string, string>)[sm.position] || null,
    joined: sm.joined_on, name: sm.full_name, birth: pv?.birth_date ?? null, gender: pv?.gender === 'nu' ? 'Nữ' : pv?.gender === 'nam' ? 'Nam' : null,
    cccd: cd?.doc_no ?? null, cccdOn: cd?.issued_on ?? null, cccdBy: cd?.issuer ?? null, address: pv?.address || String(cd?.data?.['nv.noi_thuong_tru'] ?? '') || null };
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
  };
  // Word hay tách chữ trong ô {…} ra nhiều đoạn định dạng: gom lại trước khi thay
  return html.replace(/\{(?:<[^>]+>|[^{}<])*\}/g, (m) => { const k = m.replace(/<[^>]+>/g, ''); return map[k] ?? m; });
}
/** Các trang in của văn bản: văn bản tự soạn tự chia trang A4; mẫu có sẵn 1 trang (dài thì thu nhỏ vừa trang). */
export function docPages(t: Template, number: string, signed: string, title: string, c: Content, x: DocCtx): string[] {
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
/** Lưu PDF văn bản vào <năm ký> / Pháp lý công ty / <loại>; lưu lại thì thay bản cũ. */
export async function saveDocPdf(d: OfficialDoc, x: DocCtx): Promise<void> {
  const tp = tplOf(d.template);
  const who = d.template === 'qd_bo_nhiem' && x.person ? ` · ${x.person.name}` : '';
  await savePdf([String(d.year), 'Pháp lý công ty', tp.folder], `${CODE_NAME[d.code]} số ${d.number}${who} · ${d.title}`.slice(0, 200), `${slug(d.number)}.pdf`,
    docPages(d.template, d.number, d.signed_on, d.title, d.content, x).map((html) => ({ html, land: false })), 'Lưu từ Văn bản', `vb:${d.id}`);
}
