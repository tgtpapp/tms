// Hợp đồng thuê xe ô tô (cá nhân cho nhà xe thuê xe để kinh doanh vận tải): mẫu theo nhà xe cung cấp (căn cứ pháp lý: cần xác minh).
// Mỗi chủ xe 1 hợp đồng, 1 hoặc nhiều xe (Điều 1 liệt kê). CCCD, chữ ký chủ xe có thể bổ sung sau (để trống thì in dòng chấm).
// Lưu: PDF vào hồ sơ từng xe (giấy "Hợp đồng thuê xe") + Lưu trữ hồ sơ › Năm › 03. Phương tiện › Hợp đồng thuê xe.
import { supabase, rpc } from './supabase';
import { boss, bossCol, company, signCol, type Boss, type Company, paperSig } from './profilePapers';
import { numberToWords } from './vnWords';
import { makePdf, pageImg, paginate } from './pdfMaker';
import { savePdf } from './dispatchPapers';
import { safeName } from './documents';
import { putFile } from './fileStore';
import { loadSigns, showName, type Sign } from './signatures';
import { bankName } from './vietqr';

export interface Person { name?: string; birth_year?: string; cccd?: string; cccd_on?: string; cccd_by?: string; hometown?: string; address?: string; phone?: string; files?: string[] }
export interface Lease {
  id: string; number: string; year: number; signed_on: string; start_on: string; end_on: string; pay_day: number | null; late_days: number | null;
  tax_party: 'A' | 'B' | null; lessor: Person & { spouse?: Person | null }; bank: { holder?: string; account?: string; bank?: string };
  director: { cccd_on?: string; cccd_by?: string; phone?: string; bank_holder?: string; bank_account?: string; bank_name?: string }; status: 'hieu_luc' | 'cham_dut'; note: string | null;
  items: { vehicle_id: string; price: number }[];
}
export const LEASE_COLS = 'id, number, year, signed_on, start_on, end_on, pay_day, late_days, tax_party, lessor, bank, director, status, note, items:vehicle_lease_items(vehicle_id, price)';

export interface LeaseVehicle {
  id: string; plate: string; type: string; brand: string | null; model: string | null; color: string | null; engine_no: string | null; chassis_no: string | null;
  seats: string; reg_no: string | null; reg_by: string | null; reg_on: string | null; reg_owner: string | null;
}
export interface LeaseCtx { company: Company & { tax: string }; boss: Boss; director: string; dir: { cccd: string; cccd_on: string; cccd_by: string; phone: string };
  vehicles: Map<string, LeaseVehicle>; signA: Sign | null; signB: Sign | null;
  bankB: { holder: string; account: string; bank: string } }   // tài khoản doanh nghiệp trong Cấu hình (khi hợp đồng chưa ghi)
/** Mã chữ ký chủ xe / vợ chồng theo hợp đồng (thư mục chu_ky) */
export const leaseSignKey = (leaseId: string, who: 'a' | 'b') => `hdtx_${leaseId}_${who}`;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hv = (x: unknown, d = '……………………') => (x != null && String(x).trim() !== '' ? esc(x) : d);
const dmy = (x: string | null | undefined) => (x ? x.split('-').reverse().join('/') : '……/……/………');
const money = (n: number) => n.toLocaleString('vi-VN');
const BODY: Record<string, string> = { ghe_ngoi: 'Xe ô tô khách', giuong_nam: 'Xe ô tô khách giường nằm', limousine: 'Xe ô tô khách (limousine)', phong_nam: 'Xe ô tô khách giường nằm (cabin)', khac: 'Xe ô tô' };

