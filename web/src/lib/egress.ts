// TẠM THỜI – đo lượng dữ liệu đọc từ database để so trước/sau khi tối ưu băng thông. Gỡ sau khi đo xong.
// Xem trong Console trình duyệt: tự in mỗi 5 phút, hoặc gõ tmsEgress() để in ngay.
type Row = { lan: number; dong: number; kb: number };
const tot: Record<string, Row> = {};
const since = Date.now();

function size(data: unknown): number {
  try { return JSON.stringify(data ?? null).length; } catch { return 0; }
}

/** Ghi 1 lần đọc: nhãn (màn hình/việc), dữ liệu trả về */
export function meter(label: string, data: unknown): void {
  const r = (tot[label] ??= { lan: 0, dong: 0, kb: 0 });
  r.lan += 1;
  r.dong += Array.isArray(data) ? data.length : data == null ? 0 : 1;
  r.kb += size(data) / 1024;
}

function report(): void {
  const keys = Object.keys(tot);
  if (!keys.length) return;
  const min = Math.max(1, Math.round((Date.now() - since) / 60000));
  console.info(`[đo băng thông] ${min} phút qua (KB là cỡ dữ liệu chưa nén)`);
  console.table(Object.fromEntries(keys.map((k) => [k, { 'số lần': tot[k]!.lan, 'số dòng': tot[k]!.dong, KB: Math.round(tot[k]!.kb * 10) / 10 }])));
}

if (typeof window !== 'undefined') {
  (window as unknown as { tmsEgress: () => void }).tmsEgress = report;
  setInterval(report, 5 * 60_000);
}
