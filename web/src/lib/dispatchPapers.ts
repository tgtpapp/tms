// Giấy tờ điều hành hằng ngày (như app cũ):
// - Bảng phân công lịch tài & xe hàng ngày: mỗi chuyến tuyến cố định / xe hợp đồng đã có xe hoặc lái xe là một dòng.
// - Bảng kiểm tra an toàn, nghiệm thu xe trước khi khởi hành: 1 bản chung cho mọi giờ chạy trong ngày của TỪNG lái xe.
// Lưu PDF vào Lưu trữ hồ sơ: <năm> / 08. Điều hành xe / <loại> / Tháng MM-YYYY (lưu lại thì thay bản cũ, bản cũ ẩn).
// Mẫu và nội dung kiểm tra lấy theo app cũ của nhà xe; căn cứ pháp lý của mẫu: cần xác minh.
import { dirName, type Dir } from './routes';
import { loadSigns, showName, type Sign } from './signatures';
import { supabase } from './supabase';
import { bytesToBase64, makePdf, pageImg } from './pdfMaker';
import { drive } from './drive';

const TZ = 'Asia/Ho_Chi_Minh';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const vnDay = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: TZ });

interface Person { id: string; name: string; gplx: string; expired: string[]; sign: string | null; signName: boolean }
interface Veh { id: string; plate: string; type: string; seats: number | null; expired: string[] }
export interface Row { time: string; veh: Veh | null; d1: Person | null; d2: Person | null; route: string; charter: boolean }
export interface DayData { day: string; rows: Row[]; company: { name: string; address: string }; suffix: string; me: { name: string; sign: Sign } }

type Doc = { vehicle_id: string | null; staff_id: string | null; doc_type: string; doc_no: string | null; expires_on: string | null; data: Record<string, unknown> | null };
/** Dữ liệu dùng chung cho nhiều ngày (tuyến, xe, nhân viên, giấy tờ, chữ ký): tải 1 lần cho cả lượt lưu. */
export interface PaperCache {
  base?: Promise<{ routes: { id: string; name: string; name_ve: string | null }[]; types: { id: string; name: string; reg_seats: number; reg_berths: number }[];
    vehicles: { id: string; plate: string; vehicle_type_id: string }[]; staff: { id: string; full_name: string; user_id: string | null }[]; docs: Doc[];
    company: { name: string; address: string }; suffix: string }>;
  signs: Map<string, Promise<Sign>>;
}
export const newCache = (): PaperCache => ({ signs: new Map() });

function base(c: PaperCache) {
  c.base ??= (async () => {
    const [rt, vh, vt, sm, tn, st, dc] = await Promise.all([
      supabase.from('routes').select('id, name, name_ve'),
      supabase.from('vehicles').select('id, plate, vehicle_type_id'),
      supabase.from('vehicle_types').select('id, name, reg_seats, reg_berths'),
      supabase.from('staff_members').select('id, full_name, user_id'),
      supabase.from('tenants').select('name, legal_name, address').maybeSingle(),
      supabase.from('tenant_settings').select('value').eq('key', 'lenh.hau_to').maybeSingle(),
      supabase.from('documents').select('vehicle_id, staff_id, doc_type, doc_no, expires_on, data').eq('is_current', true)
        .in('doc_type', ['kiem_dinh', 'bh_tnds', 'phu_hieu', 'gplx', 'kham_suc_khoe']),
    ]);
    const t = (tn.data ?? {}) as { name?: string; legal_name?: string | null; address?: string | null };
    return { routes: (rt.data ?? []) as { id: string; name: string; name_ve: string | null }[], types: (vt.data ?? []) as { id: string; name: string; reg_seats: number; reg_berths: number }[],
      vehicles: (vh.data ?? []) as { id: string; plate: string; vehicle_type_id: string }[], staff: (sm.data ?? []) as { id: string; full_name: string; user_id: string | null }[],
      docs: (dc.data ?? []) as Doc[], company: { name: t.legal_name || t.name || '', address: t.address ?? '' }, suffix: typeof st.data?.value === 'string' ? st.data.value : '' };
  })();
  return c.base;
}
/** Chữ ký của 1 người: chỉ tải khi người đó có trên giấy, mỗi người 1 lần cho cả lượt. */
function signOf(c: PaperCache, tenantId: string, uid: string | null): Promise<Sign> {
  if (!uid) return Promise.resolve({ img: null, hasName: false });
  if (!c.signs.has(uid)) c.signs.set(uid, loadSigns(tenantId, [uid], true).then((m) => m.get(uid) ?? { img: null, hasName: false }).catch(() => ({ img: null, hasName: false })));
  return c.signs.get(uid)!;
}

