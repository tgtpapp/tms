// Sơ yếu lý lịch nhân viên (in A4): thông tin cá nhân, công việc, giấy tờ, quá trình hợp đồng, khen thưởng / kỷ luật.
// Lấy từ dữ liệu đang có của app; phần lương chỉ có khi người in được xem (database tự chặn theo quyền).
import { supabase } from './supabase';
import { boss, bossCol, company, head, signCol, signImg, type Page } from './profilePapers';
import { toDataUrl } from './pdfMaker';
import { KIND_NAME, type Kind } from './laborContract';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const d = (x: string | null | undefined) => (x ? x.slice(0, 10).split('-').reverse().join('/') : '');
const num = (n: unknown) => (Number(n) ? Number(n).toLocaleString('vi-VN') : '');
const POSITION: Record<string, string> = { lai_xe: 'Lái xe', phu_xe: 'Phụ xe', nhan_vien: 'Nhân viên' };
const CONTRACT: Record<string, string> = {
  khong_xac_dinh: 'Không xác định thời hạn', xac_dinh: 'Xác định thời hạn', thu_viec: 'Thử việc', thoi_vu: 'Thời vụ', khoan_viec: 'Khoán việc', khac: 'Khác',
};
const TH = 'border:1px solid #333;padding:5px;font-size:12.5px;text-align:center;background:#e2e8f0;font-weight:bold';
const TD = 'border:1px solid #333;padding:5px;font-size:12.5px;vertical-align:top';
const table = (H: string[], rows: string[][]) => rows.length
  ? `<table style="width:100%;border-collapse:collapse;margin:4px 0 10px"><tr>${H.map((h) => `<th style="${TH}">${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td style="${TD}">${c}</td>`).join('')}</tr>`).join('')}</table>`
  : '<p style="margin:2px 0 10px;font-size:13px"><i>Không có</i></p>';
const sec = (t: string) => `<div style="font-weight:bold;font-size:14px;margin:12px 0 4px">${t}</div>`;
const kv = (rows: [string, string][]) => `<table style="width:100%;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="${TD};width:34%">${k}</td><td style="${TD}"><b>${esc(v)}</b></td></tr>`).join('')}</table>`;
const nowVn = () => { const [y, m, dd] = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).split('-'); return `ngày ${dd} tháng ${m} năm ${y}`; };

interface DocRow { doc_type: string; doc_no: string | null; issuer: string | null; issued_on: string | null; expires_on: string | null; is_current: boolean; data: Record<string, unknown> | null }
interface Rec { kind: string; occurred_on: string; doc_no: string | null; title: string; data: Record<string, unknown> | null }
interface Ctr { number: string | null; kind: string; start_on: string; end_on: string | null; salary: number | null; position: string | null; allowances: Record<string, number> | null; status: string }

