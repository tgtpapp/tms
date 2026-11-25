// Giám sát an toàn giao thông (theo mẫu QĐ giao nhiệm vụ giám sát ATGT của nhà xe):
// - Phụ lục 1: Checklist trước khi giao chuyến – tự lập mỗi ngày từ dữ liệu xếp xe, giấy tờ xe / lái xe, sổ giám sát.
// - Phụ lục 2: Sổ giám sát hằng ngày – chỉ lập ngày có sự việc.
// - Phụ lục 3 + 5: Báo cáo tuần / tháng / năm kèm bảng tổng hợp vi phạm – tự tính từ chuyến đã chạy và sổ giám sát.
// - Phụ lục 4: Biên bản xác minh (sự việc mức 2, 3 đã đóng). Phụ lục 6: Báo cáo sự cố khẩn cấp (sự cố hoặc mức 3).
// Tất cả tự lưu PDF vào Lưu trữ hồ sơ › Năm › An toàn giao thông; nội dung không đổi thì không lưu lại.
import { letterhead, loadBrand, type Brand } from './brand';
import { savePdf, resetFolders } from './dispatchPapers';
import { drive } from './drive';
import { paginate } from './pdfMaker';
import { company, head, signCol, type Company } from './profilePapers';
import { mergeRecordPapers } from './recordPapers';
import { fetchAll, rpc, supabase } from './supabase';

export const KIND: Record<string, string> = {
  toc_do: 'Tốc độ', thoi_gian_lai: 'Thời gian lái xe', sai_hanh_trinh: 'Sai hành trình', mat_ket_noi: 'Thiết bị mất kết nối / gián đoạn dữ liệu',
  dung_do: 'Dừng / đỗ bất thường', su_co: 'Sự cố / tai nạn', tinh_trang_xe: 'Tình trạng xe', giay_to: 'Giấy tờ / điều kiện xe, lái xe', phan_anh: 'Phản ánh', khac: 'Khác',
};
export const LEVEL: Record<number, string> = { 1: 'Nhắc nhở', 2: 'Cần xác minh', 3: 'Nghiêm trọng' };
export const CONCL: Record<string, string> = { khac_phuc: 'Đã khắc phục', vi_pham: 'Vi phạm (ghi lý lịch)', khong_vi_pham: 'Không vi phạm' };
export const SOURCES = ['Thiết bị giám sát hành trình (GSHT)', 'Camera giám sát người lái', 'Điều hành', 'Kiểm tra trực tiếp', 'Phản ánh của lái xe', 'Phản ánh của hành khách', 'Cơ quan chức năng'];
export interface SEvent {
  id: string; occurred_at: string; place: string | null; vehicle_id: string | null; staff_id: string | null; trip_id: string | null; kind: string; level: number;
  source: string | null; content: string; notified: string | null; action: string | null; due_on: string | null; verify: string | null; result: string | null;
  status: 'mo' | 'dong'; conclusion: string | null; closed_at: string | null; auto: boolean; created_at: string;
}
export const EV_COLS = 'id, occurred_at, place, vehicle_id, staff_id, trip_id, kind, level, source, content, notified, action, due_on, verify, result, status, conclusion, closed_at, auto, created_at';

const TZ = 'Asia/Ho_Chi_Minh';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const vnDay = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: TZ });
export const vnTime = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
export const dmy = (d: string | null | undefined) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '……/……/……');
export const todayVN = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const hash = (s: string) => { let a = 5381, b = 52711; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = (Math.imul(a, 33) ^ c) >>> 0; b = (Math.imul(b, 31) + c) >>> 0; } return a.toString(36) + b.toString(36); };
const B = 'border:1px solid #000;padding:3px 5px;font-size:11.5px;vertical-align:top';
const table = (h: string[], rows: string[][], center: number[] = []) => `<table style="width:100%;border-collapse:collapse;margin:4px 0"><tr>${h.map((x) => `<th style="${B};background:#e2e8f0;text-align:center">${x}</th>`).join('')}</tr>
  ${rows.map((r) => `<tr>${r.map((c, i) => `<td style="${B}${center.includes(i) ? ';text-align:center' : ''}">${c}</td>`).join('')}</tr>`).join('')}</table>`;
const dir = (r: { name: string; name_ve: string | null } | undefined, d: string) => (!r ? '' : d === 've' ? r.name_ve?.trim() || r.name.split(/\s+[-–—]\s+/).reverse().join(' - ') : r.name);