export async function loadDay(day: string, tenantId: string, me: { id: string | null; name: string }, cache: PaperCache = newCache()): Promise<DayData> {
  const from = new Date(`${day}T00:00:00+07:00`).toISOString(), to = new Date(`${day}T23:59:59+07:00`).toISOString();
  const [tr, ch, b] = await Promise.all([
    supabase.from('trips').select('id, route_id, direction, depart_at, vehicle_id').eq('service_date', day).eq('status', 'mo'),
    supabase.from('charters').select('start_at, vehicle_id, driver1_id, driver2_id, itinerary, pickup_place, destination, status').gte('start_at', from).lte('start_at', to).in('status', ['da_ky', 'dang_chay', 'xong']),
    base(cache),
  ]);
  if (tr.error) throw new Error(tr.error.message);
  const trips = (tr.data ?? []) as { id: string; route_id: string; direction: Dir; depart_at: string; vehicle_id: string | null }[];
  const crew = trips.length ? ((await supabase.from('trip_crew').select('trip_id, role, staff_id').in('trip_id', trips.map((t) => t.id)).eq('active', true)).data ?? []) as { trip_id: string; role: string; staff_id: string }[] : [];
  const NAME: Record<string, string> = { kiem_dinh: 'đăng kiểm', bh_tnds: 'BH dân sự', phu_hieu: 'phù hiệu', gplx: 'GPLX', kham_suc_khoe: 'giấy khám SK' };
  const { docs, staff } = b;
  const vehs = new Map<string, Veh>();
  for (const v of b.vehicles) {
    const t = b.types.find((x) => x.id === v.vehicle_type_id);
    vehs.set(v.id, { id: v.id, plate: v.plate, type: t?.name ?? '', seats: t ? t.reg_seats + t.reg_berths : null,
      expired: docs.filter((d) => d.vehicle_id === v.id && d.expires_on && d.expires_on < day).map((d) => NAME[d.doc_type]) });
  }
  const people = new Map<string, Person>();
  const person = async (id: string | null): Promise<Person | null> => {
    if (!id) return null;
    if (people.has(id)) return people.get(id)!;
    const s = staff.find((x) => x.id === id);
    if (!s) return null;
    const g = docs.find((d) => d.staff_id === id && d.doc_type === 'gplx');
    const hang = g?.data && typeof g.data.hang === 'string' ? g.data.hang : '';
    const sg = await signOf(cache, tenantId, s.user_id);
    const p: Person = { id, name: s.full_name, gplx: g ? `${g.doc_no ?? '—'}${hang ? ` (Hạng ${hang})` : ''}` : '—',
      expired: docs.filter((d) => d.staff_id === id && d.expires_on && d.expires_on < day).map((d) => `${NAME[d.doc_type]} ${s.full_name}`),
      sign: sg.img, signName: showName(sg) };
    people.set(id, p);
    return p;
  };
  const ids = [...new Set([...crew.map((c) => c.staff_id), ...((ch.data ?? []) as { driver1_id: string | null; driver2_id: string | null }[]).flatMap((h) => [h.driver1_id, h.driver2_id])])];
  await Promise.all(ids.map(person));   // tải chữ ký song song
  const rows: Row[] = [];
  for (const t of trips) {
    const c = crew.filter((x) => x.trip_id === t.id);
    const d1 = c.find((x) => x.role === 'lai_xe_1')?.staff_id ?? null, d2 = c.find((x) => x.role === 'lai_xe_2')?.staff_id ?? null;
    if (!t.vehicle_id && !d1 && !d2) continue;   // giờ trống (chưa xếp gì) không đưa vào bảng
    rows.push({ time: hhmm(t.depart_at), veh: t.vehicle_id ? vehs.get(t.vehicle_id) ?? null : null, d1: await person(d1), d2: await person(d2),
      route: `Tuyến cố định: ${dirName(b.routes.find((r) => r.id === t.route_id), t.direction)}`, charter: false });
  }
  for (const h of (ch.data ?? []) as { start_at: string; vehicle_id: string | null; driver1_id: string | null; driver2_id: string | null; itinerary: string | null; pickup_place: string; destination: string }[]) {
    if (vnDay(h.start_at) !== day) continue;
    rows.push({ time: hhmm(h.start_at), veh: h.vehicle_id ? vehs.get(h.vehicle_id) ?? null : null, d1: await person(h.driver1_id), d2: await person(h.driver2_id),
      route: `Xe hợp đồng: ${h.itinerary || `${h.pickup_place} - ${h.destination}`}`, charter: true });
  }
  rows.sort((a, b2) => a.time.localeCompare(b2.time) || (a.veh?.plate ?? '').localeCompare(b2.veh?.plate ?? ''));
  return { day, rows, company: b.company, suffix: b.suffix, me: { name: me.name, sign: await signOf(cache, tenantId, me.id) } };
}

