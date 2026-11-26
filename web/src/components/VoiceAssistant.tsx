// Trợ lý giọng nói trong chuyến đang chạy (giai đoạn 1: chỉ tra cứu).
// Bấm nút lớn → lần đầu đọc tình hình chuyến + điểm tới rồi hỏi "Anh cần gì?"; các lần sau chỉ bíp rồi nghe.
// Màn trợ lý phủ kín: chạm bất kỳ đâu để nói tiếp (không cần nhìn), nút Đóng ở góc.
import { useEffect, useRef, useState } from 'react';
import { beep, canListen, canSpeak, clean, codText, currentStop, intentOf, isYes, listen, litersOf, mentioned, mentionedParcels, moneyOf, nextStopText,
  parcelDue, parcelsOpen, receiverList, sayMoney, speak, stopSpeak, tripText, whoList, type Intent, type VParcel, type VTicket, type VTrip } from '../lib/voice';
import { rpc } from '../lib/supabase';

type Mark = (ids: string[], action: 'len' | 'bo_len' | 'tra' | 'bo_tra' | 'vang' | 'bo_vang', patch: Partial<VTicket>) => Promise<void>;
const UNDO = { len: ['bo_len', { boarded: false, dropped: false }], tra: ['bo_tra', { dropped: false }], vang: ['bo_vang', { no_show: false }] } as const;

const greeted = new Set<string>();   // chuyến đã đọc câu mở đầu trong phiên này

export function VoiceAssistant({ tripId, trip, tickets, parcels, cap, stopName, onMark, onChanged }: {
  tripId: string; trip: VTrip; tickets: VTicket[]; parcels: VParcel[]; cap: number; stopName: (id: string) => string; onMark: Mark;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'doc' | 'nghe' | 'cho'>('cho');
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const last = useRef('');
  const heardLast = useRef('');
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
  function answer(q: string): string {
    const d = data.current;
    switch (intentOf(q)) {
      case 'diem_toi': return nextStopText(d.tickets, d.parcels, d.stopName);
      case 'thu_ho': return codText(d.parcels);
      case 'chuyen': return tripText(d.trip, d.tickets, d.cap);
      case 'nhac_lai': return last.current || nextStopText(d.tickets, d.parcels, d.stopName);
      default: return 'Em chưa hiểu. Anh hỏi điểm tới, thu hộ, hoặc báo đã đón, đã trả, khách vắng, đã giao hàng, đổ dầu, sự cố.';
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
    const it: Intent = q ? intentOf(q) : 'khong_ro';
    let out: string;
    try {
      out = !q ? 'Em chưa nghe rõ. Anh chạm màn hình rồi nói lại.'
        : it === 'don' || it === 'tra' || it === 'vang' || it === 'hoan_tac' ? await update(q, it)
        : it === 'giao' || it === 'do_dau' || it === 'chi_phi' || it === 'su_co' || it === 'tre_gio' || it === 'nhan' ? await report(q, it)
        : answer(q);
    } catch { out = 'Ghi không được, anh thử lại sau.'; }
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
