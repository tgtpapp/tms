// Trợ lý giọng nói cho lái xe – giai đoạn 1: CHỈ TRA CỨU (không ghi dữ liệu).
// Nghe / đọc bằng tính năng sẵn có của trình duyệt (không cài thêm thư viện, không gọi AI): hiểu câu hỏi theo từ khóa.
// Câu trả lời: 1–3 câu ngắn, kiểu văn nói, không ký tự đặc biệt; giờ "14 giờ 30", tiền "1 triệu 200 nghìn", số điện thoại "đuôi 512" (3 số cuối).

import { duck, unduck } from './music';

export interface VTicket {
  id: string; from_stop_id: string; to_stop_id: string; from_idx: number; to_idx: number | null; price: number; status: 'dat' | 'da_tt';
  passenger_name: string | null; passenger_phone: string | null; boarded: boolean; no_show: boolean; dropped: boolean;
}
export interface VParcel {
  id: string; from_stop_id: string; to_stop_id: string; packages: number; receiver_name: string | null; receiver_phone: string;
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
const tail = (p: string | null | undefined) => (p && p.replace(/\D/g, '').length >= 3 ? `đuôi ${p.replace(/\D/g, '').slice(-3)}` : '');
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

export type Intent = 'diem_toi' | 'thu_ho' | 'chuyen' | 'nhac_lai' | 'don' | 'tra' | 'vang' | 'hoan_tac'
  | 'giao' | 'do_dau' | 'chi_phi' | 'su_co' | 'tre_gio' | 'nhan' | 'goi' | 'khong_ro';
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
/** Hiểu câu hỏi theo từ khóa (giai đoạn 1 chỉ có tra cứu) */
export function intentOf(heard: string): Intent {
  const s = fold(heard);
  if (/nhac lai|noi lai|lap lai/.test(s)) return 'nhac_lai';
  if (/hoan tac|huy vua|bo vua|ghi nham|nham roi/.test(s)) return 'hoan_tac';
  if (/khach vang|vang mat|bao vang|ghi vang|vang roi|khong co mat|khong ra|khong di|bo chuyen|khong thay khach/.test(s)) return 'vang';
  if (/da tra|tra du|tra xong|xuong xe|tra het/.test(s)) return 'tra';
  if (/da don|don du|don xong|don het|len xe|da len|don roi/.test(s)) return 'don';
  if (/da giao|giao hang|giao xong|giao cho|giao roi/.test(s)) return 'giao';
  if (/do dau|do xang|do nhien lieu|bom dau/.test(s)) return 'do_dau';
  if (/cau duong|phi duong|tram thu phi|ve cau|chi phi|tien phi|sua xe|va lop|rua xe|gui xe|an uong/.test(s) && moneyOf(heard)) return 'chi_phi';
  if (/bao dieu hanh|nhan dieu hanh|bao van phong|nhan van phong|nhan cho|chuyen loi/.test(s) && !/ket xe|\btre\b|\bcham\b|su co|tai nan/.test(s)) return 'nhan';
  if (/\bgoi\b|\balo\b|bam so|dien thoai cho/.test(s) && !/dieu hanh|van phong/.test(s)) return 'goi';
  if (/su co|tai nan|va cham|hu xe|hong xe|xe hu|xe hong|thung lop|be lop|xit lop|chet may|qua nhiet|canh sat|csgt|bi phat/.test(s)) return 'su_co';
  if (/\btre\b|\bcham\b|ket xe|tac duong|un tac/.test(s)) return 'tre_gio';
  if (/thu ho|cod|kien|tien hang|bao nhieu hang|con hang|tong tien/.test(s)) return 'thu_ho';
  if (/diem|toi dau|ke tiep|tiep theo|may khach|don ai|tra ai|khach nao|don khach|tra khach/.test(s)) return 'diem_toi';
  if (/chuyen|may gio|gio chay|xe nao|ban duoc|bao nhieu ghe/.test(s)) return 'chuyen';
  return 'khong_ro';
}

/** Lệnh nhạc ("mở nhạc bolero", "bài tiếp", "nhỏ lại"…); null = không phải lệnh nhạc. q: nội dung cần tìm ('' = danh sách phát của xe) */
export type MusicCmd = { act: 'mo'; q: string } | { act: 'tiep' | 'truoc' | 'dung' | 'phat' | 'to' | 'nho' | 'tat' };
export function musicOf(heard: string): MusicCmd | null {
  // "nhạc" / "nhắc", "bài" / "bãi" bỏ dấu thì giống nhau: đánh dấu riêng chữ "nhạc", "bài" trước khi bỏ dấu (câu không dấu thì coi như đúng chữ)
  const low = heard.normalize('NFC').toLowerCase(), plain = !/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/.test(low);
  const mark = (t: string) => (plain ? t.replace(/\bnhac\b/g, 'zznhac').replace(/\bbai\b/g, 'zzbai') : t.replace(/nhạc/g, ' zznhac ').replace(/bài/g, ' zzbai '));
  const s = fold(mark(low)).replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(tat|thoi|bo) (zznhac|zzbai hat|video)\b/.test(s)) return { act: 'tat' };
  if (/\btam dung\b|\b(dung|ngung) (zznhac|zzbai|phat)\b/.test(s)) return { act: 'dung' };
  if (/\bphat tiep\b|\b(mo|bat) lai zznhac\b|\btiep tuc (zznhac|phat)\b/.test(s)) return { act: 'phat' };
  if (/\bzzbai (tiep|sau|khac|moi)\b|\b(qua|chuyen|doi|sang) zzbai\b/.test(s)) return { act: 'tiep' };
  if (/\bzzbai truoc\b|\b(lui|quay lai) zzbai\b/.test(s)) return { act: 'truoc' };
  if (/\b(to|lon|tang) (len|tieng|am luong|zznhac|them)\b|\bzznhac to\b|\bvan to\b/.test(s)) return { act: 'to' };
  if (/\b(nho|giam|bot) (lai|xuong|tieng|am luong|zznhac|di|bot)\b|\bzznhac nho\b|\bvan nho\b/.test(s)) return { act: 'nho' };
  // "mở nhạc …" / "nhạc …": phần sau là nội dung cần tìm (bỏ các chữ đệm "đi, nhé, cho khách nghe…")
  const ws = s.split(' '), orig = heard.normalize('NFC').replace(/[.,!?]/g, ' ').trim().split(/\s+/);
  let i = -1;
  for (let k = 0; k < ws.length - 1 && i < 0; k++) {
    if (/^(mo|bat|phat|nghe)$/.test(ws[k]!) && /^(zznhac|zzbai|video)$/.test(ws[k + 1]!)) i = k + 2;
  }
  if (i < 0 && ws[0] === 'zznhac') i = 1;
  if (i < 0) return null;
  if (ws[i] === 'hat' && ws[i - 1] === 'zzbai') i++;
  let j = ws.length;
  while (i < j && /^(di|nao|giup|voi|nhe|ne|nha)$/.test(ws[i]!)) i++;
  if (ws[i] === 'cho') { i++; if (/^(khach|anh|em|minh|ca xe)$/.test(ws[i] ?? '')) i++; if (ws[i] === 'nghe') i++; }
  while (j > i && /^(di|nao|nhe|ne|nha|voi|giup|a|zznhac)$/.test(ws[j - 1]!)) j--;
  const q = ws.slice(i, j).join(' ').replace(/zz(nhac|bai)/g, '$1');
  if (!q || /\b(danh sach|cua xe|tren xe|nha xe|mac dinh|thuong mo)\b/.test(q)) return { act: 'mo', q: '' };
  // lấy đúng các chữ của câu gốc (còn dấu) để tìm trên YouTube
  return { act: 'mo', q: ws.length === orig.length ? orig.slice(i, j).join(' ') : q };
}