/** Các dòng thiếu xe hoặc lái xe chính (quy tắc app cũ: ngày còn thiếu thì chưa lưu, trừ khi chọn "vẫn lưu"). */
export const missing = (d: DayData) => d.rows.filter((r) => !r.veh || !r.d1)
  .map((r) => `${r.time} ${r.route.replace(/^Tuyến cố định: /, '')}${r.veh ? ` (${r.veh.plate})` : ''}: thiếu ${[!r.veh && 'xe', !r.d1 && 'lái xe'].filter(Boolean).join(' và ')}`);

const head = (d: DayData, title: string, sub: string) => `
  <table style="width:100%;border-collapse:collapse"><tr>
    <td style="width:45%;text-align:center;vertical-align:top"><b>${esc(d.company.name.toUpperCase())}</b><br><span style="font-size:12px">${esc(d.company.address)}</span></td>
    <td style="text-align:center;vertical-align:top"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><b>Độc lập - Tự do - Hạnh phúc</b><div style="width:150px;border-top:1px solid #000;margin:3px auto"></div></td>
  </tr></table>
  <h2 style="text-align:center;margin:12px 0 2px;font-size:19px">${title}</h2><div style="text-align:center;margin-bottom:10px">${sub}</div>`;
const longDay = (day: string) => { const [y, m, dd] = day.split('-'); return `ngày ${dd} tháng ${m} năm ${y}`; };
const sigImg = (p: Person | null) => (p?.sign ? `<img src="${p.sign}" alt="" style="max-height:36px;max-width:110px">` : '');
const signs = (cols: [string, string, Sign | null][]) => `<table style="width:100%;margin-top:16px;border-collapse:collapse"><tr>${cols.map(([t, n, sg]) =>
  `<td style="width:${100 / cols.length}%;text-align:center;vertical-align:top"><b>${t}</b><br><i style="font-size:12px">(Ký, ghi rõ họ tên)</i><div style="height:64px;display:flex;align-items:center;justify-content:center">${sg?.img ? `<img src="${sg.img}" alt="" style="max-height:60px;max-width:180px">` : ''}</div><b>${showName(sg) ? esc(n) : ''}</b></td>`).join('')}</tr></table>`;

