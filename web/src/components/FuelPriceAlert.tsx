// Thông báo khi giá dầu Petrolimex thay đổi (như app cũ): hiện góc màn hình, tự ẩn sau 20 giây, mỗi lần đổi giá báo 1 lần trên máy.
import { useEffect, useState } from 'react';
import { loadMarket, mkChanges, mkSig, mkWhen, type Market } from '../lib/fuelMarket';
import { supabase } from '../lib/supabase';

const num = (n: number) => Math.round(n).toLocaleString('vi-VN');
export function FuelPriceAlert({ tenantId, onOpen }: { tenantId: string; onOpen: () => void }) {
  const [m, setM] = useState<Market | null>(null);
  const [type, setType] = useState('');
  const [lit, setLit] = useState(0);
  const [on, setOn] = useState(false);
  useEffect(() => {
    let stop = false;
    const check = async () => {
      const mk = await loadMarket().catch(() => null);
      if (stop || !mk) return;
      const key = `gia-dau.seen:${tenantId}`, sig = mkSig(mk);
      let seen: string | null = null;
      try { seen = localStorage.getItem(key); localStorage.setItem(key, sig); } catch { /* trình duyệt chặn lưu: vẫn báo */ }
      if (seen === sig || seen === null) return;   // lần đầu máy này xem giá: chỉ ghi nhận, giá đổi lần sau mới báo
      const s = await supabase.from('fuel_settings').select('fuel_type').maybeSingle();
      const ft = (s.data as { fuel_type: string } | null)?.fuel_type ?? 'Dầu DO 0,05S';
      if (!mkChanges(mk, ft).some((c) => c.df)) return;
      const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const e = await supabase.from('fuel_entries').select('liters').neq('kind', 'nhap').gte('entry_date', from);
      if (stop) return;
      setM(mk); setType(ft); setLit(((e.data ?? []) as { liters: number }[]).reduce((a, r) => a + Number(r.liters), 0)); setOn(true);
    };
    void check();
    const iv = window.setInterval(() => void check(), 30 * 60_000);
    return () => { stop = true; window.clearInterval(iv); };
  }, [tenantId]);
  useEffect(() => { if (!on) return; const t = window.setTimeout(() => setOn(false), 20_000); return () => window.clearTimeout(t); }, [on]);
  if (!on || !m) return null;
  const L = mkChanges(m, type), my = L.find((c) => c.my && c.df) ?? L.find((c) => c.df);
  const title = my ? `${my.k} ${my.df > 0 ? 'tăng' : 'giảm'} ${num(Math.abs(my.df))} đ/lít` : 'Giá dầu thay đổi';
  const mine = L.find((c) => c.my && c.df), up = mine ? mine.df > 0 : L.some((c) => c.df > 0);
  return (
    <div className={`gdn-push ${up ? 'up' : 'dn'}`} role="status">
      <div className="gdn-ph"><div><small>Thông báo · giá Petrolimex vùng 1</small><b>{title}</b><span>Áp dụng từ {mkWhen(m.hieuLuc)}</span></div>
        <button type="button" className="btn small link" aria-label="Đóng thông báo giá dầu" onClick={() => setOn(false)}>✕</button></div>
      <div className="gdn-cs">{L.map((c) => (
        <div key={c.k} className={`gdn-c${c.my ? ' my' : ''}${c.df > 0 ? ' up' : c.df < 0 ? ' dn' : ''}`}><small>{c.k}{c.my ? ' · bồn công ty' : ''}</small><b>{num(c.p)}</b>
          <em>{c.df ? `${c.df > 0 ? '▲' : '▼'} ${num(Math.abs(c.df))}` : 'không đổi'}</em></div>))}</div>
      {mine && lit > 0 && <div className={`gdn-imp ${mine.df > 0 ? 'up' : 'dn'}`}>Theo lượng dầu đã cấp 30 ngày qua (<b>{lit.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} lít</b>), mỗi tháng công ty sẽ {mine.df > 0 ? 'chi thêm' : 'tiết kiệm'} khoảng <b>{num(Math.abs(lit * mine.df))} đ</b>.</div>}
      <div className="gdn-pf"><button type="button" className="btn small" onClick={() => setOn(false)}>Đã xem</button>
        <button type="button" className="btn small primary" onClick={() => { setOn(false); onOpen(); }}>Xem nhiên liệu</button></div>
    </div>
  );
}
