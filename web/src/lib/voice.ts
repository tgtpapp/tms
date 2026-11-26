// Trợ lý giọng nói cho lái xe – giai đoạn 1: CHỈ TRA CỨU (không ghi dữ liệu).
// Nghe / đọc bằng tính năng sẵn có của trình duyệt (không cài thêm thư viện, không gọi AI): hiểu câu hỏi theo từ khóa.
// Câu trả lời: 1–3 câu ngắn, kiểu văn nói, không ký tự đặc biệt; giờ "14 giờ 30", tiền "1 triệu 200 nghìn", số điện thoại "đuôi 4512".

export interface VTicket {
  from_stop_id: string; to_stop_id: string; from_idx: number; to_idx: number | null; price: number; status: 'dat' | 'da_tt';
  passenger_name: string | null; passenger_phone: string | null; boarded: boolean; no_show: boolean; dropped: boolean;
}
export interface VParcel {
  from_stop_id: string; to_stop_id: string; packages: number; receiver_name: string | null; receiver_phone: string;
  fee: number; fee_payer: 'nguoi_gui' | 'nguoi_nhan'; fee_paid_at: string | null; cod_amount: number; cod_collected_at: string | null; status: string;
}
export interface VTrip { depart_at: string; departed_at: string | null; arrived_at: string | null; plate: string | null; routeName: string }

