// Giá bán lẻ xăng dầu Petrolimex vùng 1 (như app cũ): tự cập nhật 2 lần / ngày, nhà xe nhập tay được.
import { supabase } from './supabase';

export const MK = ['DO 0,05S-II', 'DO 0,001S-V', 'E5 RON92-II', 'E10 RON95-III'] as const;
/** Loại nhiên liệu của nhà xe → mặt hàng niêm yết */
export const mkKey = (t: string | null | undefined) => {
  const s = String(t ?? '').toLowerCase();
  return /0[,.]001/.test(s) ? 'DO 0,001S-V' : /\bdo\b|dầu|diesel/.test(s) ? 'DO 0,05S-II' : /e5|92/.test(s) ? 'E5 RON92-II' : /e10|95/.test(s) ? 'E10 RON95-III' : '';
};
export interface Market { gia: Record<string, number>; truoc: Record<string, number>; hieuLuc: string; capNhat: string; tay: boolean; source: string }
interface Manual { gia: Record<string, number>; truoc: Record<string, number>; hieu_luc: string; cap_nhat: string }

/** Giá đang dùng: bản tự cập nhật mới nhất, trừ khi giá nhập tay mới hơn. */
export async function loadMarket(): Promise<Market | null> {
  const [a, s] = await Promise.all([
    supabase.from('fuel_market_prices').select('effective_at, prices, prev, source, checked_at').order('effective_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('fuel_settings').select('market_manual').maybeSingle(),
  ]);
  const auto = a.data as { effective_at: string; prices: Record<string, number>; prev: Record<string, number>; source: string | null; checked_at: string } | null;
  const man = (s.data as { market_manual: Manual | null } | null)?.market_manual ?? null;
  if (man && (!auto || Date.parse(man.cap_nhat) > Date.parse(auto.checked_at))) return { gia: man.gia, truoc: man.truoc ?? {}, hieuLuc: man.hieu_luc, capNhat: man.cap_nhat, tay: true, source: 'Petrolimex' };
  if (!auto) return null;
  return { gia: auto.prices, truoc: auto.prev ?? {}, hieuLuc: auto.effective_at, capNhat: auto.checked_at, tay: false, source: auto.source ?? 'Petrolimex' };
}
export const mkPrice = (m: Market | null, fuelType: string | null | undefined) => (m ? Number(m.gia[mkKey(fuelType)]) || 0 : 0);
export const mkWhen = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false })} ${d.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
};
/** Danh sách mặt hàng có giá, kèm chênh lệch so với giá trước */
export const mkChanges = (m: Market | null, fuelType?: string | null) => {
  if (!m) return [];
  const my = mkKey(fuelType);
  return MK.map((k) => { const p = Number(m.gia[k]) || 0, o = Number(m.truoc[k]) || 0; return { k, p, o, df: p && o ? p - o : 0, my: k === my }; }).filter((x) => x.p);
};
export const mkSig = (m: Market | null) => (m ? `${m.hieuLuc}|${MK.map((k) => m.gia[k] ?? 0).join(',')}` : '');