export async function loadLeaseCtx(tenantId: string, me: { id: string | null; name: string }, vehicleIds: string[], leaseId: string | null = null): Promise<LeaseCtx> {
  const ka = leaseId ? leaseSignKey(leaseId, 'a') : '', kb = leaseId ? leaseSignKey(leaseId, 'b') : '';
  const [c, t, p, ss, v, docs, { b }, sg] = await Promise.all([
    company(), supabase.from('tenants').select('tax_code').maybeSingle(), rpc<Record<string, string | null> | null>('lease_company_info', {}).catch(() => null),
    supabase.from('tenant_settings').select('key, value').in('key', ['cong_ty.giam_doc', 'tt.so_tai_khoan', 'tt.ngan_hang_bin', 'tt.ten_tai_khoan']),
    supabase.from('vehicles').select('id, plate, color, engine_no, chassis_no, owner_name, vehicle_types(name, brand, model_code, body_style, reg_seats, reg_berths)').in('id', vehicleIds),
    supabase.from('documents').select('vehicle_id, doc_no, issuer, issued_on, data').eq('doc_type', 'dang_ky').eq('is_current', true).in('vehicle_id', vehicleIds),
    boss(tenantId, me), leaseId ? loadSigns(tenantId, [ka, kb], true) : Promise.resolve(new Map<string, Sign>()),
  ]);
  const dk = new Map(((docs.data ?? []) as { vehicle_id: string; doc_no: string | null; issuer: string | null; issued_on: string | null; data: Record<string, unknown> | null }[]).map((d) => [d.vehicle_id, d]));
  type VRow = { id: string; plate: string; color: string | null; engine_no: string | null; chassis_no: string | null; owner_name: string | null;
    vehicle_types: { name: string; brand: string | null; model_code: string | null; body_style: string; reg_seats: number; reg_berths: number } | null };
  const vehicles = new Map(((v.data ?? []) as unknown as VRow[]).map((x) => {
    const ty = x.vehicle_types, d = dk.get(x.id);
    const seats = ty ? [ty.reg_seats ? `${ty.reg_seats} chỗ ngồi` : '', ty.reg_berths ? `${ty.reg_berths} giường nằm` : ''].filter(Boolean).join(', ') : '';
    return [x.id, { id: x.id, plate: x.plate, type: ty ? BODY[ty.body_style] ?? 'Xe ô tô' : 'Xe ô tô', brand: ty?.brand ?? null, model: ty?.model_code ?? null, color: x.color,
      engine_no: x.engine_no, chassis_no: x.chassis_no, seats, reg_no: d?.doc_no ?? null, reg_by: d?.issuer ?? null, reg_on: d?.issued_on ?? null,
      reg_owner: String(d?.data?.chu_xe ?? '') || x.owner_name } as LeaseVehicle];
  }));
  const set = (k: string) => String(((ss.data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value ?? '');
  const d = (k: string) => String(p?.[k] ?? '');
  return { company: { ...c, tax: (t.data as { tax_code?: string } | null)?.tax_code ?? '' }, boss: b, director: set('cong_ty.giam_doc'),
    dir: { cccd: d('cccd'), cccd_on: d('cccd_on'), cccd_by: d('cccd_by'), phone: d('phone') }, vehicles,
    bankB: { holder: set('tt.ten_tai_khoan'), account: set('tt.so_tai_khoan'), bank: set('tt.ngan_hang_bin') ? bankName(set('tt.ngan_hang_bin')) : '' },
    signA: sg.get(ka)?.img ? sg.get(ka)! : null, signB: sg.get(kb)?.img ? sg.get(kb)! : null };
}

const months = (a: string, b: string) => { const m = (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7)) + (+b.slice(8) >= +a.slice(8) - 1 ? 1 : 0); return Math.max(1, m); };

/** Các trang A4 của hợp đồng */
export function leasePages(k: Lease, x: LeaseCtx): string[] {
  const co = x.company, A = k.lessor, S = A.spouse, V = k.items.map((i) => ({ i, v: x.vehicles.get(i.vehicle_id) })).filter((r) => r.v);
  const P = (t: string) => `<p style="margin:3px 0">${t}</p>`, H = (t: string) => `<p style="margin:9px 0 3px"><b>${t}</b></p>`;
  const [sy, sm, sd] = (k.signed_on || '').split('-');
  const person = (p: Person | null | undefined) => [P(`Ông/Bà: <b>${hv(p?.name?.toUpperCase())}</b> &nbsp; Sinh năm: ${hv(p?.birth_year, '……………')}`),
    P(`Số CCCD: ${hv(p?.cccd)} &nbsp; Cấp ngày: ${p?.cccd_on ? dmy(p.cccd_on) : '……………'} &nbsp; Nơi cấp: ${hv(p?.cccd_by)}`),
    P(`Quê quán: ${hv(p?.hometown, '………………………………………………………………')}`), P(`Nơi thường trú: ${hv(p?.address, '………………………………………………………………')}`)].join('');
  const total = V.reduce((a, r) => a + r.i.price, 0);
  const words = (n: number) => { const w = numberToWords(n); return w.charAt(0).toLowerCase() + w.slice(1); };
  const priceTxt = (n: number) => n ? `${money(n)} VNĐ/tháng (Bằng chữ: ${esc(words(n))} đồng trên một tháng)` : '………………… VNĐ/tháng (Bằng chữ: ……………………………………… đồng trên một tháng)';
  const one = V.length === 1 ? V[0]!.v! : null;
  const dieu1 = one
    ? [P('1. Loại phương tiện: ' + esc(one.type)), P(`2. Nhãn hiệu: ${hv(one.brand)} &nbsp; Số loại: ${hv(one.model)}`), P(`3. Biển số đăng ký: <b>${esc(one.plate)}</b> &nbsp; Màu sơn: ${hv(one.color)}`),
      P(`4. Số máy: ${hv(one.engine_no)} &nbsp; Số khung: ${hv(one.chassis_no)}`), P(`5. Số chỗ ngồi / Trọng tải cho phép: ${hv(one.seats)}`),
      P(`6. Giấy chứng nhận đăng ký xe số: ${hv(one.reg_no)} do ${hv(one.reg_by)} cấp ngày ${one.reg_on ? dmy(one.reg_on) : '……………'} mang tên: ${hv(one.reg_owner || A.name)}`)].join('')
    : `<table style="width:100%;border-collapse:collapse;margin:4px 0">${['STT', 'Biển số', 'Loại / nhãn hiệu, số loại', 'Số máy / số khung', 'Số chỗ', 'Giấy đăng ký xe (số, nơi cấp, ngày cấp)', 'Giá thuê (VNĐ/tháng)']
        .map((h) => `<th style="border:1px solid #000;padding:3px;font-size:11.5px">${h}</th>`).join('')}${V.map((r, n) => `<tr>${[String(n + 1), `<b>${esc(r.v!.plate)}</b>`, `${esc(r.v!.type)}<br>${hv(r.v!.brand, '…')} ${hv(r.v!.model, '')}`,
        `${hv(r.v!.engine_no, '…')}<br>${hv(r.v!.chassis_no, '…')}`, hv(r.v!.seats, '…'), `${hv(r.v!.reg_no, '…')}, ${hv(r.v!.reg_by, '…')}, ${r.v!.reg_on ? dmy(r.v!.reg_on) : '…'}`, r.i.price ? money(r.i.price) : '…']
        .map((c) => `<td style="border:1px solid #000;padding:3px;font-size:11.5px;vertical-align:top">${c}</td>`).join('')}</tr>`).join('')}</table>`;
  const blocks = [
    `<table style="width:100%;border-collapse:collapse"><tr><td style="text-align:center"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><b>Độc lập – Tự do – Hạnh phúc</b><div style="width:170px;border-top:1px solid #000;margin:3px auto"></div></td></tr></table>
     <div style="text-align:center;margin:8px 0"><b style="font-size:17px">HỢP ĐỒNG THUÊ XE Ô TÔ</b><br><i>(V/v: Thuê phương tiện phục vụ hoạt động kinh doanh vận tải)</i><br>Số: <b>${esc(k.number)}</b></div>`,
    [P('- Căn cứ Bộ luật Dân sự số 91/2015/QH13 ngày 24/11/2015;'), P('- Căn cứ Luật Đường bộ số 35/2024/QH15 và Luật Trật tự, an toàn giao thông đường bộ số 36/2024/QH15;'),
      P('- Căn cứ Nghị định số 158/2024/NĐ-CP ngày 18/12/2024 của Chính phủ quy định về hoạt động vận tải đường bộ;'), P('- Căn cứ nhu cầu và khả năng thực tế của hai bên.')].join(''),
    P(`Hôm nay, ngày ${sd ?? '……'} tháng ${sm ?? '……'} năm ${sy ?? '……'}, tại trụ sở ${esc(co.name)}, chúng tôi gồm có:`),
    H('BÊN CHO THUÊ (Sau đây gọi tắt là Bên A):') + person(A) + P(`Số điện thoại: ${hv(A.phone)}`)
      + (S?.name ? `<p style="margin:3px 0"><i>(Xe là tài sản chung vợ chồng, cả hai cùng ký tên)</i></p>${person(S)}` : ''),
    H('BÊN THUÊ (Sau đây gọi tắt là Bên B):') + P(`Tên doanh nghiệp: <b>${esc(co.name.toUpperCase())}</b>`) + P(`Mã số doanh nghiệp: ${hv(co.tax)}`)
      + P(`Địa chỉ trụ sở chính: ${hv(co.address)}`) + P(`Đại diện theo pháp luật: Ông <b>${hv(x.director.toUpperCase())}</b> — Chức vụ: Giám đốc`)
      + P(`Số CCCD: ${hv(x.dir.cccd)} — Cấp ngày: ${x.dir.cccd_on || k.director.cccd_on ? dmy(x.dir.cccd_on || k.director.cccd_on) : '……………'} — Nơi cấp: ${hv(x.dir.cccd_by || k.director.cccd_by)}`)
      + P(`Số điện thoại: ${hv(x.dir.phone || k.director.phone)}`)
      + P(`Số tài khoản: ${hv(k.director.bank_account || x.bankB.account)} &nbsp; Tại Ngân hàng: ${hv(k.director.bank_name || x.bankB.bank)} &nbsp; Chủ tài khoản: ${hv(k.director.bank_holder || x.bankB.holder)}`),
    P('Sau khi bàn bạc, thỏa thuận, hai bên thống nhất ký kết Hợp đồng thuê xe ô tô với các điều khoản cụ thể như sau:'),
    H('Điều 1. Đặc điểm tài sản cho thuê') + P(`Bên A đồng ý cho Bên B thuê và Bên B đồng ý thuê ${String(V.length).padStart(2, '0')} xe ô tô thuộc quyền sở hữu hợp pháp của Bên A với các thông số kỹ thuật sau:`) + dieu1
      + P(`${one ? '7' : ''}${one ? '. ' : ''}Tình trạng xe khi bàn giao: Xe hoạt động bình thường, đầy đủ giấy tờ pháp lý bản chính/bản sao theo quy định (Giấy đăng ký xe, Giấy chứng nhận kiểm định ATKT &amp; BVMT, Bảo hiểm TNDS bắt buộc còn hiệu lực).`),
    H('Điều 2. Mục đích và thời hạn thuê') + P('1. Mục đích thuê: Bên B thuê xe để trực tiếp quản lý, điều hành và sử dụng vào mục đích kinh doanh vận tải hành khách / hàng hóa theo đúng quy định của Nghị định 158/2024/NĐ-CP và các văn bản hướng dẫn thi hành.')
      + P(`2. Thời hạn thuê: ${months(k.start_on, k.end_on)} tháng, tính từ ngày ${dmy(k.start_on)} đến hết ngày ${dmy(k.end_on)}.`)
      + P('3. Khi hết thời hạn thuê, nếu hai bên có nhu cầu tiếp tục hợp tác sẽ ký phụ lục gia hạn hoặc ký hợp đồng mới trước ngày hết hạn ít nhất 15 ngày.'),
    H('Điều 3. Giá thuê, phương thức thanh toán và nghĩa vụ thuế') + P(`1. Giá thuê xe: ${one ? priceTxt(total) : `theo bảng tại Điều 1, tổng cộng ${priceTxt(total)}`}.`)
      + P(`2. Phương thức thanh toán: Thanh toán bằng tiền mặt hoặc chuyển khoản vào tài khoản của Bên A vào ngày ${k.pay_day ?? '……'} hàng tháng.`)
      + P(`Chủ tài khoản: ${hv(k.bank.holder)}`) + P(`Số tài khoản: ${hv(k.bank.account)} &nbsp; Tại Ngân hàng: ${hv(k.bank.bank)}`)
      + P('3. Nghĩa vụ thuế và chi phí phát sinh:')
      + P(k.tax_party === 'B' ? 'Các khoản thuế phát sinh từ hoạt động cho thuê tài sản của cá nhân (thuế GTGT, thuế TNCN, lệ phí môn bài nếu doanh thu cho thuê trên mức quy định) do Bên B khấu trừ, kê khai và nộp thay Bên A theo quy định của pháp luật thuế.'
        : `Các khoản thuế phát sinh từ hoạt động cho thuê tài sản của cá nhân (thuế GTGT, thuế TNCN, lệ phí môn bài nếu doanh thu cho thuê trên mức quy định) do Bên ${k.tax_party ?? '……'} chịu trách nhiệm kê khai và nộp theo quy định của pháp luật thuế.`)
      + P('Toàn bộ chi phí vận hành thực tế trong quá trình kinh doanh (nhiên liệu, phí cầu đường, bến bãi, lương lái xe, bảo dưỡng định kỳ, đăng kiểm, bảo hiểm, phạt vi phạm hành chính do lỗi điều hành/lái xe của Bên B) do Bên B tự chi trả.'),
    H('Điều 4. Quyền và nghĩa vụ của Bên A') + P('1. Nghĩa vụ của Bên A:') + P('- Bàn giao xe và đầy đủ hồ sơ pháp lý của xe đúng thời gian, tình trạng như thỏa thuận tại Điều 1.')
      + P('- Cam đoan xe thuộc quyền sở hữu hợp pháp của Bên A, không có tranh chấp, không bị kê biên hoặc ràng buộc bởi giao dịch khác làm ảnh hưởng đến quyền sử dụng của Bên B (Nếu xe đang thế chấp ngân hàng, phải có văn bản đồng ý cho thuê của ngân hàng đính kèm).')
      + P('- Phối hợp với Bên B trong việc ký các giấy tờ, thủ tục cần thiết để Bên B đăng ký cấp Phù hiệu xe kinh doanh vận tải, lắp đặt thiết bị giám sát hành trình (GPS), camera hành trình theo quy định.')
      + P('2. Quyền của Bên A:') + P('- Nhận tiền thuê xe đầy đủ và đúng thời hạn theo Điều 3.') + P('- Nhận lại xe đúng hiện trạng ban đầu (trừ hao mòn tự nhiên) khi hết hạn hợp đồng.')
      + P(`- Đơn phương chấm dứt hợp đồng nếu Bên B chậm thanh toán tiền thuê quá ${k.late_days ?? '……'} ngày hoặc sử dụng xe vào mục đích trái pháp luật.`),
    H('Điều 5. Quyền và nghĩa vụ của Bên B') + P('1. Nghĩa vụ của Bên B:') + P('- Trực tiếp quản lý, điều hành phương tiện, bố trí lái xe có Giấy phép lái xe đúng hạng, đủ điều kiện sức khỏe và tập huấn nghiệp vụ vận tải theo quy định.')
      + P('- Thực hiện đầy đủ các quy định về điều kiện kinh doanh vận tải (đăng ký phù hiệu, duy trì dữ liệu giám sát hành trình, khám sức khỏe định kỳ, bảo dưỡng kỹ thuật xe).')
      + P('- Không được tự ý bán, cầm cố, thế chấp hoặc cho bên thứ ba thuê lại xe khi chưa có sự đồng ý bằng văn bản của Bên A.')
      + P('- Chịu hoàn toàn trách nhiệm dân sự, hành chính và hình sự nếu để xảy ra tai nạn giao thông hoặc vi phạm pháp luật trong thời gian quản lý, sử dụng xe.')
      + P('2. Quyền của Bên B:') + P('- Toàn quyền khai thác, điều động xe phục vụ hoạt động kinh doanh vận tải của doanh nghiệp trong suốt thời hạn thuê.')
      + P('- Yêu cầu Bên A khắc phục các hư hỏng lớn thuộc về kết cấu kỹ thuật vốn có của xe (nếu có thỏa thuận) hoặc đơn phương chấm dứt hợp đồng nếu Bên A bàn giao xe không đảm bảo điều kiện lưu hành.'),
    H('Điều 6. Điều khoản chung') + P('1. Hai bên cam kết thực hiện nghiêm túc các điều khoản đã thỏa thuận. Mọi sửa đổi, bổ sung hợp đồng phải được lập thành phụ lục bằng văn bản có chữ ký của cả hai bên.')
      + P('2. Trong quá trình thực hiện, nếu phát sinh tranh chấp, hai bên ưu tiên giải quyết thông qua thương lượng. Trường hợp không thỏa thuận được, tranh chấp sẽ được đưa ra Tòa án nhân dân có thẩm quyền để giải quyết.')
      + P('3. Hợp đồng này có hiệu lực kể từ ngày ký và được lập thành 02 (hai) bản có giá trị pháp lý như nhau, mỗi bên giữ 01 (một) bản.'),
    `<table style="width:100%;border-collapse:collapse;margin-top:12px"><tr>
      ${S?.name
        ? `<td style="width:50%;text-align:center;vertical-align:top"><b>ĐẠI DIỆN BÊN A</b><br><i style="font-size:12px">(Ký, ghi rõ họ tên)</i>
            <table style="width:100%;border-collapse:collapse"><tr>${[[A.name, x.signA], [S.name, x.signB]].map(([n, sg]) => `<td style="width:50%;text-align:center;vertical-align:top">
            <div style="height:90px;display:flex;align-items:center;justify-content:center">${(sg as Sign | null)?.img ? `<img src="${(sg as Sign).img}" alt="" style="max-height:66px;max-width:140px">` : ''}</div><b>${showName(sg as Sign | null) ? esc(String(n ?? '').toUpperCase()) : ''}</b></td>`).join('')}</tr></table></td>`
        : signCol('ĐẠI DIỆN BÊN A', '(Ký, ghi rõ họ tên)', x.signA?.img ? `<img src="${x.signA.img}" alt="" style="max-height:66px;max-width:190px">` : '', (A.name ?? '').toUpperCase(), x.signA, 50)}
      ${bossCol(x.boss, 'ĐẠI DIỆN BÊN B', 50)}</tr></table>`,
  ];
  return paginate(blocks.map((b) => `<div style="font-size:12.5px;line-height:1.42;text-align:justify">${b}</div>`));
}

/** Tự cập nhật Lưu trữ hồ sơ (chỉ bản PDF trong cây thư mục, không thêm giấy vào hồ sơ xe): nội dung đổi thì lưu đè. */
export async function archiveLeasePdf(k: Lease, x: LeaseCtx, sigs: Map<string, string>): Promise<boolean> {
  const pages = leasePages(k, x).map((html) => ({ html, land: false }));
  const sig = paperSig(pages);
  if (sigs.get(`hdtx:${k.id}`) === sig) return false;
  const so = k.number.replace(/[\\/:*?"<>|]+/g, '-'), who = k.lessor.name ?? '';
  await savePdf([String(k.year), '03. Phương tiện', 'Hợp đồng thuê xe'], `Hợp đồng thuê xe ${so} · ${who} · ${k.items.map((i) => x.vehicles.get(i.vehicle_id)?.plate).filter(Boolean).join(', ')}`.slice(0, 200),
    `HĐTX ${so} - ${who}.pdf`, pages, `Lập từ hồ sơ xe · sig:${sig}`, `hdtx:${k.id}`);
  return true;
}

/** Lưu PDF: hồ sơ từng xe (giấy "Hợp đồng thuê xe", có hạn) + Lưu trữ hồ sơ. Gọi khi lập / sửa xong. */
export async function saveLeasePdf(tenantId: string, k: Lease, x: LeaseCtx): Promise<string> {
  const pages = leasePages(k, x);
  const imgs = [];
  for (const html of pages) imgs.push(await pageImg(html, false));
  const pdf = makePdf(imgs), so = k.number.replace(/[\\/:*?"<>|]+/g, '-'), who = k.lessor.name ?? '';
  const blob = new Blob([pdf as BlobPart], { type: 'application/pdf' });
  for (const it of k.items) {
    const v = x.vehicles.get(it.vehicle_id);
    if (!v) continue;
    // Tên tệp trong kho chỉ được chữ không dấu (số HĐ có chữ "Đ"): 001/2026/HĐTX-TGTP → 0012026HDTXTGTP
    const path = `${tenantId}/xe/${v.id}/${safeName(v.plate)}_hop_dong_thue_${safeName(k.number)}_${crypto.randomUUID().slice(0, 4)}.pdf`;
    try { await putFile(path, blob, 'application/pdf'); }
    catch (e) { throw new Error(`Không tải được PDF lên hồ sơ xe ${v.plate}: ${e instanceof Error ? e.message : String(e)}`); }
    await rpc('add_vehicle_document', { p_vehicle_id: v.id, p_doc_type: 'hop_dong_thue', p_doc_no: k.number, p_issuer: who || null, p_issued_on: k.signed_on,
      p_valid_from: k.start_on, p_expires_on: k.end_on, p_data: { 'xe.bien_so': v.plate, gia_thue: it.price || null }, p_files: [path],
      p_note: k.status === 'cham_dut' ? 'Đã chấm dứt' : null, p_request_id: crypto.randomUUID() });
  }
  // Lưu trữ hồ sơ (Google Drive): chưa kết nối / lỗi mạng thì vẫn giữ hợp đồng + bản trong hồ sơ xe, báo lại để lưu sau
  try {
    await savePdf([String(k.year), '03. Phương tiện', 'Hợp đồng thuê xe'], `Hợp đồng thuê xe ${so} · ${who} · ${k.items.map((i) => x.vehicles.get(i.vehicle_id)?.plate).filter(Boolean).join(', ')}`.slice(0, 200),
    `HĐTX ${so} - ${who}.pdf`, pages.map((html) => ({ html, land: false })), 'Lập từ hồ sơ xe', `hdtx:${k.id}`);
    return '';
  } catch (e) {
    return `chưa lưu được vào Lưu trữ hồ sơ (${e instanceof Error ? e.message : String(e)})`;
  }
}
