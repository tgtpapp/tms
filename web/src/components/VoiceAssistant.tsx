// Trợ lý giọng nói trong chuyến đang chạy (giai đoạn 1: chỉ tra cứu).
// Bấm nút lớn → lần đầu đọc tình hình chuyến + điểm tới rồi hỏi "Anh cần gì?"; các lần sau chỉ bíp rồi nghe.
// Màn trợ lý phủ kín: chạm bất kỳ đâu để nói tiếp (không cần nhìn), nút Đóng ở góc.
import { useEffect, useRef, useState } from 'react';
import { beep, canListen, canSpeak, codText, intentOf, listen, nextStopText, speak, stopSpeak, tripText, type VParcel, type VTicket, type VTrip } from '../lib/voice';

const greeted = new Set<string>();   // chuyến đã đọc câu mở đầu trong phiên này

export function VoiceAssistant({ tripId, trip, tickets, parcels, cap, stopName }: {
  tripId: string; trip: VTrip; tickets: VTicket[]; parcels: VParcel[]; cap: number; stopName: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'doc' | 'nghe' | 'cho'>('cho');
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const last = useRef('');
  const stopRef = useRef<() => void>(() => undefined);
  const data = useRef({ trip, tickets, parcels, cap, stopName });
  data.current = { trip, tickets, parcels, cap, stopName };
  useEffect(() => () => { stopSpeak(); stopRef.current(); }, []);
  if (!canSpeak()) return null;

  async function say(t: string) { setSaid(t); last.current = t; setPhase('doc'); await speak(t); }
  function answer(q: string): string {
    const d = data.current;
    switch (intentOf(q)) {
      case 'diem_toi': return nextStopText(d.tickets, d.parcels, d.stopName);
      case 'thu_ho': return codText(d.parcels);
      case 'chuyen': return tripText(d.trip, d.tickets, d.cap);
      case 'nhac_lai': return last.current || nextStopText(d.tickets, d.parcels, d.stopName);
      default: return 'Em chưa hiểu. Anh hỏi điểm tới, hoặc tiền thu hộ.';
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
    await say(q ? answer(q) : 'Em chưa nghe rõ. Anh chạm màn hình rồi nói lại.');
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
