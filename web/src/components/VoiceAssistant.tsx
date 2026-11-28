// Trợ lý giọng nói trong chuyến đang chạy (giai đoạn 1: chỉ tra cứu).
// Bấm nút lớn → lần đầu đọc tình hình chuyến + điểm tới rồi hỏi "Anh cần gì?"; các lần sau chỉ bíp rồi nghe.
// Màn trợ lý phủ kín: chạm bất kỳ đâu để nói tiếp (không cần nhìn), nút Đóng ở góc.
import { useEffect, useRef, useState } from 'react';
import { beep, callResultOf, canListen, canSpeak, clean, codText, voiceCfg, whoOf, currentStop, intentOf, isYes, listen, hotword, wakeOf, litersOf, mentioned, musicOf, dropBad, hasBad, learnedOf, menuOf, phraseKey, MENU_ASK, mentionedParcels, moneyOf, nextStopText,
  parcelDue, parcelsOpen, receiverList, sayMoney, speak, stopSpeak, tripText, whoList, type Intent, type LearnIntent, type MusicCmd, type Phrase, type VParcel, type VTicket, type VTrip } from '../lib/voice';
import { rpc, supabase } from '../lib/supabase';
import { hold, musicState, next as nextSong, pause as pauseSong, playList, prev as prevSong, release, resume as resumeSong, searchSongs, stopMusic, tenantPlaylist, volume } from '../lib/music';
import { distM, learnStop, type StopGeo } from '../lib/geo';

type Mark = (ids: string[], action: 'len' | 'bo_len' | 'tra' | 'bo_tra' | 'vang' | 'bo_vang', patch: Partial<VTicket>) => Promise<void>;
const UNDO = { len: ['bo_len', { boarded: false, dropped: false }], tra: ['bo_tra', { dropped: false }], vang: ['bo_vang', { no_show: false }] } as const;

const greeted = new Set<string>();   // chuyến đã đọc câu mở đầu trong phiên này

