// Lý lịch hành nghề người lái xe & Lý lịch phương tiện kinh doanh vận tải (mẫu theo app cũ của nhà xe).
// Tự lấy dữ liệu: hồ sơ nhân viên / xe, giấy tờ (CCCD, GPLX, khám sức khỏe, tập huấn, đăng ký, kiểm định, bảo hiểm, phù hiệu),
// các dòng lý lịch, chuyến đã chạy, phiếu sửa chữa, km GPS, sự cố. Xem / in, và lưu PDF vào Lưu trữ hồ sơ:
//   <năm> / 02. Nhân sự / Lý lịch hành nghề      (1 tệp / lái xe, lưu lại thì thay bản cũ)
//   <năm> / 03. Phương tiện / Lý lịch phương tiện (1 tệp / xe)
// Căn cứ pháp lý của hai mẫu sổ: cần xác minh.
import { fetchAll, rpc, supabase } from './supabase';
import { loadSigns, showName, type Sign } from './signatures';
import { signatureUrl } from './documents';
import { toDataUrl } from './pdfMaker';
import { savePdf } from './dispatchPapers';

export interface Page { html: string; land: boolean }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const d = (x: string | null | undefined) => (x ? x.slice(0, 10).split('-').reverse().join('/') : '');
const money = (n: number) => n.toLocaleString('vi-VN');
const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
const uniq = (a: (string | null | undefined)[]) => [...new Set(a.map((x) => (x ?? '').trim()).filter(Boolean))];
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export interface Company { name: string; address: string }
export interface Boss { gd: Sign | null; gdName: string; seal: string | null; me: Sign; meName: string }

// ------------------------------------------------------------------ phần chung
export async function company(): Promise<Company> {
  const t = (await supabase.from('tenants').select('name, legal_name, address').maybeSingle()).data as { name?: string; legal_name?: string | null; address?: string | null } | null;
  return { name: t?.legal_name || t?.name || '', address: t?.address ?? '' };
}
/** Chữ ký người lập (người đang dùng) + giám đốc + con dấu (theo Cấu hình in). Ảnh dạng data URL để vẽ được vào PDF. */
export async function boss(tenantId: string, me: { id: string | null; name: string }, extra: string[] = []): Promise<{ b: Boss; m: Map<string, Sign> }> {
  const ss = ((await supabase.from('tenant_settings').select('key, value').in('key', ['cong_ty.giam_doc', 'in.chu_ky_giam_doc', 'in.con_dau'])).data ?? []) as { key: string; value: unknown }[];
  const raw = (k: string) => ss.find((x) => x.key === k)?.value;
  // chữ ký người lập (người đang dùng): chữ ký trong hồ sơ nhân viên trước, chưa có thì chữ ký của tài khoản
  const mine = me.id ? (((await supabase.from('staff_members').select('id').eq('user_id', me.id).limit(1)).data ?? []) as { id: string }[])[0] : undefined;
  const nv = mine ? `nv_${mine.id}` : null;
  const m = await loadSigns(tenantId, ['giam_doc', me.id, nv, ...extra], true);
  const meSign = [nv, me.id].map((k) => (k ? m.get(k) : undefined)).find((x) => x?.img) ?? { img: null, hasName: false };
  const seal = raw('in.con_dau') !== false ? await toDataUrl(await signatureUrl(tenantId, 'con_dau').catch(() => null)) : null;
  return { m, b: { gd: raw('in.chu_ky_giam_doc') === false ? null : m.get('giam_doc') ?? null, gdName: String(raw('cong_ty.giam_doc') ?? ''), seal,
    me: meSign, meName: me.name } };
}
export const head = (c: Company) => `<table style="width:100%;border-collapse:collapse"><tr>
  <td style="width:45%;text-align:center;vertical-align:top"><b>${esc(c.name.toUpperCase())}</b><br><span style="font-size:12px">${esc(c.address)}</span></td>
  <td style="text-align:center;vertical-align:top"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><b>Độc lập - Tự do - Hạnh phúc</b><div style="width:150px;border-top:1px solid #000;margin:3px auto"></div></td></tr></table>`;
const today = () => { const [y, m, dd] = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).split('-'); return `ngày ${dd} tháng ${m} năm ${y}`; };
export const signImg = (s: Sign | null | undefined) => (s?.img ? `<img src="${s.img}" alt="" style="max-height:66px;max-width:190px">` : '');
export const signCol = (title: string, hint: string, inner: string, name: string, s: Sign | null | undefined, w: number) =>
  `<td style="width:${w}%;text-align:center;vertical-align:top"><b>${title}</b><br><i style="font-size:12px">${hint}</i>
   <div style="height:96px;display:flex;align-items:center;justify-content:center;position:relative">${inner}</div><b>${showName(s) ? esc(name) : ''}</b></td>`;
