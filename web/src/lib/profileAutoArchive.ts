// Tự cập nhật hồ sơ trong Lưu trữ hồ sơ: sửa bất kỳ thông tin nào (hồ sơ, giấy tờ, lý lịch, xe, chuyến, hợp đồng…) thì
// PDF đã lưu được dựng lại và LƯU ĐÈ đúng chỗ cũ trong cây thư mục; hồ sơ chưa có thì lưu mới.
//   <năm> / 02. Nhân sự / Lý lịch hành nghề        – mỗi lái xe đang làm 1 tệp      [llhn:<id>]
//   <năm> / 03. Phương tiện / Lý lịch phương tiện   – mỗi xe đang dùng 1 tệp         [llpt:<id>]
//   <năm> / Nhân sự / Hợp đồng lao động / <tên>     – hợp đồng năm nay đang hiệu lực [hdld:<id>:<năm>]
// Nội dung không đổi (so mã nội dung "sig" ghi trong ghi chú tệp) thì bỏ qua, không tải lên lại.
// PDF phải vẽ trên trình duyệt nên chạy ngầm trên máy người có quyền: sau khi mở app, khi vừa sửa dữ liệu, và định kỳ.
import { drive } from './drive';
import { resetFolders } from './dispatchPapers';
import { driverPages, loadDriverPaper, loadVehiclePaper, paperSig, saveDriverPaper, saveVehiclePaper, sharedBase, vehiclePages } from './profilePapers';
import { loadLaborCtx, saveContractPdf, type Contract } from './laborContract';
import { CONTRACT_COLS } from '../components/ContractEditor';
import { fetchAll, supabase } from './supabase';

export interface AutoCan { drivers: boolean; vehicles: boolean; contracts: boolean }
let running = false, again = false;

/** Dựng lại và lưu đè hồ sơ đã đổi / còn thiếu. Trả số tệp đã lưu. */
export async function autoArchiveProfiles(tenantId: string, me: { id: string | null; name: string }, can: AutoCan): Promise<number> {
  if (running) { again = true; return 0; }
  running = true;
  let n = 0;
  try {
    if (!can.drivers && !can.vehicles && !can.contracts) return 0;
    await drive({ action: 'ping' });   // chưa kết nối Google Drive thì dừng ngay, không dựng giấy
    resetFolders();
    const items = await fetchAll<{ note: string | null }>(() => supabase.from('archive_items').select('note').eq('is_old', false)
      .or('note.like.%[llhn:%,note.like.%[llpt:%').order('id'));
    const sigs = new Map<string, string>();
    for (const r of items) { const k = /\[(ll(?:hn|pt):[0-9a-f-]+)\]/.exec(r.note ?? '')?.[1]; if (k) sigs.set(k, /sig:([a-z0-9]+)/.exec(r.note ?? '')?.[1] ?? ''); }
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
    return n;
  } finally {
    running = false;
    if (again) { again = false; setTimeout(() => void autoArchiveProfiles(tenantId, me, can).catch(() => undefined), 5_000); }
  }
}

/** Báo "dữ liệu hồ sơ vừa đổi" (sau khi lưu hồ sơ, giấy tờ, lý lịch, xe…): máy đang mở app sẽ tự cập nhật PDF sau ít giây */
export const profileChanged = () => window.dispatchEvent(new Event('tms-hs-doi'));
