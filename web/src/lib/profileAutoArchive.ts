// Tự cập nhật hồ sơ trong Lưu trữ hồ sơ: sửa bất kỳ thông tin nào (hồ sơ, giấy tờ, lý lịch, xe, chuyến, hợp đồng…) thì
// PDF đã lưu được dựng lại và LƯU ĐÈ đúng chỗ cũ trong cây thư mục; hồ sơ chưa có thì lưu mới.
//   <năm> / 02. Nhân sự / Lý lịch hành nghề        – mỗi lái xe đang làm 1 tệp      [llhn:<id>]
//   <năm> / 03. Phương tiện / Lý lịch phương tiện   – mỗi xe đang dùng 1 tệp         [llpt:<id>]
//   <năm> / Nhân sự / Hợp đồng lao động / <tên>     – hợp đồng năm nay đang hiệu lực [hdld:<id>:<năm>]
//   <năm> / 02. Nhân sự / Sơ yếu lý lịch            – mỗi người đang làm 1 tệp        [syll:<id>]
//   <năm> / … / <loại văn bản>                      – văn bản còn hiệu lực           [vb:<id>]
//   <năm> / 03. Phương tiện / Hợp đồng thuê xe       – hợp đồng thuê xe              [hdtx:<id>]
//   <năm> / Tài chính - Kế toán / BHXH & lương chuyển khoản – mỗi tháng có dữ liệu   [bhxh:<yyyy-mm>]
//   <năm> / 03. Phương tiện / Sửa chữa / Tháng mm-yyyy – mỗi phiếu sửa chữa             [psc:<id>]
// Nội dung không đổi (so mã nội dung "sig" ghi trong ghi chú tệp) thì bỏ qua, không tải lên lại.
// PDF phải vẽ trên trình duyệt nên chạy ngầm trên máy người có quyền: sau khi mở app, khi vừa sửa dữ liệu, và định kỳ.
import { drive } from './drive';
import { avatarUrls } from './documents';
import { staffCvPages } from './staffCv';
import { repairPaperHtml } from '../components/RepairPrint';
import { loadDocCtx, saveDocPdf, type OfficialDoc } from './officialDocs';
import { archiveLeasePdf, LEASE_COLS, loadLeaseCtx, type Lease } from './vehicleLease';
import { resetFolders, savePdf } from './dispatchPapers';
import { boss, bossCol, company, driverPages, head, loadDriverPaper, loadVehiclePaper, paperSig, saveDriverPaper, saveVehiclePaper, sharedBase, signCol, signImg, vehiclePages } from './profilePapers';
import { loadLaborCtx, saveContractPdf, type Contract } from './laborContract';
import { CONTRACT_COLS } from '../components/ContractEditor';
import { fetchAll, supabase } from './supabase';

export interface AutoCan { drivers: boolean; vehicles: boolean; contracts: boolean; cv: boolean; docs: boolean; leases: boolean; pay: boolean; repairs: boolean }
let running = false, again = false;