export function VoiceAssistant({ tripId, trip, tickets, parcels, cap, stopName, onMark, onChanged, geo, learn = true }: {
  tripId: string; trip: VTrip; tickets: VTicket[]; parcels: VParcel[]; cap: number; stopName: (id: string) => string; onMark: Mark;
  onChanged: () => Promise<void>; geo: Record<string, StopGeo>; learn?: boolean;   // learn: học vị trí điểm dừng từ GPS máy này (chỉ người chạy chuyến)
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'doc' | 'nghe' | 'cho'>('cho');
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const last = useRef('');
  const heardLast = useRef('');
  /** Gọi khách: chờ chạm để mở cuộc gọi; gọi xong chờ ghi kết quả */
  const [dial, setDial] = useState<{ phone: string; ticketId: string | null; name: string } | null>(null);
  const callBack = useRef<{ ticketId: string; name: string } | null>(null);
  const busyRef = useRef(false);
  busyRef.current = phase !== 'cho';
  // quay lại app sau cuộc gọi → hỏi kết quả gọi khách
  useEffect(() => {
    const on = () => {
      if (document.visibilityState !== 'visible' || !callBack.current || !open) return;
      void say(`Khách ${callBack.current.name} nghe máy không? Anh chạm màn hình rồi trả lời.`).then(() => setPhase('cho'));
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Tin mới trên chuyến đang chạy (vé mới, vé hủy, hàng mới): tự đọc khi đã bật trợ lý trên chuyến này
  const seen = useRef<{ t: Map<string, VTicket>; p: Set<string> } | null>(null);
  useEffect(() => {
    const prev = seen.current;
    seen.current = { t: new Map(tickets.map((x) => [x.id, x])), p: new Set(parcels.map((x) => x.id)) };
    if (!prev || !greeted.has(tripId) || !voiceCfg().news || busyRef.current) return;
    const added = tickets.filter((x) => !prev.t.has(x.id));
    const gone = [...prev.t.values()].filter((x) => !tickets.some((y) => y.id === x.id));
    const newP = parcels.filter((x) => !prev.p.has(x.id) && x.status !== 'huy');
    const parts: string[] = [];
    if (added.length) parts.push(`Có ${added.length} khách mới, ${whoList(added)}, đón tại ${stopName(added[0].from_stop_id)}.`);
    if (gone.length) parts.push(`${whoList(gone)} đã hủy vé.`);
    if (newP.length) parts.push(`Có thêm ${newP.reduce((a, x) => a + x.packages, 0)} kiện hàng giao tại ${stopName(newP[0].to_stop_id)}.`);
    if (parts.length) { const t = clean(`Tin mới. ${parts.join(' ')}`); setSaid(t); last.current = t; void speak(t); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets, parcels]);
  const undo = useRef<{ ids: string[]; act: 'len' | 'tra' | 'vang' } | null>(null);
  const stopRef = useRef<() => void>(() => undefined);
  // Câu nói đã học của nhà xe (trợ lý tự học khi chưa hiểu)
  const phrases = useRef<Phrase[]>([]);
  const loadPhrases = async () => {
    const r = await supabase.from('voice_phrases').select('id, phrase_key, intent').limit(2000);
    if (!r.error) phrases.current = (r.data ?? []) as Phrase[];
  };
  useEffect(() => { void loadPhrases().catch(() => undefined); }, []);
  const data = useRef({ trip, tickets, parcels, cap, stopName, geo });
  data.current = { trip, tickets, parcels, cap, stopName, geo };
  // Tự nhắc khi sắp tới điểm (GPS): chỉ sau khi đã bật trợ lý ở chuyến này và xe đã xuất bến; mỗi điểm nhắc 1 lần lúc còn khoảng 2 km
  const [active, setActive] = useState(() => greeted.has(tripId));
  const told = useRef(new Set<string>());
  useEffect(() => {
    if (!active || !trip.departed_at || trip.arrived_at || !('geolocation' in navigator)) return;
    const id = navigator.geolocation.watchPosition((p) => {
      const d = data.current;
      const stop = currentStop(d.tickets, 'don') || currentStop(d.tickets, 'tra') || parcelsOpen(d.parcels)[0]?.to_stop_id;
      const g = stop ? d.geo[stop] : undefined;
      if (!stop || !g || g.lat == null || g.lng == null || told.current.has(stop) || busyRef.current) return;
      const m = distM(p.coords.latitude, p.coords.longitude, g.lat, g.lng);
      if (m > 2000) return;
      told.current.add(stop);
      const km = m < 700 ? 'Sắp tới nơi.' : `Còn khoảng ${(Math.round(m / 500) / 2).toString().replace('.', ' phẩy ')} ki lô mét.`;
      const t = `${km} ${nextStopText(d.tickets, d.parcels, d.stopName)}`;
      setSaid(t); last.current = t; void speak(t);
    }, () => undefined, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [active, trip.departed_at, trip.arrived_at]);
  // Chế độ rảnh tay: chạm 1 lần để bật, sau đó nói "Trợ lý ơi" + lệnh, không phải chạm nữa (màn hình giữ sáng)
  const [free, setFree] = useState(false);
  const hw = useRef<ReturnType<typeof hotword> | null>(null);
  const wakeRef = useRef<(cmd: string) => void>(() => undefined);
  useEffect(() => () => { hw.current?.stop(); hw.current = null; }, []);
  useEffect(() => {
    if (!free) return;
    type Lock = { release: () => Promise<void> };
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Lock> } }).wakeLock;
    if (!wl) return;
    let lock: Lock | null = null, off = false;
    const grab = () => {
      if (off || document.visibilityState !== 'visible') return;
      void wl.request('screen').then((l) => { if (off) void l.release().catch(() => undefined); else lock = l; }).catch(() => undefined);
    };
    grab();
    document.addEventListener('visibilitychange', grab);
    return () => { off = true; document.removeEventListener('visibilitychange', grab); void lock?.release().catch(() => undefined); };
  }, [free]);
  useEffect(() => () => { stopSpeak(); stopRef.current(); }, []);
  if (!canSpeak()) return null;

  async function say(t: string) { setSaid(t); last.current = t; setPhase('doc'); await speak(t); }
  /** Nghe thêm 1 câu (hỏi lại / xác nhận) */
  async function ask(t: string): Promise<string> {
    await say(t);
    beep(); setPhase('nghe');
    const l = listen(); stopRef.current = l.stop;
    const q = await l.done; setHeard(q); heardLast.current = q; return q;
  }
  /** Điểm kế tiếp sau khi vừa cập nhật (đón còn thì điểm đón, hết thì điểm trả) */
  function nextName(tk: VTicket[]): string {
    const s = currentStop(tk, 'don') || currentStop(tk, 'tra');
    return s ? ` Điểm tiếp theo là ${data.current.stopName(s)}.` : ' Đã hết khách phải đón trả.';
  }
  async function mark(ids: string[], act: 'len' | 'tra' | 'vang', patch: Partial<VTicket>): Promise<VTicket[]> {
    await onMark(ids, act, patch);
    undo.current = { ids, act };
    return data.current.tickets.map((t) => (ids.includes(t.id) ? { ...t, ...patch } : t));
  }
  /** Cập nhật bằng giọng nói: đón / trả ghi ngay (nói Hoàn tác để quay lại); khách vắng hỏi xác nhận trước */
  async function update(q: string, it: 'don' | 'tra' | 'vang' | 'hoan_tac'): Promise<string> {
    const d = data.current, tk = d.tickets.filter((t) => !t.no_show);
    if (it === 'hoan_tac') {
      const u = undo.current;
      if (!u) return 'Chưa có việc gì để hoàn tác.';
      const [a, patch] = UNDO[u.act];
      await onMark(u.ids, a, patch); undo.current = null;
      return 'Đã hoàn tác việc vừa ghi.';
    }
    if (it === 'don') {
      const wait = tk.filter((t) => !t.boarded);
      const stop = currentStop(tk, 'don');
      const who = mentioned(q, wait);
      const g = who.length ? who : wait.filter((t) => t.from_stop_id === stop);
      if (!g.length) return 'Không còn khách chờ đón.';
      const after = await mark(g.map((t) => t.id), 'len', { boarded: true, no_show: false });
      return `Đã ghi đón ${who.length ? whoList(g) : `đủ ${g.length} khách`} tại ${d.stopName(g[0].from_stop_id)}.${nextName(after)}`;
    }
    if (it === 'tra') {
      const on = tk.filter((t) => t.boarded && !t.dropped);
      const stop = currentStop(tk, 'tra');
      const who = mentioned(q, on);
      const g = who.length ? who : on.filter((t) => t.to_stop_id === stop);
      if (!g.length) return 'Không còn khách trên xe phải trả.';
      const after = await mark(g.map((t) => t.id), 'tra', { dropped: true, boarded: true });
      return `Đã ghi trả ${who.length ? whoList(g) : `đủ ${g.length} khách`} tại ${d.stopName(g[0].to_stop_id)}.${nextName(after)}`;
    }
    // vắng: phải nói rõ khách nào, rồi xác nhận
    const wait = tk.filter((t) => !t.boarded);
    let g = mentioned(q, wait);
    if (!g.length) g = mentioned(await ask('Khách nào vắng ạ? Anh nói tên hoặc 3 số cuối điện thoại.'), wait);
    if (!g.length) return 'Em không tìm thấy khách đó. Chưa ghi gì.';
    if (!isYes(await ask(`Xác nhận ${whoList(g)} vắng, đúng không ạ?`))) return 'Đã bỏ qua, chưa ghi.';
    const after = await mark(g.map((t) => t.id), 'vang', { no_show: true });
    return `Đã ghi ${g.length} khách vắng.${nextName(after)}`;
  }
  /** Giai đoạn 3: giao hàng, đổ dầu, báo điều hành – luôn hỏi xác nhận 1 câu trước khi ghi / gửi */
  async function report(q: string, it: 'giao' | 'do_dau' | 'chi_phi' | 'su_co' | 'tre_gio' | 'nhan'): Promise<string> {
    const d = data.current;
    if (it === 'giao') {
      const open = parcelsOpen(d.parcels);
      if (!open.length) return 'Chuyến này không còn hàng phải giao.';
      let g = mentionedParcels(q, open);
      if (!g.length) {
        const stop = currentStop(d.tickets, 'tra');
        const here = open.filter((p) => p.to_stop_id === stop);
        g = open.length === 1 ? open : here.length === 1 ? here : mentionedParcels(await ask('Giao cho ai ạ? Anh nói tên người nhận hoặc 3 số cuối điện thoại.'), open);
      }
      if (!g.length) return 'Em không tìm thấy kiện đó. Chưa ghi gì.';
      const ck = /chuyen khoan|ck\b|bank/.test(q.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
      const due = g.reduce((a, p) => a + parcelDue(p), 0), n = g.reduce((a, p) => a + p.packages, 0);
      if (!isYes(await ask(`Xác nhận giao ${n} kiện cho ${receiverList(g)}${due ? `, thu ${sayMoney(due)} ${ck ? 'chuyển khoản' : 'tiền mặt'}` : ''}, đúng không ạ?`))) return 'Đã bỏ qua, chưa ghi.';
      for (const p of g) await rpc('deliver_shipment', { p_id: p.id, p_receiver: null, p_method: ck ? 'chuyen_khoan' : 'tien_mat' });
      if (learn) learnStop(tripId, g[0].to_stop_id);
      await onChanged();
      return `Đã ghi giao ${n} kiện${due ? `, đã thu ${sayMoney(due)}` : ''}.`;
    }
    if (it === 'do_dau') {
      if (!d.trip.plate) return 'Chuyến chưa có xe, chưa ghi được đổ dầu.';
      let tien = moneyOf(q), lit = litersOf(q);
      if (!tien) tien = moneyOf(await ask('Đổ bao nhiêu tiền ạ?'));
      if (!tien) return 'Em chưa nghe rõ số tiền. Chưa ghi gì.';
      if (!lit) lit = litersOf(await ask('Bao nhiêu lít ạ?')) || Number((heardLast.current.match(/\d+(?:[.,]\d+)?/) ?? ['0'])[0].replace(',', '.'));
      if (!(lit > 0)) return 'Em chưa nghe rõ số lít. Chưa ghi gì.';
      if (!isYes(await ask(`Xác nhận đổ dầu ${String(lit).replace('.', ' phẩy ')} lít, ${sayMoney(tien)} cho xe ${d.trip.plate.slice(-5)}, đúng không ạ?`))) return 'Đã bỏ qua, chưa ghi.';
      const now = new Date(), ymd = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
      const hm = now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false });
      await rpc('report_fuel', { p: { key: crypto.randomUUID(), plate: d.trip.plate, entry_date: ymd, entry_time: hm, liters: lit, unit_price: null, amount: tien,
        odo_km: null, supplier: null, invoice_no: null, note: `Báo bằng giọng nói: ${q}`.slice(0, 300), files: [] } });
      return 'Đã gửi phiếu đổ dầu cho điều hành duyệt. Nhớ chụp hóa đơn bổ sung sau.';
    }
    const kind = it === 'chi_phi' ? 'chi_phi' : it === 'tre_gio' ? 'tre_gio' : it === 'su_co' ? 'su_co' : 'nhan';
    const text = clean(q);
    const tien = it === 'chi_phi' ? moneyOf(q) : 0;
    const lead = it === 'chi_phi' ? `chi phí ${sayMoney(tien)}` : it === 'tre_gio' ? 'trễ giờ' : it === 'su_co' ? 'sự cố' : 'lời nhắn';
    if (!isYes(await ask(`Gửi điều hành ${lead}: ${text}. Đúng không ạ?`))) return 'Đã bỏ qua, chưa gửi.';
    const n = await rpc<number>('crew_report', { p_trip_id: tripId, p_kind: kind, p_text: text });
    return n ? `Đã gửi ${lead} về văn phòng điều hành.` : 'Đã ghi nhận, nhưng nhà xe chưa có người điều hành nhận báo.';
  }
  /** Gọi khách / người nhận hàng: tìm theo tên hoặc 3 số cuối, chạm màn hình để mở cuộc gọi */
  async function call(q: string): Promise<string> {
    const d = data.current, live = d.tickets.filter((t) => !t.no_show && !t.dropped);
    let tk = mentioned(q, live).filter((t) => t.passenger_phone);
    let ps = tk.length ? [] : mentionedParcels(q, parcelsOpen(d.parcels)).filter((p) => p.receiver_phone);
    if (!tk.length && !ps.length) {
      const stop = currentStop(d.tickets, 'don');
      const here = live.filter((t) => !t.boarded && t.from_stop_id === stop && t.passenger_phone);
      if (here.length === 1) tk = here;
      else {
        const a = await ask('Gọi ai ạ? Anh nói tên hoặc 3 số cuối điện thoại.');
        tk = mentioned(a, live).filter((t) => t.passenger_phone);
        if (!tk.length) ps = mentionedParcels(a, parcelsOpen(d.parcels)).filter((p) => p.receiver_phone);
      }
    }
    if (tk.length) {
      const t = tk[0], name = whoOf(t.passenger_name, t.passenger_phone);
      setDial({ phone: t.passenger_phone!, ticketId: t.id, name });
      return `Chạm màn hình để gọi ${name}.`;
    }
    if (ps.length) {
      const p = ps[0], name = whoOf(p.receiver_name, p.receiver_phone);
      setDial({ phone: p.receiver_phone!, ticketId: null, name });
      return `Chạm màn hình để gọi ${name}.`;
    }
    return 'Em không tìm thấy người đó trên chuyến.';
  }
  /** Ghi kết quả gọi khách sau khi gọi xong */
  async function callResult(q: string): Promise<string> {
    const cb = callBack.current; callBack.current = null;
    release();   // gọi xong: phát nhạc lại
    if (!cb) return '';
    const r = callResultOf(q);
    if (!r) return 'Em chưa rõ kết quả, chưa ghi. Anh ghi trên màn hình giúp em.';
    await rpc('crew_mark', { p_ticket_id: cb.ticketId, p_action: r });
    await onChanged();
    return r === 'nghe_may' ? `Đã ghi ${cb.name} nghe máy, sẽ ra đón.` : r === 'thue_bao' ? `Đã ghi ${cb.name} thuê bao, không nghe máy.` : `Đã ghi ${cb.name} báo hủy.`;
  }
  /** Điều khiển nhạc bằng giọng nói */
  async function music(c: MusicCmd): Promise<string> {
    if (c.act === 'mo') {
      if (c.q) {
        const found = await searchSongs(/^nh\u1ea1c\b/i.test(c.q) ? c.q : `nhạc ${c.q}`).catch(() => null);
        if (found?.length) { playList(found, `Nhạc: ${c.q}`); return `Em mở nhạc ${c.q}.`; }
        if (found) return `Em không tìm thấy nhạc ${c.q}. Anh nói tên khác giúp em.`;
      }
      const l = await tenantPlaylist().catch(() => []);
      if (!l.length) return c.q ? 'Chưa tìm được nhạc, nhà xe cũng chưa có danh sách phát trên xe.' : 'Nhà xe chưa có danh sách phát trên xe. Anh nói mở nhạc kèm tên bài, ví dụ mở nhạc bolero.';
      playList(l, 'Danh sách phát trên xe');
      return c.q ? 'Chưa tìm được bài theo yêu cầu, em mở danh sách nhạc của xe.' : 'Em mở danh sách nhạc của xe.';
    }
    if (!musicState().list.length) return 'Chưa mở nhạc. Anh nói mở nhạc để nghe.';
    switch (c.act) {
      case 'tiep': nextSong(); return 'Đã chuyển bài.';
      case 'truoc': prevSong(); return 'Đã quay lại bài trước.';
      case 'dung': pauseSong(); return 'Đã tạm dừng nhạc.';
      case 'phat': resumeSong(); return 'Dạ.';
      case 'tat': stopMusic(); return 'Đã tắt nhạc.';
      default: {
        if (/iP(hone|ad|od)/.test(navigator.userAgent)) return 'Máy này không cho chỉnh âm lượng nhạc, anh bấm nút âm lượng của điện thoại.';
        return `Âm lượng nhạc ${volume(c.act === 'to' ? 20 : -20)} phần trăm.`;
      }
    }
  }
  /** Làm theo lệnh (lệnh có sẵn hoặc lệnh đã học) */
  async function run(it: LearnIntent, q: string): Promise<string> {
    if (it.startsWith('nhac:')) {
      const act = it.slice(5) as MusicCmd['act'];
      return music(act === 'mo' ? { act: 'mo', q: '' } : ({ act } as MusicCmd));
    }
    const i = it as Exclude<Intent, 'khong_ro'>;
    return i === 'goi' ? call(q)
      : i === 'don' || i === 'tra' || i === 'vang' || i === 'hoan_tac' ? update(q, i)
      : i === 'giao' || i === 'do_dau' || i === 'chi_phi' || i === 'su_co' || i === 'tre_gio' || i === 'nhan' ? report(q, i)
      : answer(i);
  }
  /** Câu chưa hiểu: tìm trong câu đã học; chưa có thì hỏi lại lái xe là lệnh nào, làm theo rồi lưu câu (không lưu câu có từ tục) */
  async function learnTurn(q: string): Promise<string> {
    const hit = learnedOf(q, phrases.current);
    if (hit) { void rpc('voice_used', { p_id: hit.id }).catch(() => undefined); return run(hit.intent, q); }
    const a = await ask(MENU_ASK);
    const li = a ? menuOf(a) : null;
    if (!li) return 'Dạ, em chưa làm gì.';
    const out = await run(li, q);
    const key = phraseKey(q);
    if (key && !hasBad(q)) void rpc<string>('voice_learn', { p_phrase: q, p_key: key, p_intent: li }).then(() => loadPhrases()).catch(() => undefined);
    return out;
  }
  function answer(it: Intent): string {
    const d = data.current;
    switch (it) {
      case 'diem_toi': return nextStopText(d.tickets, d.parcels, d.stopName);
      case 'thu_ho': return codText(d.parcels);
      case 'chuyen': return tripText(d.trip, d.tickets, d.cap);
      case 'nhac_lai': return last.current || nextStopText(d.tickets, d.parcels, d.stopName);
      default: return 'Em chưa hiểu. Anh hỏi điểm tới, thu hộ, hoặc báo đã đón, đã trả, khách vắng, đã giao hàng, đổ dầu, sự cố, hoặc nói mở nhạc.';
    }
  }
  async function turn(pre?: string) {
    stopSpeak(); stopRef.current();
    if (!canListen()) {
      await say('Máy này chưa nghe được giọng nói. Em đọc điểm tới. ' + nextStopText(data.current.tickets, data.current.parcels, data.current.stopName));
      setPhase('cho'); return;
    }
    let q = pre ?? '';
    if (!pre) {
      beep();
      setHeard(''); setPhase('nghe');
      const l = listen();
      stopRef.current = l.stop;
      q = await l.done;
    }
    setHeard(q);
    const it: Intent = q ? intentOf(dropBad(q)) : 'khong_ro';
    const mc = q && !callBack.current ? musicOf(dropBad(q)) : null;
    let out: string;
    try {
      out = q && callBack.current ? await callResult(q)
        : !q ? (free ? 'Em chưa nghe rõ. Anh nói trợ lý ơi rồi nói lại.' : 'Em chưa nghe rõ. Anh chạm màn hình rồi nói lại.')
        : mc ? await music(mc)
        : it !== 'khong_ro' ? await run(it, q)
        : await learnTurn(q);
    } catch { out = 'Ghi không được, anh thử lại sau.'; }
    await say(out);
    setPhase('cho');
  }
  async function start() {
    setOpen(true); setActive(true);
    if (!greeted.has(tripId)) {
      greeted.add(tripId);
      const d = data.current;
      await say(`${tripText(d.trip, d.tickets, d.cap)} ${d.trip.arrived_at ? '' : nextStopText(d.tickets, d.parcels, d.stopName)} Anh cần gì?`);
    }
    await turn();
  }
  /** Rảnh tay: nghe thấy "Trợ lý ơi" (kèm lệnh thì làm luôn, chưa có lệnh thì bíp rồi nghe) */
  async function onWake(cmd: string) {
    if (busyRef.current) return;
    hw.current?.pause();   // máy chỉ nghe được 1 lần một lúc: tạm dừng nghe nền khi trợ lý làm việc
    try {
      setOpen(true); setActive(true);
      if (!greeted.has(tripId)) {
        greeted.add(tripId);
        const d = data.current;
        await say(`${tripText(d.trip, d.tickets, d.cap)} ${d.trip.arrived_at ? '' : nextStopText(d.tickets, d.parcels, d.stopName)}${cmd ? '' : ' Anh cần gì?'}`);
      }
      await turn(cmd || undefined);
    } finally { hw.current?.resume(); }
  }
  wakeRef.current = (cmd) => { void onWake(cmd); };
  function freeToggle() {
    if (free) { hw.current?.stop(); hw.current = null; setFree(false); void speak('Đã tắt rảnh tay.'); return; }
    if (!canListen()) { void speak('Máy này chưa nghe được giọng nói, chưa bật được rảnh tay.'); return; }
    setFree(true); setActive(true);
    hw.current = hotword((t) => { const c = wakeOf(t); if (c !== null) wakeRef.current(c); }, () => {
      hw.current = null; setFree(false);
      void speak('Máy chưa cho dùng micro. Anh cho phép micro rồi bật lại rảnh tay.');
    });
    void speak('Đã bật rảnh tay. Anh nói trợ lý ơi, rồi nói lệnh.');
  }
  function close() { stopSpeak(); stopRef.current(); setOpen(false); setPhase('cho'); setDial(null); callBack.current = null; release(); }

  return (
    <>
      <button type="button" className="btn va-btn" onClick={() => void start()} aria-label="Trợ lý giọng nói">🎙 Trợ lý giọng nói</button>
      <button type="button" className={`btn va-btn${free ? ' on' : ''}`} aria-pressed={free} onClick={freeToggle}>{free ? '👂 Đang rảnh tay · bấm để tắt' : '👂 Rảnh tay'}</button>
      {open && (
        <div className="va-pane" role="dialog" aria-label="Trợ lý giọng nói" onClick={() => {
          if (phase === 'nghe') return;
          if (dial) {   // mở cuộc gọi bằng chính lần chạm (trình duyệt chỉ cho mở cuộc gọi khi người dùng chạm)
            stopSpeak();
            if (dial.ticketId) { callBack.current = { ticketId: dial.ticketId, name: dial.name }; void rpc('crew_mark', { p_ticket_id: dial.ticketId, p_action: 'goi' }).catch(() => undefined); }
            const tel = dial.phone; setDial(null);
            hold();   // đang gọi điện: dừng nhạc đến khi ghi xong kết quả cuộc gọi
            window.location.href = `tel:${tel}`;
            return;
          }
          void turn();
        }}>
          <button type="button" className="va-x" aria-label="Đóng trợ lý" onClick={(e) => { e.stopPropagation(); close(); }}>✕</button>
          <div className={`va-mic ${phase}`}>🎙</div>
          <div className="va-st">{phase === 'nghe' ? 'Đang nghe…' : phase === 'doc' ? 'Đang đọc…' : dial ? `📞 Chạm để gọi ${dial.name}` : 'Chạm để nói'}</div>
          {heard && <div className="va-q">“{heard}”</div>}
          {said && <div className="va-a">{said}</div>}
        </div>
      )}
    </>
  );
}
