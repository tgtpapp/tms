// Nghỉ việc (như app cũ): Đơn xin nghỉ việc + Quyết định thôi việc; số ngày báo trước theo Điều 35 BLLĐ 2019,
// hạn thanh toán 14 ngày làm việc (Điều 48), trợ cấp thôi việc (Điều 46). Căn cứ pháp lý theo app cũ: cần xác minh.
import type { Sign } from './signatures';

export const TV_HT: { value: string; label: string }[] = [
  { value: 'don', label: 'Người lao động đơn phương chấm dứt HĐLĐ (Điều 35)' },
  { value: 'thoathuan', label: 'Hai bên thỏa thuận chấm dứt HĐLĐ (khoản 3 Điều 34)' },
  { value: 'hethan', label: 'Hết hạn hợp đồng lao động (khoản 1 Điều 34)' },
];
export const TV_LY_DO = ['Lý do gia đình', 'Lý do sức khỏe', 'Thay đổi định hướng nghề nghiệp', 'Chuyển nơi cư trú', 'Có công việc khác phù hợp hơn', 'Tiếp tục học tập', 'Khác (ghi rõ bên dưới)'];

export interface TvPerson {
  name: string; birth: string | null; gender: string | null; cccd: string | null; cccdOn: string | null; cccdBy: string | null;
  phone: string | null; job: string | null; joined: string | null; dept: string | null; sign: Sign | null;
  hd: { number: string; kind: string; start: string; end: string | null } | null;   // hợp đồng lao động đang hiệu lực mới nhất
}
export const tvBlank: TvPerson = { name: '', birth: null, gender: null, cccd: null, cccdOn: null, cccdBy: null, phone: null, job: null, joined: null, dept: null, sign: null, hd: null };

// ------------------------------------------------------------------ ngày tháng
const parse = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y!, m! - 1, d!)); };
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const diffDays = (a: string, b: string) => Math.round((parse(a).getTime() - parse(b).getTime()) / 86400000);
/** Cộng n ngày làm việc (bỏ Chủ nhật, và Thứ 7 nếu công ty nghỉ T7) */
export function addWork(s: string, n: number, offSat: boolean): string {
  let d = s, k = 0;
  while (k < n) { d = addDays(d, 1); const w = parse(d).getUTCDay(); if (w !== 0 && !(offSat && w === 6)) k++; }
  return d;
}
/** Số ngày phải báo trước (Điều 35 BLLĐ 2019) theo hợp đồng đang hiệu lực */
export function notice(p: TvPerson): { n: number; work: boolean; txt: string } {
  const k = p.hd?.kind ?? 'xac_dinh';
  if (k === 'khong_xac_dinh') return { n: 45, work: false, txt: 'HĐLĐ không xác định thời hạn: báo trước ít nhất 45 ngày' };
  const th = p.hd?.start && p.hd.end ? Math.round(diffDays(p.hd.end, p.hd.start) / 30.44) : 12;
  if (k === 'thoi_vu' || th < 12) return { n: 3, work: true, txt: 'HĐLĐ dưới 12 tháng: báo trước ít nhất 3 ngày làm việc' };
  return { n: 30, work: false, txt: `HĐLĐ xác định thời hạn ${th} tháng: báo trước ít nhất 30 ngày` };
}
export const earliest = (p: TvPerson, don: string, offSat: boolean) => { const k = notice(p); return k.work ? addWork(don, k.n, offSat) : addDays(don, k.n); };
/** Thâm niên: x năm y tháng */
export function seniority(from: string | null, to: string): string {
  if (!from || !to || to < from) return '';
  const a = parse(from), b = parse(to);
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  if (b.getUTCDate() < a.getUTCDate()) m--;
  m = Math.max(0, m);
  const y = Math.floor(m / 12), mo = m % 12;
  return [y ? `${y} năm` : '', mo ? `${mo} tháng` : '', !y && !mo ? 'dưới 1 tháng' : ''].filter(Boolean).join(' ');
}
export function tvFacts(p: TvPerson, c: Record<string, string>, offSat: boolean) {
  const cuoi = c.ngay_nghi ? addDays(c.ngay_nghi, -1) : '';
  return { cuoi, bg: c.ngay_bg || cuoi, han: c.ngay_nghi ? addWork(cuoi || c.ngay_nghi, 14, offSat) : '', tn: c.ngay_nghi ? seniority(p.joined, cuoi || c.ngay_nghi) : '' };
}