const TZ = 'Asia/Ho_Chi_Minh';
/** Bỏ ký tự máy đọc dễ đọc sai */
export const clean = (s: string) => s.replace(/[*#_|•→⇄–—]/g, ' ').replace(/\s[-/]\s/g, ' ').replace(/\s+/g, ' ').trim();
export function sayTime(iso: string): string {
  const [h, m] = new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).split(':');
  return `${Number(h)} giờ${Number(m) ? ` ${Number(m)}` : ''}`;
}
export function sayMoney(n: number): string {
  if (n <= 0) return '0 đồng';
  if (n < 1000) return `${n} đồng`;
  const tr = Math.floor(n / 1_000_000), ng = Math.floor((n % 1_000_000) / 1000), d = n % 1000;
  const parts = [tr && `${tr} triệu`, ng && `${ng} nghìn`, d && `${d} đồng`].filter(Boolean);
  return parts.join(' ');
}
const tail = (p: string | null | undefined) => (p && p.replace(/\D/g, '').length >= 4 ? `đuôi ${p.replace(/\D/g, '').slice(-4)}` : '');
const who = (name: string | null | undefined, phone: string | null | undefined) => clean([name?.trim() || 'khách', tail(phone)].filter(Boolean).join(' '));
const list = (xs: string[], max = 3) => (xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} và ${xs.length - max} người nữa`);

/** Hàng còn trên xe chưa giao */
const openParcels = (ps: VParcel[]) => ps.filter((p) => p.status !== 'giao' && p.status !== 'huy');
const toCollect = (p: VParcel) => (p.cod_collected_at ? 0 : p.cod_amount) + (p.fee_payer === 'nguoi_nhan' && !p.fee_paid_at ? p.fee : 0);

/** Điểm tới: còn khách chờ đón thì điểm đón gần nhất; hết thì điểm trả gần nhất. Kèm hàng giao ở điểm đó. */
export function nextStopText(tk: VTicket[], ps: VParcel[], stopName: (id: string) => string): string {
  const live = tk.filter((t) => !t.no_show);
  const wait = live.filter((t) => !t.boarded);
  let stop = '', idx = Infinity, mode: 'don' | 'tra' = 'don';
  for (const t of wait) if (t.from_idx < idx) { idx = t.from_idx; stop = t.from_stop_id; }
  if (!stop) {
    mode = 'tra';
    for (const t of live.filter((x) => x.boarded && !x.dropped)) { const i = t.to_idx ?? 999; if (i < idx) { idx = i; stop = t.to_stop_id; } }
  }
  const deliver = openParcels(ps).filter((p) => p.to_stop_id === stop);
  if (!stop) {
    const rest = openParcels(ps);
    if (!rest.length) return 'Chuyến này đã đón trả đủ khách, không còn hàng phải giao.';
    const p0 = rest[0];
    return clean(`Không còn khách phải đón trả. Còn ${rest.length} đơn hàng, đơn đầu giao tại ${stopName(p0.to_stop_id)} cho ${who(p0.receiver_name, p0.receiver_phone)}.`);
  }
  const here = mode === 'don' ? wait.filter((t) => t.from_stop_id === stop) : live.filter((t) => t.boarded && !t.dropped && t.to_stop_id === stop);
  const due = mode === 'don' ? here.filter((t) => t.status === 'dat').reduce((a, t) => a + t.price, 0) : 0;
  const parts = [`Điểm tới ${stopName(stop)} ${mode === 'don' ? 'đón' : 'trả'} ${here.length} khách, ${list(here.map((t) => who(t.passenger_name, t.passenger_phone)))}.`];
  if (due > 0) parts.push(`Thu tiền vé ${sayMoney(due)}.`);
  if (deliver.length) {
    const n = deliver.reduce((a, p) => a + p.packages, 0), c = deliver.reduce((a, p) => a + toCollect(p), 0);
    parts.push(`Có ${n} kiện hàng giao ${list(deliver.map((p) => who(p.receiver_name, p.receiver_phone)), 2)}${c ? `, thu ${sayMoney(c)}` : ''}.`);
  }
  return clean(parts.join(' '));
}

/** Tổng hàng còn lại + tiền thu hộ */
export function codText(ps: VParcel[]): string {
  const rest = openParcels(ps);
  if (!rest.length) return 'Chuyến này không còn hàng phải giao.';
  const n = rest.reduce((a, p) => a + p.packages, 0);
  const cod = rest.reduce((a, p) => a + (p.cod_collected_at ? 0 : p.cod_amount), 0);
  const fee = rest.reduce((a, p) => a + (p.fee_payer === 'nguoi_nhan' && !p.fee_paid_at ? p.fee : 0), 0);
  return clean(`Còn ${n} kiện, ${rest.length} đơn chưa giao. ${cod ? `Tổng thu hộ ${sayMoney(cod)}.` : 'Không có tiền thu hộ.'}${fee ? ` Cước người nhận trả ${sayMoney(fee)}.` : ''}`);
}

/** Tóm tắt chuyến (câu mở đầu) */
export function tripText(t: VTrip, tk: VTicket[], cap: number): string {
  const live = tk.filter((x) => !x.no_show).length;
  const head = `Chuyến ${t.routeName.replace(/\s*[-–—→⇄]\s*/g, ' đi ')} ${sayTime(t.depart_at)}${t.plate ? `, xe ${t.plate.slice(-5)}` : ''}.`;
  if (t.arrived_at) return clean(`${head} Chuyến đã đến bến.`);
  if (!t.departed_at) return clean(`${head} Chưa xuất bến, đã bán ${live}${cap ? ` trên ${cap}` : ''} ghế.`);
  return clean(head);
}

export type Intent = 'diem_toi' | 'thu_ho' | 'chuyen' | 'nhac_lai' | 'khong_ro';
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
/** Hiểu câu hỏi theo từ khóa (giai đoạn 1 chỉ có tra cứu) */
export function intentOf(heard: string): Intent {
  const s = fold(heard);
  if (/nhac lai|noi lai|lap lai/.test(s)) return 'nhac_lai';
  if (/thu ho|cod|kien|tien hang|bao nhieu hang|con hang|tong tien/.test(s)) return 'thu_ho';
  if (/diem|toi dau|ke tiep|tiep theo|may khach|don ai|tra ai|khach nao|don khach|tra khach/.test(s)) return 'diem_toi';
  if (/chuyen|may gio|gio chay|xe nao|ban duoc|bao nhieu ghe/.test(s)) return 'chuyen';
  return 'khong_ro';
}

/* ---------------- Đọc / nghe bằng trình duyệt ---------------- */
interface Rec { lang: string; interimResults: boolean; maxAlternatives: number; continuous: boolean; start(): void; abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null }
type RecCtor = new () => Rec;
const recCtor = (): RecCtor | null => {
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
export const canListen = () => !!recCtor();
export const canSpeak = () => 'speechSynthesis' in window;

let voice: SpeechSynthesisVoice | null = null;
function viVoice(): SpeechSynthesisVoice | null {
  if (voice) return voice;
  const vs = window.speechSynthesis?.getVoices() ?? [];
  voice = vs.find((v) => /^vi/i.test(v.lang)) ?? null;
  return voice;
}
/** Đọc to (hơi chậm, âm lượng tối đa); xong thì resolve */
export function speak(text: string): Promise<void> {
  return new Promise((res) => {
    if (!canSpeak()) { res(); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'vi-VN'; u.rate = 0.95; u.volume = 1;
    const v = viVoice(); if (v) u.voice = v;
    u.onend = () => res(); u.onerror = () => res();
    window.speechSynthesis.speak(u);
  });
}
export const stopSpeak = () => { try { window.speechSynthesis?.cancel(); } catch { /* bỏ qua */ } };

/** Tiếng bíp ngắn báo bắt đầu nghe */
export function beep() {
  try {
    const C = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext });
    const A = C.AudioContext ?? C.webkitAudioContext; if (!A) return;
    const ac = new A(), o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; g.gain.value = 0.2; o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.15); o.onended = () => void ac.close();
  } catch { /* bỏ qua */ }
}

/** Nghe 1 câu; trả câu nghe được ('' = không nghe được) */
export function listen(onStart?: () => void): { done: Promise<string>; stop: () => void } {
  const C = recCtor();
  if (!C) return { done: Promise.resolve(''), stop: () => undefined };
  const r = new C();
  r.lang = 'vi-VN'; r.interimResults = false; r.maxAlternatives = 1; r.continuous = false;
  let text = '';
  const done = new Promise<string>((res) => {
    r.onresult = (e) => { text = e.results[0]?.[0]?.transcript ?? ''; };
    r.onerror = () => undefined;
    r.onend = () => res(text.trim());
  });
  try { r.start(); onStart?.(); } catch { /* đang nghe */ }
  return { done, stop: () => { try { r.abort(); } catch { /* bỏ qua */ } } };
}
