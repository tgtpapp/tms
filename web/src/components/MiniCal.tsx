// Lịch tháng chọn ngày, có ngày âm lịch (mùng 1 và rằm tô đỏ) + dòng "Âm lịch: 11/10 năm Bính Ngọ".
import { useEffect, useMemo, useState } from 'react';
import { fmtDate, today } from './Documents';
import { lunarText, toLunar } from '../lib/lunar';

const WD = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

/** marks: ngày có chuyến (chấm dưới ngày, như app cũ); onMonth: đổi tháng đang xem (để tải các ngày có chuyến) */
export function MiniCal({ day, onPick, marks, onMonth }: { day: string; onPick: (d: string) => void; marks?: Map<string, number>; onMonth?: (ym: string) => void }) {
  const [month, setMonth] = useState(day.slice(0, 7));
  useEffect(() => setMonth(day.slice(0, 7)), [day]);
  useEffect(() => { onMonth?.(month); }, [month]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [y, m] = month.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lunar = useMemo(() => Array.from({ length: days }, (_, i) => toLunar(i + 1, m, y)), [days, m, y]);
  const iso = (d: number) => `${month}-${String(d).padStart(2, '0')}`;
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  };
  const now = today();
  return (
    <div className="mini-cal">
      <div className="mc-head">
        <button type="button" className="btn small link" aria-label="Tháng trước" onClick={() => shift(-1)}>‹</button>
        <b>Tháng {m}/{y}</b>
        <button type="button" className="btn small link" aria-label="Tháng sau" onClick={() => shift(1)}>›</button>
        <button type="button" className="btn small primary" onClick={() => onPick(now)}>Hôm nay</button>
      </div>
      <div className="mc-grid">
        {WD.map((w) => <span key={w} className="mc-wd">{w}</span>)}
        {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
        {Array.from({ length: days }, (_, i) => {
          const d = iso(i + 1);
          const l = lunar[i];
          const cls = ['mc-day', d === day && 'on', d === now && 'now', d < now && 'past', (lead + i) % 7 === 6 && 'sun'].filter(Boolean).join(' ');
          const red = l.day === 1 || l.day === 15;
          return (
            <button key={d} type="button" className={cls} aria-label={`Ngày ${fmtDate(d)}${marks?.get(d) ? ` · ${marks.get(d)} chuyến` : ''}`} onClick={() => onPick(d)}>
              <span className="mc-solar">{i + 1}</span>
              <span className={red ? 'mc-lunar red' : 'mc-lunar'}>{l.day === 1 ? `${l.day}/${l.month}${l.leap ? 'N' : ''}` : l.day}</span>
              {marks && <span className={marks.get(d) ? 'mc-dot on' : 'mc-dot'} />}
            </button>
          );
        })}
      </div>
      <p className="mc-foot">Âm lịch: <b>{lunarText(day)}</b></p>
    </div>
  );
}