// ------------------------------------------------------------------ Dữ liệu dùng chung 1 lượt
interface Doc { vehicle_id: string | null; staff_id: string | null; doc_type: string; expires_on: string | null }
export interface Base {
  company: Company; brand: Brand; vehicles: Map<string, { plate: string; gsht: string | null; camera: string | null }>; staff: Map<string, string>;
  routes: Map<string, { name: string; name_ve: string | null }>; docs: Doc[]; events: SEvent[];
  supervisor: { name: string; since: string } | null;
}
export async function loadBase(): Promise<Base> {
  const [c, vh, sm, rt, dc, rc, ev, qd] = await Promise.all([
    company(),
    supabase.from('vehicles').select('id, plate, gsht_provider, camera_provider'),
    supabase.from('staff_members').select('id, full_name'),
    supabase.from('routes').select('id, name, name_ve'),
    supabase.from('documents').select('vehicle_id, staff_id, doc_type, expires_on').eq('is_current', true)
      .in('doc_type', ['dang_ky', 'kiem_dinh', 'bh_tnds', 'phu_hieu', 'gplx', 'kham_suc_khoe', 'tap_huan']),
    supabase.from('staff_records').select('staff_id, kind, data').in('kind', ['suc_khoe', 'dao_tao']),
    supabase.from('safety_events').select(EV_COLS).order('occurred_at'),
    supabase.from('official_docs').select('staff_id, signed_on, content').eq('template', 'qd_giam_sat').eq('status', 'hieu_luc').order('signed_on', { ascending: false }).limit(1),
  ]);
  if (ev.error) throw new Error(ev.error.message);
  const staff = new Map(((sm.data ?? []) as { id: string; full_name: string }[]).map((s) => [s.id, s.full_name]));
  const q = ((qd.data ?? []) as { staff_id: string | null; signed_on: string; content: Record<string, string> }[])[0];
  return {
    company: c, brand: await loadBrand(), staff,
    vehicles: new Map(((vh.data ?? []) as { id: string; plate: string; gsht_provider: string | null; camera_provider: string | null }[]).map((v) => [v.id, { plate: v.plate, gsht: v.gsht_provider, camera: v.camera_provider }])),
    routes: new Map(((rt.data ?? []) as { id: string; name: string; name_ve: string | null }[]).map((r) => [r.id, r])),
    docs: mergeRecordPapers((dc.data ?? []) as Doc[], (rc.data ?? []) as { staff_id: string; kind: string; data: Record<string, unknown> | null }[],
      (sid, type, exp): Doc => ({ vehicle_id: null, staff_id: sid, doc_type: type, expires_on: exp })),
    // Bỏ khỏi sổ / báo cáo: cảnh báo giờ lái trong ngày / tuần do phần mềm tự ghi theo quy định đã bãi bỏ
    // (Luật 118/2025/QH15 từ 01/7/2026 chỉ còn giới hạn lái xe liên tục 4 giờ); vẫn lưu trong dữ liệu.
    events: ((ev.data ?? []) as SEvent[]).filter((e) => !(e.auto && e.status === 'dong' && e.conclusion === 'khong_vi_pham' && /Luật 118\/2025/.test(e.result ?? ''))),
    supervisor: q?.staff_id ? { name: staff.get(q.staff_id) ?? '', since: q.content?.hieu_luc || q.signed_on } : null,
  };
}
const who = (b: Base, e: { vehicle_id: string | null; staff_id: string | null }) =>
  [e.vehicle_id ? b.vehicles.get(e.vehicle_id)?.plate : '', e.staff_id ? b.staff.get(e.staff_id) : ''].filter(Boolean).join(' / ') || '—';
const signRow = (cols: [string, string][]) => `<table style="width:100%;border-collapse:collapse;margin-top:10px"><tr>${cols.map(([t, n]) => signCol(t, '(Ký, ghi rõ họ tên)', '', n, null, Math.floor(100 / cols.length))).join('')}</tr></table>`;
const title = (t: string, sub = '') => `<h2 style="text-align:center;margin:10px 0 2px;font-size:16px">${t}</h2>${sub ? `<div style="text-align:center;margin-bottom:6px">${sub}</div>` : ''}`;

