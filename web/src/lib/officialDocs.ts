// Văn bản (công văn, quyết định, thông báo): mẫu in + lưu PDF vào Lưu trữ hồ sơ (như các mẫu quyết định của app cũ).
// Lưu: <năm ký> / Pháp lý công ty / <loại văn bản> (khớp cả thư mục "01. Pháp lý công ty"); lưu lại thì thay bản cũ.
// Căn cứ pháp lý ghi trong mẫu: theo app cũ, cần xác minh.
import { supabase } from './supabase';
import { boss, bossCol, company, type Boss, type Company } from './profilePapers';
import { savePdf } from './dispatchPapers';

export type Template = 'qd_bo_nhiem' | 'qd_atgt' | 'cong_van' | 'quyet_dinh' | 'thong_bao';
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
];
export const tplOf = (k: Template) => TEMPLATES.find((t) => t.key === k)!;
export const CODE_NAME: Record<string, string> = { QD: 'Quyết định', CV: 'Công văn', TB: 'Thông báo' };

/** Nội dung mặc định khi soạn mới (theo app cũ). */
export function defaults(t: Template, noi: string, director: string): Content {
  const base = { noi };
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
interface Person { name: string; birth: string | null; gender: string | null; cccd: string | null; cccdOn: string | null; cccdBy: string | null; address: string | null }

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
    supabase.from('staff_members').select('full_name').eq('id', id).maybeSingle(),
    supabase.from('staff_private').select('birth_date, gender, address').eq('staff_id', id).maybeSingle(),
    supabase.from('documents').select('doc_no, issued_on, issuer, data').eq('staff_id', id).eq('doc_type', 'cccd').eq('is_current', true).maybeSingle(),
  ]);
  if (!s.data) return null;
  const pv = p.data as { birth_date: string | null; gender: string | null; address: string | null } | null;
  const cd = d.data as { doc_no: string | null; issued_on: string | null; issuer: string | null; data: Record<string, unknown> | null } | null;
  return { name: (s.data as { full_name: string }).full_name, birth: pv?.birth_date ?? null, gender: pv?.gender === 'nu' ? 'Nữ' : pv?.gender === 'nam' ? 'Nam' : null,
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
    [{ html: docHtml(d.template, d.number, d.signed_on, d.title, d.content, x), land: false }], 'Lưu từ Văn bản', `vb:${d.id}`);
}