/** Dựng lại và lưu đè hồ sơ đã đổi / còn thiếu. Trả số tệp đã lưu. */
export async function autoArchiveProfiles(tenantId: string, me: { id: string | null; name: string }, can: AutoCan): Promise<number> {
  if (running) { again = true; return 0; }
  running = true;
  let n = 0;
  try {
    if (!Object.values(can).some(Boolean)) return 0;
    await drive({ action: 'ping' });   // chưa kết nối Google Drive thì dừng ngay, không dựng giấy
    resetFolders();
    const items = await fetchAll<{ note: string | null }>(() => supabase.from('archive_items').select('note').eq('is_old', false)
      .or('note.like.%[llhn:%,note.like.%[llpt:%,note.like.%[syll:%,note.like.%[vb:%,note.like.%[hdtx:%,note.like.%[bhxh:%').order('id'));
    const sigs = new Map<string, string>();
    for (const r of items) { const k = /\[((?:llhn|llpt|syll|vb|hdtx):[0-9a-f-]+|bhxh:\d{4}-\d{2})\]/.exec(r.note ?? '')?.[1]; if (k) sigs.set(k, /sig:([a-z0-9]+)/.exec(r.note ?? '')?.[1] ?? ''); }
    const base = sharedBase();
    let fail = 0;
    const step = async (fn: () => Promise<boolean>, what: string) => {
      try { if (await fn()) n++; }
      catch (e) { console.warn('Tự lưu hồ sơ', what, e); if (++fail >= 3 && n === 0) throw e; }   // lỗi liên tiếp (mất kết nối Drive): dừng
    };
    if (can.drivers) {
      const { data } = await supabase.from('staff_members').select('id, full_name').eq('is_active', true).eq('position', 'lai_xe');
      for (const s of (data ?? []) as { id: string; full_name: string }[]) {
        await step(async () => {
          const x = await loadDriverPaper(tenantId, s.id, me, base);
          const pages = driverPages(x);
          if (sigs.get(`llhn:${s.id}`) === paperSig(pages)) return false;
          await saveDriverPaper(x, pages);
          return true;
        }, `lý lịch hành nghề ${s.full_name}`);
      }
    }
    if (can.vehicles) {
      const { data } = await supabase.from('vehicles').select('id, plate').eq('is_active', true);
      for (const v of (data ?? []) as { id: string; plate: string }[]) {
        await step(async () => {
          const x = await loadVehiclePaper(tenantId, v.id, me, base);
          const pages = vehiclePages(x);
          if (sigs.get(`llpt:${v.id}`) === paperSig(pages)) return false;
          await saveVehiclePaper(x, pages);
          return true;
        }, `lý lịch phương tiện ${v.plate}`);
      }
    }
    if (can.contracts) {
      const year = new Date(Date.now() + 7 * 3600_000).getUTCFullYear();   // năm theo giờ VN
      const { data } = await supabase.from('labor_contracts').select(CONTRACT_COLS).eq('year', year).eq('status', 'hieu_luc').order('seq');
      for (const k of (data ?? []) as Contract[]) {
        // hồ sơ nhân viên đổi (tên, CCCD, địa chỉ…) thì nội dung hợp đồng đổi → lưu đè; không đổi thì 'same', bỏ qua
        await step(async () => (await saveContractPdf(k, await loadLaborCtx(tenantId, me, k.staff_id))) === 'saved', `hợp đồng ${k.number}`);
      }
    }
    if (can.cv) {
      const { data } = await supabase.from('staff_members').select('id, full_name').eq('is_active', true);
      const avas = await avatarUrls(tenantId).catch(() => ({} as Record<string, string>));
      for (const s of (data ?? []) as { id: string; full_name: string }[]) {
        await step(async () => {
          const pages = await staffCvPages(tenantId, s.id, me, avas[s.id] ?? null);
          const sig = paperSig(pages);
          if (sigs.get(`syll:${s.id}`) === sig) return false;
          await savePdf([vnYear(), '02. Nhân sự', 'Sơ yếu lý lịch'], `Sơ yếu lý lịch · ${s.full_name}`, `SYLL_${slug(s.full_name)}.pdf`, pages, `Sơ yếu lý lịch nhân viên · sig:${sig}`, `syll:${s.id}`);
          return true;
        }, `sơ yếu lý lịch ${s.full_name}`);
      }
    }
    if (can.docs) {
      const { data } = await supabase.from('official_docs').select('id, template, code, year, seq, number, signed_on, title, staff_id, content, status, cancel_reason, created_at').eq('status', 'hieu_luc');
      for (const d of (data ?? []) as OfficialDoc[]) await step(async () => saveDocPdf(d, await loadDocCtx(tenantId, me, d.staff_id), sigs), `văn bản ${d.number}`);
    }
    if (can.leases) {
      const { data } = await supabase.from('vehicle_leases').select(LEASE_COLS);
      for (const k of (data ?? []) as unknown as Lease[]) {
        await step(async () => archiveLeasePdf(k, await loadLeaseCtx(tenantId, me, k.items.map((i) => i.vehicle_id), k.id), sigs), `hợp đồng thuê xe ${k.number}`);
      }
    }
    if (can.pay) {
      const { data } = await supabase.from('staff_pay_months').select('month');
      const months = [...new Set(((data ?? []) as { month: string }[]).map((r) => r.month.slice(0, 7)))].sort();
      for (const m of months) {
        await step(async () => {
          const pages = [{ html: await payMonthHtml(tenantId, me, m), land: false }];
          const sig = paperSig(pages);
          if (sigs.get(`bhxh:${m}`) === sig) return false;
          const [y, mo] = m.split('-');
          await savePdf([y!, 'Tài chính - Kế toán', 'BHXH & lương chuyển khoản'], `BHXH và lương chuyển khoản tháng ${mo}/${y}`, `BHXH-LuongCK-${m}.pdf`, pages, `Bảng tháng ${mo}/${y} · sig:${sig}`, `bhxh:${m}`);
          return true;
        }, `BHXH tháng ${m}`);
      }
    }
    if (can.repairs) {
      // Phiếu nhiều: chỉ dựng phiếu chưa lưu hoặc đã sửa sau lần lưu gần nhất
      const saved = new Map(((await fetchAll<{ note: string | null; created_at: string }>(() => supabase.from('archive_items').select('note, created_at').eq('is_old', false)
        .like('note', '%[psc:%').order('id'))) ?? []).map((r) => [/\[psc:([0-9a-f-]+)\]/.exec(r.note ?? '')?.[1] ?? '', r.created_at]));
      const orders = await fetchAll<{ id: string; code: string; vehicle_id: string; driver_id: string | null; repaired_on: string; odo_km: number | null; workshop: string | null; note: string | null; created_by: string | null; updated_at: string }>(
        () => supabase.from('repair_orders').select('id, code, vehicle_id, driver_id, repaired_on, odo_km, workshop, note, created_by, updated_at').order('id'));
      const todo = orders.filter((o) => !saved.has(o.id) || o.updated_at > saved.get(o.id)!);
      if (todo.length) {
        const { data: vs } = await supabase.from('vehicles').select('id, plate');
        const plates = new Map(((vs ?? []) as { id: string; plate: string }[]).map((v) => [v.id, v.plate]));
        for (const o of todo) {
          await step(async () => {
            const { data: its } = await supabase.from('repair_items').select('content, unit, qty, unit_price').eq('order_id', o.id).order('seq');
            const plate = plates.get(o.vehicle_id) ?? '';
            const html = await repairPaperHtml({ ...o, plate, items: ((its ?? []) as { content: string; unit: string | null; qty: number; unit_price: number }[]) }, tenantId, me);
            const [y, m, d] = o.repaired_on.split('-');
            await savePdf([y!, '03. Phương tiện', 'Sửa chữa', `Tháng ${m}-${y}`], `Phiếu sửa chữa ${o.code} · ${plate} · ${d}/${m}/${y}`, `${slug(o.code)}_${slug(plate)}.pdf`,
              [{ html, land: false }], 'Phiếu sửa chữa phương tiện', `psc:${o.id}`);
            return true;
          }, `phiếu sửa chữa ${o.code}`);
        }
      }
    }
    return n;
  } finally {
    running = false;
    if (again) { again = false; setTimeout(() => void autoArchiveProfiles(tenantId, me, can).catch(() => undefined), 5_000); }
  }
}