// ------------------------------------------------------------------ Phụ lục 1: Checklist trước khi giao chuyến (theo ngày)
export const CHECK_ITEMS = [
  'Lái xe có giấy phép phù hợp, còn hiệu lực và các điều kiện cần thiết', 'Lái xe đáp ứng điều kiện tập huấn nghiệp vụ vận tải áp dụng',
  'Lái xe có điều kiện sức khỏe/không có dấu hiệu không đủ điều kiện lái', 'Xe có đăng ký, kiểm định, bảo hiểm, phù hiệu/giấy tờ theo yêu cầu',
  'Thiết bị giám sát hành trình hoạt động (nếu phải lắp)', 'Camera/thiết bị ghi hình người lái hoạt động (nếu phải lắp)',
  'Tình trạng lái xe và lịch nghỉ phù hợp giới hạn lái xe', 'Lịch trình, nhiệm vụ, điểm đi/đến được thông tin rõ', 'Cảnh báo/vi phạm tồn đọng đã được rà soát',
  'Phối hợp xác nhận kiểm tra xe: phanh, lốp, lái, đèn, còi...', 'Thông tin liên lạc và phương án xử lý sự cố được phổ biến', 'Các yêu cầu đặc thù chuyến xe được kiểm tra',
];
const DOC_NAME: Record<string, string> = { dang_ky: 'đăng ký', kiem_dinh: 'kiểm định', bh_tnds: 'BH TNDS', phu_hieu: 'phù hiệu', gplx: 'GPLX', kham_suc_khoe: 'khám SK', tap_huan: 'tập huấn' };
export async function checklistDay(b: Base, day: string): Promise<{ pages: string[]; n: number } | null> {
  const tr = await supabase.from('trips').select('id, route_id, direction, depart_at, vehicle_id').eq('service_date', day).eq('status', 'mo').order('depart_at');
  if (tr.error) throw new Error(tr.error.message);
  const trips = (tr.data ?? []) as { id: string; route_id: string; direction: string; depart_at: string; vehicle_id: string | null }[];
  const crew = trips.length ? ((await supabase.from('trip_crew').select('trip_id, staff_id').in('trip_id', trips.map((t) => t.id)).eq('role', 'lai_xe_1').eq('active', true)).data ?? []) as { trip_id: string; staff_id: string }[] : [];
  const drv = new Map(crew.map((c) => [c.trip_id, c.staff_id]));
  const rows = trips.filter((t) => t.vehicle_id || drv.get(t.id));
  if (!rows.length) return null;
  const doc = (k: 'vehicle_id' | 'staff_id', id: string, type: string) => b.docs.find((d) => d[k] === id && d.doc_type === type);
  const ok = (d: Doc | undefined) => !!d && (!d.expires_on || d.expires_on >= day);
  const why = (d: Doc | undefined, type: string) => (!d ? `chưa có ${DOC_NAME[type]}` : `${DOC_NAME[type]} hết hạn ${dmy(d.expires_on)}`);
  const body = rows.map((t, i) => {
    const sid = drv.get(t.id) ?? null, v = t.vehicle_id ? b.vehicles.get(t.vehicle_id) : undefined, notes: string[] = [];
    const mark = (pass: boolean, note?: string) => { if (!pass && note) notes.push(note); return pass ? '<b>Đ</b>' : '<b style="color:#b91c1c">K</b>'; };
    const staffItem = (type: string) => (sid ? mark(ok(doc('staff_id', sid, type)), why(doc('staff_id', sid, type), type)) : mark(false, type === 'gplx' ? 'chưa xếp lái xe' : undefined));
    const vehDocs = ['dang_ky', 'kiem_dinh', 'bh_tnds', 'phu_hieu'].filter((x) => !t.vehicle_id || !ok(doc('vehicle_id', t.vehicle_id, x)));
    const timeWarn = b.events.some((e) => e.trip_id === t.id && e.auto && e.kind === 'thoi_gian_lai' && (e.status === 'mo' || e.conclusion === 'vi_pham'));
    const open = b.events.filter((e) => e.status === 'mo' && e.trip_id !== t.id && e.occurred_at < t.depart_at && ((sid && e.staff_id === sid) || (t.vehicle_id && e.vehicle_id === t.vehicle_id)));
    const cells = [
      staffItem('gplx'), staffItem('tap_huan'), staffItem('kham_suc_khoe'),
      t.vehicle_id ? mark(vehDocs.length === 0, vehDocs.map((x) => why(doc('vehicle_id', t.vehicle_id!, x), x)).join(', ')) : mark(false, 'chưa xếp xe'),
      t.vehicle_id ? mark(!!v?.gsht, 'chưa khai thiết bị GSHT') : '–', t.vehicle_id ? mark(!!v?.camera, 'chưa khai camera') : '–',
      sid ? mark(!timeWarn, 'cảnh báo giờ lái khi xếp xe') : '–', mark(!!(t.vehicle_id && sid), undefined),
      mark(open.length === 0, `${open.length} cảnh báo/vi phạm chưa đóng`), 'BNT', mark(!!b.supervisor, 'chưa có QĐ giao nhiệm vụ giám sát'), 'N.A.',
    ];
    return [String(i + 1), vnTime(t.depart_at), esc(dir(b.routes.get(t.route_id), t.direction)), esc(v?.plate ?? '—'), esc(sid ? b.staff.get(sid) : '—'), ...cells, esc(notes.join('; '))];
  });
  const hdr = ['STT', 'Giờ', 'Tuyến', 'Xe', 'Lái xe', ...CHECK_ITEMS.map((_, i) => String(i + 1)), 'Ghi chú / xử lý'];
  const per = 18, pages: string[] = [];
  for (let i = 0; i < body.length; i += per) {
    const first = i === 0, last = i + per >= body.length;
    pages.push(`<div style="font-size:12px">${first ? `${letterhead(b.brand)}${title('CHECKLIST KIỂM TRA TRƯỚC KHI GIAO CHUYẾN', `Ngày ${dmy(day)} · ${body.length} chuyến · (Phụ lục 1 – QĐ giao nhiệm vụ giám sát ATGT)`)}` : ''}
      ${table(hdr, body.slice(i, i + per), [0, 1, ...CHECK_ITEMS.map((_, k) => 5 + k)])}
      ${last ? `<div style="font-size:10.5px;margin-top:4px"><b>Nội dung kiểm tra:</b> ${CHECK_ITEMS.map((x, k) => `<b>${k + 1}</b>. ${esc(x)}`).join(' · ')}</div>
      <div style="font-size:10.5px">Đ = Đạt · K = Không đạt · N.A. = Không áp dụng · BNT = theo Bảng kiểm tra an toàn, nghiệm thu xe trước khi khởi hành của lái xe. Mục 1–9, 11 do phần mềm tự đối chiếu hồ sơ xe, lái xe, lịch xếp xe và sổ giám sát.</div>
      ${signRow([['NGƯỜI KIỂM TRA / GIÁM SÁT', b.supervisor?.name ?? ''], ['XÁC NHẬN ĐIỀU HÀNH', '']])}` : ''}</div>`);
  }
  return { pages, n: body.length };
}

