// Sổ nhiên liệu (như app cũ): tồn bồn sau từng phiếu, giá bình quân gia quyền di động, tiêu hao L/100km từng lần đổ.
export type FuelKind = 'nhap' | 'bon' | 'ngoai';
export interface FuelEntry {
  id: string; code: string; kind: FuelKind; entry_date: string; entry_time: string | null; vehicle_id: string | null; driver_id: string | null;
  odo_km: number | null; liters: number; unit_price: number | null; supplier: string | null; invoice_no: string | null; note: string | null; files: string[];
  market_price?: boolean;
}
export interface FuelSettings { tank_name: string; fuel_type: string; capacity_l: number; opening_l: number; opening_price: number; opening_on: string | null; alert_l: number; issue_price_mode: 'tt' | 'bq' }
export interface FuelRow { tank: number; avg: number; price: number; amount: number; km: number; per100: number }

export const FUEL_KIND: Record<FuelKind, { label: string; short: string }> = {
  nhap: { label: 'Nhập dầu vào bồn', short: 'Nhập bồn' },
  bon: { label: 'Cấp dầu từ bồn', short: 'Cấp từ bồn' },
  ngoai: { label: 'Đổ ngoài cây xăng', short: 'Đổ ngoài' },
};
export const DEFAULT_FUEL: FuelSettings = { tank_name: 'Bồn dầu công ty', fuel_type: 'Dầu DO 0,05S', capacity_l: 5000, opening_l: 0, opening_price: 0, opening_on: null, alert_l: 500, issue_price_mode: 'tt' };

export const fuelSort = (a: FuelEntry, b: FuelEntry) =>
  a.entry_date.localeCompare(b.entry_date) || (a.entry_time ?? '').localeCompare(b.entry_time ?? '') || a.code.localeCompare(b.code);

/** Tính sổ: trả về từng phiếu (theo id) + tồn cuối + giá bình quân cuối. Phiếu trước ngày tồn đầu kỳ không tính vào bồn. */
export function fuelLedger(list: FuelEntry[], s: FuelSettings) {
  const L = list.slice().sort(fuelSort);
  let tank = Number(s.opening_l) || 0, avg = Number(s.opening_price) || 0;
  const map = new Map<string, FuelRow>();
  const lastKm = new Map<string, number>();
  for (const r of L) {
    const lit = Number(r.liters) || 0;
    const inTank = !s.opening_on || r.entry_date >= s.opening_on;
    let price = Number(r.unit_price) || 0;
    if (r.kind === 'nhap') {
      if (inTank) {
        const base = Math.max(0, tank);
        avg = base + lit > 0 ? (base * avg + lit * price) / (base + lit) : price;
        tank += lit;
      }
    } else if (r.kind === 'bon') {
      if (r.unit_price == null || !price) price = avg;
      if (inTank) tank -= lit;
    }
    let km = 0, per100 = 0;
    if (r.kind !== 'nhap' && r.vehicle_id && r.odo_km) {
      const pv = lastKm.get(r.vehicle_id);
      if (pv && r.odo_km > pv) { km = r.odo_km - pv; per100 = (lit / km) * 100; }
      lastKm.set(r.vehicle_id, r.odo_km);
    }
    map.set(r.id, { tank, avg, price, amount: Math.round(lit * price), km, per100 });
  }
  return { map, tank, avg, list: L };
}

/** Màu tiêu hao so với định mức: vượt >10% đỏ, vượt nhẹ vàng, đạt xanh. */
export function normLevel(per100: number, norm: number | null): 'bad' | 'warn' | 'ok' | 'none' {
  if (!per100 || !norm) return 'none';
  return per100 > norm * 1.1 ? 'bad' : per100 > norm ? 'warn' : 'ok';
}