export const bossCol = (b: Boss, title: string, w: number) => signCol(title, '(Ký, đóng dấu)',
  `${b.seal ? `<img src="${b.seal}" alt="" style="position:absolute;left:50%;top:0;height:94px;transform:translateX(-78%);opacity:.9">` : ''}${b.gd?.img ? `<img src="${b.gd.img}" alt="" style="position:relative;max-height:70px;max-width:180px">` : ''}`,
  b.gdName, b.gd, w);
const TH = 'border:1px solid #333;padding:5px 5px;font-size:12.5px;text-align:center;background:#e2e8f0;font-weight:bold';
const TD = 'border:1px solid #333;padding:5px 5px;font-size:12.5px;vertical-align:top';
const table = (H: string[], rows: string[][], blank: number) => `<table style="width:100%;border-collapse:collapse;margin:4px 0 10px"><tr>${H.map((h) => `<th style="${TH}">${h}</th>`).join('')}</tr>
  ${rows.map((r) => `<tr>${r.map((c) => `<td style="${TD}">${c}</td>`).join('')}</tr>`).join('')}
  ${Array.from({ length: Math.max(0, blank - rows.length) }, () => `<tr style="height:28px">${H.map(() => `<td style="${TD}"></td>`).join('')}</tr>`).join('')}</table>`;
const sec = (t: string) => `<div style="font-weight:bold;font-size:14px;margin:10px 0 3px">${t}</div>`;

// ------------------------------------------------------------------ Lý lịch hành nghề người lái xe
interface DocRow { doc_type: string; doc_no: string | null; issuer: string | null; issued_on: string | null; valid_from: string | null; expires_on: string | null; is_current: boolean; data: Record<string, unknown> | null }
interface Rec { kind: string; occurred_on: string; doc_no: string | null; title: string; data: Record<string, unknown> | null; vehicle_id: string | null }
export interface DriverPaper {
  company: Company; boss: Boss; driverSign: Sign;
  s: { id: string; full_name: string; job_title: string | null; phone: string | null; joined_on: string };
  p: { birth_date: string | null; address: string | null; current_address: string | null; contract_type: string | null } | null;
  docs: DocRow[]; recs: Rec[]; plates: Map<string, string>; work: { types: string[]; seats: string[]; first: string | null; last: string | null; trips: number };
}
const CONTRACT: Record<string, string> = {
  khong_xac_dinh: 'Không xác định thời hạn', xac_dinh: 'Xác định thời hạn', thu_viec: 'Thử việc', thoi_vu: 'Thời vụ', khoan_viec: 'Khoán việc', khac: 'Khác',
};

export async function loadDriverPaper(tenantId: string, staffId: string, me: { id: string | null; name: string }, shared?: SharedBase | Promise<SharedBase>): Promise<DriverPaper> {
  const base = await (shared ?? sharedBase());
  const [sm, pv, dc, rc, crew, ch] = await Promise.all([
    supabase.from('staff_members').select('id, full_name, job_title, phone, joined_on, user_id').eq('id', staffId).maybeSingle(),
    supabase.from('staff_private').select('birth_date, address, current_address, contract_type').eq('staff_id', staffId).maybeSingle(),
    supabase.from('documents').select('doc_type, doc_no, issuer, issued_on, valid_from, expires_on, is_current, data').eq('staff_id', staffId),
    supabase.from('staff_records').select('kind, occurred_on, doc_no, title, data, vehicle_id').eq('staff_id', staffId).order('occurred_on'),
    fetchAll<{ trip_id: string }>(() => supabase.from('trip_crew').select('trip_id').eq('staff_id', staffId).eq('active', true).in('role', ['lai_xe_1', 'lai_xe_2']).order('trip_id')),
    supabase.from('charters').select('start_at, vehicle_id, driver1_id, driver2_id').or(`driver1_id.eq.${staffId},driver2_id.eq.${staffId}`).in('status', ['da_ky', 'dang_chay', 'xong']),
  ]);
  if (!sm.data) throw new Error('Không tìm thấy nhân viên');
  const s = sm.data as DriverPaper['s'] & { user_id: string | null };
  // Xe đã lái: chuyến tuyến cố định + hợp đồng → loại xe, số chỗ, thời gian
  const runs: { day: string; vehicle_id: string | null }[] = [];
  for (const part of chunks(crew.map((c) => c.trip_id), 200)) {
    const r = await supabase.from('trips').select('service_date, vehicle_id').in('id', part).eq('status', 'mo');
    runs.push(...((r.data ?? []) as { service_date: string; vehicle_id: string | null }[]).map((x) => ({ day: x.service_date, vehicle_id: x.vehicle_id })));
  }
  runs.push(...((ch.data ?? []) as { start_at: string; vehicle_id: string | null }[]).map((x) => ({ day: x.start_at.slice(0, 10), vehicle_id: x.vehicle_id })));
  const vs = runs.map((r) => (r.vehicle_id ? base.veh.get(r.vehicle_id) : undefined)).filter((x): x is VehInfo => !!x);
  const days = runs.map((r) => r.day).sort();
  const who = `nv_${staffId}`;
  // Lái xe tự mở lý lịch của mình: người lập là người quản lý cập nhật hồ sơ gần nhất (chưa có thì Chủ nhà xe), không phải lái xe
  const self = !!me.id && s.user_id === me.id;
  const maker = self ? await rpc<{ user_id: string; staff_id: string | null; name: string } | null>('paper_maker', { p_staff_id: staffId }).catch(() => null) : null;
  const { b, m } = await boss(tenantId, maker ? { id: maker.user_id, name: maker.name } : me, [who, s.user_id ?? '']);
  if (self && !maker) { b.me = { img: null, hasName: false }; b.meName = ''; }
  const own = m.get(who);
  return {
    company: base.company, boss: b, driverSign: own?.img ? own : (s.user_id && m.get(s.user_id)) || { img: null, hasName: false },
    s, p: (pv.data ?? null) as DriverPaper['p'], docs: (dc.data ?? []) as DocRow[], recs: (rc.data ?? []) as Rec[], plates: base.plates,
    work: { types: uniq(vs.map((v) => v.type)), seats: uniq(vs.map((v) => v.seats)), first: days[0] ?? null, last: days[days.length - 1] ?? null, trips: runs.length },
  };
}

