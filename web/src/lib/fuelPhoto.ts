// Đọc ảnh đổ dầu (trụ bơm, hóa đơn, biển số, đồng hồ km) bằng AI → số liệu phiếu. Dùng chung cho
// "Tạo phiếu từ ảnh" ở Nhiên liệu, lái xe "Báo đổ dầu" và ảnh chia sẻ từ Zalo vào app (như app cũ).
import { readByAI, safeName, type PreparedFile } from './documents';
import { putFile } from './fileStore';
import { today } from '../components/Documents';

export interface FuelRead { plate: string; liters: number; price: number; amount: number; date: string; time: string; km: string; supplier: string; invoice: string; warnings: string[] }

const numOf = (x: unknown) => Number(String(x ?? '').replace(/[^\d.,]/g, '').replace(',', '.').replace(/\.(?=.*\.)/g, '')) || 0;

/** AI đọc ảnh, sửa các lỗi đọc số hay gặp (thiếu dấu thập phân, giá đọc theo nghìn). */
export async function readFuelPhotos(files: PreparedFile[]): Promise<FuelRead> {
  const r = await readByAI('phieu_do_dau', files), v = r.fields;
  let lit = numOf(v.lit), gia = Number(v.don_gia) || 0;
  const tien = Number(v.thanh_tien) || 0;
  if (lit > 1000 && tien && gia && Math.abs((lit / 1000) * gia - tien) < Math.abs(lit * gia - tien)) lit /= 1000;   // 44737 đọc thiếu dấu → 44,737
  if (gia > 0 && gia < 1000) gia = Math.round(gia * 1000);                                                          // 26.82 → 26.820 đ
  if (!gia && lit && tien) gia = Math.round(tien / lit);
  if (!lit && gia && tien) lit = Math.round((tien / gia) * 1000) / 1000;
  return {
    plate: String(v['xe.bien_so'] ?? ''), liters: Math.round(lit * 1000) / 1000, price: gia, amount: tien || Math.round(lit * gia),
    date: typeof v.ngay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.ngay) ? v.ngay : today(),
    time: typeof v.gio === 'string' && /^\d{1,2}:\d{2}$/.test(v.gio) ? v.gio.padStart(5, '0') : '',
    km: v.km ? String(v.km) : '', supplier: String(v.cay_xang ?? ''), invoice: String(v.so_hd ?? ''), warnings: r.warnings ?? [],
  };
}

/** So biển số không phân biệt dấu gạch / chấm; AI đọc thiếu đầu biển thì so 5 số cuối. */
export const plateKey = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]/g, '');
export function matchPlate<T extends { plate: string }>(list: T[], raw: string): T | undefined {
  const k = plateKey(raw);
  if (k.length < 4) return undefined;
  return list.find((x) => plateKey(x.plate) === k) ?? list.find((x) => plateKey(x.plate).endsWith(k.slice(-5))) ?? list.find((x) => k.endsWith(plateKey(x.plate).slice(-5)));
}

/** Ảnh lái xe gửi: <nhà xe>/bao_dau/<hồ sơ lái xe>/… (chỉ chính lái xe tải lên, điều hành xem được).
    Tải song song các ảnh; mạng chập chờn thì thử lại cùng tên (ghi đè, không sinh tệp trùng); lỗi quyền / tệp hỏng thì báo ngay. */
export async function uploadReportPhotos(tenantId: string, staffId: string, plate: string, files: PreparedFile[]): Promise<string[]> {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  const base = `${safeName(plate) || 'XE'}_bao_dau_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${crypto.randomUUID().slice(0, 4)}`;
  return Promise.all(files.map(async (f, i) => {
    const path = `${tenantId}/bao_dau/${staffId}/${base}_${i + 1}.${f.ext}`;
    for (let t = 0; ; t++) {
      const error = await putFile(path, f.blob, f.mime).then(() => null, (e: unknown) => (e instanceof Error ? e : new Error(String(e))));
      if (!error) return path;
      if (t >= 2 || /quyền|không hợp lệ|lớn hơn|chưa đăng nhập/i.test(error.message)) throw new Error(`Chưa tải được ảnh lên: ${error.message}`);
      await new Promise((r) => setTimeout(r, 1500 * (t + 1)));   // sóng yếu ở cây xăng: thử lại
    }
  }));
}