/* ---------------- Tự học câu nói (câu chưa hiểu → hỏi lại → lưu dùng chung cả nhà xe) ---------------- */
export type LearnIntent = Exclude<Intent, 'khong_ro'> | `nhac:${Exclude<MusicCmd['act'], never>}`;
export interface Phrase { id: string; phrase_key: string; intent: LearnIntent }
/** Từ tục tĩu (so trên chữ có dấu nên "đèo", "đụng", "đĩa"… không bị nhầm); máy chủ kiểm lại lần nữa */
const BAD = ['đm', 'đmm', 'dm', 'dmm', 'đcm', 'dcm', 'đkm', 'dkm', 'đcmm', 'vcl', 'vkl', 'vl', 'vãi lồn', 'vãi l', 'clgt', 'cl', 'cc', 'đéo', 'đếch', 'địt', 'đjt', 'djt',
  'đụ', 'đù má', 'đù', 'lồn', 'buồi', 'cặc', 'đĩ', 'đỉ', 'mẹ mày', 'má mày', 'con mẹ', 'mẹ kiếp', 'bố mày', 'thằng chó', 'con chó', 'đồ chó', 'chó chết', 'óc chó',
  'khốn nạn', 'súc vật', 'ngu như', 'fuck', 'shit', 'bitch'];