// ------------------------------------------------------------------ Phụ lục 2: Sổ theo dõi giám sát an toàn hằng ngày
const evRow2 = (b: Base, e: SEvent) => [`${dmy(vnDay(e.occurred_at))} ${vnTime(e.occurred_at)}`, esc(who(b, e)), esc(e.trip_id ? tripLabel(b, e) : e.place ?? ''),
  `<b>${esc(KIND[e.kind] ?? e.kind)}</b> (${LEVEL[e.level]})<br>${esc(e.content)}`, esc([e.notified && `Báo: ${e.notified}`, e.action, e.due_on && `Hạn: ${dmy(e.due_on)}`].filter(Boolean).join(' · ')),
  esc(e.status === 'dong' ? `${CONCL[e.conclusion ?? ''] ?? 'Đã đóng'}${e.result ? `: ${e.result}` : ''}` : 'Đang theo dõi')];
const tripLabel = (b: Base, e: SEvent) => { const t = tripCache.get(e.trip_id ?? ''); return t ? `${vnTime(t.depart_at)} ${dir(b.routes.get(t.route_id), t.direction)}` : ''; };
const tripCache = new Map<string, { depart_at: string; route_id: string; direction: string }>();
async function loadTrips(ids: string[]) {
  const need = [...new Set(ids)].filter((x) => x && !tripCache.has(x));
  for (let i = 0; i < need.length; i += 200) {
    const { data } = await supabase.from('trips').select('id, depart_at, route_id, direction').in('id', need.slice(i, i + 200));
    for (const t of (data ?? []) as { id: string; depart_at: string; route_id: string; direction: string }[]) tripCache.set(t.id, t);
  }
}
export async function soNgay(b: Base, day: string): Promise<string[] | null> {
  const L = b.events.filter((e) => vnDay(e.occurred_at) === day);
  if (!L.length) return null;
  await loadTrips(L.map((e) => e.trip_id ?? ''));
  return paginate([`${letterhead(b.brand)}${title('SỔ THEO DÕI GIÁM SÁT AN TOÀN HẰNG NGÀY', `Ngày ${dmy(day)} · (Phụ lục 2)`)}`,
    table(['Ngày/giờ', 'Xe / lái xe', 'Chuyến / tuyến', 'Cảnh báo/vi phạm/sự cố', 'Thông báo/biện pháp', 'Kết quả/đóng'], L.map((e) => evRow2(b, e))),
    '<p style="font-size:11px;margin:4px 0">Ghi rõ thời điểm, dữ liệu/căn cứ, nội dung cảnh báo, người được thông báo, thời hạn khắc phục và kết quả xác minh.</p>',
    signRow([['NGƯỜI GIÁM SÁT', b.supervisor?.name ?? ''], ['XÁC NHẬN ĐIỀU HÀNH', '']])].map((x) => `<div style="font-size:12px">${x}</div>`), true);
}