const vnYear = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 4);
const slug = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
const esc = (t: unknown) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const num = (v: number) => v.toLocaleString('vi-VN');
/** Bảng BHXH & lương chuyển khoản 1 tháng – cùng mẫu với nút "Lưu vào hồ sơ" ở Cấu hình › BHXH & lương chuyển khoản */
async function payMonthHtml(tenantId: string, me: { id: string | null; name: string }, month: string): Promise<string> {
  const [s, p, c, b] = await Promise.all([
    supabase.from('staff_members').select('id, full_name, is_active, left_on, joined_on'),
    supabase.from('staff_pay_months').select('staff_id, has_bhxh, transfer_pay, bhxh_pay').eq('month', `${month}-01`),
    company(), boss(tenantId, me),
  ]);
  const rows = new Map(((p.data ?? []) as { staff_id: string; has_bhxh: boolean; transfer_pay: number; bhxh_pay: number }[]).map((r) => [r.staff_id, r]));
  const end = `${month}-31`;
  const list = ((s.data ?? []) as { id: string; full_name: string; is_active: boolean; left_on: string | null; joined_on: string }[])
    .filter((x) => x.joined_on <= end && (x.is_active || (x.left_on && x.left_on >= `${month}-01`))).sort((a, b2) => a.full_name.localeCompare(b2.full_name, 'vi'));
  const val = (id: string) => { const r = rows.get(id); return { has_bhxh: !!r?.has_bhxh, transfer_pay: Number(r?.transfer_pay ?? 0), bhxh_pay: Number(r?.bhxh_pay ?? 0) }; };
  const tot = list.reduce((a, x) => { const v = val(x.id); return { n: a.n + (v.has_bhxh ? 1 : 0), ck: a.ck + v.transfer_pay, ml: a.ml + (v.has_bhxh ? v.bhxh_pay : 0) }; }, { n: 0, ck: 0, ml: 0 });
  const [y, mo] = month.split('-');
  const td = (v: string, al = '') => `<td style="border:1px solid #000;padding:3px 6px;${al ? `text-align:${al}` : ''}">${v}</td>`;
  const th = (v: string) => `<th style="border:1px solid #000;padding:4px 6px;background:#e2e8f0">${v}</th>`;
  const t = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  return `<div style="font-size:13px">${head(c)}<h2 style="text-align:center;margin:12px 0 2px;font-size:18px">BẢNG ĐÓNG BHXH VÀ LƯƠNG CHUYỂN KHOẢN</h2>
    <div style="text-align:center;margin-bottom:8px">Tháng <b>${mo}/${y}</b> · ${esc(c.name)}</div>
    <table style="width:100%;border-collapse:collapse"><tr>${th('STT')}${th('Tháng')}${th('Tên nhân viên')}${th('Đóng BHXH')}${th('Lương chuyển khoản')}${th('Bảo hiểm xã hội')}</tr>
    ${list.map((x, i) => { const v = val(x.id); return `<tr>${td(String(i + 1), 'center')}${td(`${mo}/${y}`, 'center')}${td(esc(x.full_name))}${td(v.has_bhxh ? '☒ Có' : '☐ Không', 'center')}${td(num(v.transfer_pay), 'right')}${td(num(v.bhxh_pay), 'right')}</tr>`; }).join('')}
    <tr style="font-weight:bold">${td('')}${td('Tổng cộng')}${td('')}${td(`${tot.n} người`, 'center')}${td(num(tot.ck), 'right')}${td(num(tot.ml), 'right')}</tr></table>
    <p style="text-align:right;margin:12px 0 4px;font-style:italic">Ngày ${t.slice(8)} tháng ${t.slice(5, 7)} năm ${t.slice(0, 4)}</p>
    <table style="width:100%;border-collapse:collapse"><tr>${signCol('NGƯỜI LẬP BẢNG', '(Ký tên)', signImg(b.b.me), b.b.meName, b.b.me, 33)}${signCol('KẾ TOÁN TRƯỞNG', '(Ký tên)', '', '', null, 33)}${bossCol(b.b, 'GIÁM ĐỐC', 34)}</tr></table></div>`;
}

/** Báo "dữ liệu hồ sơ vừa đổi" (sau khi lưu hồ sơ, giấy tờ, lý lịch, xe…): máy đang mở app sẽ tự cập nhật PDF sau ít giây */
export const profileChanged = () => window.dispatchEvent(new Event('tms-hs-doi'));