const BAD_RE = new RegExp(`(^|[^\\p{L}\\p{N}])(${BAD.sort((a, b) => b.length - a.length).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'gu');
export const hasBad = (t: string) => { BAD_RE.lastIndex = 0; return BAD_RE.test(t.normalize('NFC').toLowerCase()); };
/** Bỏ từ tục chen trong câu (để vẫn hiểu lệnh) */
export const dropBad = (t: string) => t.normalize('NFC').toLowerCase().replace(BAD_RE, '$1 ').replace(/\s+/g, ' ').trim();
/** Mã so khớp của câu: bỏ dấu, bỏ từ tục, bỏ chữ đệm (à, ơi, nhé…) */
export function phraseKey(t: string): string {
  return fold(dropBad(t)).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !/^(a|ah|oi|nhe|nha|ne|u|uh|um|ha|nhi|vay|the)$/.test(w))
    .slice(0, 30).join(' ').slice(0, 200).trim();
}
/** Câu đã học khớp với câu vừa nói: trùng hẳn, hoặc câu đã học (từ 2 chữ) nằm trọn theo thứ tự trong câu vừa nói (lấy câu dài nhất) */
export function learnedOf(heard: string, list: Phrase[]): Phrase | null {
  const k = phraseKey(heard);
  if (!k) return null;
  const exact = list.find((p) => p.phrase_key === k);
  if (exact) return exact;
  const ws = k.split(' ');
  const inside = (p: Phrase) => { const ps = p.phrase_key.split(' '); if (ps.length < 2) return false; let i = 0; for (const w of ws) if (w === ps[i]) i++; return i === ps.length; };
  return list.filter(inside).sort((a, b) => b.phrase_key.length - a.phrase_key.length)[0] ?? null;
}
/** Câu hỏi lại khi chưa hiểu */
export const MENU_ASK = 'Em chưa hiểu. Anh muốn: điểm tới, đón khách, trả khách, khách vắng, gọi khách, giao hàng, thu hộ, đổ dầu, chi phí, sự cố, trễ giờ, nhắn điều hành, thông tin chuyến, hay mở nhạc? Nói không nếu thôi.';
/** Hiểu câu trả lời cho câu hỏi lại (tên lệnh); null = thôi / không rõ */
export function menuOf(answer: string): LearnIntent | null {
  const m = musicOf(answer);
  if (m) return `nhac:${m.act}`;
  const s = fold(answer);
  if (/nhac lai|noi lai|lap lai/.test(s)) return 'nhac_lai';
  if (/hoan tac/.test(s)) return 'hoan_tac';
  if (/vang/.test(s)) return 'vang';
  if (/\bgoi\b/.test(s)) return 'goi';
  if (/giao/.test(s)) return 'giao';
  if (/thu ho/.test(s)) return 'thu_ho';
  if (/do dau|xang|nhien lieu/.test(s)) return 'do_dau';
  if (/chi phi/.test(s)) return 'chi_phi';
  if (/su co|tai nan|hu xe|hong xe/.test(s)) return 'su_co';
  if (/\btre\b|\bcham\b/.test(s)) return 'tre_gio';
  if (/nhan|dieu hanh|van phong/.test(s)) return 'nhan';
  if (/chuyen|thong tin/.test(s)) return 'chuyen';
  if (/diem|\btoi\b/.test(s)) return 'diem_toi';
  if (/\bdon\b/.test(s)) return 'don';
  if (/\btra\b/.test(s)) return 'tra';
  return null;
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

/** Giọng đọc trợ lý (Tài khoản của tôi → Giao diện của tôi), lưu trên máy này */
export interface VoiceCfg { voice: string; rate: number; volume: number; news: boolean }
const VOICE_KEY = 'tms.giong_doc';
export const VOICE_DEF: VoiceCfg = { voice: '', rate: 0.95, volume: 1, news: true };
export function voiceCfg(): VoiceCfg { try { return { ...VOICE_DEF, ...JSON.parse(localStorage.getItem(VOICE_KEY) ?? '{}') } as VoiceCfg; } catch { return VOICE_DEF; } }
export function saveVoiceCfg(c: VoiceCfg) { try { localStorage.setItem(VOICE_KEY, JSON.stringify(c)); } catch { /* bỏ qua */ } }
/** Các giọng tiếng Việt có trong máy (danh sách có thể tải chậm: gọi lại sau sự kiện voiceschanged) */
export const viVoices = () => (window.speechSynthesis?.getVoices() ?? []).filter((v) => /^vi/i.test(v.lang));
function viVoice(): SpeechSynthesisVoice | null {
  const vs = viVoices(), want = voiceCfg().voice;
  return vs.find((v) => v.voiceURI === want) ?? vs[0] ?? null;
}
/** Đọc to (hơi chậm, âm lượng tối đa); xong thì resolve */
export function speak(text: string): Promise<void> {
  return new Promise((res) => {
    if (!canSpeak()) { res(); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const c = voiceCfg();
    u.lang = 'vi-VN'; u.rate = c.rate; u.volume = c.volume;
    const v = viVoice(); if (v) u.voice = v;
    duck();   // nhạc nhỏ lại khi trợ lý đọc
    let done = false;
    const fin = () => { if (done) return; done = true; clearTimeout(t); unduck(); res(); };
    const t = setTimeout(fin, 8000 + text.length * 150);   // máy không báo đọc xong (lỗi một số máy Android): không để nhạc nhỏ mãi
    u.onend = fin; u.onerror = fin;
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
    r.onend = () => { if (ducked) { ducked = false; unduck(); } res(text.trim()); };
  });
  let ducked = true;
  duck();   // nhạc nhỏ lại để máy nghe rõ giọng lái xe
  try { r.start(); onStart?.(); } catch { ducked = false; unduck(); /* đang nghe */ }
  return { done, stop: () => { try { r.abort(); } catch { /* bỏ qua */ } } };
}


/* ---------------- Giai đoạn 2: cập nhật đã đón / đã trả / khách vắng ---------------- */
export const isYes = (heard: string) => /\b(dung|phai|u|uh|ok|oke|co|dong y|chot|xac nhan|duoc)\b/.test(fold(heard)) && !/\b(khong|sai|chua)\b/.test(fold(heard));
/** Điểm đón gần nhất còn khách chờ / điểm trả gần nhất còn khách chưa xuống */
export function currentStop(tk: VTicket[], mode: 'don' | 'tra'): string {
  let stop = '', idx = Infinity;
  for (const t of tk.filter((x) => !x.no_show && (mode === 'don' ? !x.boarded : x.boarded && !x.dropped))) {
    const i = mode === 'don' ? t.from_idx : t.to_idx ?? 999;
    if (i < idx) { idx = i; stop = mode === 'don' ? t.from_stop_id : t.to_stop_id; }
  }
  return stop;
}
/** Khách được nhắc tới trong câu nói: theo 3 số cuối điện thoại hoặc theo tên (bỏ dấu); không nhắc ai thì [] */
export function mentioned(heard: string, pool: VTicket[]): VTicket[] {
  const digits = heard.replace(/\D/g, '');
  if (digits.length >= 3) {
    const by = pool.filter((t) => (t.passenger_phone ?? '').replace(/\D/g, '').endsWith(digits.slice(-3)));
    if (by.length) return by;
  }
  const s = ` ${fold(heard)} `;
  return pool.filter((t) => {
    const w = fold(t.passenger_name ?? '').split(/\s+/).filter((x) => x.length >= 2);
    const last = w[w.length - 1];
    return !!last && s.includes(` ${last} `);
  });
}
export const whoList = (ts: VTicket[]) => list(ts.map((t) => who(t.passenger_name, t.passenger_phone)));


/* ---------------- Giai đoạn 3: giao hàng, đổ dầu, báo điều hành ---------------- */
/** Đọc số tiền trong câu nói: "1 triệu 2", "1 triệu 200 nghìn", "500 nghìn", "500k", "1.200.000" → đồng; không có → 0 */
export function moneyOf(heard: string): number {
  const s = fold(heard).replace(/(\d)[.,](\d{3})/g, '$1$2').replace(/(\d)[.,](\d{3})/g, '$1$2');
  const tr = /(\d+(?:[.,]\d+)?)\s*(?:trieu|tr\b|m\b)\s*(\d{1,3})?(?:\s*(?:nghin|ngan|k)\b)?/.exec(s);
  if (tr) {
    const main = Math.round(Number(tr[1].replace(',', '.')) * 1_000_000);
    const rest = tr[2] ? Number(tr[2]) * (tr[2].length === 1 ? 100_000 : tr[2].length === 2 ? 10_000 : 1000) : 0;
    return main + rest;
  }
  const ng = /(\d+)\s*(?:nghin|ngan|k)\b/.exec(s);
  if (ng) return Number(ng[1]) * 1000;
  const big = /(\d{4,})\s*(?:dong|d\b)?/.exec(s);
  return big ? Number(big[1]) : 0;
}
/** Số lít trong câu nói: "60 lít" */
export function litersOf(heard: string): number {
  const m = /(\d+(?:[.,]\d+)?)\s*lit/.exec(fold(heard));
  return m ? Number(m[1].replace(',', '.')) : 0;
}
/** Kiện hàng được nhắc tới: theo 3 số cuối điện thoại người nhận hoặc tên người nhận */
export function mentionedParcels(heard: string, pool: VParcel[]): VParcel[] {
  const digits = heard.replace(/\D/g, '');
  if (digits.length >= 3) {
    const by = pool.filter((p) => p.receiver_phone.replace(/\D/g, '').endsWith(digits.slice(-3)));
    if (by.length) return by;
  }
  const s = ` ${fold(heard)} `;
  return pool.filter((p) => {
    const w = fold(p.receiver_name ?? '').split(/\s+/).filter((x) => x.length >= 2);
    const last = w[w.length - 1];
    return !!last && s.includes(` ${last} `);
  });
}
export const parcelsOpen = openParcels;
export const parcelDue = toCollect;
export const receiverList = (ps: VParcel[]) => list(ps.map((p) => who(p.receiver_name, p.receiver_phone)), 2);

/** Kết quả gọi khách trong câu trả lời */
export function callResultOf(heard: string): 'nghe_may' | 'thue_bao' | 'bao_huy' | null {
  const s = fold(heard);
  if (/huy|khong di nua|bo ve/.test(s)) return 'bao_huy';
  if (/thue bao|khong nghe|khong bat|tat may|ban may|khong lien lac|chua nghe/.test(s)) return 'thue_bao';
  if (/nghe may|co nghe|ra don|dang ra|da nghe|\bco\b|\bdung\b|\bok\b|\bu\b/.test(s)) return 'nghe_may';
  return null;
}
export const whoOf = (name: string | null | undefined, phone: string | null | undefined) => who(name, phone);