// ------------------------------------------------------------------ Phụ lục 4: Biên bản ghi nhận / xác minh sự việc
export function bienBan(b: Base, e: SEvent): string[] {
  const line = (n: string, t: string, v: string) => `<p style="margin:5px 0"><b>${n}. ${t}:</b> ${v || '…………………………………………'}</p>`;
  const lap = e.closed_at ?? e.created_at;
  return paginate([`${head(b.company)}${title('BIÊN BẢN GHI NHẬN / XÁC MINH SỰ VIỆC', '(Phụ lục 4 – QĐ giao nhiệm vụ giám sát ATGT)')}`,
    line('1', 'Thời gian lập', `${vnTime(lap)} ngày ${dmy(vnDay(lap))}`), line('2', 'Người lập', esc(b.supervisor?.name ?? '')),
    line('3', 'Thông tin phương tiện/lái xe/chuyến', esc([who(b, e), e.trip_id ? tripLabel(b, e) : ''].filter(Boolean).join(' · '))),
    line('4', 'Thời gian, địa điểm xảy ra', esc(`${vnTime(e.occurred_at)} ngày ${dmy(vnDay(e.occurred_at))}${e.place ? ` · ${e.place}` : ''}`)),
    line('5', 'Nội dung sự việc và nguồn thông tin', esc(`${KIND[e.kind] ?? e.kind}: ${e.content}${e.source ? ` (Nguồn: ${e.source})` : ''}`)),
    line('6', 'Diễn biến xác minh / ý kiến các bên', esc(e.verify ?? '')),
    line('7', 'Nguy cơ và đánh giá sơ bộ (không thay kết luận của cơ quan có thẩm quyền)', esc(LEVEL[e.level] ?? '')),
    line('8', 'Biện pháp ngay lúc phát hiện', esc([e.action, e.notified && `Đã thông báo: ${e.notified}`].filter(Boolean).join(' · '))),
    line('9', 'Đề xuất / xử lý / thời hạn khắc phục', esc([e.conclusion ? CONCL[e.conclusion] : '', e.due_on ? `Hạn: ${dmy(e.due_on)}` : ''].filter(Boolean).join(' · '))),
    line('10', 'Kết quả, theo dõi, hồ sơ đính kèm', esc(e.status === 'dong' ? e.result ?? 'Đã đóng' : 'Đang theo dõi')),
    signRow([['NGƯỜI LẬP', b.supervisor?.name ?? ''], ['LÁI XE / ĐẠI DIỆN', e.staff_id ? b.staff.get(e.staff_id) ?? '' : ''], ['NGƯỜI XỬ LÝ', '']]),
  ].map((x) => `<div style="font-size:13.5px">${x}</div>`));
}

// ------------------------------------------------------------------ Phụ lục 6: Báo cáo sự cố khẩn cấp
export function suCo(b: Base, e: SEvent): string[] {
  const f = (t: string, v: string) => `<p style="margin:5px 0"><b>${t}:</b> ${v || '…………………………'}</p>`;
  return paginate([`${letterhead(b.brand)}${title('BÁO CÁO SỰ CỐ KHẨN CẤP (TÓM TẮT)', '(Phụ lục 6 – QĐ giao nhiệm vụ giám sát ATGT)')}`,
    f('Thời điểm/địa điểm', esc(`${vnTime(e.occurred_at)} ngày ${dmy(vnDay(e.occurred_at))}${e.place ? ` · ${e.place}` : ''}`)), f('Xe/lái xe', esc(who(b, e))),
    f('Loại sự cố', esc(`${KIND[e.kind] ?? e.kind} · ${LEVEL[e.level]}`)), f('Hành động ban đầu', esc(e.action ?? '')), f('Người tiếp nhận/đầu mối', esc(e.notified ?? '')),
    f('Thời điểm ghi nhận vào sổ', esc(`${vnTime(e.created_at)} ngày ${dmy(vnDay(e.created_at))}`)),
    f('Diễn biến, cập nhật và kết quả', esc([e.content, e.verify, e.result, e.status === 'dong' ? CONCL[e.conclusion ?? ''] : 'Đang theo dõi'].filter(Boolean).join(' · '))),
    `<div style="font-size:12px;margin-top:8px"><b>Nguyên tắc xử lý:</b> ưu tiên bảo đảm an toàn, gọi cứu hộ/cơ quan chức năng khi cần; báo ngay lãnh đạo và điều hành, chỉ định đầu mối liên lạc;
      thu thập, bảo toàn dữ liệu, hình ảnh, thông tin nhân chứng, không tự ý sửa/xóa dữ liệu; phối hợp cứu hộ, xử lý hiện trường theo quy trình, pháp luật;
      sau sự cố phân tích nguyên nhân, bài học và hành động khắc phục, theo dõi thực hiện.</div>`,
    signRow([['NGƯỜI BÁO CÁO', b.supervisor?.name ?? ''], ['LÃNH ĐẠO TIẾP NHẬN', '']]),
  ].map((x) => `<div style="font-size:13.5px">${x}</div>`));
}

