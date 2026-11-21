// Ô chọn tháng gọn, cân đối, dùng chung mọi mục: ‹ 11/2026 › — bấm vào tháng mở lịch chọn tháng của máy.
import { useRef } from 'react';

const now = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 7);

export function MonthPicker({ value, onChange, label = 'Tháng', allowEmpty = false }: { value: string; onChange: (v: string) => void; label?: string; allowEmpty?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const shift = (n: number) => {
    const [y, m] = (value || now()).split('-').map(Number);
    onChange(new Date(Date.UTC(y!, m! - 1 + n, 1)).toISOString().slice(0, 7));
  };
  return (
    <div className="month-pick">
      <span className="mp-lbl">{label}</span>
      <div className="mp-box">
        <button type="button" aria-label={`${label}: lùi 1 tháng`} onClick={() => shift(-1)}>‹</button>
        <span className="mp-val">
          {value ? `${value.slice(5)}/${value.slice(0, 4)}` : 'Tất cả'}
          <input ref={ref} type="month" aria-label={label} value={value}
                 onClick={() => { try { ref.current?.showPicker?.(); } catch { /* máy không hỗ trợ: dùng ô chọn sẵn */ } }}
                 onChange={(e) => { if (e.target.value || allowEmpty) onChange(e.target.value); }} />
        </span>
        <button type="button" aria-label={`${label}: tới 1 tháng`} onClick={() => shift(1)}>›</button>
      </div>
    </div>
  );
}
