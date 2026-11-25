// Báo điều hành khi lái xe gửi phiếu đổ dầu qua app (như app cũ): hiện góc màn hình, tự ẩn sau 20 giây, mỗi phiếu báo 1 lần trên máy.
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface Row { id: string; plate: string; liters: number; amount: number | null; unit_price: number; created_at: string; staff_id: string }
const num = (n: number, d = 0) => n.toLocaleString('vi-VN', { maximumFractionDigits: d });

export function FuelReportAlert({ tenantId, onOpen }: { tenantId: string; onOpen: () => void }) {
  const [list, setList] = useState<{ r: Row; who: string }[]>([]);
  const [wait, setWait] = useState(0);
  useEffect(() => {
    let stop = false;
    const key = `bao-dau.seen:${tenantId}`;
    const check = async () => {
      const q = await supabase.from('fuel_reports').select('id, plate, liters, amount, unit_price, created_at, staff_id').eq('status', 'cho').order('created_at');
      if (stop || q.error) return;
      const rows = (q.data ?? []) as Row[];
      let seen: string | null = null;
      try { seen = localStorage.getItem(key); } catch { /* trình duyệt chặn lưu: vẫn báo */ }
      const fresh = rows.filter((r) => !seen || r.created_at > seen);
      if (rows.length) try { localStorage.setItem(key, rows[rows.length - 1]!.created_at); } catch { /* bỏ qua */ }
      if (!fresh.length) return;
      const ids = [...new Set(fresh.map((r) => r.staff_id))];
      const s = await supabase.from('staff_members').select('id, full_name').in('id', ids);
      const names = new Map(((s.data ?? []) as { id: string; full_name: string }[]).map((x) => [x.id, x.full_name]));
      if (stop) return;
      setWait(rows.length);
      setList(fresh.map((r) => ({ r: { ...r, liters: Number(r.liters) }, who: names.get(r.staff_id) ?? 'Lái xe' })));
    };
    void check();
    const iv = window.setInterval(() => { if (!document.hidden) void check(); }, 120_000);
    return () => { stop = true; window.clearInterval(iv); };
  }, [tenantId]);
  useEffect(() => { if (!list.length) return; const t = window.setTimeout(() => setList([]), 20_000); return () => window.clearTimeout(t); }, [list]);
  if (!list.length) return null;
  const x = list[list.length - 1]!, tien = x.r.amount ?? Math.round(x.r.liters * x.r.unit_price);
  return (
    <div className="gdn-push" role="status">
      <div className="gdn-ph"><div><small>Thông báo · lái xe báo đổ dầu</small>
        <b>{x.who} báo đổ dầu xe {x.r.plate}: {num(x.r.liters, 3)} lít{tien ? `, ${num(tien)} đồng` : ''}</b>
        <span>Đang chờ duyệt{wait > 1 ? ` · tổng ${wait} phiếu chờ duyệt` : ''}</span></div>
        <button type="button" className="btn small link" aria-label="Đóng thông báo đổ dầu" onClick={() => setList([])}>✕</button></div>
      <div className="gdn-pf"><button type="button" className="btn small" onClick={() => setList([])}>Để sau</button>
        <button type="button" className="btn small primary" onClick={() => { setList([]); onOpen(); }}>Xem, duyệt</button></div>
    </div>
  );
}
