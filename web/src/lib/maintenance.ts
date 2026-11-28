// Kế hoạch bảo dưỡng xe: hạn theo km hoặc theo tháng, cái nào đến trước thì nhắc trước.
// Lần gần nhất = phiếu sửa chữa loại "Bảo dưỡng" mới nhất; km đã chạy = tổng km xe sau ngày đó (hàm vehicle_maintenance).
import { boss, bossCol, company, head, signCol, signImg } from './profilePapers';
import { paginate } from './pdfMaker';
import { savePdf } from './dispatchPapers';
import { rpc, supabase } from './supabase';

export interface MaintCfg { km: number; months: number; warnKm: number; warnDays: number }
export const MAINT_KEYS = { km: 'bao_duong.chu_ky_km', months: 'bao_duong.chu_ky_thang', warnKm: 'bao_duong.bao_truoc_km', warnDays: 'bao_duong.bao_truoc_ngay' } as const;
export const MAINT_DEFAULT: MaintCfg = { km: 10000, months: 3, warnKm: 1000, warnDays: 15 };
export interface MaintRow { vehicle_id: string; last_on: string | null; last_odo: number | null; last_code: string | null; km_since: number | null }
export type MaintState = 'qua_han' | 'sap_den' | 'con_han' | 'chua_co';
export interface Maint { row: MaintRow; state: MaintState; dueOn: string | null; daysLeft: number | null; kmLeft: number | null; dueOdo: number | null; text: string }

const todayIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
export const addMonths = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
};
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const dmy = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '');
const n0 = (n: number) => Math.round(n).toLocaleString('vi-VN');

