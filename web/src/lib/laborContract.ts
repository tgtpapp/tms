// Hợp đồng lao động (như app cũ): mẫu in 8 điều + Phụ lục I (mô tả công việc) + Phụ lục II (phụ cấp, hỗ trợ).
// Câu chữ điều khoản chép nguyên văn app cũ (laborText.ts). Lưu PDF vào <năm> / Nhân sự / Hợp đồng lao động / <họ tên>.
import { supabase } from './supabase';
import { boss, bossCol, company, signCol, signImg, type Boss, type Company } from './profilePapers';
import { loadSigns, type Sign } from './signatures';
import { paginate } from './pdfMaker';
import { savePdf } from './dispatchPapers';
import { numberToWords } from './vnWords';
import { BANKS } from './vietqr';
import { HD_CANCU, HD_CV, HD_D1b, HD_DIEU, HD_YC } from './laborText';

export type Kind = 'xac_dinh' | 'thoi_vu' | 'khong_xac_dinh';
export const KIND_NAME: Record<Kind, string> = { xac_dinh: 'Xác định thời hạn', thoi_vu: 'Thời vụ', khong_xac_dinh: 'Không xác định thời hạn' };
export interface Allow { an_trua?: number; xang?: number; dien_thoai?: number; khac?: number }
export interface Contract {
  id: string; staff_id: string; year: number; seq: number; number: string; kind: Kind; start_on: string; end_on: string | null; salary: number;
  position: string | null; department: string | null; job_desc: string | null; allowances: Allow; status: 'hieu_luc' | 'da_huy'; cancel_reason: string | null;
}
export interface Terms { payDay: number; hours: number; off: 'CN' | 'T7CN' }
export const TERMS_KEYS = ['hdld.ngay_tra_luong', 'hdld.gio_ngay', 'hdld.ngay_nghi'];

interface Person { name: string; gender: string | null; birth: string | null; nation: string | null; cccd: string | null; cccdOn: string | null; cccdBy: string | null;
  address: string | null; current: string | null; phone: string | null; sign: Sign }
export interface LaborCtx {
  company: Company & { tax: string; phone: string; bank: string; bankNo: string }; boss: Boss; director: string; title: string; terms: Terms; person: Person;
}