// ------------------------------------------------------------------ Phụ lục 5 + 3: Báo cáo tuần / tháng / năm
export async function baoCao(b: Base, label: string, from: string, to: string): Promise<{ pages: string[]; empty: boolean }> {
  const [st, tr] = await Promise.all([
    rpc<{ trips: number; vehicles: number; drivers: number }>('safety_period_stats', { p_from: from, p_to: to }),
    supabase.from('staff_records').select('staff_id').eq('kind', 'dao_tao').gte('occurred_on', from).lte('occurred_on', to),
  ]);
  const L = b.events.filter((e) => { const d = vnDay(e.occurred_at); return d >= from && d <= to; });
  await loadTrips(L.map((e) => e.trip_id ?? ''));
  const n = (k: string[]) => L.filter((e) => k.includes(e.kind)).length;
  const open = L.filter((e) => e.status === 'mo').length, closed = L.length - open, viol = L.filter((e) => e.conclusion === 'vi_pham').length;
  const train = (tr.data ?? []).length, remind = L.filter((e) => e.level === 1).length;
  const per = new Map<string, number>();
  L.forEach((e) => { if (e.staff_id) per.set(e.staff_id, (per.get(e.staff_id) ?? 0) + 1); });
  const rep = [...per.entries()].filter(([, k]) => k >= 2).sort((a, b2) => b2[1] - a[1]).map(([id, k]) => `${b.staff.get(id) ?? '?'} (${k})`);
  const ev = (k: number) => (k ? `Phát sinh ${k}` : 'Không phát sinh');
  const advice: string[] = [];
  if (rep.length) advice.push(`Nhắc nhở, tập huấn lại lái xe có từ 2 sự việc: ${rep.join(', ')}`);
  if (open) advice.push(`Theo dõi khắc phục ${open} sự việc còn tồn đọng`);
  if (n(['su_co'])) advice.push('Rà soát nguyên nhân sự cố, phổ biến rút kinh nghiệm cho toàn bộ lái xe');
  if (n(['thoi_gian_lai'])) advice.push('Điều chỉnh xếp lịch, bố trí đủ lái xe để bảo đảm thời gian lái và nghỉ');
  if (n(['giay_to'])) advice.push('Bổ sung, gia hạn giấy tờ xe / lái xe còn thiếu hoặc hết hạn');
  if (!advice.length) advice.push('Tiếp tục duy trì kiểm tra trước chuyến, theo dõi dữ liệu giám sát hành trình');
  const rows: string[][] = [
    ['Số chuyến/xe/lái xe được theo dõi', `${st.trips} chuyến · ${st.vehicles} xe · ${st.drivers} lái xe`, ''],
    ['Cảnh báo tốc độ', String(n(['toc_do'])), ev(n(['toc_do']))], ['Cảnh báo thời gian lái xe', String(n(['thoi_gian_lai'])), ev(n(['thoi_gian_lai']))],
    ['Sai hành trình', String(n(['sai_hanh_trinh'])), ev(n(['sai_hanh_trinh']))], ['Thiết bị gián đoạn/mất kết nối', String(n(['mat_ket_noi'])), ev(n(['mat_ket_noi']))],
    ['Sự cố/tai nạn', String(n(['su_co'])), ev(n(['su_co']))], ['Vi phạm khác / phản ánh', String(n(['dung_do', 'tinh_trang_xe', 'giay_to', 'phan_anh', 'khac'])), ev(n(['dung_do', 'tinh_trang_xe', 'giay_to', 'phan_anh', 'khac']))],
    ['Đã xử lý / còn tồn đọng', `${closed} / ${open}`, viol ? `${viol} vi phạm đã ghi lý lịch lái xe` : ''],
    ['Đào tạo / nhắc nhở', `${train} lượt tập huấn · ${remind} nhắc nhở`, ''], ['Đề xuất phòng ngừa', '', esc(advice.join('; '))],
  ];
  const general = L.length ? `Trong kỳ có ${st.trips} chuyến được theo dõi, ghi nhận ${L.length} cảnh báo/vi phạm/sự cố (${closed} đã xử lý, ${open} còn theo dõi).`
    : `Trong kỳ có ${st.trips} chuyến được theo dõi, không ghi nhận cảnh báo/vi phạm/sự cố.`;
  const blocks = [`${letterhead(b.brand)}${title(`BÁO CÁO GIÁM SÁT AN TOÀN ${label.toUpperCase()}`, `Kỳ báo cáo: từ ${dmy(from)} đến ${dmy(to)} · Người báo cáo: ${esc(b.supervisor?.name ?? '……………')} · (Phụ lục 5)`)}`,
    table(['Nội dung', 'Số liệu / ghi nhận', 'Đánh giá / đề xuất'], rows.map((r) => [esc(r[0]), esc(r[1]), r[2]!])),
    `<p style="margin:6px 0"><b>Nhận xét chung và đề xuất:</b> ${esc(general)} ${esc(advice.join('; '))}.</p>`];
  if (L.length) {
    blocks.push(`<h3 style="margin:10px 0 4px;font-size:14px">BẢNG TỔNG HỢP VI PHẠM/CẢNH BÁO (Phụ lục 3)</h3>`);
    for (let i = 0; i < L.length; i += 25) blocks.push(table(['STT', 'Ngày, giờ', 'Xe / lái xe', 'Loại vi phạm/cảnh báo', 'Nguồn dữ liệu', 'Xác minh', 'Biện pháp', 'Theo dõi'],
      L.slice(i, i + 25).map((e, k) => [String(i + k + 1), `${dmy(vnDay(e.occurred_at))} ${vnTime(e.occurred_at)}`, esc(who(b, e)), esc(`${KIND[e.kind] ?? e.kind}: ${e.content}`),
        esc(e.source ?? ''), esc(e.verify ?? ''), esc(e.action ?? ''), esc(e.status === 'dong' ? CONCL[e.conclusion ?? ''] ?? '' : 'Đang theo dõi')]), [0]));
  }
  blocks.push(signRow([['NGƯỜI BÁO CÁO', b.supervisor?.name ?? ''], ['LÃNH ĐẠO / BỘ PHẬN NHẬN BÁO CÁO', '']]));
  return { pages: paginate(blocks.map((x) => `<div style="font-size:12.5px">${x}</div>`)), empty: !st.trips && !L.length };
}

