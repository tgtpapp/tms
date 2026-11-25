// In máy in nhiệt (vé, phiếu gửi hàng, phiếu dầu) như app cũ: mỗi phiếu 1 trang riêng, khổ rộng theo cuộn giấy (80 / 58mm),
// chiều dài vừa đúng nội dung của chính phiếu đó (đo thật trên màn hình) → không kéo giấy thừa, không trang trắng.
// Lề trang 0 nên trình duyệt không in ngày giờ / tiêu đề / địa chỉ web; lề an toàn cho đầu in là phần đệm của phiếu.
// Cấu hình (tự động / chiều dài cố định, lề, cỡ chữ) lưu riêng trên từng máy (trình duyệt không nhận ra từng máy in).

export interface ThermalCfg { mode: 'auto' | 'manual'; len: number; margin: 'hep' | 'vua' | 'rong'; font: 'nho' | 'vua' | 'lon' }
const KEY = 'tms.in_nhiet';
export const THERMAL_DEF: ThermalCfg = { mode: 'auto', len: 0, margin: 'vua', font: 'vua' };
export function readThermalCfg(): ThermalCfg {
  try { return { ...THERMAL_DEF, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ThermalCfg>) }; } catch { return THERMAL_DEF; }
}
export function saveThermalCfg(c: ThermalCfg): void {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* trình duyệt chặn lưu: chỉ áp dụng lần này */ }
}

const PAD = { hep: 1.5, vua: 3, rong: 4 } as const;              // mm – không dưới 1,5mm để chữ không ra ngoài vùng in
const FONT = { nho: [11, 10], vua: [12, 10.5], lon: [13.5, 11.5] } as const;   // px [K80, K58] – không nhỏ hơn 10px cho dễ đọc
const CUT = 2;                                                   // mm thêm cuối phiếu cho dao cắt

/** Áp cấu hình (lề, cỡ chữ) lên danh sách phiếu đang xem */
export function applyThermalCfg(list: HTMLElement, c: ThermalCfg): void {
  list.style.setProperty('--ve-pad', `${PAD[c.margin]}mm`);
  list.style.setProperty('--ve-fs', `${FONT[c.font][0]}px`);
  list.style.setProperty('--ve-fs58', `${FONT[c.font][1]}px`);
}

const mmOf = (px: number) => (px * 25.4) / 96;
export const lastList = () => [...document.querySelectorAll<HTMLElement>('.ve-list')].pop() ?? null;
export const paperWidth = (list: HTMLElement) => (list.classList.contains('w58') ? 58 : 80);

/** Chiều dài giấy (mm) của từng phiếu: đo nội dung thật; chế độ thủ công lấy chiều dài cố định nhưng không bao giờ ngắn hơn nội dung */
export function slipLengths(list: HTMLElement, c: ThermalCfg = readThermalCfg()): number[] {
  return [...list.querySelectorAll<HTMLElement>(':scope > .ve')].map((el) => {
    const need = Math.max(30, Math.ceil(mmOf(el.getBoundingClientRect().height)) + CUT);
    return c.mode === 'manual' && c.len > 0 ? Math.max(c.len, need) : need;
  });
}

export function printThermal(): void {
  const list = lastList();
  const slips = list ? [...list.querySelectorAll<HTMLElement>(':scope > .ve')] : [];
  if (!list || !slips.length) { window.print(); return; }
  const c = readThermalCfg();
  applyThermalCfg(list, c);
  const w = paperWidth(list), lens = slipLengths(list, c);
  const rules = slips.map((el, i) => {
    el.classList.add(`tpg${i}`);
    return `.ve.tpg${i}{page:tpg${i}} @page tpg${i}{size:${w}mm ${lens[i]}mm;margin:0}`;
  }).join('\n');
  const st = document.createElement('style');
  st.textContent = `
@media print {
  body.thermal-printing *:not(:has(.ve-list)):not(.ve-list):not(.ve-list *) { display: none !important; }
  body.thermal-printing, body.thermal-printing *:has(.ve-list) { display: block !important; position: static !important; margin: 0 !important; padding: 0 !important;
    border: 0 !important; width: auto !important; height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important;
    background: #fff !important; box-shadow: none !important; transform: none !important; }
  body.thermal-printing .ve-list { position: static !important; display: block !important; width: auto !important; padding: 0 !important; margin: 0 !important; visibility: visible !important; gap: 0 !important; }
  body.thermal-printing .ve-list .ve { margin: 0 auto !important; border: 0 !important; box-shadow: none !important; break-after: page; page-break-after: always; break-inside: auto; }
  body.thermal-printing .ve-list .ve:last-child { break-after: auto; page-break-after: auto; }
}
${rules}`;
  document.head.appendChild(st);
  document.body.classList.add('thermal-printing');
  let done = false;
  const clean = () => {
    if (done) return;
    done = true;
    document.body.classList.remove('thermal-printing');
    st.remove();
    slips.forEach((el, i) => el.classList.remove(`tpg${i}`));
    window.removeEventListener('afterprint', clean);
  };
  window.addEventListener('afterprint', clean);
  window.print();
  setTimeout(clean, 60_000);   // trình duyệt không báo đã in xong
}
