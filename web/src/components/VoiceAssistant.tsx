// Trợ lý giọng nói trong chuyến đang chạy (giai đoạn 1: chỉ tra cứu).
// Bấm nút lớn → lần đầu đọc tình hình chuyến + điểm tới rồi hỏi "Anh cần gì?"; các lần sau chỉ bíp rồi nghe.
// Màn trợ lý phủ kín: chạm bất kỳ đâu để nói tiếp (không cần nhìn), nút Đóng ở góc.
import { useEffect, useRef, useState } from 'react';
import { beep, canListen, canSpeak, codText, currentStop, intentOf, isYes, listen, mentioned, nextStopText, speak, stopSpeak, tripText, whoList,
  type VParcel, type VTicket, type VTrip } from '../lib/voice';

type Mark = (ids: string[], action: 'len' | 'bo_len' | 'tra' | 'bo_tra' | 'vang' | 'bo_vang', patch: Partial<VTicket>) => Promise<void>;
const UNDO = { len: ['bo_len', { boarded: false, dropped: false }], tra: ['bo_tra', { dropped: false }], vang: ['bo_vang', { no_show: false }] } as const;

const greeted = new Set<string>();   // chuyến đã đọc câu mở đầu trong phiên này

export function VoiceAssistant({ tripId, trip, tickets, parcels, cap, stopName, onMark }: {
  tripId: string; trip: VTrip; tickets: VTicket[]; parcels: VParcel[]; cap: number; stopName: (id: string) => string; onMark: Mark;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'doc' | 'nghe' | 'cho'>('cho');
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const last = useRef('');
  const undo = useRef<{ ids: string[]; act: 'len' | 'tra' | 'vang' } | null>(null);
  const stopRef = useRef<() => void>(() => undefined);
  const data = useRef({ trip, tickets, parcels, cap, stopName });
  data.current = { trip, tickets, parcels, cap, stopName };
  useEffect(() => () => { stopSpeak(); stopRef.current(); }, []);
  if (!canSpeak()) return null;

  async function say(t: string) { setSaid(t); last.current = t; setPhase('doc'); await speak(t); }
  /** Nghe thêm 1 câu (hỏi lại / xác nhận) */
  async function ask(t: string): Promise<string> {
    await say(t);
    beep(); setPhase('nghe');
    const l = listen(); stopRef.current = l.stop;
    const q = await l.done; setHeard(q); return q;
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
    if (!g.length) g = mentioned(await ask('Khách nào vắng ạ? Anh nói tên hoặc 4 số cuối điện thoại.'), wait);
    if (!g.length) return 'Em không tìm thấy khách đó. Chưa ghi gì.';
    if (!isYes(await ask(`Xác nhận ${whoList(g)} vắng, đúng không ạ?`))) return 'Đã bỏ qua, chưa ghi.';
    const after = await mark(g.map((t) => t.id), 'vang', { no_show: true });
    return `Đã ghi ${g.length} khách vắng.${nextName(after)}`;
  }
  function answer(q: string): string {
    const d = data.current;
    switch (intentOf(q)) {
      case 'diem_toi': return nextStopText(d.tickets, d.parcels, d.stopName);
      case 'thu_ho': return codText(d.parcels);
      case 'chuyen': return tripText(d.trip, d.tickets, d.cap);
      case 'nhac_lai': return last.current || nextStopText(d.tickets, d.parcels, d.stopName);
      default: return 'Em chưa hiểu. Anh hỏi điểm tới, tiền thu hộ, hoặc báo đã đón, đã trả, khách vắng.';
    }
  }
  async function turn() {
    stopSpeak(); stopRef.current();
    if (!canListen()) {
      await say('Máy này chưa nghe được giọng nói. Em đọc điểm tới. ' + nextStopText(data.current.tickets, data.current.parcels, data.current.stopName));
      setPhase('cho'); return;
    }
    beep();
    setHeard(''); setPhase('nghe');
    const l = listen();
    stopRef.current = l.stop;
    const q = await l.done;
    setHeard(q);
    const it = q ? intentOf(q) : 'khong_ro';
    let out: string;
    try { out = !q ? 'Em chưa nghe rõ. Anh chạm màn hình rồi nói lại.' : it === 'don' || it === 'tra' || it === 'vang' || it === 'hoan_tac' ? await update(q, it) : answer(q); }
    catch { out = 'Ghi không được, anh thử lại sau.'; }
    await say(out);
    setPhase('cho');
  }
  async function start() {
    setOpen(true);
    if (!greeted.has(tripId)) {
      greeted.add(tripId);
      const d = data.current;
      await say(`${tripText(d.trip, d.tickets, d.cap)} ${d.trip.arrived_at ? '' : nextStopText(d.tickets, d.parcels, d.stopName)} Anh cần gì?`);
    }
    await turn();
  }
  function close() { stopSpeak(); stopRef.current(); setOpen(false); setPhase('cho'); }

  return (
    <>
      <button type="button" className="btn va-btn" onClick={() => void start()} aria-label="Trợ lý giọng nói">🎙 Trợ lý giọng nói</button>
      {open && (
        <div className="va-pane" role="dialog" aria-label="Trợ lý giọng nói" onClick={() => { if (phase !== 'nghe') void turn(); }}>
          <button type="button" className="va-x" aria-label="Đóng trợ lý" onClick={(e) => { e.stopPropagation(); close(); }}>✕</button>
          <div className={`va-mic ${phase}`}>🎙</div>
          <div className="va-st">{phase === 'nghe' ? 'Đang nghe…' : phase === 'doc' ? 'Đang đọc…' : 'Chạm để nói'}</div>
          {heard && <div className="va-q">“{heard}”</div>}
          {said && <div className="va-a">{said}</div>}
        </div>
      )}
    </>
  );
}