// ------------------------------------------------------------------ Kỳ báo cáo
export const weekOf = (d: string) => { const x = new Date(`${d}T00:00:00Z`); const w = (x.getUTCDay() + 6) % 7; const from = addDays(d, -w); return { from, to: addDays(from, 6) }; };
export const monthOf = (d: string) => { const from = `${d.slice(0, 7)}-01`; const n = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate(); return { from, to: `${d.slice(0, 7)}-${String(n).padStart(2, '0')}` }; };
export const yearOf = (d: string) => ({ from: `${d.slice(0, 4)}-01-01`, to: `${d.slice(0, 4)}-12-31` });
const isoWeek = (d: string) => { const x = new Date(`${d}T00:00:00Z`); const day = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - day + 3); const y = x.getUTCFullYear(); const j = new Date(Date.UTC(y, 0, 4)); return { y, w: 1 + Math.round(((x.getTime() - j.getTime()) / 864e5 - 3 + ((j.getUTCDay() + 6) % 7)) / 7) }; };
export const weekLabel = (from: string) => { const k = isoWeek(from); return `tuần ${k.w}/${k.y}`; };

// ------------------------------------------------------------------ Tự lưu hồ sơ
const ROOT = '09. An toàn giao thông';
const monthDir = (d: string) => `Tháng ${d.slice(5, 7)}-${d.slice(0, 4)}`;
let running = false;
/** Tự lập và lưu hồ sơ còn thiếu / đã thay đổi. Trả số PDF đã lưu. */
export async function autoArchiveSafety(onStep?: (s: string) => void): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const b = await loadBase();
    const items = await fetchAll<{ note: string | null }>(() => supabase.from('archive_items').select('note').eq('is_old', false).like('note', '%[atgt-%').order('id'));
    const sigs = new Map<string, string>();
    for (const r of (items ?? []) as { note: string | null }[]) { const k = /\[(atgt-[^\]]+)\]/.exec(r.note ?? '')?.[1]; const s = /sig:([a-z0-9]+)/.exec(r.note ?? '')?.[1]; if (k) sigs.set(k, s ?? ''); }
    let n = 0;
    resetFolders();
    await drive({ action: 'ping' });   // chưa kết nối Google Drive thì dừng ngay, không dựng giấy
    const put = async (key: string, path: string[], name: string, file: string, pages: string[], land: boolean) => {
      const sig = hash(pages.join(''));
      if (sigs.get(key) === sig) return;
      onStep?.(`Đang lưu: ${name}`);
      await savePdf(path, name, file, pages.map((html) => ({ html, land })), `Tự lập · sig:${sig}`, key);
      sigs.set(key, sig);
      n++;
    };
    const today = todayVN();
    // Làm cho mọi kỳ có dữ liệu: từ chuyến đầu tiên (hoặc sự việc đầu tiên) đến nay.
    // Kỳ đã lưu và đã qua lâu (không còn đổi) thì bỏ qua cho nhanh; kỳ gần đây dựng lại, nội dung đổi mới lưu.
    const ft = await supabase.from('trips').select('service_date').eq('status', 'mo').order('service_date').limit(1);
    const firstTrip = ((ft.data ?? []) as { service_date: string }[])[0]?.service_date ?? today;
    const firstEv = b.events[0] ? vnDay(b.events[0].occurred_at) : today;
    const first = firstTrip < firstEv ? firstTrip : firstEv;
    const settled = (key: string, end: string, days: number) => sigs.has(key) && end < addDays(today, -days);
    // Checklist trước chuyến: mọi ngày có chuyến
    for (let d = first; d <= today; d = addDays(d, 1)) {
      const key = `atgt-ck:${d}`;
      if (settled(key, d, 8)) continue;
      const r = await checklistDay(b, d);
      if (r) await put(key, [d.slice(0, 4), ROOT, 'Checklist trước chuyến', monthDir(d)], `Checklist trước chuyến ngày ${dmy(d)}`, `Checklist-truoc-chuyen-${d}.pdf`, r.pages, true);
    }
    // Sổ giám sát hằng ngày: chỉ ngày có sự việc
    for (const d of [...new Set(b.events.map((e) => vnDay(e.occurred_at)))]) {
      const p = await soNgay(b, d);
      if (p) await put(`atgt-so:${d}`, [d.slice(0, 4), ROOT, 'Sổ giám sát hằng ngày', monthDir(d)], `Sổ giám sát an toàn ngày ${dmy(d)}`, `So-giam-sat-${d}.pdf`, p, true);
    }
    // Biên bản xác minh (mức 2, 3 đã đóng) và báo cáo sự cố khẩn cấp (sự cố hoặc mức 3)
    await loadTrips(b.events.map((e) => e.trip_id ?? ''));
    for (const e of b.events) {
      const d = vnDay(e.occurred_at), tag = `${d}-${(b.staff.get(e.staff_id ?? '') ?? b.vehicles.get(e.vehicle_id ?? '')?.plate ?? '').slice(0, 40)}`;
      if (e.status === 'dong' && e.level >= 2 && !e.auto) await put(`atgt-bb:${e.id}`, [d.slice(0, 4), ROOT, 'Biên bản xác minh'], `Biên bản xác minh ${dmy(d)} ${who(b, e)}`, `Bien-ban-xac-minh-${tag}.pdf`, bienBan(b, e), false);
      if (e.kind === 'su_co' || e.level === 3) await put(`atgt-sc:${e.id}`, [d.slice(0, 4), ROOT, 'Sự cố khẩn cấp'], `Báo cáo sự cố ${dmy(d)} ${who(b, e)}`, `Su-co-${tag}.pdf`, suCo(b, e), false);
    }
    // Báo cáo tuần: mọi tuần đã xong có dữ liệu
    for (let w = weekOf(first); w.to < today; w = weekOf(addDays(w.to, 1))) {
      const key = `atgt-bc:w:${w.from}`;
      if (settled(key, w.to, 14)) continue;
      const lb = weekLabel(w.from), r = await baoCao(b, lb, w.from, w.to);
      if (!r.empty) await put(key, [w.to.slice(0, 4), ROOT, 'Báo cáo tuần'], `Báo cáo giám sát an toàn ${lb} (${dmy(w.from)} - ${dmy(w.to)})`, `Bao-cao-tuan-${w.from}.pdf`, r.pages, false);
    }
    // Báo cáo tháng: mọi tháng đã xong có dữ liệu
    for (let m = monthOf(first); m.to < today; m = monthOf(addDays(m.to, 1))) {
      const key = `atgt-bc:m:${m.from.slice(0, 7)}`;
      if (settled(key, m.to, 40)) continue;
      const lb = `tháng ${m.from.slice(5, 7)}/${m.from.slice(0, 4)}`, r = await baoCao(b, lb, m.from, m.to);
      if (!r.empty) await put(key, [m.from.slice(0, 4), ROOT, 'Báo cáo tháng'], `Báo cáo giám sát an toàn ${lb}`, `Bao-cao-thang-${m.from.slice(0, 7)}.pdf`, r.pages, false);
    }
    // Báo cáo năm: mọi năm đã xong có dữ liệu
    for (let y = +first.slice(0, 4); y < +today.slice(0, 4); y++) {
      const key = `atgt-bc:y:${y}`, p = yearOf(`${y}-01-01`);
      if (settled(key, p.to, 60)) continue;
      const r = await baoCao(b, `năm ${y}`, p.from, p.to);
      if (!r.empty) await put(key, [String(y), ROOT, 'Báo cáo năm'], `Báo cáo giám sát an toàn năm ${y}`, `Bao-cao-nam-${y}.pdf`, r.pages, false);
    }
    return n;
  } finally { running = false; }
}