// ------------------------------------------------------------------ mẫu in (theo app cũ)
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const dm = (s: string | undefined) => { if (!s) return 'ngày ..... tháng ..... năm ......'; const [y, m, d] = s.split('-'); return `ngày ${d} tháng ${m} năm ${y}`; };
const dd = (s: string | null | undefined) => (s ? s.split('-').reverse().join('/') : '......./....../..........');
const dots = (v: string | null | undefined, n = 30) => (v ? `<b>${esc(v)}</b>` : '.'.repeat(n));
const lyDoOf = (c: Record<string, string>) => (/^Khác/.test(c.ly_do ?? '') ? (c.ly_do_ct ?? '').trim() : [c.ly_do, c.ly_do_ct?.trim()].filter(Boolean).join(': '));
const items = (c: Record<string, string>) => String(c.noi_dung_bg ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
const ongOf = (p: TvPerson) => (p.gender === 'Nữ' ? 'Bà' : 'Ông');

export interface TvOpt { co: string; number: string; signed: string; title: string; c: Record<string, string>; p: TvPerson; offSat: boolean; sgBoss: string; sgMe: string }

export function tvDonHtml(o: TvOpt): string {
  const { c, p } = o, x = tvFacts(p, c, o.offSat), it = items(c), ly = lyDoOf(c);
  const r = (l: string, v: string) => `<div style="margin:3px 0">${l}: ${v}</div>`;
  const nhan = c.nguoi_bg ? `Ông/Bà <b>${esc(c.nguoi_bg)}</b>` : 'người được Công ty phân công';
  return `<div style="text-align:center"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><b>Độc lập - Tự do - Hạnh phúc</b><div style="width:150px;border-top:1px solid #000;margin:3px auto 6px"></div>
    <div style="text-align:right;font-style:italic">${esc(c.noi || '……………')}, ${dm(c.ngay_don)}</div></div>
    <h2 style="text-align:center;margin:16px 0 14px;font-size:19px">ĐƠN XIN NGHỈ VIỆC</h2>
    <table style="border-collapse:collapse"><tr><td style="vertical-align:top;white-space:nowrap;padding-right:8px"><b>Kính gửi:</b></td>
      <td>- Ban Giám đốc ${esc(o.co || 'Công ty')};<br>- Phòng Nhân sự / Bộ phận Tổ chức - Hành chính;<br>- Trưởng bộ phận ${dots(p.dept, 24)}.</td></tr></table>
    <div style="margin-top:10px">${r('Tôi tên là', dots(p.name.toUpperCase()))}${r('Ngày, tháng, năm sinh', `${dd(p.birth)} &nbsp; Giới tính: ${dots(p.gender, 8)}`)}
      ${r('Số CCCD', `${dots(p.cccd, 16)} &nbsp; Ngày cấp: ${dd(p.cccdOn)} &nbsp; Nơi cấp: ${dots(p.cccdBy, 16)}`)}
      ${r('Chức danh / Chức vụ hiện tại', dots(p.job, 26))}${r('Bộ phận / Phòng ban công tác', dots(p.dept, 26))}
      ${r('Ngày vào làm', dd(p.joined) + (p.hd ? ` &nbsp; theo Hợp đồng lao động số: <b>${esc(p.hd.number)}</b>` : ''))}${p.phone ? r('Số điện thoại liên hệ', `<b>${esc(p.phone)}</b>`) : ''}</div>
    <p style="margin:10px 0 4px">Nay tôi làm đơn này trân trọng xin được nghỉ việc kể từ <b>${dm(c.ngay_nghi)}</b>${x.cuoi ? ` (ngày làm việc cuối cùng là ${dd(x.cuoi)})` : ''}.</p>
    <p style="margin:4px 0">Lý do nghỉ việc: ${ly ? `<b>${esc(ly)}</b>.` : '.'.repeat(90)}</p>
    <p style="margin:8px 0 2px">Tôi cam kết trong thời gian báo trước đến ngày làm việc cuối cùng, tôi sẽ:</p>
    <ol style="margin:2px 0;padding-left:34px"><li>Tiếp tục hoàn thành tốt các nhiệm vụ, công việc được giao.</li>
      <li>Bàn giao đầy đủ công việc, tài sản, hồ sơ, tài liệu và công cụ làm việc cho ${nhan}${x.bg ? ` trước ngày <b>${dd(x.bg)}</b>` : ''}${it.length ? `, gồm:<ul style="margin:2px 0;padding-left:20px">${it.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '.'}</li>
      <li>Thanh toán dứt điểm các khoản tạm ứng, công nợ (nếu có) với Công ty.</li></ol>
    <p style="margin:8px 0">Kính mong Ban Giám đốc và Trưởng bộ phận xem xét, chấp thuận. Tôi xin chân thành cảm ơn!</p>
    <table style="width:100%;border-collapse:collapse"><tr><td style="width:50%"></td><td style="text-align:center;vertical-align:top"><b>NGƯỜI LÀM ĐƠN</b><br><i style="font-size:12px">(Ký và ghi rõ họ tên)</i>
      <div style="height:80px;display:flex;align-items:center;justify-content:center">${o.sgMe}</div><b>${esc(p.name)}</b></td></tr></table>
    <table style="width:100%;border-collapse:collapse;margin-top:14px"><tr><td style="width:50%;text-align:center;vertical-align:top"><b>Ý KIẾN CỦA TRƯỞNG BỘ PHẬN</b><br><i style="font-size:12px">(Ký và ghi rõ họ tên)</i>
      <div style="height:78px"></div><b>${esc(c.truong_bp ?? '')}</b></td>
      <td style="text-align:center;vertical-align:top"><b>PHÊ DUYỆT CỦA BAN GIÁM ĐỐC</b><br><i style="font-size:12px">(Ký, ghi rõ họ tên)</i><div style="height:78px"></div></td></tr></table>`;
}

export function tvQdHtml(o: TvOpt): string {
  const { c, p } = o, x = tvFacts(p, c, o.offSat), it = items(c), ly = lyDoOf(c), ong = ongOf(p), ten = esc(p.name || '……………………'), CO = (o.co || 'Công ty').toUpperCase();
  const li = (t: string, v: string) => `<li style="margin:2px 0">${t}: ${v}</li>`;
  const hdLine = p.hd ? `Hợp đồng lao động số ${esc(p.hd.number)} ký ngày ${dd(p.hd.start)}` : 'Hợp đồng lao động';
  const can = ['Căn cứ Bộ luật Lao động ngày 20 tháng 11 năm 2019;',
    'Căn cứ Nghị định số 145/2020/NĐ-CP ngày 14/12/2020 của Chính phủ quy định chi tiết và hướng dẫn thi hành một số điều của Bộ luật Lao động về điều kiện lao động và quan hệ lao động;',
    `Căn cứ ${hdLine} giữa ${esc(o.co || 'Công ty')} và ${ong} ${ten};`];
  if (c.hinh_thuc !== 'hethan') can.push(`Căn cứ Đơn xin nghỉ việc ${dm(c.ngay_don)} của ${ong} ${ten};`);
  can.push('Xét đề nghị của Trưởng bộ phận và Phòng Nhân sự.');
  const lyDo = c.hinh_thuc === 'hethan'
    ? `Hợp đồng lao động hết hạn theo khoản 1 Điều 34 Bộ luật Lao động năm 2019${p.hd?.end ? ` (hết hạn ngày ${dd(p.hd.end)})` : ''}; hai bên không tiếp tục giao kết hợp đồng lao động mới.`
    : c.hinh_thuc === 'thoathuan'
      ? `Hai bên thỏa thuận chấm dứt hợp đồng lao động theo khoản 3 Điều 34 Bộ luật Lao động năm 2019, trên cơ sở nguyện vọng của ${ong} ${ten}${ly ? ` (lý do: ${esc(ly)})` : ''}.`
      : `${ong} ${ten} đơn phương chấm dứt hợp đồng lao động theo nguyện vọng cá nhân${ly ? ` (lý do: ${esc(ly)})` : ''}, có báo trước theo quy định tại Điều 35 Bộ luật Lao động năm 2019.`;
  const nhan = c.nguoi_bg ? `Ông/Bà <b>${esc(c.nguoi_bg)}</b>` : 'người được Công ty phân công';
  const nn = String(c.noi_nhan || '- Như Điều 4;\n- Lưu: VT, HS.').split('\n').map((l) => l.trim()).filter(Boolean);
  return `<table style="width:100%;border-collapse:collapse"><tr>
      <td style="width:44%;text-align:center;vertical-align:top"><b>${esc(CO)}</b><div style="width:90px;border-top:1px solid #000;margin:3px auto"></div>Số: ${esc(o.number)}</td>
      <td style="text-align:center;vertical-align:top"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><b>Độc lập - Tự do - Hạnh phúc</b><div style="width:150px;border-top:1px solid #000;margin:3px auto"></div><i>${esc(c.noi || '……………')}, ${dm(o.signed)}</i></td></tr></table>
    <h2 style="text-align:center;margin:18px 0 2px;font-size:19px">QUYẾT ĐỊNH</h2><div style="text-align:center;font-weight:bold;margin-bottom:12px">${esc(o.title)}${o.title.includes(p.name) || !p.name ? '' : ` đối với ${ong} ${ten}`}</div>
    <div style="text-align:center;font-weight:bold;margin-bottom:8px">GIÁM ĐỐC ${esc(CO)}</div>
    <div style="font-style:italic;margin-left:18px">${can.map((t) => `<div>- ${t}</div>`).join('')}</div>
    <div style="text-align:center;font-weight:bold;margin:12px 0 6px">QUYẾT ĐỊNH:</div>
    <p style="margin:4px 0"><b>Điều 1.</b> Chấm dứt hợp đồng lao động và giải quyết cho nghỉ việc đối với:</p>
    <ul style="margin:2px 0 2px 18px;padding-left:18px">${li('Ông/Bà', dots(p.name.toUpperCase()))}${li('Ngày sinh', `${dd(p.birth)} &nbsp; Số CCCD: ${dots(p.cccd, 14)}`)}
      ${li('Chức vụ / Chức danh', dots(p.job, 24))}${li('Bộ phận / Phòng ban', dots(p.dept, 24))}
      ${li('Thời gian làm việc tại Công ty', `từ ${dd(p.joined)} đến ${dd(x.cuoi)}${x.tn ? ` (<b>${x.tn}</b>)` : ''}`)}${li('Nghỉ việc kể từ', `<b>${dm(c.ngay_nghi)}</b>`)}</ul>
    <p style="margin:6px 0 2px"><b>Điều 2. Lý do chấm dứt:</b> ${lyDo}</p>
    <p style="margin:6px 0 2px"><b>Điều 3. Trách nhiệm của các bên:</b></p>
    <ol style="margin:2px 0;padding-left:34px"><li>${ong} ${ten} có trách nhiệm bàn giao toàn bộ công việc, hồ sơ, tài liệu, tài sản và công cụ làm việc cho ${nhan}${x.bg ? ` trước ngày <b>${dd(x.bg)}</b>` : ''}${it.length ? ` (${it.map(esc).join('; ')})` : ''}; thanh toán các khoản tạm ứng, công nợ với Công ty (nếu có).</li>
      <li>Phòng Kế toán và Phòng Nhân sự có trách nhiệm thanh toán đầy đủ tiền lương, tiền phép năm chưa nghỉ, trợ cấp thôi việc (nếu đủ điều kiện theo Điều 46 Bộ luật Lao động) và các khoản liên quan đến quyền lợi của người lao động trong thời hạn 14 ngày làm việc${x.han ? `, chậm nhất ngày <b>${dd(x.han)}</b>` : ''}; hoàn thành thủ tục xác nhận thời gian đóng bảo hiểm xã hội và trả lại giấy tờ gốc cho người lao động (nếu Công ty đang giữ).</li></ol>
    <p style="margin:6px 0 2px"><b>Điều 4.</b> Quyết định này có hiệu lực kể từ ngày ký. Phòng Nhân sự, Phòng Kế toán, Trưởng bộ phận ${esc(p.dept ?? '')}, các bộ phận có liên quan và ${ong} ${ten} chịu trách nhiệm thi hành Quyết định này.</p>
    <table style="width:100%;border-collapse:collapse;margin-top:14px"><tr><td style="width:50%;vertical-align:top;font-size:13px"><b><i>Nơi nhận:</i></b>${nn.map((l) => `<br>${esc(l)}`).join('')}</td>${o.sgBoss}</tr></table>`;
}