export function driverPages(x: DriverPaper): Page[] {
  const cur = (t: string) => x.docs.find((g) => g.doc_type === t && g.is_current);
  const cccd = cur('cccd'), gplx = cur('gplx');
  const dt = (g: DocRow | undefined, k: string) => String(g?.data?.[k] ?? '');
  const recs = (k: string) => x.recs.filter((r) => r.kind === k);
  const kv = (l: string, v: string) => `<td style="padding:3px 0;font-size:13.5px;width:50%">${l}: <b>${esc(v)}</b></td>`;
  const one = (l: string, v: string) => `<tr><td colspan="2" style="padding:3px 0;font-size:13.5px">${l}: <b>${esc(v)}</b></td></tr>`;
  const plate = (r: Rec) => (r.vehicle_id ? x.plates.get(r.vehicle_id) : '') || String(r.data?.bien_so ?? '');
  // 3. Sức khỏe: dòng lý lịch + giấy khám sức khỏe (cả bản cũ), trùng ngày thì lấy 1
  const sk = new Map<string, string[]>();
  for (const g of x.docs.filter((g) => g.doc_type === 'kham_suc_khoe')) {
    const day = g.issued_on || g.valid_from || '';
    sk.set(`${day}|g`, [d(day), esc(g.issuer ?? ''), esc([dt(g, 'ket_luan'), dt(g, 'hang_du_dieu_kien') && `đủ điều kiện hạng ${dt(g, 'hang_du_dieu_kien')}`].filter(Boolean).join('; ')), d(g.expires_on)]);
  }
  for (const r of recs('suc_khoe')) {
    if ([...sk.keys()].some((k) => k.startsWith(`${r.occurred_on}|`))) continue;
    sk.set(`${r.occurred_on}|r`, [d(r.occurred_on), esc(String(r.data?.co_so ?? '')), esc([r.title, r.data?.ghi_chu].filter(Boolean).join('; ')), '']);
  }
  const skRows = [...sk.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((e) => e[1]);
  // 7. Tập huấn: dòng lý lịch + giấy chứng nhận tập huấn
  const th: [string, string[]][] = [
    ...x.docs.filter((g) => g.doc_type === 'tap_huan').map((g): [string, string[]] => [g.issued_on ?? '', ['Tập huấn nghiệp vụ' + (g.doc_no ? ` (GCN số ${esc(g.doc_no)})` : ''), d(g.issued_on), esc(g.issuer ?? ''), d(g.expires_on)]]),
    ...recs('dao_tao').map((r): [string, string[]] => [r.occurred_on, [esc(r.title) + (r.doc_no ? ` (GCN số ${esc(r.doc_no)})` : ''), d(r.occurred_on), esc(String(r.data?.co_so ?? '')), d(String(r.data?.het_han ?? '') || null)]]),
  ].sort((a, b) => a[0].localeCompare(b[0]))
    // cùng 1 lần tập huấn (vừa có giấy chứng nhận vừa có dòng lý lịch): cùng hạn + cùng đơn vị → lấy 1 (ưu tiên dòng có số GCN)
    .filter((r, i, A) => {
      const key = (x: [string, string[]]) => (x[1][3] ? `${x[1][3]}|${fold(x[1][2] ?? '')}` : `${x[1][1]}|${fold(x[1][0] ?? '')}`);
      const gcn = (x: [string, string[]]) => /GCN số/.test(x[1][0] ?? '');
      return !A.some((o, j) => j !== i && key(o) === key(r) && ((gcn(o) && !gcn(r)) || (gcn(o) === gcn(r) && j < i)));
    });
  const vp = recs('vi_pham').map((r) => [d(r.occurred_on), esc(r.title) + (plate(r) ? ` (xe ${esc(plate(r))})` : ''),
    esc([r.data?.hinh_thuc, r.data?.so_tien ? `phạt ${money(Number(r.data.so_tien))} đ` : '', r.data?.tru_diem ? `trừ ${r.data.tru_diem} điểm GPLX` : ''].filter(Boolean).join('; ')),
    esc([r.doc_no && `QĐ/BB số ${r.doc_no}`, r.data?.co_quan].filter(Boolean).join(' · '))]);
  const tn = recs('tai_nan').map((r) => [d(r.occurred_on), esc(plate(r)), esc(String(r.data?.dia_diem ?? '')), esc([r.title, r.data?.thiet_hai].filter(Boolean).join('; ')), esc(String(r.data?.trach_nhiem ?? ''))]);
  const kt: [string, string, Rec][] = [...recs('khen_thuong').map((r): [string, string, Rec] => [r.occurred_on, 'Khen thưởng', r]),
    ...recs('ky_luat').map((r): [string, string, Rec] => [r.occurred_on, 'Kỷ luật', r])];
  const ktRows = kt.sort((a, b) => a[0].localeCompare(b[0])).map(([, k, r]) => [d(r.occurred_on), k, esc([r.title, r.data?.hinh_thuc].filter(Boolean).join('; ')), esc(r.doc_no ?? '')]);
  const work = [[x.s.joined_on ? `Từ ${d(x.s.joined_on)}` : x.work.first ? `Từ ${d(x.work.first)}` : '', esc(dt(gplx, 'hang')), esc(x.work.types.join(', ')),
    esc(x.work.seats.join(', ')), esc(x.p?.contract_type ? CONTRACT[x.p.contract_type] ?? '' : '')]];

  const p1 = `<div style="font-size:13.5px;line-height:1.4">${head(x.company)}
    <h2 style="text-align:center;margin:12px 0 10px;font-size:19px">LÝ LỊCH HÀNH NGHỀ NGƯỜI LÁI XE</h2>
    ${sec('1. Thông tin chung')}
    <table style="width:100%;border-collapse:collapse">
      <tr>${kv('Họ và tên', x.s.full_name.toUpperCase())}${kv('Ngày sinh', d(x.p?.birth_date))}</tr>
      <tr>${kv('Số CCCD', cccd?.doc_no ?? '')}${kv('Điện thoại', x.s.phone ?? '')}</tr>
      <tr>${kv('Giấy phép lái xe số', gplx?.doc_no ?? '')}${kv('Hạng', [dt(gplx, 'hang'), gplx?.expires_on ? `hết hạn ${d(gplx.expires_on)}` : ''].filter(Boolean).join(' · '))}</tr>
      ${one('Cơ quan cấp GPLX', [gplx?.issuer, gplx?.issued_on ? `ngày cấp ${d(gplx.issued_on)}` : ''].filter(Boolean).join(' · '))}
      ${one('Nơi thường trú', x.p?.address || dt(cccd, 'nv.noi_thuong_tru'))}
      ${one('Chỗ ở hiện nay', x.p?.current_address ?? '')}
      <tr>${kv('Chức vụ', x.s.job_title || 'Lái xe')}${kv('Ngày vào công ty', d(x.s.joined_on))}</tr>
    </table>
    ${sec('2. Quá trình hành nghề lái xe')}
    ${table(['Thời gian', 'Hạng GPLX', 'Loại xe điều khiển', 'Sức chứa / tải trọng', 'Hình thức hợp đồng lao động'], work, 1)}
    ${sec('3. Theo dõi sức khỏe')}
    ${table(['Ngày khám', 'Cơ sở khám', 'Kết quả khám', 'Hạn giấy khám'], skRows, 3)}
    ${sec('4. Vi phạm quy định về an toàn giao thông')}
    ${table(['Ngày', 'Lỗi vi phạm', 'Hình thức xử lý', 'Ghi chú'], vp, 3)}</div>`;
  const p2 = `<div style="font-size:13.5px;line-height:1.4">
    ${sec('5. Tai nạn giao thông')}
    ${table(['Ngày', 'Xe', 'Địa điểm', 'Thiệt hại về người và phương tiện', 'Nguyên nhân / kết luận trách nhiệm'], tn, 3)}
    ${sec('6. Khen thưởng, kỷ luật')}
    ${table(['Ngày', 'Khen thưởng / Kỷ luật', 'Nội dung', 'Số quyết định'], ktRows, 3)}
    ${sec('7. Tập huấn nghiệp vụ')}
    ${table(['Nội dung tập huấn', 'Thời gian', 'Đơn vị tổ chức', 'Hạn giấy chứng nhận'], th.map((e) => e[1]), 3)}
    <p style="text-align:right;margin:18px 0 4px"><i>……………, ${today()}</i></p>
    <table style="width:100%;border-collapse:collapse"><tr>
      ${signCol('NGƯỜI LẬP', '(Ký, ghi rõ họ tên)', signImg(x.boss.me), x.boss.meName, x.boss.me, 33)}
      ${signCol('NGƯỜI LÁI XE', '(Ký, ghi rõ họ tên)', signImg(x.driverSign), x.s.full_name, x.driverSign, 33)}
      ${bossCol(x.boss, 'THỦ TRƯỞNG ĐƠN VỊ', 34)}
    </tr></table></div>`;
  return [{ html: p1, land: false }, { html: p2, land: false }];
}

// ------------------------------------------------------------------ Lý lịch phương tiện
interface VehInfo { plate: string; type: string; seats: string }
export interface SharedBase { company: Company; veh: Map<string, VehInfo>; plates: Map<string, string> }
/** Dữ liệu dùng chung khi lưu nhiều người / nhiều xe một lượt: tải 1 lần. */
export async function sharedBase(): Promise<SharedBase> {
  const [c, vh, vt] = await Promise.all([company(), supabase.from('vehicles').select('id, plate, vehicle_type_id'), supabase.from('vehicle_types').select('id, name, reg_seats, reg_berths')]);
  const types = new Map(((vt.data ?? []) as { id: string; name: string; reg_seats: number; reg_berths: number }[]).map((t) => [t.id, t]));
  const veh = new Map<string, VehInfo>(), plates = new Map<string, string>();
  for (const v of (vh.data ?? []) as { id: string; plate: string; vehicle_type_id: string }[]) {
    const t = types.get(v.vehicle_type_id);
    veh.set(v.id, { plate: v.plate, type: t?.name ?? '', seats: t ? (t.reg_berths ? `${t.reg_berths} giường` : `${t.reg_seats} chỗ`) : '' });
    plates.set(v.id, v.plate);
  }
  return { company: c, veh, plates };
}

const BUSINESS: Record<string, string> = { tuyen_co_dinh: 'Tuyến cố định', hop_dong: 'Xe hợp đồng', ca_hai: 'Tuyến cố định + Xe hợp đồng' };
export interface VehiclePaper {
  company: Company; boss: Boss;
  v: { id: string; plate: string; chassis_no: string | null; engine_no: string | null; country_of_origin: string | null; manufacture_year: number | null; business_type: string;
    acquired_on: string | null; gsht_provider: string | null; gsht_device_no: string | null; camera_provider: string | null; camera_device_no: string | null;
    gsht_account: string | null; odo_start: number | null; odo_date: string | null; retired_on: string | null };
  t: { name: string; brand: string | null; model_code: string | null; reg_seats: number; reg_berths: number; reg_standing: number | null; gross_weight_kg: number | null } | null;
  docs: DocRow[]; inc: { occurred_on: string; place: string | null; summary: string; damage: string | null; resolution: string | null }[];
  months: { m: string; days: number; trips: number; km: number | null; run: number }[];
  rep: { repaired_on: string; odo_km: number | null; workshop: string | null; text: string; cost: number }[];
}

export async function loadVehiclePaper(tenantId: string, vehicleId: string, me: { id: string | null; name: string }, shared?: SharedBase | Promise<SharedBase>): Promise<VehiclePaper> {
  const base = await (shared ?? sharedBase());
  const vr = await supabase.from('vehicles').select('id, plate, vehicle_type_id, chassis_no, engine_no, country_of_origin, manufacture_year, business_type, acquired_on, gsht_provider, gsht_device_no, camera_provider, camera_device_no, gsht_account, odo_start, odo_date, retired_on').eq('id', vehicleId).maybeSingle();
  if (!vr.data) throw new Error('Không tìm thấy xe');
  const v = vr.data as VehiclePaper['v'] & { vehicle_type_id: string };
  const [t, dc, i, a, tr, kms, ro] = await Promise.all([
    supabase.from('vehicle_types').select('name, brand, model_code, reg_seats, reg_berths, reg_standing, gross_weight_kg').eq('id', v.vehicle_type_id).maybeSingle(),
    supabase.from('documents').select('doc_type, doc_no, issuer, issued_on, valid_from, expires_on, is_current, data').eq('vehicle_id', vehicleId),
    supabase.from('vehicle_incidents').select('occurred_on, place, summary, damage, resolution').eq('vehicle_id', vehicleId),
    supabase.from('staff_records').select('occurred_on, title, data').eq('vehicle_id', vehicleId).eq('kind', 'tai_nan'),
    fetchAll<{ service_date: string }>(() => supabase.from('trips').select('service_date').eq('vehicle_id', vehicleId).eq('status', 'mo').order('service_date')),
    fetchAll<{ run_date: string; km: number }>(() => supabase.from('vehicle_km').select('run_date, km').eq('vehicle_id', vehicleId).order('run_date')).catch(() => []),
    supabase.from('repair_orders').select('id, repaired_on, odo_km, workshop').eq('vehicle_id', vehicleId).order('repaired_on'),
  ]);
  const inc = [...((i.data ?? []) as VehiclePaper['inc']),
    ...((a.data ?? []) as { occurred_on: string; title: string; data: Record<string, unknown> | null }[]).map((x) => ({
      occurred_on: x.occurred_on, place: String(x.data?.dia_diem ?? '') || null, summary: x.title, damage: String(x.data?.thiet_hai ?? '') || null, resolution: String(x.data?.trach_nhiem ?? x.data?.xu_ly ?? '') || null }))]
    .sort((p, q) => p.occurred_on.localeCompare(q.occurred_on))
    // sự cố ghi ở xe và tai nạn ghi ở lý lịch lái xe trùng nhau: cùng ngày + cùng nội dung → lấy 1
    .filter((x, i, A) => A.findIndex((o) => o.occurred_on === x.occurred_on && fold(o.summary) === fold(x.summary)) === i);
  const M: Record<string, { days: Set<string>; trips: number }> = {};
  for (const r of tr) { const m = r.service_date.slice(0, 7); (M[m] ??= { days: new Set(), trips: 0 }).trips++; M[m].days.add(r.service_date); }
  const K: Record<string, { km: number; days: number; run: number }> = {};
  for (const r of kms) {
    const m = r.run_date.slice(0, 7), o = (K[m] ??= { km: 0, days: 0, run: 0 });
    o.km += Number(r.km); if (Number(r.km) > 0) o.days++;
    if (!v.odo_date || r.run_date >= v.odo_date) o.run += Number(r.km);
  }
  let run = 0;
  const months = [...new Set([...Object.keys(M), ...Object.keys(K)])].sort().map((m) => {
    run += K[m]?.run ?? 0;
    return { m, days: Math.max(M[m]?.days.size ?? 0, K[m]?.days ?? 0), trips: M[m]?.trips ?? 0, km: K[m]?.km ?? null, run };
  });
  const ros = (ro.data ?? []) as { id: string; repaired_on: string; odo_km: number | null; workshop: string | null }[];
  const its = ros.length ? ((await supabase.from('repair_items').select('order_id, content, qty, unit_price').in('order_id', ros.map((o) => o.id)).order('seq')).data ?? []) as { order_id: string; content: string; qty: number; unit_price: number }[] : [];
  const rep = ros.map((o) => {
    const l = its.filter((x) => x.order_id === o.id);
    return { repaired_on: o.repaired_on, odo_km: o.odo_km, workshop: o.workshop, text: l.map((x) => `${x.content}${Number(x.qty) > 1 ? ` (x${x.qty})` : ''}`).join('; '),
      cost: l.reduce((s, x) => s + Number(x.qty) * Number(x.unit_price), 0) };
  });
  const { b } = await boss(tenantId, me);
  return { company: base.company, boss: b, v, t: (t.data ?? null) as VehiclePaper['t'], docs: (dc.data ?? []) as DocRow[], inc, months, rep };
}

export function vehiclePages(x: VehiclePaper): Page[] {
  const { v, t } = x;
  const doc = (c: string) => x.docs.find((g) => g.doc_type === c && g.is_current);
  const dk = doc('dang_ky'), kd = doc('kiem_dinh');
  const kdAll = x.docs.filter((g) => g.doc_type === 'kiem_dinh').sort((a, b) => String(a.expires_on ?? '').localeCompare(String(b.expires_on ?? '')));
  const dots = (s: string | null | undefined) => (s ? `<b>${esc(s)}</b>` : '<span style="letter-spacing:1px">…………………………</span>');
  const dt = (s: string | null | undefined) => (s ? `<b>${d(s)}</b>` : '<span>…../…../20…..</span>');
  const seats = t ? `${t.reg_seats} chỗ ngồi${t.reg_berths ? ` · ${t.reg_berths} chỗ nằm` : ''}${t.reg_standing ? ` · ${t.reg_standing} chỗ đứng` : ''}` : '';
  const brand = [t?.brand, t?.model_code].filter(Boolean).join(' / ') || t?.name || '';
  const li = (n: number, l: string, val: string) => `<div style="margin:5px 0"><b>${n}. ${l}:</b> ${val}</div>`;
  const sub = (l: string, val: string) => `<div style="margin:2px 0 2px 24px">○ ${l}: ${val}</div>`;
  const h3 = (s: string) => `<h3 style="margin:12px 0 6px;font-size:14.5px">${s}</h3>`;
  const wrap = (s: string) => `<div style="font-size:13.5px;line-height:1.4">${s}</div>`;
  const p1 = wrap(`${head(x.company)}<div style="text-align:center;margin-top:8px"><h2 style="margin:6px 0 2px;font-size:19px">LÝ LỊCH PHƯƠNG TIỆN KINH DOANH VẬN TẢI</h2>
    <div style="font-weight:bold">${esc(x.company.name)}</div><div style="margin-top:4px">SỐ LÝ LỊCH XE: <b>${esc(v.plate)}/LLPT</b></div></div>
    ${h3('TRANG 1: THÔNG TIN CHUNG CỦA PHƯƠNG TIỆN')}
    ${li(1, 'Biển kiểm soát', dots(v.plate))}${li(2, 'Nhãn hiệu / Số loại', dots(brand))}
    ${li(3, 'Số khung', `${dots(v.chassis_no)} &nbsp; <b>Số máy:</b> ${dots(v.engine_no)}`)}
    ${li(4, 'Năm sản xuất', `${dots(v.manufacture_year ? String(v.manufacture_year) : '')} &nbsp; <b>Nước sản xuất:</b> ${dots(v.country_of_origin)}`)}
    ${li(5, 'Số chỗ ngồi / Số chỗ đứng / Số chỗ nằm', dots(seats))}
    ${li(6, 'Tải trọng cho phép chở (đối với xe tải / xe đầu kéo)', `${t?.gross_weight_kg ? `<b>${money(t.gross_weight_kg)}</b>` : '………………'} kg`)}
    ${li(7, 'Loại hình kinh doanh vận tải đã đăng ký', dots(BUSINESS[v.business_type]))}
    ${li(8, 'Giấy chứng nhận đăng ký xe', '')}${sub('Số đăng ký', `${dots(dk?.doc_no)} &nbsp; Ngày cấp: ${dt(dk?.issued_on)} &nbsp; Nơi cấp: ${dots(dk?.issuer)}`)}
    ${li(9, 'Giấy chứng nhận kiểm định an toàn kỹ thuật &amp; bảo vệ môi trường', '')}${sub('Số giấy chứng nhận', `${dots(kd?.doc_no)} &nbsp; Ngày hết hạn kiểm định: ${dt(kd?.expires_on)}`)}
    ${sub('Bảo hiểm dân sự bắt buộc hết hạn', dt(doc('bh_tnds')?.expires_on))}${sub('Bảo hiểm vật chất hết hạn', dt(doc('bh_vat_chat')?.expires_on))}
    ${li(10, 'Thiết bị giám sát hành trình (GPS) &amp; Camera giám sát', '')}${sub('Nhà cung cấp / số thiết bị', dots([v.gsht_provider, v.gsht_device_no].filter(Boolean).join(' · ')))}
    ${sub('Tài khoản truy cập quản lý', dots(v.gsht_account))}${sub('Camera', dots([v.camera_provider, v.camera_device_no].filter(Boolean).join(' · ')))}
    ${li(11, 'Thời hạn phù hiệu / biển hiệu kinh doanh vận tải', `đến ngày ${dt(doc('phu_hieu')?.expires_on)}`)}`);
  const p2 = wrap(`${h3('TRANG 2: THEO DÕI QUÁ TRÌNH HOẠT ĐỘNG, BẢO DƯỠNG VÀ SỬA CHỮA')}<div><b>1. Theo dõi bảo dưỡng định kỳ và sửa chữa lớn:</b></div>
    ${table(['Ngày / Tháng / Năm', 'Số km hiện tại (Odo)', 'Nội dung bảo dưỡng / Thay thế phụ tùng / Sửa chữa', 'Đơn vị thực hiện (Gara / Xưởng)', 'Chi phí (đ)', 'Xác nhận của bộ phận Kỹ thuật / Quản lý'],
      x.rep.map((r) => [d(r.repaired_on), r.odo_km ? `${money(r.odo_km)} km` : '', esc(r.text), esc(r.workshop ?? ''), money(r.cost), '']), 8)}
    <div><b>2. Theo dõi quá trình hoạt động (số chuyến, km chạy, km lũy kế):</b>${v.odo_start != null ? ` Odo gốc ${money(v.odo_start)} km${v.odo_date ? ` ngày ${d(v.odo_date)}` : ''}` : ''}</div>
    ${table(['Tháng', 'Số ngày hoạt động', 'Số chuyến', 'Km chạy trong tháng', v.odo_start != null ? 'Km lũy kế (Odo)' : 'Km lũy kế'],
      x.months.map((r) => [`${r.m.slice(5)}/${r.m.slice(0, 4)}`, String(r.days), String(r.trips), r.km != null ? r.km.toLocaleString('vi-VN', { maximumFractionDigits: 1 }) : '',
        r.km != null ? ((v.odo_start ?? 0) + r.run).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) : '']), 4)}
    <div><b>3. Theo dõi kiểm định kỹ thuật (Đăng kiểm):</b></div>
    ${table(['Lần kiểm định', 'Ngày kiểm định', 'Ngày hết hạn', 'Số giấy chứng nhận kiểm định', 'Kết quả'],
      kdAll.map((g, i) => [`Lần ${i + 1}`, d(g.valid_from || g.issued_on), d(g.expires_on), esc(g.doc_no ?? ''), 'Đạt']), 3)}`);
  const p3 = wrap(`${h3('TRANG 3: THEO DÕI TAI NẠN GIAO THÔNG &amp; SỰ CỐ KỸ THUẬT (NẾU CÓ)')}
    ${table(['Ngày xảy ra', 'Địa điểm', 'Tóm tắt sự cố / Tai nạn', 'Mức độ thiệt hại phương tiện', 'Kết quả xử lý / Khắc phục'],
      x.inc.map((r) => [d(r.occurred_on), esc(r.place ?? ''), esc(r.summary), esc(r.damage ?? ''), esc(r.resolution ?? '')]), 6)}
    ${h3('TRANG 4: THAY ĐỔI THÔNG TIN VÀ XÁC NHẬN CỦA ĐƠN VỊ')}
    ${sub('Thời gian đưa phương tiện vào hoạt động kinh doanh vận tải', dt(v.acquired_on))}${sub('Thời gian ngừng hoạt động / Thanh lý xe (nếu có)', dt(v.retired_on))}
    <p style="text-align:right;margin:22px 0 4px"><i>……………, ${today()}</i></p>
    <table style="width:100%;border-collapse:collapse"><tr>
      ${signCol('NGƯỜI LẬP SỔ LÝ LỊCH', '(Ký, ghi rõ họ tên)', signImg(x.boss.me), x.boss.meName, x.boss.me, 50)}
      ${bossCol(x.boss, 'ĐẠI DIỆN ĐƠN VỊ KINH DOANH VẬN TẢI', 50)}
    </tr></table>`);
  return [{ html: p1, land: false }, { html: p2, land: false }, { html: p3, land: false }];
}

// ------------------------------------------------------------------ Lưu vào Lưu trữ hồ sơ
const year = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).slice(0, 4);
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
export const DRIVER_PATH = () => [year(), '02. Nhân sự', 'Lý lịch hành nghề'];
export const VEHICLE_PATH = () => [year(), '03. Phương tiện', 'Lý lịch phương tiện'];