/** Bảng phân công: trả về các trang (ngang). */
export function assignPages(d: DayData): string[] {
  const td = 'border:1px solid #333;padding:5px 4px;font-size:12.5px;vertical-align:middle';
  const th = 'border:1px solid #333;padding:5px 4px;font-size:12px;text-align:center;background:#e2e8f0;font-weight:bold';
  const H = ['STT', 'Biển kiểm soát xe', 'Loại xe / Số chỗ', 'Họ và tên lái xe chính', 'Số GPLX &amp; Hạng', 'Họ và tên lái xe phụ (nếu có)', 'Số GPLX (lái xe phụ)',
    'Tuyến đường / Hợp đồng vận chuyển', 'Giờ xuất bến', 'Trạng thái kỹ thuật &amp; GPS', 'Chữ ký lái xe nhận xe'];
  const state = (r: Row) => {
    const w = [...(r.veh?.expired ?? []), ...(r.d1?.expired ?? []), ...(r.d2?.expired ?? [])];
    return w.length ? `<b style="color:#b91c1c">Hết hạn: ${esc(w.join(', '))}</b>` : r.veh ? 'Đủ điều kiện' : '';
  };
  const row = (r: Row, i: number) => `<tr style="height:42px"><td style="${td};text-align:center">${String(i + 1).padStart(2, '0')}</td><td style="${td}"><b>${esc(r.veh?.plate ?? '')}</b></td>
    <td style="${td}">${esc(r.veh?.type ?? '')}${r.veh?.seats ? ` / ${r.veh.seats} chỗ` : ''}</td><td style="${td}">${esc(r.d1?.name ?? '')}</td><td style="${td}">${esc(r.d1?.gplx ?? '')}</td>
    <td style="${td}">${esc(r.d2?.name ?? '—')}</td><td style="${td}">${esc(r.d2?.gplx ?? '—')}</td><td style="${td}">${esc(r.route)}</td><td style="${td};text-align:center">${esc(r.time)}</td>
    <td style="${td};text-align:center">${state(r)}</td><td style="${td};text-align:center">${sigImg(r.d1)}${r.d2?.sign ? `<br>${sigImg(r.d2)}` : ''}</td></tr>`;
  const foot = `<div style="margin-top:10px;font-size:13px"><b>XÁC NHẬN CỦA BỘ PHẬN QUẢN LÝ AN TOÀN GIAO THÔNG:</b><div>• Đã kiểm tra các điều kiện an toàn đối với phương tiện; đồng thời kiểm tra tính hợp lệ của Giấy phép lái xe, thời gian làm việc (không quá giờ quy định) của lái xe trước khi ký lệnh xuất bến.</div></div>
    ${signs([['Người lập lịch tài', d.me.name, d.me.sign], ['Đội trưởng điều hành', '', null], ['Bộ phận quản lý ATGT', '', null]])}`;
  const table = (rs: Row[], start: number) => `<table style="width:100%;border-collapse:collapse"><tr>${H.map((h) => `<th style="${th}">${h}</th>`).join('')}</tr>${rs.map((r, i) => row(r, start + i)).join('')}</table>`;
  const top = `${head(d, 'BẢNG PHÂN CÔNG LỊCH TÀI &amp; XE HÀNG NGÀY', `<i>${longDay(d.day)[0].toUpperCase()}${longDay(d.day).slice(1)}</i>`).replace('<h2', '<div style="font-weight:bold;margin-top:4px">BỘ PHẬN ĐIỀU HÀNH VẬN TẢI</div><h2')}`;
  const pages: string[] = [];
  const first = 7, next = 11;
  let i = 0;
  if (d.rows.length <= first - 2) return [`${top}${table(d.rows, 0)}${foot}`];
  pages.push(`${top}${table(d.rows.slice(0, first), 0)}`);
  i = first;
  while (i < d.rows.length) {
    const rest = d.rows.length - i, take = rest <= next - 4 ? rest : Math.min(next, rest);
    pages.push(`${table(d.rows.slice(i, i + take), i)}${i + take >= d.rows.length ? foot : ''}`);
    i += take;
  }
  if (!pages[pages.length - 1].includes('XÁC NHẬN')) pages.push(foot);
  return pages;
}

const CHECKS: [string, string[]][] = [
  ['A. Giấy tờ và lệnh vận chuyển', ['Giấy đăng ký xe, giấy kiểm định an toàn kỹ thuật còn hạn', 'Bảo hiểm bắt buộc trách nhiệm dân sự còn hạn', 'Phù hiệu, giấy phép kinh doanh vận tải hợp lệ',
    'Giấy phép lái xe phù hợp hạng xe, còn hạn', 'Lệnh vận chuyển, danh sách hành khách đã lập', 'Thông tin niêm yết trên xe đầy đủ, đúng quy định']],
  ['B. Lái xe', ['Lái xe đủ sức khỏe, không mệt mỏi, đủ thời gian nghỉ theo quy định', 'Nồng độ cồn bằng 0, không sử dụng chất kích thích', 'Mặc đồng phục, đeo thẻ tên',
    'Lái xe đã đăng nhập thẻ nhận dạng trên thiết bị giám sát hành trình']],
  ['C. Tình trạng kỹ thuật của xe', ['Lốp: áp suất, độ mòn, không nứt vỡ; có lốp dự phòng', 'Phanh chân, phanh tay hoạt động tốt', 'Hệ thống lái, hệ thống treo, không rò rỉ dầu nhớt',
    'Đèn chiếu sáng, đèn phanh, đèn xi nhan, còi', 'Gạt mưa, gương chiếu hậu, kính chắn gió', 'Dầu, nước làm mát, nhiên liệu đủ cho hành trình', 'Thiết bị giám sát hành trình, camera hoạt động']],
  ['D. An toàn cho hành khách', ['Dây an toàn các ghế, ghế ngồi chắc chắn', 'Cửa lên xuống, cửa thoát hiểm mở được; có búa phá kính', 'Bình chữa cháy, hộp sơ cứu đầy đủ, còn hạn',
    'Lối đi thông thoáng, hành lý được chằng buộc chắc chắn', 'Đã phổ biến hướng dẫn an toàn cho hành khách', 'Điều hòa hoạt động, xe sạch sẽ']],
];