export async function loadMaintCfg(): Promise<MaintCfg> {
  const { data } = await supabase.from('tenant_settings').select('key, value').in('key', Object.values(MAINT_KEYS));
  const get = (k: string, d: number) => { const v = Number(((data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value); return Number.isFinite(v) && v >= 0 ? v : d; };
  return { km: get(MAINT_KEYS.km, MAINT_DEFAULT.km), months: get(MAINT_KEYS.months, MAINT_DEFAULT.months),
    warnKm: get(MAINT_KEYS.warnKm, MAINT_DEFAULT.warnKm), warnDays: get(MAINT_KEYS.warnDays, MAINT_DEFAULT.warnDays) };
}
export async function saveMaintCfg(c: MaintCfg): Promise<void> {
  const rows = (Object.keys(MAINT_KEYS) as (keyof MaintCfg)[]).map((k) => ({ key: MAINT_KEYS[k], value: Math.round(c[k]) }));
  const { error } = await supabase.from('tenant_settings').upsert(rows, { onConflict: 'tenant_id,key' });
  if (error) throw new Error(error.message);
}

/** Hạn bảo dưỡng của 1 xe: hạn ngày = lần gần nhất + chu kỳ tháng; còn km = chu kỳ km − km đã chạy. */
export function maintOf(row: MaintRow, c: MaintCfg, now = todayIso()): Maint {
  if (!row.last_on) return { row, state: 'chua_co', dueOn: null, daysLeft: null, kmLeft: null, dueOdo: null, text: 'Chưa có phiếu bảo dưỡng' };
  const dueOn = addMonths(row.last_on, c.months), daysLeft = days(now, dueOn), kmLeft = Math.round(c.km - Number(row.km_since ?? 0));
  const dueOdo = row.last_odo != null ? row.last_odo + c.km : null;
  const late: string[] = [];
  if (kmLeft < 0) late.push(`quá ${n0(-kmLeft)} km`);
  if (daysLeft < 0) late.push(`quá ${-daysLeft} ngày`);
  if (late.length) return { row, state: 'qua_han', dueOn, daysLeft, kmLeft, dueOdo, text: `Quá hạn bảo dưỡng: ${late.join(', ')}` };
  const soon = kmLeft <= c.warnKm || daysLeft <= c.warnDays;
  return { row, state: soon ? 'sap_den' : 'con_han', dueOn, daysLeft, kmLeft, dueOdo,
    text: `${soon ? 'Sắp đến hạn bảo dưỡng' : 'Còn hạn bảo dưỡng'}: còn ${n0(kmLeft)} km / ${daysLeft} ngày (hạn ${dmy(dueOn)})` };
}
export async function loadMaint(): Promise<{ cfg: MaintCfg; list: Maint[] }> {
  const [cfg, rows] = await Promise.all([loadMaintCfg(), rpc<MaintRow[]>('vehicle_maintenance', {})]);
  return { cfg, list: (rows ?? []).map((r) => maintOf(r, cfg)) };
}
const ORDER: Record<MaintState, number> = { qua_han: 0, sap_den: 1, chua_co: 2, con_han: 3 };
export const byUrgency = (a: Maint, b: Maint) => ORDER[a.state] - ORDER[b.state] || (a.daysLeft ?? 0) - (b.daysLeft ?? 0);

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
/** Các ngày dự kiến bảo dưỡng trong năm (theo chu kỳ tháng, từ hạn kế tiếp). */
function planDates(m: Maint, c: MaintCfg, year: number): string[] {
  const out: string[] = [];
  let d = m.dueOn ?? `${year}-01-01`;
  if (!m.dueOn) { out.push('Bảo dưỡng ngay để lấy mốc'); return out; }
  while (Number(d.slice(0, 4)) < year) d = addMonths(d, c.months);
  for (let i = 0; i < 40 && Number(d.slice(0, 4)) === year; i++) { out.push(dmy(d)); d = addMonths(d, c.months); }
  return out;
}
/** Trang in kế hoạch bảo dưỡng năm (khổ ngang): mỗi xe 1 dòng. */
export async function maintPlanPages(tenantId: string, me: { id: string | null; name: string }, list: Maint[], plate: (id: string) => string, c: MaintCfg, year: number): Promise<string[]> {
  const [co, { b }] = await Promise.all([company(), boss(tenantId, me)]);
  const TH = 'border:1px solid #333;padding:4px;font-size:12px;text-align:center;background:#e2e8f0';
  const TD = 'border:1px solid #333;padding:4px;font-size:12px;vertical-align:top';
  const rows = [...list].sort((a, z) => plate(a.row.vehicle_id).localeCompare(plate(z.row.vehicle_id))).map((m, i) => `<tr>
    <td style="${TD};text-align:center">${i + 1}</td><td style="${TD}"><b>${esc(plate(m.row.vehicle_id))}</b></td>
    <td style="${TD}">${m.row.last_on ? `${dmy(m.row.last_on)}${m.row.last_odo != null ? `<br>Odo ${n0(m.row.last_odo)} km` : ''}${m.row.last_code ? `<br>${esc(m.row.last_code)}` : ''}` : 'Chưa có'}</td>
    <td style="${TD};text-align:right">${m.row.km_since != null ? n0(Number(m.row.km_since)) : ''}</td>
    <td style="${TD}">${m.dueOn ? `${dmy(m.dueOn)}${m.dueOdo != null ? `<br>hoặc Odo ${n0(m.dueOdo)} km` : `<br>hoặc sau ${n0(c.km)} km`}` : 'Bảo dưỡng ngay'}</td>
    <td style="${TD}">${planDates(m, c, year).join('; ')}</td>
    <td style="${TD}">${esc(m.state === 'qua_han' ? 'Quá hạn' : m.state === 'sap_den' ? 'Sắp đến hạn' : m.state === 'chua_co' ? 'Chưa có mốc' : 'Còn hạn')}</td><td style="${TD}"></td></tr>`);
  const top = `${head(co)}<h2 style="text-align:center;margin:12px 0 2px;font-size:18px">KẾ HOẠCH BẢO DƯỠNG PHƯƠNG TIỆN NĂM ${year}</h2>
    <p style="text-align:center;margin:0 0 8px;font-size:13px">Chu kỳ bảo dưỡng: mỗi <b>${n0(c.km)} km</b> hoặc <b>${c.months} tháng</b>, tùy điều kiện nào đến trước.</p>`;
  const table = (body: string[]) => `<table style="width:100%;border-collapse:collapse"><tr><th style="${TH};width:4%">STT</th><th style="${TH};width:11%">Biển số</th>
    <th style="${TH};width:15%">Lần bảo dưỡng gần nhất</th><th style="${TH};width:9%">Km đã chạy từ lần gần nhất</th><th style="${TH};width:15%">Hạn lần tới</th>
    <th style="${TH}">Dự kiến bảo dưỡng trong năm</th><th style="${TH};width:9%">Tình trạng</th><th style="${TH};width:9%">Ghi chú</th></tr>${body.join('')}</table>`;
  const sign = `<table style="width:100%;border-collapse:collapse;margin-top:12px"><tr>
    ${signCol('NGƯỜI LẬP', '(Ký, ghi rõ họ tên)', signImg(b.me), b.meName, b.me, 50)}${bossCol(b, 'GIÁM ĐỐC', 50)}</tr></table>`;
  const chunks: string[][] = [];
  for (let i = 0; i < rows.length; i += 14) chunks.push(rows.slice(i, i + 14));
  if (!chunks.length) chunks.push([]);
  return paginate(chunks.map((ch, i) => `<div style="font-size:13px;line-height:1.4">${i === 0 ? top : ''}${table(ch)}${i === chunks.length - 1 ? sign : ''}</div>`), true);
}
export async function saveMaintPlan(pages: string[], year: number): Promise<void> {
  await savePdf([String(year), '03. Phương tiện', 'Kế hoạch bảo dưỡng'], `Kế hoạch bảo dưỡng phương tiện năm ${year}`, `ke-hoach-bao-duong-${year}.pdf`,
    pages.map((html) => ({ html, land: true })), 'Lưu từ Sửa chữa › Kế hoạch bảo dưỡng', `bd:${year}`);
}
