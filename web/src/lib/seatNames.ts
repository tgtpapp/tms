// Tên ghế hiện cho người dùng (cả nhà xe chọn 1 kiểu, Admin chọn trong sơ đồ ghế):
//  - 'so'     : số thứ tự 1, 2, 3… đánh từ trên xuống dưới, trái sang phải (như app cũ) — mặc định
//  - 'chu_so' : đúng tên ghế đã lưu (vd A2, B1 — chép từ Vexere)
// Trong database tên ghế giữ nguyên (để nhập vé Vexere khớp đúng ghế); chỉ đổi cách HIỆN.
import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase';

export type SeatStyle = 'so' | 'chu_so';
export const SEAT_STYLE_KEY = 'ban_ve.kieu_ten_ghe';
export type Namer = (label: string) => string;
const same: Namer = (l) => l;

interface Store { style: SeatStyle; byType: Map<string, Map<string, number>>; vehType: Map<string, string>; plateType: Map<string, string> }
let store: Store = { style: 'so', byType: new Map(), vehType: new Map(), plateType: new Map() };
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();

/** Số thứ tự của từng ghế / giường (không tính ô tài xế, cửa) trong 1 sơ đồ: tầng → hàng → cột */
export function seatNumbers(seats: { label: string; deck: number; row_no: number; col_no: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  [...seats].sort((a, b) => a.deck - b.deck || a.row_no - b.row_no || a.col_no - b.col_no).forEach((s, i) => m.set(s.label, i + 1));
  return m;
}

async function load(): Promise<void> {
  const [st, seats, veh] = await Promise.all([
    supabase.from('tenant_settings').select('value').eq('key', SEAT_STYLE_KEY).maybeSingle(),
    supabase.from('vehicle_type_seats').select('vehicle_type_id, label, deck, row_no, col_no').in('kind', ['ghe', 'giuong']).limit(5000),   // bỏ ô tài xế, cửa
    supabase.from('vehicles').select('id, plate, vehicle_type_id').limit(2000),
  ]);
  const by = new Map<string, { label: string; deck: number; row_no: number; col_no: number }[]>();
  for (const s of (seats.data ?? []) as { vehicle_type_id: string; label: string; deck: number; row_no: number; col_no: number }[]) {
    const l = by.get(s.vehicle_type_id) ?? []; l.push(s); by.set(s.vehicle_type_id, l);
  }
  const vs = (veh.data ?? []) as { id: string; plate: string | null; vehicle_type_id: string | null }[];
  store = {
    style: st.data?.value === 'chu_so' ? 'chu_so' : 'so',
    byType: new Map([...by].map(([k, l]) => [k, seatNumbers(l)])),
    vehType: new Map(vs.filter((v) => v.vehicle_type_id).map((v) => [v.id, v.vehicle_type_id!])),
    plateType: new Map(vs.filter((v) => v.plate && v.vehicle_type_id).map((v) => [v.plate!, v.vehicle_type_id!])),
  };
  subs.forEach((f) => f());
}
/** Tải lại (sau khi đổi kiểu tên ghế / sửa sơ đồ ghế) */
export function reloadSeatNames(): Promise<void> { loading = load().catch(() => undefined); return loading; }

function namerOf(typeId: string | null | undefined): Namer {
  if (store.style === 'chu_so' || !typeId) return same;
  const m = store.byType.get(typeId);
  return m ? (l) => (m.has(l) ? String(m.get(l)) : l) : same;
}

/** Cách hiện tên ghế theo loại xe / xe / biển số (tự cập nhật khi Admin đổi kiểu) */
export function useSeatNames() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subs.add(f);
    if (!loading) void reloadSeatNames();
    return () => { subs.delete(f); };
  }, []);
  return {
    style: store.style,
    byType: namerOf,
    byVehicle: (id: string | null | undefined) => namerOf(id ? store.vehType.get(id) : null),
    byPlate: (plate: string | null | undefined) => namerOf(plate ? store.plateType.get(plate) : null),
  };
}

/** Lưu kiểu tên ghế cho cả nhà xe (Admin) */
export async function saveSeatStyle(style: SeatStyle): Promise<void> {
  const { error } = await supabase.from('tenant_settings').upsert([{ key: SEAT_STYLE_KEY, value: style }], { onConflict: 'tenant_id,key' });
  if (error) throw new Error(error.message);
  await reloadSeatNames();
}

/** Tên ghế trong 1 chuyến (màn bán vé): các phần bên trong lấy bằng useSeatName() */
export const SeatNameCtx = createContext<Namer>(same);
export const useSeatName = () => useContext(SeatNameCtx);
/** So sánh để xếp theo tên ghế đang hiện (số thì theo số) */
export const bySeat = (sn: Namer) => (a: string, b: string) => sn(a).localeCompare(sn(b), 'vi', { numeric: true });