export interface DriverDay { p: Person; rows: Row[]; no: string }
/** Lái xe có chuyến trong ngày (lái chính hoặc lái phụ), mỗi người 1 bản. */
export function driversOf(d: DayData): DriverDay[] {
  const m = new Map<string, DriverDay>();
  for (const r of d.rows) for (const p of [r.d1, r.d2]) if (p) { if (!m.has(p.id)) m.set(p.id, { p, rows: [], no: '' }); m.get(p.id)!.rows.push(r); }
  const [y, mo, dd] = d.day.split('-');
  return [...m.values()].sort((a, b) => a.rows[0].time.localeCompare(b.rows[0].time) || a.p.name.localeCompare(b.p.name, 'vi'))
    .map((x, i) => ({ ...x, no: `${dd}${mo}${y.slice(2)}.${String(i + 1).padStart(2, '0')}/NTAT${d.suffix ? `-${d.suffix}` : ''}` }));
}

/** Nghiệm thu an toàn của 1 lái xe trong ngày (1 trang dọc), mặc định đạt mọi mục như app cũ. */
export function safetyPage(d: DayData, x: DriverDay): string {
  const b = 'border:1px solid #000;padding:3px 6px;font-size:12.5px';
  const plates = [...new Set(x.rows.map((r) => r.veh?.plate).filter(Boolean))].join(', ');
  const trips = `<table style="width:100%;border-collapse:collapse;margin:4px 0 8px"><tr style="background:#e2e8f0"><th style="${b}">Giờ xuất bến</th><th style="${b}">Xe</th><th style="${b}">Tuyến / Hợp đồng</th><th style="${b}">Vai trò</th></tr>
    ${x.rows.map((r) => `<tr><td style="${b};text-align:center"><b>${esc(r.time)}</b></td><td style="${b}">${esc(r.veh?.plate ?? '')}</td><td style="${b}">${esc(r.route)}</td><td style="${b}">${r.d1?.id === x.p.id ? 'Lái xe chính' : 'Lái xe phụ'}</td></tr>`).join('')}</table>`;
  let n = 0;
  const rows = CHECKS.map(([g, items]) => `<tr><td colspan="5" style="${b};background:#f1f5f9"><b>${g}</b></td></tr>${items.map((t) => { n++; return `<tr><td style="${b};text-align:center;width:6%">${n}</td><td style="${b}">${t}</td><td style="${b};text-align:center;width:9%">☒</td><td style="${b};text-align:center;width:9%">☐</td><td style="${b};text-align:center;width:11%">☐</td></tr>`; }).join('')}`).join('');
  const exp = [...x.rows.flatMap((r) => r.veh?.expired ?? []), ...x.p.expired];
  return `<div style="font-size:13px;line-height:1.4">${head(d, 'BẢNG KIỂM TRA AN TOÀN, NGHIỆM THU XE TRƯỚC KHI KHỞI HÀNH', `Số: <b>${esc(x.no)}</b> · ${longDay(d.day)} · áp dụng cho tất cả các chuyến trong ngày của lái xe`)}
    <table style="width:100%;margin:2px 0"><tr><td style="width:55%">Lái xe: <b>${esc(x.p.name)}</b> · GPLX: ${esc(x.p.gplx)}</td><td>Biển số xe: <b>${esc(plates || '…………')}</b></td></tr>
    <tr><td>Số km đồng hồ: ……………………</td><td>Nhiên liệu: ……………</td></tr></table>
    ${trips}
    <table style="width:100%;border-collapse:collapse"><tr style="background:#e2e8f0"><th style="${b}">STT</th><th style="${b}">Nội dung kiểm tra</th><th style="${b}">Đạt</th><th style="${b}">Không đạt</th><th style="${b}">Không áp dụng</th></tr>${rows}</table>
    ${exp.length ? `<p style="margin:6px 0 0;color:#b91c1c"><b>Lưu ý giấy tờ hết hạn:</b> ${esc([...new Set(exp)].join(', '))}</p>` : ''}
    <p style="margin:6px 0 2px"><b>Ghi chú / khắc phục:</b> ………………………………………………………………………………………………</p>
    <p style="margin:4px 0;font-size:14px"><b>KẾT LUẬN:</b> ☒ ĐẠT, cho phép xe khởi hành các chuyến trong ngày</p>
    ${signs([['LÁI XE', x.p.name, { img: x.p.sign, hasName: !x.p.signName }], ['NGƯỜI KIỂM TRA', '', null], ['ĐIỀU HÀNH', d.me.name, d.me.sign]])}</div>`;
}

