// Đơn xin nghỉ phép: tự lấy thông tin đơn nghỉ + hồ sơ điền vào mẫu chuẩn; chữ ký theo quy tắc chung
// (chữ ký trong hồ sơ nhân viên trước, chưa có thì chữ ký tài khoản). Ký đủ: người làm đơn, trưởng bộ phận điều hành
// (người duyệt đơn; chưa duyệt thì người đang dùng), Ban Giám đốc (chữ ký giám đốc theo Cấu hình in).
// Đơn đã duyệt tự lưu PDF vào Lưu trữ hồ sơ: <năm> / 02. Nhân sự / Nghỉ phép / Tháng mm-yyyy   [dnp:<id>]
import { loadDocCtx, type DocCtx } from './officialDocs';
import { loadSigns, showName, type Sign } from './signatures';
import { paperSig } from './profilePapers';
import { savePdf } from './dispatchPapers';
import { supabase } from './supabase';

export interface LeaveRow {
  id: string; staff_id: string; kind: string; from_on: string; to_on: string; days: number; reason: string | null;
  status: string; decided_by: string | null; handover_staff_id: string | null; created_at: string;
}
export const LEAVE_PAPER_COLS = 'id, staff_id, kind, from_on, to_on, days, reason, status, decided_by, handover_staff_id, created_at';
const KIND: Record<string, string> = {
  phep_nam: 'Nghỉ phép năm', om: 'Nghỉ ốm', viec_rieng: 'Nghỉ việc riêng có hưởng lương', khong_luong: 'Nghỉ không lương', thai_san: 'Nghỉ thai sản', nghi_bu: 'Nghỉ bù',
};
const POS: Record<string, string> = { lai_xe: 'Lái xe', phu_xe: 'Phụ xe', nhan_vien: 'Nhân viên' };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const dd = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '......./....../..........');
const dots = (v: string | null | undefined, n = 30) => (v ? `<b>${esc(v)}</b>` : '.'.repeat(n));
const num = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
const img = (s: Sign | null | undefined) => (s?.img ? `<img src="${s.img}" alt="" style="max-height:66px;max-width:190px">` : '');

interface Who { name: string; job: string | null; sign: Sign | null }
export interface LeaveCtx { doc: DocCtx; person: Who & { dept: string | null; phone: string | null }; handover: Who | null; head: Who | null }

/** Người theo hồ sơ (staffId) hoặc theo tài khoản (userId): họ tên, chức vụ, chữ ký (hồ sơ trước, tài khoản sau) */
async function who(tenantId: string, p: { staffId?: string | null; userId?: string | null }): Promise<Who | null> {
  if (!p.staffId && !p.userId) return null;
  const q = supabase.from('staff_members').select('id, full_name, job_title, position, user_id');
  const st = (((await (p.staffId ? q.eq('id', p.staffId) : q.eq('user_id', p.userId!)).limit(1)).data ?? []) as
    { id: string; full_name: string; job_title: string | null; position: string; user_id: string | null }[])[0];
  const keys = [st ? `nv_${st.id}` : null, p.userId ?? st?.user_id ?? null];
  const m = await loadSigns(tenantId, keys, true).catch(() => new Map<string, Sign>());
  const sign = keys.map((k) => (k ? m.get(k) : undefined)).find((x) => x?.img) ?? null;
  if (st) return { name: st.full_name, job: st.job_title || POS[st.position] || null, sign };
  const u = (await supabase.from('app_users').select('full_name').eq('id', p.userId!).maybeSingle()).data as { full_name?: string } | null;
  return { name: u?.full_name ?? '', job: null, sign };
}

export async function loadLeaveCtx(tenantId: string, me: { id: string | null; name: string }, l: LeaveRow): Promise<LeaveCtx> {
  const [doc, self, handover, head] = await Promise.all([
    loadDocCtx(tenantId, me, l.staff_id),
    who(tenantId, { staffId: l.staff_id }),
    who(tenantId, { staffId: l.handover_staff_id }),
    who(tenantId, { userId: l.decided_by ?? me.id }),
  ]);
  const p = doc.person;
  return { doc, handover, head, person: { name: p?.name ?? self?.name ?? '', job: p?.job ?? self?.job ?? null, dept: p?.dept ?? null, phone: p?.phone ?? null, sign: self?.sign ?? null } };
}

/** Địa điểm làm đơn: tỉnh / thành phố cuối địa chỉ công ty */
const placeOf = (addr: string) => addr.split(',').map((x) => x.trim()).filter(Boolean).pop()?.replace(/^(tỉnh|thành phố|tp\.?)\s+/i, '') ?? '';

