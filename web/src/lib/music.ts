// Trình phát nhạc dùng chung cho cả app (trợ lý giọng nói của lái xe điều khiển được): phát danh sách video YouTube trong khung nhỏ
// ở cuối màn hình, không mất khi chuyển màn. Điều khiển khung YouTube bằng postMessage (không tải script ngoài, CSP chỉ cho mã của app).
// - Trợ lý đọc / nghe: nhạc tự nhỏ lại rồi to lên (iPhone không cho chỉnh âm lượng video → tạm dừng rồi phát tiếp).
// - Lái xe gọi khách: nhạc dừng đến khi ghi xong kết quả cuộc gọi.
import { supabase } from './supabase';

export interface Song { id: string; title: string }
export interface MusicState { list: Song[]; label: string; playing: boolean; vol: number; ver: number }

const PL_KEY = 'giai_tri.ds';
const VOL_KEY = 'tms.nhac.am_luong';
const isId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{11}$/.test(s);
/** iPhone / iPad: trang web không chỉnh được âm lượng video */
const noVolume = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const readVol = () => { try { const v = Number(localStorage.getItem(VOL_KEY)); return v >= 10 && v <= 100 ? v : 80; } catch { return 80; } };

let st: MusicState = { list: [], label: '', playing: false, vol: readVol(), ver: 0 };
const subs = new Set<(s: MusicState) => void>();
const set = (p: Partial<MusicState>) => { st = { ...st, ...p }; subs.forEach((f) => f(st)); };
export const musicState = () => st;
export function onMusic(f: (s: MusicState) => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

/* ---------- Khung YouTube (MusicDock gắn vào) ---------- */
let frame: HTMLIFrameElement | null = null;
let ready = false;
const queue: string[] = [];
function post(func: string, args: unknown[] = []) {
  const m = JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' });
  if (!frame?.contentWindow || !ready) { queue.push(m); return; }
  frame.contentWindow.postMessage(m, '*');
}
/** MusicDock gọi khi khung YouTube vừa tải xong / bị gỡ */
let hello: ReturnType<typeof setInterval> | undefined;
export function attachFrame(f: HTMLIFrameElement | null) {
  frame = f; ready = false; queue.length = 0;
  clearInterval(hello);
  if (!f) return;
  // Báo khung YouTube gửi trạng thái về; nhắc lại vài lần đến khi khung trả lời (khung tải chậm)
  let n = 0;
  const hi = () => { if (ready || frame !== f || ++n > 40) { clearInterval(hello); return; } f.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*'); };
  hi(); hello = setInterval(hi, 250);
}
window.addEventListener('message', (e) => {
  if (!frame || e.source !== frame.contentWindow || !/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(e.origin)) return;
  let d: { event?: string; info?: unknown };
  try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
  if (d.event === 'onReady' || (!ready && d.event === 'infoDelivery')) {
    ready = true;
    frame.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'setVolume', args: [level()], id: 1, channel: 'widget' }), '*');
    queue.splice(0).forEach((m) => frame?.contentWindow?.postMessage(m, '*'));
  }
  const ps = d.event === 'onStateChange' ? d.info : d.event === 'infoDelivery' ? (d.info as { playerState?: number } | null)?.playerState : undefined;
  if (typeof ps === 'number' && ps !== 3 && ps !== -1) {   // 1 đang phát · 2 dừng · 0 hết (3 đang tải, -1 chưa bắt đầu: bỏ qua)
    const p = ps === 1;
    if (p !== st.playing) set({ playing: p });
  }
});
/** Địa chỉ khung nhúng: phát cả danh sách, lặp lại, cho điều khiển bằng postMessage */
export function embedSrc(list: Song[]): string {
  const ids = list.map((x) => x.id);
  const q = new URLSearchParams({ autoplay: '1', playsinline: '1', rel: '0', modestbranding: '1', enablejsapi: '1', origin: location.origin,
    loop: '1', playlist: ids.join(',') });
  return `https://www.youtube-nocookie.com/embed/${ids[0]}?${q}`;
}

/* ---------- Nhỏ tiếng khi trợ lý đọc / nghe, dừng khi gọi điện ---------- */
let duckN = 0;
let holdN = 0;
let pausedBy = false;   // nhạc đang phát bị trợ lý tạm dừng (sẽ phát tiếp)
const level = () => (duckN > 0 ? Math.max(5, Math.round(st.vol * 0.2)) : st.vol);
function quiet() {
  if (!st.list.length) return;
  const stop = holdN > 0 || (duckN > 0 && noVolume());
  if (stop && st.playing && !pausedBy) { pausedBy = true; post('pauseVideo'); return; }
  if (!stop && pausedBy) { pausedBy = false; post('setVolume', [level()]); post('playVideo'); return; }
  if (!noVolume()) post('setVolume', [level()]);
}
/** Trợ lý bắt đầu đọc / nghe */
export function duck() { duckN++; quiet(); }
/** Trợ lý đọc / nghe xong */
export function unduck() { duckN = Math.max(0, duckN - 1); quiet(); }
/** Gọi điện: dừng nhạc đến khi release() */
export function hold() { holdN++; quiet(); }
export function release() { if (!holdN) return; holdN = 0; quiet(); }

/* ---------- Lệnh ---------- */
export function playList(list: Song[], label: string) {
  const l = list.filter((x) => isId(x.id)).slice(0, 50);
  if (!l.length) return;
  pausedBy = false;
  set({ list: l, label, playing: false, ver: st.ver + 1 });
}
export function stopMusic() { pausedBy = false; holdN = 0; set({ list: [], label: '', playing: false, ver: st.ver + 1 }); }
export const pause = () => { pausedBy = false; set({ playing: false }); post('pauseVideo'); };   // báo dừng ngay: trợ lý đọc xong không tự phát lại
export const resume = () => { pausedBy = false; post('playVideo'); };
export const next = () => post('nextVideo');
export const prev = () => post('previousVideo');
/** Đổi âm lượng (bước 20%); trả âm lượng mới */
export function volume(step: number): number {
  const v = Math.min(100, Math.max(10, st.vol + step));
  try { localStorage.setItem(VOL_KEY, String(v)); } catch { /* bỏ qua */ }
  set({ vol: v });
  post('setVolume', [level()]);
  return v;
}

/** Danh sách phát trên xe của nhà xe (Giải trí → Phát trên xe) */
export async function tenantPlaylist(): Promise<Song[]> {
  const r = await supabase.from('tenant_settings').select('value').eq('key', PL_KEY).maybeSingle();
  const v = r.data?.value;
  return Array.isArray(v) ? (v as Song[]).filter((x) => x && isId(x.id)).map((x) => ({ id: x.id, title: String(x.title ?? '') })) : [];
}
/** Tìm nhạc trên YouTube (qua máy chủ); null = máy chủ chưa cài khóa tìm kiếm */
export async function searchSongs(q: string): Promise<Song[] | null> {
  const { data } = await supabase.functions.invoke('youtube', { body: { q, page: '' } });
  const d = data as { items?: Song[]; no_key?: boolean } | null;
  if (!d?.items) return null;
  return d.items.filter((x) => isId(x.id)).map((x) => ({ id: x.id, title: x.title }));
}