// ------------------------------------------------------------------ Lưu vào Lưu trữ hồ sơ
interface Folder { id: string; parent_id: string | null; name: string }
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Tìm / tạo thư mục theo đường dẫn tên, trả id thư mục cuối. Danh sách thư mục tải 1 lần cho cả lượt lưu. */
let folderList: Promise<Folder[]> | null = null;
let folderPending: Promise<unknown> = Promise.resolve();
export async function ensurePath(names: string[]): Promise<string> {
  const run = folderPending.then(async () => {      // tạo thư mục lần lượt để 2 việc song song không tạo trùng
    folderList ??= supabase.from('archive_folders').select('id, parent_id, name').then((r) => ((r.data ?? []) as Folder[]));
    const all = await folderList;
    let parent: string | null = null;
    for (const n of names) {
      let f = all.find((x) => x.parent_id === parent && same(x.name, n));
      if (!f) {
        const ins = await supabase.from('archive_folders').insert({ parent_id: parent, name: n }).select('id, parent_id, name').single();
        if (ins.error) { folderList = null; throw new Error(`Không tạo được thư mục ${n}: ${ins.error.message}`); }
        f = ins.data as Folder;
        all.push(f);
      }
      parent = f.id;
    }
    return parent!;
  });
  folderPending = run.catch(() => undefined);
  return run;
}
export const resetFolders = () => { folderList = null; };

export const monthPath = (day: string, kind: string) => [day.slice(0, 4), '08. Điều hành xe', kind, `Tháng ${day.slice(5, 7)}-${day.slice(0, 4)}`];

/** Tạo PDF từ các trang rồi lưu vào thư mục; có hồ sơ cùng mã thì thay bản mới (bản cũ ẩn). */
export async function savePdf(path: string[], name: string, fileName: string, pages: { html: string; land: boolean }[], note: string, key: string): Promise<void> {
  const imgs = [];
  for (const p of pages) imgs.push(await pageImg(p.html, p.land));
  const data = bytesToBase64(makePdf(imgs));
  const folder = await ensurePath(path);
  // Mỗi giấy có 1 mã cố định (ghi cuối ghi chú): lưu lại thì thay bản cũ, không sinh thêm bản thứ hai
  const tag = `[${key}]`;
  const cur = ((await supabase.from('archive_items').select('id, name, note').eq('folder_id', folder).eq('is_old', false).like('note', `%${tag}%`)).data ?? []) as { id: string }[];
  const legacy = cur.length ? [] : ((await supabase.from('archive_items').select('id').eq('folder_id', folder).eq('is_old', false).eq('name', name).not('note', 'like', '%[%')).data ?? []) as { id: string }[];
  const same2 = [...cur, ...legacy];
  const r = await drive<{ id: string }>({ action: 'put', folder_id: folder, name, file_name: fileName, mime: 'application/pdf', data, expires_on: null,
    note: `${note} ${tag}`, replace_id: same2[0]?.id ?? null });
  const extra = same2.slice(1).map((x) => x.id).filter((id) => id !== r.id);
  if (extra.length) await supabase.from('archive_items').update({ is_old: true, replaced_by: r.id }).in('id', extra);
}
