// Vé Vexere (dữ liệu trang Đặt vé của Vexere) → dòng gửi hàm sync_vexere_tickets.
// Gói dán vào ô "Nhập lịch Vexere": {"tms":"vexere_ve","ngay":"yyyy-mm-dd","chuyen":[{"tuyen","gio","ve":[VxRaw…]}]}

/** Một vé Vexere như trang Đặt vé tải về (giữ nguyên chuỗi gốc) */
export interface VxRaw {
  id: string;          // Id vé
  ghe: string;         // SeatCode "A5|1|5|1" = ký hiệu | tầng | hàng | cột
  kh: string;          // CustomerInfo "…|…|…|Tên|SĐT|…"
  st: number;          // Status: 1 đặt chỗ, 2 đã thanh toán, khác = hủy
  gia?: number | null; // Fare
  coc?: number | null; // Deposit
  isdep?: number | null; // IsDeposit
  ghi?: string | null; // Note
  tu?: string | null;  // FromArea "1~155972|16|BXBH|Bến xe Biên Hòa"
  den?: string | null; // ToArea
}
export interface VxTrip { tuyen: string; gio: string; ve: VxRaw[] }
export interface VxPayload { tms: 'vexere_ve'; ngay: string; chuyen: VxTrip[] }

export interface SyncTicket {
  id: string; ghe: string; tang?: string; hang?: string; cot?: string; tt: 'tt' | 'coc' | 'giu' | 'huy';
  gia?: string; coc?: string; ten?: string; sdt?: string; ghi_chu?: string; tu_ma?: string; tu_ten?: string; den_ma?: string; den_ten?: string;
}

/** Đọc gói vé Vexere; không phải gói vé thì trả null */
export function parseVxPayload(raw: string): VxPayload | null {
  const s = raw.trim();
  if (!s.startsWith('{') || !s.includes('vexere_ve')) return null;
  try {
    const j = JSON.parse(s) as Partial<VxPayload>;
    if (j.tms !== 'vexere_ve' || !/^\d{4}-\d{2}-\d{2}$/.test(String(j.ngay)) || !Array.isArray(j.chuyen)) return null;
    const chuyen = j.chuyen.filter((c): c is VxTrip => !!c && typeof c.tuyen === 'string' && /^\d{1,2}:\d{2}$/.test(String(c.gio)) && Array.isArray(c.ve))
      .map((c) => ({ ...c, gio: c.gio.padStart(5, '0') }));
    return { tms: 'vexere_ve', ngay: j.ngay as string, chuyen };
  } catch {
    return null;
  }
}

const part = (s: string | null | undefined, i: number) => (s ?? '').split('|')[i]?.trim() ?? '';
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? String(Math.round(v)) : undefined);

export function vxStatus(v: VxRaw): SyncTicket['tt'] {
  if (v.st === 2) return 'tt';
  if (v.st === 1) return v.isdep === 1 || (v.coc ?? 0) > 0 ? 'coc' : 'giu';
  return 'huy';
}

export function toSyncTicket(v: VxRaw): SyncTicket {
  const area = (a: string | null | undefined) => ({ ma: part(a, 2), ten: part(a, 3) });
  const tu = area(v.tu), den = area(v.den);
  return {
    id: String(v.id), ghe: part(v.ghe, 0), tang: part(v.ghe, 1) || undefined, hang: part(v.ghe, 2) || undefined, cot: part(v.ghe, 3) || undefined,
    tt: vxStatus(v), gia: num(v.gia), coc: num(v.coc), ten: part(v.kh, 3) || undefined, sdt: part(v.kh, 4) || undefined,
    ghi_chu: v.ghi?.trim() || undefined, tu_ma: tu.ma || undefined, tu_ten: tu.ten || undefined, den_ma: den.ma || undefined, den_ten: den.ten || undefined,
  };
}