export async function loadTerms(): Promise<Terms> {
  const { data } = await supabase.from('tenant_settings').select('key, value').in('key', TERMS_KEYS);
  const v = (k: string) => ((data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value;
  return { payDay: Number(v('hdld.ngay_tra_luong')) || 5, hours: Number(v('hdld.gio_ngay')) || 8, off: v('hdld.ngay_nghi') === 'T7CN' ? 'T7CN' : 'CN' };
}

export async function loadLaborCtx(tenantId: string, me: { id: string | null; name: string }, staffId: string): Promise<LaborCtx> {
  const [c, t, ss, terms, sm, pv, cd] = await Promise.all([
    company(), supabase.from('tenants').select('tax_code, phone').maybeSingle(),
    supabase.from('tenant_settings').select('key, value').in('key', ['cong_ty.giam_doc', 'cong_ty.chuc_danh_ky', 'tt.so_tai_khoan', 'tt.ngan_hang_bin']),
    loadTerms(),
    supabase.from('staff_members').select('full_name, phone, user_id').eq('id', staffId).maybeSingle(),
    supabase.from('staff_private').select('birth_date, gender, address, current_address').eq('staff_id', staffId).maybeSingle(),
    supabase.from('documents').select('doc_no, issued_on, issuer, data').eq('staff_id', staffId).eq('doc_type', 'cccd').eq('is_current', true).maybeSingle(),
  ]);
  if (!sm.data) throw new Error('Không tìm thấy nhân viên');
  const s = sm.data as { full_name: string; phone: string | null; user_id: string | null };
  const set = (k: string) => String(((ss.data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value ?? '');
  const who = `nv_${staffId}`;
  const [{ b }, signs] = await Promise.all([boss(tenantId, me), loadSigns(tenantId, [who, s.user_id], true)]);
  const own = signs.get(who);
  const p = pv.data as { birth_date: string | null; gender: string | null; address: string | null; current_address: string | null } | null;
  const d = cd.data as { doc_no: string | null; issued_on: string | null; issuer: string | null; data: Record<string, unknown> | null } | null;
  const tt = t.data as { tax_code: string | null; phone: string | null } | null;
  return {
    company: { ...c, tax: tt?.tax_code ?? '', phone: tt?.phone ?? '', bankNo: set('tt.so_tai_khoan'), bank: BANKS.find((x) => x.bin === set('tt.ngan_hang_bin'))?.name ?? '' },
    boss: b, director: set('cong_ty.giam_doc'), title: set('cong_ty.chuc_danh_ky') || 'Giám đốc', terms,
    person: { name: s.full_name, gender: p?.gender === 'nu' ? 'Nữ' : p?.gender === 'nam' ? 'Nam' : null, birth: p?.birth_date ?? null,
      nation: String(d?.data?.quoc_tich ?? '') || null, cccd: d?.doc_no ?? null, cccdOn: d?.issued_on ?? null, cccdBy: d?.issuer ?? null,
      address: p?.address || String(d?.data?.['nv.noi_thuong_tru'] ?? '') || null, current: p?.current_address || String(d?.data?.['nv.noi_thuong_tru'] ?? '') || p?.address || null,   // trống: lấy nơi cư trú trên CCCD phone: s.phone,
      sign: own?.img ? own : (s.user_id && signs.get(s.user_id)) || { img: null, hasName: false } },
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hv = (x: unknown, dflt = '............') => (x != null && String(x).trim() !== '' ? esc(x) : dflt);
const hd8 = (x: string | null | undefined) => (x ? x.split('-').reverse().join('/') : '..../..../........');
const pad = (n: number) => String(n).padStart(2, '0');
const money = (n: number) => n.toLocaleString('vi-VN');
export const months = (tu: string, den: string | null) => (den ? (+den.slice(0, 4) - +tu.slice(0, 4)) * 12 + (+den.slice(5, 7) - +tu.slice(5, 7)) + 1 : 0);

/** Các trang A4 của 1 hợp đồng (hợp đồng, Phụ lục I, Phụ lục II – mỗi phần bắt đầu trang mới). */
export function contractPages(k: Contract, x: LaborCtx): string[] {
  const co = x.company, e = x.person, up = (v: string | null | undefined) => (v ? esc(v.toUpperCase()) : '............');
  const ten = esc(e.name.toUpperCase());
  const lw = numberToWords(k.salary);
  const R: Record<string, string> = { TU: hd8(k.start_on), LUONG: money(k.salary), LUONGCHU: esc(lw.charAt(0).toLowerCase() + lw.slice(1) + ' đồng'),
    NGAYTRA: pad(x.terms.payDay), GIO: pad(x.terms.hours), NGAYLAM: x.terms.off === 'T7CN' ? 'Thứ 6' : 'Thứ 7' };
  const fill = (t: string) => t.replace(/\{(\w+)\}/g, (m, key: string) => R[key] ?? m);
  const P = (t: string) => (t.startsWith('#') ? `<p style="margin:3px 0"><b>${fill(t.slice(1))}</b></p>` : `<p style="margin:3px 0">${fill(t)}</p>`);
  const H = (t: string) => `<div style="font-size:13px;font-weight:bold;margin:11px 0 3px">${t}</div>`;
  const th = months(k.start_on, k.end_on);
  const l11 = k.kind === 'khong_xac_dinh' ? 'Hợp đồng lao động không xác định thời hạn' : `Hợp đồng lao động ${k.kind === 'thoi_vu' ? 'thời vụ' : 'xác định thời hạn'} [${th || '....'}] tháng`;
  const pc = (v: number | undefined) => (Number(v) > 0 ? `${money(Number(v))} đồng/tháng` : 'Không áp dụng');
  const sig = `<table style="width:100%;border-collapse:collapse;margin-top:12px"><tr>
    ${signCol('NGƯỜI LAO ĐỘNG', '(Ký tên)', signImg(e.sign), e.name.toUpperCase(), e.sign, 50)}
    ${bossCol(x.boss, 'NGƯỜI SỬ DỤNG LAO ĐỘNG', 50)}</tr></table>`;
  const wrap = (s: string) => `<div style="font-size:12.5px;line-height:1.42;text-align:justify">${s}</div>`;
  const coName = esc(co.name.toUpperCase()).replace(/^CÔNG TY TNHH MTV /, 'CÔNG TY TNHH MTV<br>');

  const main = [
    `<table style="width:100%;border-collapse:collapse"><tr><td style="width:40%;text-align:center;vertical-align:top;padding:8px"><b>${coName}</b><br><b><i>Số: ${esc(k.number)}</i></b></td>
      <td style="text-align:center;vertical-align:top;padding:8px"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><b>Độc lập - Tự do - Hạnh phúc</b><br>-----***-----</td></tr></table>`,
    `<div style="margin-top:4px">${HD_CANCU.map((t) => `<p style="margin:3px 0">- ${t}</p>`).join('')}</div>`,
    `<p style="margin:3px 0">Chúng tôi, một bên là:</p><p style="margin:3px 0"><b>NGƯỜI SỬ DỤNG LAO ĐỘNG (BÊN A):</b></p><p style="margin:3px 0"><b>${esc(co.name)}</b></p>
     <p style="margin:3px 0">Người đại diện: Ông ${hv(x.director)} &nbsp; Chức vụ: ${hv(x.title)}</p><p style="margin:3px 0">Địa chỉ: ${hv(co.address)}</p><p style="margin:3px 0">MST: ${hv(co.tax)}</p>
     <p style="margin:3px 0">Số điện thoại: ${hv(co.phone)} &nbsp; Email: ............</p><p style="margin:3px 0">Số tài khoản: ${hv(co.bankNo)} &nbsp; Tại: ${hv(co.bank)}</p><p style="margin:3px 0">ĐKKD số: ............</p>`,
    `<p style="margin:3px 0"><b>NGƯỜI LAO ĐỘNG (BÊN B):</b></p>
     <p style="margin:3px 0">Ông/Bà: <b>${ten}</b> &nbsp; Giới tính: ${up(e.gender)}</p><p style="margin:3px 0">Sinh ngày: ${hd8(e.birth)} &nbsp; Quốc tịch: ${hv(e.nation || 'Việt Nam')}</p>
     <p style="margin:3px 0">CMND/CCCD số: ${hv(e.cccd)} &nbsp; Ngày cấp: ${hd8(e.cccdOn)} &nbsp; Nơi cấp: ${hv(e.cccdBy)}</p>
     <p style="margin:3px 0">Địa chỉ thường trú: ${hv(e.address)}</p><p style="margin:3px 0">Chỗ ở hiện nay: ${hv(e.current)}</p><p style="margin:3px 0">Số điện thoại: ${hv(e.phone)}</p>
     <p style="margin:3px 0">Số sổ lao động/Sổ BHXH (nếu có): cấp ngày: ${hd8(null)}</p>
     <p style="margin:3px 0">Sau khi trao đổi, hai bên đồng ý ký kết Hợp đồng lao động (“HĐLĐ”) và cam kết thực hiện đúng các điều khoản cụ thể sau đây:</p>`,
    `${H('ĐIỀU 1. ĐIỀU KHOẢN CHUNG')}<p style="margin:3px 0">1.1. Loại HĐLĐ: ${l11}.</p>
     <p style="margin:3px 0">1.2. Thời hạn HĐLĐ: kể từ ngày ${hd8(k.start_on)}${k.kind === 'khong_xac_dinh' ? '' : ` đến hết ngày ${hd8(k.end_on)}`}.</p>
     <p style="margin:3px 0">1.3. Nơi làm việc: tại trụ sở ${esc(co.name)}</p><p style="margin:3px 0">1.4. Vị trí: ${up(k.position)}. Phòng ban: ${up(k.department)}.</p><p style="margin:3px 0">1.5. Nhiệm vụ công việc:</p>
     ${HD_D1b.map((t) => `<p style="margin:3px 0">${t}</p>`).join('')}`,
    ...HD_DIEU.flatMap(([h, ps]) => [H(h) + P(ps[0] ?? ''), ...ps.slice(1).map(P)]),
    sig,
  ];
  const cv = (k.job_desc ?? '').split('\n').map((t) => t.trim()).filter(Boolean);
  const td = 'border:1px solid #333;padding:5px 8px;vertical-align:top;font-size:12px';
  const pl1 = [
    `<p style="text-align:center;margin:3px 0"><b>PHỤ LỤC I<br>BẢNG MÔ TẢ CÔNG VIỆC CHI TIẾT</b></p>
     <table style="width:100%;border-collapse:collapse"><tr><td style="${td};width:30%"><b>Vị trí</b></td><td style="${td}">${up(k.position)}</td></tr>
     <tr><td style="${td}"><b>Người hướng dẫn và quản lý trực tiếp</b></td><td style="${td}">${esc(x.title)}: ${hv(x.director)}</td></tr>
     <tr><td style="${td}"><b>Công việc cần thực hiện</b></td><td style="${td}">${cv.length ? cv.map((t) => `<p style="margin:3px 0">- ${esc(t)}</p>`).join('')
      : `<p style="margin:3px 0">Triển khai và hoàn thành các nhiệm vụ chuyên môn theo đúng chức năng của vị trí, đảm bảo tiến độ và chất lượng công việc.</p>${HD_CV.map(([a, b]) => `<p style="margin:3px 0"><b>${a}</b><br>${b}</p>`).join('')}`}</td></tr>
     <tr><td style="${td}"><b>Yêu cầu</b></td><td style="${td}">${HD_YC.map((t) => `<p style="margin:3px 0">- ${t}</p>`).join('')}</td></tr></table>`,
  ];
  const a = k.allowances ?? {};
  const pl2 = [
    `<p style="text-align:center;margin:3px 0"><b>PHỤ LỤC II<br>BẢNG MỨC PHỤ CẤP, HỖ TRỢ CỦA NGƯỜI LAO ĐỘNG</b><br><i>(Kèm theo Hợp đồng lao động số ${esc(k.number)} ký ngày ${R.TU})</i><br>
       <i>Hai bên thống nhất các khoản phụ cấp, hỗ trợ áp dụng đối với Người lao động như sau:</i></p>
     <table style="width:100%;border-collapse:collapse"><tr><th style="${td};width:36px">STT</th><th style="${td}">Khoản phụ cấp/hỗ trợ</th><th style="${td}">Mức áp dụng</th><th style="${td}">Điều kiện chi trả</th></tr>
       <tr><td style="${td};text-align:center">1</td><td style="${td}">Hỗ trợ ăn trưa</td><td style="${td}">${pc(a.an_trua)}</td><td style="${td}">Theo số ngày làm việc thực tế và quy định của Công ty.</td></tr>
       <tr><td style="${td};text-align:center">2</td><td style="${td}">Hỗ trợ xăng xe/đi lại</td><td style="${td}">${pc(a.xang)}</td><td style="${td}">Theo vị trí công việc và chính sách của Công ty.</td></tr>
       <tr><td style="${td};text-align:center">3</td><td style="${td}">Hỗ trợ điện thoại</td><td style="${td}">${pc(a.dien_thoai)}</td><td style="${td}">Theo nhu cầu liên lạc, điều phối công việc.</td></tr>
       <tr><td style="${td};text-align:center">4</td><td style="${td}">Hỗ trợ khác</td><td style="${td}">${pc(a.khac)}</td><td style="${td}">Theo thỏa thuận hoặc phê duyệt bằng văn bản.</td></tr></table>
     <p style="margin:8px 0 3px">Các khoản trong bảng là phụ cấp/hỗ trợ riêng theo thỏa thuận, không bao gồm mức lương theo công việc/chức danh, trừ khi có quy định khác.</p>
     <p style="margin:3px 0">Khoản theo tháng được thanh toán cùng kỳ lương; khoản theo ngày/thực tế được xác định theo thời gian làm việc, chứng từ và điều kiện hưởng tương ứng.</p>
     <p style="margin:3px 0">Nghĩa vụ thuế và việc xác định khoản làm căn cứ đóng BHXH thực hiện theo quy định pháp luật tại từng thời điểm.</p>
     <p style="margin:3px 0">Phụ lục có hiệu lực từ ngày <b>${R.TU}</b>, là bộ phận không tách rời của HĐLĐ. Mọi sửa đổi, bổ sung được lập thành văn bản phù hợp pháp luật.</p>
     <p style="margin:3px 0">Phụ lục được lập thành số bản và có giá trị pháp lý tương ứng với HĐLĐ kèm theo.</p>`,
    sig,
  ];
  return [...paginate(main.map(wrap)), ...paginate(pl1.map(wrap)), ...paginate(pl2.map(wrap))];
}

/** Lưu PDF theo quy tắc app cũ: <năm bắt đầu> / Nhân sự / Hợp đồng lao động / <họ tên>;
 *  tên "Hợp đồng lao động - <tên> (<số>)", tệp "HĐLĐ <số> - <tên>.pdf"; mỗi người mỗi năm 1 bản (sửa thì đè bản của năm đó);
 *  nội dung không đổi so với bản đã lưu thì bỏ qua. Trả 'saved' | 'same'. */
export async function saveContractPdf(k: Contract, x: LaborCtx): Promise<'saved' | 'same'> {
  const pages = contractPages(k, x);
  const sig = hash(pages.join(''));
  const key = `hdld:${k.staff_id}:${k.year}`;
  const path = [String(k.year), 'Nhân sự', 'Hợp đồng lao động', x.person.name];
  const so = k.number.replace(/[\\/:*?"<>|]+/g, '-');
  const { data } = await supabase.from('archive_items').select('id, note').eq('is_old', false).like('note', `%[${key}]%`);
  if (((data ?? []) as { note: string | null }[]).some((r) => r.note?.includes(`sig:${sig}`))) return 'same';
  await savePdf(path, `Hợp đồng lao động - ${x.person.name} (${so})`, `HĐLĐ ${so} - ${x.person.name}.pdf`,
    pages.map((html) => ({ html, land: false })), `Tự tạo PDF khi lưu/in · sig:${sig}`, key);
  return 'saved';
}
/** Mã ngắn của nội dung để biết hợp đồng có đổi không. */
function hash(s: string): string {
  let a = 5381, b = 52711;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = (Math.imul(a, 33) ^ c) >>> 0; b = (Math.imul(b, 31) + c) >>> 0; }
  return a.toString(36) + b.toString(36);
}
