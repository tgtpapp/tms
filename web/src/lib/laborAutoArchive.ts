// Sang năm mới máy chủ tự lập hợp đồng lao động năm mới cho mọi nhân viên (như app cũ).
// PDF phải vẽ trên trình duyệt, nên máy của người có quyền xem tất cả hợp đồng + lưu hồ sơ tự tạo PDF
// các hợp đồng năm nay còn thiếu trong Lưu trữ hồ sơ (chạy ngầm, mỗi lần mở app 1 lần, bỏ qua bản đã có).
import { CONTRACT_COLS } from '../components/ContractEditor';
import { resetFolders } from './dispatchPapers';
import { loadLaborCtx, saveContractPdf, type Contract } from './laborContract';
import { supabase } from './supabase';

let running = false;
export async function archiveMissingContracts(tenantId: string, me: { id: string | null; name: string }): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const year = new Date(Date.now() + 7 * 3600_000).getUTCFullYear();   // năm theo giờ VN
    const { data: ks } = await supabase.from('labor_contracts').select(CONTRACT_COLS).eq('year', year).eq('status', 'hieu_luc').order('seq');
    const list = (ks ?? []) as Contract[];
    if (!list.length) return 0;
    const { data: items } = await supabase.from('archive_items').select('note').eq('is_old', false).like('note', `%[hdld:%:${year}]%`);
    const have = new Set(((items ?? []) as { note: string | null }[]).map((r) => /\[hdld:([0-9a-f-]+):\d{4}\]/.exec(r.note ?? '')?.[1]).filter(Boolean));
    const miss = list.filter((k) => !have.has(k.staff_id));
    let n = 0, fail = 0;
    resetFolders();
    for (const k of miss) {
      try { if (await saveContractPdf(k, await loadLaborCtx(tenantId, me, k.staff_id)) === 'saved') n++; }
      catch (e) { console.warn('Tự lưu PDF hợp đồng', k.number, e); if (++fail >= 3 && n === 0) break; }   // chưa kết nối Drive: dừng, không thử hết từng người
    }
    return n;
  } finally { running = false; }
}