/** Mã nội dung giấy (bỏ dòng "ngày … tháng … năm …" đổi theo ngày in) để biết hồ sơ có đổi không */
function hash(t: string): string {
  let a = 5381, b = 52711;
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); a = (Math.imul(a, 33) ^ c) >>> 0; b = (Math.imul(b, 31) + c) >>> 0; }
  return a.toString(36) + b.toString(36);
}
export const paperSig = (pages: Page[]) => hash(pages.map((p) => p.html).join('').replace(/ngày (<b>)?\d{1,2}(<\/b>)? tháng (<b>)?\d{1,2}(<\/b>)? năm (<b>)?\d{4}/gi, ''));
export async function saveDriverPaper(x: DriverPaper, pages = driverPages(x)): Promise<void> {
  await savePdf(DRIVER_PATH(), `Lý lịch hành nghề · ${x.s.full_name}`, `LLHN_${slug(x.s.full_name)}.pdf`, pages, `Lý lịch hành nghề người lái xe · sig:${paperSig(pages)}`, `llhn:${x.s.id}`);
}
export async function saveVehiclePaper(x: VehiclePaper, pages = vehiclePages(x)): Promise<void> {
  await savePdf(VEHICLE_PATH(), `Lý lịch phương tiện · ${x.v.plate}`, `LLPT_${slug(x.v.plate)}.pdf`, pages, `Lý lịch phương tiện · sig:${paperSig(pages)}`, `llpt:${x.v.id}`);
}