export async function staffCvPages(tenantId: string, staffId: string, me: { id: string | null; name: string }, photoUrl: string | null): Promise<Page[]> {
  const [sm, pv, dc, rc, hd, pay, co] = await Promise.all([
    supabase.from('staff_members').select('id, full_name, position, job_title, department, phone, joined_on, left_on, is_active, user_id').eq('id', staffId).maybeSingle(),
    supabase.from('staff_private').select('birth_date, gender, address, current_address, hometown, contract_type, bhxh_no').eq('staff_id', staffId).maybeSingle(),
    supabase.from('documents').select('doc_type, doc_no, issuer, issued_on, expires_on, is_current, data').eq('staff_id', staffId),
    supabase.from('staff_records').select('kind, occurred_on, doc_no, title, data').eq('staff_id', staffId).in('kind', ['khen_thuong', 'ky_luat']).order('occurred_on'),
    supabase.from('labor_contracts').select('number, kind, start_on, end_on, salary, position, allowances, status').eq('staff_id', staffId).eq('status', 'hieu_luc').order('start_on'),
    supabase.from('staff_pay_months').select('month, has_bhxh, bhxh_pay, transfer_pay').eq('staff_id', staffId).order('month', { ascending: false }).limit(1),
    company(),
  ]);
  if (!sm.data) throw new Error('Không tìm thấy nhân viên');
  const s = sm.data as { full_name: string; position: string; job_title: string | null; department: string | null; phone: string | null; joined_on: string; left_on: string | null; is_active: boolean; user_id: string | null };
  const p = (pv.data ?? null) as { birth_date: string | null; gender: string | null; address: string | null; current_address: string | null; hometown: string | null; contract_type: string | null; bhxh_no: string | null } | null;
  const docs = (dc.data ?? []) as DocRow[];
  const cur = (t: string) => docs.find((g) => g.doc_type === t && g.is_current);
  const cccd = cur('cccd'), gplx = cur('gplx');
  const ctrs = (hd.data ?? []) as unknown as Ctr[];
  const lastPay = ((pay.data ?? []) as { month: string; has_bhxh: boolean; bhxh_pay: number; transfer_pay: number }[])[0];
  const who = `nv_${staffId}`;
  const [{ b, m }, photo] = await Promise.all([boss(tenantId, me, [who, s.user_id ?? '']), toDataUrl(photoUrl)]);
  const own = m.get(who)?.img ? m.get(who) : (s.user_id ? m.get(s.user_id) : undefined);

  const papers = ['gplx', 'kham_suc_khoe', 'tap_huan'].map((t) => cur(t)).filter((g): g is DocRow => !!g).map((g) => [
    esc({ gplx: 'Giấy phép lái xe', kham_suc_khoe: 'Giấy khám sức khỏe', tap_huan: 'Chứng nhận tập huấn nghiệp vụ' }[g.doc_type] ?? g.doc_type)
      + (g.doc_type === 'gplx' && g.data?.hang ? ` hạng ${esc(g.data.hang)}` : ''),
    esc(g.doc_no ?? ''), d(g.issued_on), esc(g.issuer ?? ''), d(g.expires_on)]);
  const showSalary = ctrs.some((c) => c.salary != null);
  const ctrRows = ctrs.map((c) => [esc(c.number ?? ''), esc(KIND_NAME[c.kind as Kind] ?? c.kind), d(c.start_on), c.end_on ? d(c.end_on) : 'Không thời hạn',
    ...(showSalary ? [num(c.salary)] : [])]);
  const ktRows = ((rc.data ?? []) as Rec[]).map((r) => [d(r.occurred_on), r.kind === 'ky_luat' ? 'Kỷ luật' : 'Khen thưởng',
    esc([r.title, r.data?.hinh_thuc].filter(Boolean).join('; ')), esc(r.doc_no ?? '')]);
  const now = ctrs.filter((c) => c.start_on <= new Date().toISOString().slice(0, 10)).pop();
  const allow = now?.allowances ? Object.values(now.allowances).reduce((a, x) => a + (Number(x) || 0), 0) : 0;

  const html = `${head(co)}
  <h2 style="text-align:center;margin:16px 0 2px;font-size:20px">SƠ YẾU LÝ LỊCH NHÂN VIÊN</h2>
  <div style="display:flex;gap:16px;margin-top:12px;align-items:flex-start">
    <div style="width:30mm;height:40mm;border:1px solid #000;flex:0 0 auto;display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:12px">
      ${photo ? `<img src="${photo}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:50% 0">` : 'Ảnh 3x4'}</div>
    <div style="flex:1">${kv([
      ['Họ và tên', s.full_name.toUpperCase()], ['Giới tính', p?.gender === 'nam' ? 'Nam' : p?.gender === 'nu' ? 'Nữ' : ''], ['Ngày sinh', d(p?.birth_date)],
      ['Số CCCD', cccd?.doc_no ?? ''], ['Ngày cấp, nơi cấp', [d(cccd?.issued_on), cccd?.issuer].filter(Boolean).join(', ')],
      ['Quê quán', p?.hometown || String(cccd?.data?.que_quan ?? '')], ['Nơi thường trú', p?.address || String(cccd?.data?.['nv.noi_thuong_tru'] ?? '')], ['Điện thoại', s.phone ?? ''],
    ])}</div>
  </div>
  ${sec('I. THÔNG TIN CÔNG VIỆC')}
  ${kv([
    ['Chức vụ', s.job_title?.trim() || POSITION[s.position] || ''], ['Bộ phận', s.department ?? ''], ['Ngày vào làm', d(s.joined_on)],
    ['Loại hợp đồng', p?.contract_type ? CONTRACT[p.contract_type] ?? '' : (now ? KIND_NAME[now.kind as Kind] ?? '' : '')],
    ...(s.position === 'lai_xe' ? [['Hạng GPLX', String(gplx?.data?.hang ?? '')] as [string, string]] : []),
    ...(now?.salary != null ? [['Lương theo hợp đồng', `${num(now.salary)} đồng`] as [string, string]] : []),
    ...(now?.salary != null && allow ? [['Phụ cấp, hỗ trợ', `${num(allow)} đồng/tháng`] as [string, string]] : []),
    ...(p?.bhxh_no ? [['Số sổ BHXH', p.bhxh_no] as [string, string]] : []),
    ...(lastPay ? [['Lương đóng BHXH', lastPay.has_bhxh ? `${num(lastPay.bhxh_pay)} đồng` : 'Không đóng'] as [string, string]] : []),
    ...(!s.is_active ? [['Ngày nghỉ việc', d(s.left_on)] as [string, string]] : []),
  ])}
  ${sec('II. GIẤY TỜ')}
  ${table(['Giấy tờ', 'Số', 'Ngày cấp', 'Nơi cấp', 'Hết hạn'], papers)}
  ${sec('III. QUÁ TRÌNH HỢP ĐỒNG LAO ĐỘNG')}
  ${table(['Số HĐ', 'Loại hợp đồng', 'Từ ngày', 'Đến ngày', ...(showSalary ? ['Lương HĐ'] : [])], ctrRows)}
  ${sec('IV. KHEN THƯỞNG, KỶ LUẬT')}
  ${table(['Ngày', 'Loại', 'Nội dung', 'Số quyết định'], ktRows)}
  <p style="text-align:right;font-style:italic;margin:14px 10px 4px">..............., ${nowVn()}</p>
  <table style="width:100%;border-collapse:collapse"><tr>
    ${signCol('NGƯỜI KHAI', '(Ký, ghi rõ họ tên)', signImg(own), s.full_name, own, 50)}
    ${bossCol(b, 'XÁC NHẬN CỦA ĐƠN VỊ', 50)}
  </tr></table>`;
  return [{ html, land: false }];
}