export function leaveHtml(l: LeaveRow, x: LeaveCtx): string {
  const p = x.person, co = x.doc.company.name, b = x.doc.boss;
  const day = l.created_at.slice(0, 10);
  const [y, m, d] = day.split('-');
  const place = placeOf(x.doc.company.address);
  const col = (title: string, s: Sign | null | undefined, name: string, w = 50) => `<td style="width:${w}%;text-align:center;vertical-align:top"><b>${title}</b><br><i style="font-size:13px">(Ký và ghi rõ họ tên)</i>
    <div style="height:84px;display:flex;align-items:center;justify-content:center">${img(s)}</div><b>${showName(s) ? esc(name) : ''}</b></td>`;
  return `<div style="font-family:'Times New Roman',Tinos,serif;font-size:14.5px;line-height:1.55;text-align:justify">
    <div style="text-align:center"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><b>Độc lập - Tự do - Hạnh phúc</b><div style="width:170px;border-top:1px solid #000;margin:3px auto 0"></div></div>
    <h2 style="text-align:center;margin:22px 0 16px;font-size:19px">ĐƠN XIN NGHỈ PHÉP</h2>
    <table style="border-collapse:collapse;margin-left:60px"><tr><td style="vertical-align:top;white-space:nowrap;padding-right:8px"><b>Kính gửi:</b></td>
      <td>- Ban Giám đốc ${co ? `Công ty ${esc(co.replace(/^công ty\s+/i, ''))}` : dots(null, 30)}<br>- Trưởng phòng ${dots(p.dept, 30)}</td></tr></table>
    <div style="margin-top:12px">Tôi tên là: ${dots(p.name)}</div>
    <div>Chức vụ: ${dots(p.job, 20)} – Bộ phận: ${dots(p.dept, 24)}</div>
    <div>Số điện thoại liên hệ: ${dots(p.phone, 16)}</div>
    <p style="margin:8px 0 4px">Nay tôi làm đơn này kính đề nghị Ban Giám đốc và Trưởng bộ phận cho phép tôi được nghỉ phép trong thời gian:</p>
    <div style="margin-left:24px">Từ ngày: <b>${dd(l.from_on)}</b><br>Đến hết ngày: <b>${dd(l.to_on)}</b><br>Tổng số ngày nghỉ: <b>${num(l.days)}</b> ngày</div>
    <div>Hình thức nghỉ: <b>${esc(KIND[l.kind] ?? l.kind)}</b></div>
    <div>Lý do xin nghỉ: ${dots(l.reason, 80)}</div>
    <p style="margin:8px 0 4px">Trong thời gian nghỉ phép, tôi đã bàn giao toàn bộ công việc đang phụ trách cho anh/chị ${dots(x.handover?.name, 30)} – Chức vụ: ${dots(x.handover?.job, 20)} để đảm bảo tiến độ chung của bộ phận. Trong trường hợp khẩn cấp, anh/chị có thể liên hệ với tôi qua số điện thoại ${dots(p.phone, 16)}. Tôi xin cam đoan sẽ quay trở lại làm việc đúng thời hạn quy định. Rất mong nhận được sự chấp thuận của Ban Giám đốc và Trưởng bộ phận.</p>
    <p style="margin:4px 0">Tôi xin chân thành cảm ơn!</p>
    <div style="text-align:right;font-style:italic;margin:10px 0 6px">${esc(place || '……………')}, ngày ${d} tháng ${m} năm ${y}</div>
    <table style="width:100%;border-collapse:collapse"><tr>${col('Ý kiến của Trưởng bộ phận điều hành', x.head?.sign, x.head?.name ?? '')}${col('Người làm đơn', p.sign, p.name)}</tr></table>
    <table style="width:100%;border-collapse:collapse;margin-top:10px"><tr><td style="width:25%"></td>${col('Phê duyệt của Ban Giám đốc', b.gd, b.gdName)}<td style="width:25%"></td></tr></table>
  </div>`;
}

const slug = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Lưu PDF đơn đã duyệt; nội dung không đổi (so sig) thì bỏ qua. Trả true khi đã lưu. */
export async function archiveLeavePdf(tenantId: string, me: { id: string | null; name: string }, l: LeaveRow, sigs: Map<string, string>): Promise<boolean> {
  const x = await loadLeaveCtx(tenantId, me, l);
  const pages = [{ html: leaveHtml(l, x), land: false }];
  const sig = paperSig(pages);
  if (sigs.get(`dnp:${l.id}`) === sig) return false;
  const [y, m] = l.from_on.split('-');
  await savePdf([y!, '02. Nhân sự', 'Nghỉ phép', `Tháng ${m}-${y}`], `Đơn xin nghỉ phép · ${x.person.name} · ${dd(l.from_on)}`,
    `DonNghiPhep_${slug(x.person.name)}_${l.from_on}.pdf`, pages, `Đơn xin nghỉ phép · sig:${sig}`, `dnp:${l.id}`);
  return true;
}
